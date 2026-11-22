/**
 * Ink written in a margin, then seen on a phone-width window: it docks or folds into a marker,
 * never on the words, and returns to where it was written when the window is wide again.
 */
import { allNotes, type Box, expect, inLayer, line, type Pt, stroke, tap, test, textBox } from './fixtures';

/** Client boxes of what the layer shows: ink notes that are painted, and markers. */
const shown = (page: import('@playwright/test').Page) =>
  inLayer(page, (root) => {
    const out: { id: string; box: { x: number; y: number; w: number; h: number }; marker: boolean }[] = [];
    for (const g of root.querySelectorAll<SVGGElement>('g[data-note]')) {
      const r = g.getBoundingClientRect();
      if (r.width > 0 && g.querySelector('path[data-stroke]'))
        out.push({
          id: g.dataset.note ?? '',
          box: { x: r.left, y: r.top, w: r.width, h: r.height },
          marker: false,
        });
    }
    for (const b of root.querySelectorAll<HTMLElement>('button.dk')) {
      const r = b.getBoundingClientRect();
      if (r.width > 0)
        out.push({
          id: b.dataset.note ?? '',
          box: { x: r.left, y: r.top, w: r.width, h: r.height },
          marker: true,
        });
    }
    return out;
  });

/** Client boxes of every piece of text on the page. */
const words = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const out: { x: number; y: number; w: number; h: number }[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (!/\S/.test(t.nodeValue ?? '') || t.parentElement?.closest('script,style')) continue;
      r.selectNodeContents(t);
      for (const c of r.getClientRects())
        if (c.width > 0.5) out.push({ x: c.left, y: c.top, w: c.width, h: c.height });
    }
    return out;
  });

const meets = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A star: five points, drawn in one stroke. */
const star = (c: Pt, r: number): Pt[] =>
  Array.from({ length: 6 }, (_, i) => {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
  }).flatMap((p, i, all) => (i ? line(all[i - 1]!, p, 3).slice(1) : [p]));

test('margin ink on a phone-width window docks off the words, folds when there is no room, and comes back', async ({
  context,
  origin,
  ext,
}) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin.a}/article.html`);
  // The right margin beside the second paragraph: a "yes!" and a star with an arrow.
  const p2 = (await textBox(page, 'Iron gall'))!;
  const x0 = 800;
  const y0 = p2.y + 4;
  await stroke(page, line({ x: x0, y: y0 }, { x: x0 + 50, y: y0 + 16 }));
  // The second stroke of the same note: close to the first on the input clock, however busy the machine.
  await stroke(page, line({ x: x0 + 50, y: y0 + 16 }, { x: x0 + 70, y: y0 }), { after: 200 });
  // Past the grouping gap of 1.5 s, so the star starts a note of its own.
  await page.waitForTimeout(1700);
  await stroke(page, [
    ...star({ x: x0 + 20, y: y0 + 70 }, 14),
    ...line({ x: x0, y: y0 + 70 }, { x: x0 - 30, y: y0 + 60 }),
  ]);
  await expect.poll(async () => (await shown(page))?.length).toBe(2);
  const wide = (await shown(page))!;
  expect(wide.every((n) => !n.marker)).toBe(true);
  // The saves have landed before the window changes.
  await expect.poll(async () => (await allNotes(ext)).length).toBe(2);

  await page.setViewportSize({ width: 390, height: 844 });
  // Laid out again for the narrow window: before that, the notes sit where they were, off
  // screen and off the words, so the window's width is part of the wait.
  const vw = 390 - (await page.evaluate(() => innerWidth - document.documentElement.clientWidth));
  await expect
    .poll(async () => {
      const now = (await shown(page)) ?? [];
      const text = await words(page);
      // Every note is shown, as ink or as a marker, on screen, and none of it is on a word.
      return (
        now.length === 2 &&
        now.every((n) => n.box.x >= -0.5 && n.box.x + n.box.w <= vw + 0.5) &&
        now.every((n) => !text.some((w) => meets(n.box, w)))
      );
    })
    .toBe(true);
  const narrow = (await shown(page))!;
  for (const n of narrow) {
    expect(n.box.x).toBeGreaterThanOrEqual(-0.5);
    expect(n.box.x + n.box.w).toBeLessThanOrEqual(vw + 0.5);
  }
  expect(meets(narrow[0]!.box, narrow[1]!.box)).toBe(false);

  // A folded note opens with a tap and closes with a tap elsewhere.
  const mk = narrow.find((n) => n.marker);
  if (mk) {
    const open = () =>
      inLayer(page, (root) => {
        const p = root.querySelector<HTMLElement>('.pop');
        return !!p && !p.hidden && p.getBoundingClientRect().width > 40;
      });
    await page.mouse.click(mk.box.x + mk.box.w / 2, mk.box.y + mk.box.h / 2);
    await expect.poll(open).toBe(true);
    await tap(page, { x: 200, y: 780 }, 'mouse');
    await expect.poll(open).toBe(false);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect
    .poll(async () => {
      const now = (await shown(page)) ?? [];
      return (
        now.length === 2 &&
        wide.every((w) => {
          const b = now.find((n) => n.id === w.id && !n.marker)?.box;
          return (
            !!b && Math.abs(b.x - w.box.x) < 1 && Math.abs(b.y - w.box.y) < 1 && Math.abs(b.w - w.box.w) < 1
          );
        })
      );
    })
    .toBe(true);
});
