/**
 * A web page cannot find the extension by probing its addresses. No content script is web
 * accessible, and the PDF page is reachable only at a per-session address. The probe knows
 * the extension's id, as a page could for a store extension.
 */
import { centre, expect, layerInfo, ring, stroke, test, textBox, workerOf } from './fixtures';

/** Files a page might ask for, by every way a page can load an address. */
const PATHS = [
  'stub.js',
  'content/loader.js',
  'content/tools.js',
  'content/pdf.js',
  'content/boot.js',
  'pdf.html',
  'manifest.json',
  'icons/16.png',
];

test('a page that probes every address of the extension finds nothing, before and after it has ink', async ({
  context,
  origin,
  extId,
  ext,
}) => {
  const page = await context.newPage();
  const probe = () =>
    page.evaluate(
      async ({ id, paths }) => {
        const found: string[] = [];
        for (const p of paths) {
          const url = `chrome-extension://${id}/${p}`;
          const ok = await fetch(url).then(
            () => true,
            () => false,
          );
          if (ok) found.push(`fetch ${p}`);
          const loaded = await new Promise<boolean>((done) => {
            const el = p.endsWith('.png') ? new Image() : document.createElement('script');
            el.onload = () => done(true);
            el.onerror = () => done(false);
            (el as HTMLImageElement).src = url;
            if (el instanceof HTMLScriptElement) document.head.append(el);
          });
          if (loaded) found.push(`element ${p}`);
          const imported = await import(/* @vite-ignore */ url).then(
            () => true,
            () => false,
          );
          if (imported) found.push(`import ${p}`);
        }
        return found;
      },
      { id: extId, paths: PATHS },
    );

  await page.goto(`${origin.a}/article.html`);
  expect(await probe()).toEqual([]);

  // Write, so the site has ink and the viewer is a registered content script there.
  const b = (await textBox(page, 'pomegranate'))!;
  await stroke(page, ring(centre(b), b.w / 2 + 8, b.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  // The site now has the viewer as a registered content script.
  const sw = await workerOf(context);
  const host = new URL(origin.a).hostname;
  await expect
    .poll(() =>
      sw.evaluate(
        async (h) =>
          (await chrome.scripting.getRegisteredContentScripts()).some((c) =>
            c.matches?.some((m) => m.includes(h)),
          ),
        host,
      ),
    )
    .toBe(true);
  await page.reload();
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  expect(await probe()).toEqual([]);
  // The viewer came as the registered script: its first read ran at document start.
  const cdp = await context.newCDPSession(page);
  const worlds: { id: number; origin: string; auxData?: { type?: string } }[] = [];
  cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
  await cdp.send('Runtime.enable');
  const world = worlds.find((w) => w.auxData?.type === 'isolated' && w.origin.includes(extId));
  const { result } = await cdp.send('Runtime.evaluate', {
    contextId: world!.id,
    expression:
      '!!globalThis.__ink?.boot && !!globalThis.__ink?.early && !!globalThis.__ink?.loader && !globalThis.__ink?.tools',
    returnByValue: true,
  });
  expect(result.value).toBe(true);
  await cdp.detach();
  // The registration names this host only.
  const scripts = await ext.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  expect(scripts.map((s) => s.matches)).toEqual([[`*://${new URL(origin.a).hostname}/*`]]);
});
