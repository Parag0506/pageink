/**
 * DESIGN 7.4 step 5: a note whose passage is gone shows at the same relative
 * height of the page, with its saved words, and opens the tray on itself.
 */
import { note, record, seed } from '../src/testing/records';
import { expect, inLayer, layerInfo, layerPoint, seedStorage, test } from './fixtures';

test('a moved note shows a marker at its height on the page edge that opens the tray on it', async ({
  context,
  origin,
  ext,
}) => {
  const url = `${origin.a}/article.html`;
  const gone = note('gone', 'a passage that left the page');
  gone.anchor.frac = { x: 0.5, y: 0.4 };
  await seedStorage(ext, seed(record(url, [gone])));
  const page = await context.newPage();
  await page.goto(url);
  await expect.poll(async () => (await layerInfo(page))?.notes.length ?? -1).toBe(0);
  // The marker waits until the page has settled, like the badge.
  await expect.poll(() => inLayer(page, (root) => root.querySelectorAll('.mks .mk').length)).toBe(1);

  const m = (await inLayer(page, (root) => {
    const b = root.querySelector<HTMLButtonElement>('.mks .mk')!;
    const r = b.getBoundingClientRect();
    const html = document.documentElement;
    return {
      title: b.title,
      mid: r.top + r.height / 2 + scrollY,
      right: r.right,
      w: r.width,
      want: 0.4 * html.scrollHeight,
      edge: html.clientWidth,
    };
  }))!;
  expect(m.title).toContain('a passage that left the page');
  expect(Math.abs(m.mid - m.want)).toBeLessThan(2);
  expect(m.edge - m.right).toBeLessThan(4);
  expect(m.w).toBeLessThanOrEqual(12);

  // The page under the marker's column stays clickable everywhere else.
  await page.evaluate((y) => window.scrollTo(0, y - 300), m.mid);
  const p = (await layerPoint(page, '.mks .mk'))!;
  const under = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y! + 30)?.localName,
    [p.x, p.y],
  );
  expect(under).not.toBe('ink-layer');
  await page.mouse.click(p.x, p.y);
  await expect
    .poll(() =>
      inLayer(page, (root) => ({
        open: root.querySelector<HTMLElement>('.iu .tray')?.hidden === false,
        on: root.querySelector('.iu li[data-on]')?.textContent ?? '',
      })),
    )
    .toEqual({ open: true, on: expect.stringContaining('a passage that left the page') });
});
