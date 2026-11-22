import { readFileSync, writeFileSync } from 'node:fs';
import { hashKey, idxKey, pageKeyOf } from 'pageink-core/hash';
import { NAME } from '../src/brand';
import {
  allNotes,
  barClick,
  centre,
  expect,
  layerInfo,
  line,
  readStorage,
  records,
  ring,
  seedStorage,
  shotPath,
  stroke,
  test,
} from './fixtures';
import {
  DOC,
  frameBarClick,
  inkCount,
  notePoint,
  pageBox,
  pdfServer,
  ready,
  showPage,
  viewerOf,
  wordBox,
  wordPoint,
} from './pdf-kit';

let srv: Awaited<ReturnType<typeof pdfServer>>;
test.beforeAll(async () => {
  srv = await pdfServer();
});
test.afterAll(() => srv.close());

const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThan(tol);

test('a PDF address opens in the ink viewer; ink on page 2 stays on the same PDF point through reload, zoom and resize', async ({
  context,
  ext,
}) => {
  const url = `${srv.url}/doc.pdf`;
  // The server is shared by the file, so only this test's reads are counted.
  const hits0 = srv.hits('/doc.pdf');
  const page = await context.newPage();
  await page.goto(url);
  const v = await viewerOf(page);
  await ready(v);
  // The address bar keeps the PDF address and the tab shows the PDF's title.
  expect(page.url()).toBe(url);
  await expect(page).toHaveTitle('PageInk test paper');
  expect(await v.locator('.page').count()).toBe(12);
  await expect(v.locator('#count')).toHaveText('of 12');

  await showPage(v, 2);
  await expect(v.locator('#page')).toHaveValue('2');
  const w = await wordBox(v, 2, 'quokka2');
  await stroke(page, ring(centre(w), w.w / 2 + 10, w.h / 2 + 8));
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);

  // The record is keyed by the PDF's own address, and the site index lists it.
  const recs = await records(ext);
  const rec = Object.values(recs)[0]!;
  expect(rec.key).toBe(url);
  expect(Object.keys(recs)).toEqual([pageKeyOf(url)]);
  expect((rec as unknown as { urls: string[] }).urls).toContain(url);
  const idx = (await readStorage(ext, [idxKey('127.0.0.1')]))[idxKey('127.0.0.1')] as {
    m: Record<string, string>;
  };
  expect(idx.m[hashKey(url)]).toBe(hashKey(url));
  const note = rec.notes[0]!;
  expect(note.anchor.type).toBe('media');
  expect((note.anchor as unknown as { media: { src: string } }).media.src).toBe('ink-pdf-page-2');
  expect(note.anchor.quote.exact).toBe('Page 2');

  const at = async () => {
    const n = await notePoint(v, 2);
    const t = await wordPoint(v, 2, 'quokka2');
    return n && { dx: n.x - t.x, dy: n.y - t.y, w: n.w };
  };
  const first = (await at())!;
  expect(first).not.toBeNull();

  // Reload: the same address, the same ink, on the same point of the page.
  await page.reload();
  const v2 = await viewerOf(page);
  await ready(v2);
  await showPage(v2, 2);
  await expect.poll(async () => (await inkCount(v2)).notes).toBe(1);
  const again = async () => {
    const n = await notePoint(v2, 2);
    const t = await wordPoint(v2, 2, 'quokka2');
    return n && { dx: n.x - t.x, dy: n.y - t.y, w: n.w };
  };
  const check = async (label: string) => {
    await expect
      .poll(
        async () => {
          const a = await again();
          return a ? Math.abs(a.dx - first.dx) + Math.abs(a.dy - first.dy) + Math.abs(a.w - first.w) : 1;
        },
        { message: label },
      )
      .toBeLessThan(0.006);
  };
  await check('after reload');

  // Zoom in twice, out three times, then fit: the ink stays on the word.
  const zoomOf = () => v2.locator('#zoom').textContent();
  const z0 = await zoomOf();
  await v2.locator('#zoom-in').click();
  await v2.locator('#zoom-in').click();
  await expect.poll(zoomOf).not.toBe(z0);
  await showPage(v2, 2);
  await check('after zoom in');
  for (let i = 0; i < 3; i++) await v2.locator('#zoom-out').click();
  await showPage(v2, 2);
  await check('after zoom out');
  // Keyboard zoom.
  await v2
    .locator('main')
    .click({ position: { x: 4, y: 4 } })
    .catch(() => {});
  await page.keyboard.press('Control+=');
  await showPage(v2, 2);
  await check('after keyboard zoom');

  // Resize the window. Fit width follows it.
  await v2.locator('#fit').click();
  await page.setViewportSize({ width: 700, height: 800 });
  await showPage(v2, 2);
  // Fit width: the page fills the narrower window without spilling over.
  await expect.poll(async () => (await pageBox(v2, 2)).w).toBeLessThanOrEqual(700 - 32);
  expect((await pageBox(v2, 2)).w).toBeGreaterThan(600);
  await showPage(v2, 2);
  await check('after resize');
  await page.screenshot({ path: shotPath('pdf-ink-light') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await check('in dark mode');
  await page.screenshot({ path: shotPath('pdf-ink-dark') });
  // One read of the address for the viewer, besides the browser's own load. Both may come from the cache.
  expect(srv.hits('/doc.pdf') - hits0).toBeLessThanOrEqual(4);
});

test('a far page has its ink when it is scrolled to', async ({ context, ext }) => {
  const url = `${srv.url}/doc.pdf`;
  const page = await context.newPage();
  await page.goto(url);
  const v = await viewerOf(page);
  await ready(v);
  await showPage(v, 11);
  const w = await wordBox(v, 11, 'zebra11');
  await stroke(page, line({ x: w.x, y: w.y + w.h + 4 }, { x: w.x + w.w, y: w.y + w.h + 30 }));
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);
  const first = await notePoint(v, 11);
  const t1 = await wordPoint(v, 11, 'zebra11');

  await page.reload();
  const v2 = await viewerOf(page);
  await ready(v2);
  // Page 11 is far away and not drawn yet. Its container has its size, and the ink waits on it.
  expect(await v2.locator('#ink-pdf-page-11 canvas').count()).toBe(0);
  await showPage(v2, 11);
  await expect.poll(async () => (await inkCount(v2)).notes).toBe(1);
  const n = (await notePoint(v2, 11))!;
  const t2 = await wordPoint(v2, 11, 'zebra11');
  near(n.x - t2.x, first!.x - t1.x, 0.006);
  near(n.y - t2.y, first!.y - t1.y, 0.006);
  // Far canvases are let go; the containers keep their size.
  await showPage(v2, 1);
  await expect.poll(() => v2.locator('#ink-pdf-page-11 canvas').count()).toBe(0);
  const box = await pageBox(v2, 11);
  expect(box.h).toBeGreaterThan(500);
});

test('an arXiv PDF address joins the family record and offers the HTML version', async ({ context, ext }) => {
  await context.route('https://arxiv.org/pdf/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: DOC,
      headers: { 'cache-control': 'max-age=600' },
    }),
  );
  const url = 'https://arxiv.org/pdf/2401.12345v2';
  const page = await context.newPage();
  await page.goto(url);
  const v = await viewerOf(page);
  await ready(v);
  const link = v.locator('#html-version');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://arxiv.org/html/2401.12345v2');
  await expect(link).toHaveAttribute('target', '_top');
  await showPage(v, 1);
  const w = await wordBox(v, 1, 'quokka1');
  await stroke(page, ring(centre(w), w.w / 2 + 10, w.h / 2 + 8));
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);
  const recs = await records(ext);
  expect(Object.keys(recs)).toEqual([pageKeyOf('arxiv:2401.12345')]);
  // The abs page of the same paper finds the record through the index.
  const idx = (await readStorage(ext, [idxKey('arxiv.org')]))[idxKey('arxiv.org')] as {
    m: Record<string, string>;
  };
  expect(idx.m[hashKey('arxiv:2401.12345')]).toBe(hashKey('arxiv:2401.12345'));
  expect(idx.m[hashKey(url)]).toBe(hashKey('arxiv:2401.12345'));
});

test('with "Open PDFs with ink" off, the built-in viewer stays and a button opens the ink viewer', async ({
  context,
  ext,
}) => {
  await seedStorage(ext, { cfg: { v: 1, device: 'test', pdf: false } });
  const page = await context.newPage();
  await page.goto(`${srv.url}/doc.pdf`);
  const button = page.locator('ink-pdf-offer').locator('button');
  await expect(button).toHaveText(`Open with ${NAME}`);
  expect(page.frames().some((f) => f.url().includes('pdf.html'))).toBe(false);
  await button.click();
  const v = await viewerOf(page);
  await ready(v);
  await expect(page.locator('ink-pdf-offer')).toHaveCount(0);
});

test('the settings page switches PDFs off and links to the viewer page', async ({ context, extId, ext }) => {
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html#settings`);
  const box = opt.locator('#pdf-open');
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect.poll(async () => ((await readStorage(ext, ['cfg'])).cfg as { pdf?: boolean }).pdf).toBe(false);
  await expect(opt.locator('a#open-pdf')).toHaveAttribute('href', '/pdf.html');
});

test('a local file keeps its notes under another name; Markdown names the page; the reader can print', async ({
  context,
  ext,
  extId,
}) => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed++;
    };
  });
  await page.goto(`chrome-extension://${extId}/pdf.html`);
  await expect(page.locator('#empty')).toBeVisible();
  await page.screenshot({ path: shotPath('pdf-empty') });
  await page
    .locator('#file')
    .setInputFiles({ name: 'paper-one.pdf', mimeType: 'application/pdf', buffer: DOC });
  const v = await viewerOf(page);
  await ready(v);
  await showPage(v, 2);
  const w = await wordBox(v, 2, 'quokka2');
  await stroke(page, ring(centre(w), w.w / 2 + 10, w.h / 2 + 8));
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);
  const recs = await records(ext);
  const rec = Object.values(recs)[0]!;
  expect(rec.key).toMatch(/^pdf:[0-9a-f]{32}$/);
  const where = (await notePoint(v, 2))!;

  // Another file name, the same document: the same notes, on the same point.
  await page.reload();
  await page
    .locator('#file')
    .setInputFiles({ name: 'renamed copy.pdf', mimeType: 'application/pdf', buffer: DOC });
  await ready(v);
  await showPage(v, 2);
  await expect.poll(async () => (await inkCount(v)).notes).toBe(1);
  const back = (await notePoint(v, 2))!;
  near(back.x, where.x, 0.006);
  near(back.y, where.y, 0.006);
  expect(Object.keys(await records(ext))).toHaveLength(1);

  // Markdown export: the page number stands in for a quote.
  await barClick(page, 'More');
  const [dl] = await Promise.all([page.waitForEvent('download'), barClick(page, 'Save notes as Markdown')]);
  const md = readFileSync((await dl.path())!, 'utf8');
  expect(md).toContain('> Page 2');

  // Image of the view with its ink.
  await barClick(page, 'More');
  const [img] = await Promise.all([page.waitForEvent('download'), barClick(page, 'Save as image')]);
  expect(
    readFileSync((await img.path())!)
      .subarray(1, 4)
      .toString(),
  ).toBe('PNG');

  // Print: every page is drawn as an image in its container and the ink lines up with the pages.
  await barClick(page, 'More');
  await barClick(page, 'Print');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed))
    .toBe(1);
  expect(await page.locator('img.print-page').count()).toBe(12);
  await page.emulateMedia({ media: 'print' });
  const p2 = await pageBox(v, 2);
  const ink = (await layerInfo(v))!.notes[0]!.box;
  near((ink.x - p2.x) / p2.w, where.x, 0.01);
  near((ink.y - p2.y) / p2.w, where.y, 0.01);
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  const out = shotPath('pdf-printed');
  if (out) writeFileSync(out.replace(/\.png$/, '.pdf'), pdf);
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('img.print-page')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveClass(/printing/);
});

test('a highlighter line over PDF text becomes a text mark that stays on its words at any zoom and after reload', async ({
  context,
  ext,
}) => {
  const page = await context.newPage();
  await page.goto(`${srv.url}/doc.pdf`);
  const v = await viewerOf(page);
  await ready(v);
  await showPage(v, 2);
  await frameBarClick(page, v, 'Highlighter');
  const a = await wordBox(v, 2, 'quick');
  const b = await wordBox(v, 2, 'jumps');
  const y = a.y + a.h / 2;
  await stroke(page, line({ x: a.x + 2, y }, { x: b.x + b.w - 2, y }));
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);
  const note = (await allNotes(ext))[0]!;
  expect(note.kind).toBe('textmark');
  expect(note.anchor.quote.exact).toBe('quick brown fox jumps');

  // The mark covers the words at each zoom: its left edge on "quick", its right edge on "jumps".
  const covers = async (vv: typeof v) => {
    const m = (await layerInfo(vv))?.marks[0]?.box;
    if (!m) return 99;
    const q = await wordBox(vv, 2, 'quick');
    const j = await wordBox(vv, 2, 'jumps');
    return (
      Math.abs(m.x - q.x) / q.h +
      Math.abs(m.x + m.w - (j.x + j.w)) / q.h +
      Math.abs(m.y + m.h / 2 - (q.y + q.h / 2)) / q.h
    );
  };
  await expect.poll(() => covers(v)).toBeLessThan(0.8);
  for (const id of ['zoom-in', 'zoom-in', 'zoom-in']) await v.locator(`#${id}`).click();
  await showPage(v, 2);
  await expect.poll(() => covers(v)).toBeLessThan(0.8);
  for (const id of ['zoom-out', 'zoom-out', 'zoom-out', 'zoom-out', 'zoom-out'])
    await v.locator(`#${id}`).click();
  await showPage(v, 2);
  await expect.poll(() => covers(v)).toBeLessThan(0.8);

  // After a reload the mark's page gets its text layer before the ink is placed, so it never waits in the tray.
  await page.reload();
  const v2 = await viewerOf(page);
  await ready(v2);
  await expect.poll(async () => (await layerInfo(v2))?.marks.length).toBe(1);
  await showPage(v2, 2);
  await expect.poll(() => covers(v2)).toBeLessThan(0.8);
  expect((await layerInfo(v2))?.bar?.tray ?? '').not.toMatch(/[1-9]/);
});

test('on a browser that cannot run PDF.js, the built-in viewer stays with no offer to retry', async ({
  context,
}) => {
  // Only the extension's pages lose the built-in, the way an old engine would lack it.
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:') return;
    Object.defineProperty(globalThis, 'Iterator', { value: undefined, writable: false, configurable: false });
  });
  const page = await context.newPage();
  let framed = 0;
  page.on('framenavigated', (f) => {
    if (f.url().includes('pdf.html')) framed++;
  });
  await page.goto(`${srv.url}/doc.pdf`);
  await expect.poll(() => framed).toBeGreaterThan(0);
  // The viewer says it cannot run, and the frame goes with no offer. The other way a frame goes
  // is the fallback after 15 seconds (READY_MS in src/content/pdf.ts), and that one leaves an
  // offer in the same task. So the offer tells the two apart, not the time it took, and the
  // wait is long enough to see the fallback if the viewer never spoke.
  await expect
    .poll(() => page.frames().some((f) => f.url().includes('pdf.html')), { timeout: 30_000 })
    .toBe(false);
  expect(await page.locator('ink-pdf-offer').count()).toBe(0);
  await expect(page.locator('body iframe')).toHaveCount(0);
});
