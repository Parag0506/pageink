/**
 * Helpers for the PDF tests: a server for generated PDFs, and ways to reach
 * the viewer page whether it runs in a frame on a PDF address or on its own.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Frame, Page } from '@playwright/test';
import { type Box, expect, inLayer, layerInfo } from './fixtures';
import { makePdf, paperPages } from './pdfs';

export const DOC = makePdf({ pages: paperPages(12), title: 'PageInk test paper' });
export const OTHER = makePdf({
  pages: paperPages(3, 'other'),
  title: 'Other paper',
  id: 'ffeeddccbbaa99887766554433221100',
});

export async function pdfServer(): Promise<{ url: string; close(): void; hits(path: string): number }> {
  const count = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    count.set(path, (count.get(path) ?? 0) + 1);
    if (path === '/doc.pdf' || path === '/papers/doc.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'max-age=600' }).end(DOC);
    } else if (path === '/other.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'max-age=600' }).end(OTHER);
    } else res.writeHead(404).end('not found');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
    hits: (p) => count.get(p) ?? 0,
  };
}

/** The viewer: the frame on a PDF address, or the page itself when it is pdf.html. */
export async function viewerOf(page: Page): Promise<Frame> {
  if (page.url().includes('/pdf.html')) return page.mainFrame();
  await expect
    .poll(() => page.frames().some((f) => f.url().includes('/pdf.html')), { timeout: 15_000 })
    .toBe(true);
  return page.frames().find((f) => f.url().includes('/pdf.html'))!;
}

/** Wait until the document is shown, the ink bar is up and the page in view is drawn. */
export async function ready(v: Frame): Promise<void> {
  await v.waitForFunction(
    () => document.documentElement.classList.contains('has-doc') && !!document.querySelector('.page canvas'),
  );
  await expect
    .poll(async () => (await layerInfo(v))?.bar !== null && (await layerInfo(v)) !== null)
    .toBe(true);
}

/** Scroll page n to the top of the view, under the bar. */
export async function showPage(v: Frame, n: number): Promise<void> {
  await v.evaluate((k) => {
    const el = document.getElementById(`ink-pdf-page-${k}`)!;
    const bar = document.getElementById('bar')!.getBoundingClientRect().bottom;
    window.scrollTo(window.scrollX, el.getBoundingClientRect().top + window.scrollY - bar - 8);
  }, n);
  await v.waitForFunction((k) => !!document.querySelector(`#ink-pdf-page-${k} canvas`), n);
  await v.waitForFunction((k) => !!document.querySelector(`#ink-pdf-page-${k} .textLayer span`), n);
}

/** Client box of page n's container. */
export const pageBox = (v: Frame, n: number): Promise<Box> =>
  v.evaluate((k) => {
    const r = document.getElementById(`ink-pdf-page-${k}`)!.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, n);

/** Where the first note sits, in units of its page width, from the page's top-left. */
export async function notePoint(
  v: Frame,
  n: number,
  i = 0,
): Promise<{ x: number; y: number; w: number } | null> {
  const note = (await layerInfo(v))?.notes[i]?.box;
  if (!note) return null;
  const p = await pageBox(v, n);
  return { x: (note.x - p.x) / p.w, y: (note.y - p.y) / p.w, w: note.w / p.w };
}

/** Where a word sits, in units of its page width. */
export async function wordPoint(v: Frame, n: number, word: string): Promise<{ x: number; y: number }> {
  const b = await v.evaluate(
    ([k, w]) => {
      const spans = document.querySelectorAll(`#ink-pdf-page-${k} .textLayer span`);
      for (const s of spans) {
        const t = s.firstChild;
        const i = t?.textContent?.indexOf(w as string) ?? -1;
        if (!t || i < 0) continue;
        const r = document.createRange();
        r.setStart(t, i);
        r.setEnd(t, i + (w as string).length);
        const b = r.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      }
      return null;
    },
    [n, word] as const,
  );
  if (!b) throw new Error(`no ${word} on page ${n}`);
  const p = await pageBox(v, n);
  return { x: (b.x - p.x) / p.w, y: (b.y - p.y) / p.w };
}

/** Client box of a word on page n. */
export async function wordBox(v: Frame, n: number, word: string): Promise<Box> {
  const w = await wordPoint(v, n, word);
  const p = await pageBox(v, n);
  const h = await v.evaluate(
    ([k, wd]) => {
      for (const s of document.querySelectorAll(`#ink-pdf-page-${k} .textLayer span`)) {
        const t = s.firstChild;
        const i = t?.textContent?.indexOf(wd as string) ?? -1;
        if (!t || i < 0) continue;
        const r = document.createRange();
        r.setStart(t, i);
        r.setEnd(t, i + (wd as string).length);
        const b = r.getBoundingClientRect();
        return { w: b.width, h: b.height };
      }
      return { w: 0, h: 0 };
    },
    [n, word] as const,
  );
  return { x: p.x + w.x * p.w, y: p.y + w.y * p.w, ...h };
}

/** Click a button in the viewer's bar. */
export const viewerClick = (v: Frame, id: string) => v.locator(`#${id}`).click();

/** Number of drawn ink notes and text marks in the layer. */
export async function inkCount(v: Frame): Promise<{ notes: number; marks: number }> {
  const i = await layerInfo(v);
  return { notes: i?.notes.length ?? 0, marks: i?.marks.length ?? 0 };
}

export { inLayer };

/** Click an ink bar button inside the viewer frame. The frame fills the tab, so its points are the page's. */
export async function frameBarClick(page: Page, v: Frame, label: string): Promise<void> {
  const { layerPoint } = await import('./fixtures');
  const hidden = await inLayer(v, (root) => !!root.querySelector('.iu.hid'));
  if (hidden) {
    const h = await layerPoint(v, '.iu button.hdl');
    if (h) await page.mouse.click(h.x, h.y);
  }
  const p = await layerPoint(v, `.iu button[aria-label="${label}"]`);
  if (!p) throw new Error(`no bar button ${label}`);
  await page.mouse.click(p.x, p.y);
}
