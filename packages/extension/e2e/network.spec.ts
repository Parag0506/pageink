/**
 * The runtime no-network check (netlog.ts) records what it should. Every other
 * test relies on it: closing a context fails when the extension made a request.
 */
import { expect, extDir, extensionRequests, test, workerOf } from './fixtures';
import { forbidden, unpackedId } from './netlog';
import { pdfServer, ready, viewerOf } from './pdf-kit';

test('the PDF read is recorded and allowed once per load', async ({ context }) => {
  const srv = await pdfServer();
  try {
    const url = `${srv.url}/doc.pdf`;
    const page = await context.newPage();
    await page.goto(url);
    await ready(await viewerOf(page));
    const reads = extensionRequests(context).filter((r) => r.url === url);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.from).toMatch(/^chrome-extension:\/\/[^/]+\/content\/pdf\.js$/);
    expect(forbidden(context)).toEqual([]);
    // A second read for the same load breaks the rule.
    extensionRequests(context).push({ ...reads[0]! });
    expect(forbidden(context)).toHaveLength(1);
    extensionRequests(context).pop();
  } finally {
    srv.close();
  }
});

test('a request from an extension script is caught', async ({ context, origin }) => {
  const sw = await workerOf(context);
  const id = new URL(sw.url()).host;
  // The id the suite computes for other extensions matches how Chromium names this one.
  expect(unpackedId(extDir)).toBe(id);
  const page = await context.newPage();
  await page.goto(`${origin.a}/plain.html`);
  // Run a request as if from a content script: in the extension's world, under its address.
  const cdp = await context.newCDPSession(page);
  const worlds: { id: number; origin: string; auxData?: { type?: string } }[] = [];
  cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
  await cdp.send('Runtime.enable');
  const world = worlds.find((w) => w.auxData?.type === 'isolated' && w.origin.includes(id));
  expect(world).toBeDefined();
  const target = `${origin.b}/plain.html?probe`;
  await cdp.send('Runtime.evaluate', {
    contextId: world!.id,
    expression: `fetch(${JSON.stringify(target)}).catch(() => {});\n//# sourceURL=chrome-extension://${id}/probe.js`,
    awaitPromise: true,
  });
  await expect.poll(() => extensionRequests(context).filter((r) => r.url === target).length).toBe(1);
  expect(forbidden(context).map((r) => r.url)).toEqual([target]);
  // Taken out again so that closing this context does not fail the test.
  const list = extensionRequests(context);
  list.splice(
    list.findIndex((r) => r.url === target),
    1,
  );
  await cdp.detach();
});
