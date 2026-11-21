/**
 * The PDF viewer: links in the PDF, print with each page's own size, print
 * from the browser's menu, and the bar in dark mode.
 */
import type { Page } from '@playwright/test';
import { barClick, expect, inLayer, test } from './fixtures';
import { ready, showPage, viewerOf } from './pdf-kit';
import { makePdf, paperPages } from './pdfs';

const LINKED = makePdf({
  pages: paperPages(4, 'linked'),
  title: 'Linked paper',
  id: '0123456789abcdef0123456789abcdef',
  // Page 2 is A4 landscape, the rest US Letter.
  sizes: { 1: { w: 842, h: 595 } },
  links: [
    { page: 0, rect: [72, 600, 300, 620], to: { page: 2, y: 400 } },
    { page: 0, rect: [72, 560, 300, 580], uri: 'https://example.org/paper' },
    { page: 0, rect: [72, 520, 300, 540], uri: 'javascript:alert(1)' },
  ],
});

async function openLinked(page: Page, extId: string) {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed++;
    };
  });
  await page.goto(`chrome-extension://${extId}/pdf.html`);
  await page
    .locator('#file')
    .setInputFiles({ name: 'linked.pdf', mimeType: 'application/pdf', buffer: LINKED });
  const v = await viewerOf(page);
  await ready(v);
  return v;
}

/** Page sizes in points from the MediaBox entries of a PDF the browser wrote. */
function mediaBoxes(pdf: Buffer): string[] {
  return [...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map(
    (m) => `${Math.round(Number(m[1]))}x${Math.round(Number(m[2]))}`,
  );
}

test('links in a PDF: web links open in a new tab, links inside the document scroll to their page', async ({
  context,
  extId,
}) => {
  const page = await context.newPage();
  const requests: string[] = [];
  context.on('request', (r) => requests.push(r.url()));
  const v = await openLinked(page, extId);
  await expect(v.locator('#ink-pdf-page-1 .linkLayer a')).toHaveCount(2);
  const web = v.locator('#ink-pdf-page-1 .linkLayer a[target="_blank"]');
  await expect(web).toHaveAttribute('href', 'https://example.org/paper');
  await expect(web).toHaveAttribute('rel', /noopener/);
  // The unsafe address in the file is not a link at all.
  expect(await v.locator('a[href^="javascript:"]').count()).toBe(0);
  // The link areas sit over the page; the layer itself lets the pen and mouse through.
  expect(
    await v.locator('#ink-pdf-page-1 .linkLayer').evaluate((el) => getComputedStyle(el).pointerEvents),
  ).toBe('none');

  await v.locator('#ink-pdf-page-1 .linkLayer a[href="#ink-pdf-page-3"]').click();
  await expect(v.locator('#page')).toHaveValue('3');
  expect(requests.filter((u) => u.includes('example.org'))).toEqual([]);
});

test('print gives each sheet the size of its own page, and the browser menu prints the same way', async ({
  context,
  extId,
}) => {
  const page = await context.newPage();
  const v = await openLinked(page, extId);
  await barClick(page, 'More');
  await barClick(page, 'Print');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed))
    .toBe(1);
  await expect(page.locator('img.print-page')).toHaveCount(4);
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  expect(mediaBoxes(pdf)).toEqual(['612x792', '842x595', '612x792', '612x792']);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('html')).not.toHaveClass(/printing/);

  // The browser's menu: beforeprint lays the pages out and copies the drawn ones.
  await showPage(v, 1);
  const zoom = await page.locator('#zoom').textContent();
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await expect(page.locator('html')).toHaveClass(/printing/);
  expect(await page.locator('canvas.print-page').count()).toBeGreaterThan(0);
  const menuPdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  expect(mediaBoxes(menuPdf)).toEqual(['612x792', '842x595', '612x792', '612x792']);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('html')).not.toHaveClass(/printing/);
  await expect(page.locator('.print-page')).toHaveCount(0);
  await expect(page.locator('#zoom')).toHaveText(zoom ?? '');
});

test('dark mode: the viewer chrome and the ink bar are dark, the ink keeps its light page colours', async ({
  context,
  extId,
}) => {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'dark' });
  const v = await openLinked(page, extId);
  const bar = await v.locator('#bar').evaluate((el) => getComputedStyle(el).backgroundColor);
  const dark = (c: string) => {
    const [r, g, b] = (c.match(/[\d.]+/g) ?? []).map(Number);
    return (r ?? 255) + (g ?? 255) + (b ?? 255) < 200;
  };
  expect(dark(bar)).toBe(true);
  const look = await inLayer(v, (root) => ({
    ink: (root.host as HTMLElement).dataset.theme,
    bar: root.querySelector('.iu')?.getAttribute('data-theme'),
    bg: getComputedStyle(root.querySelector('.iu .bar')!).backgroundColor,
  }));
  expect(look?.ink).toBe('light');
  expect(look?.bar).toBe('dark');
  expect(dark(look?.bg ?? '')).toBe(true);
});
