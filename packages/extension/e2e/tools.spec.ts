import type { Page } from '@playwright/test';
import {
  allNotes,
  barClick,
  centre,
  expect,
  layerInfo,
  line,
  ring,
  shotPath,
  stroke,
  tap,
  test,
  textBox,
} from './fixtures';

const PHRASE = 'Graphite from Borrowdale was so pure that it could';

/** How many lines PHRASE takes on the page. */
function phraseLines(page: Page): Promise<number> {
  return page.evaluate((t) => {
    const p = [...document.querySelectorAll('p')].find((e) => e.textContent?.includes(t))!;
    const node = p.firstChild!;
    const i = node.textContent!.indexOf(t);
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + t.length);
    return new Set([...r.getClientRects()].map((c) => Math.round(c.top))).size;
  }, PHRASE);
}

test('a highlighter line becomes a text mark that rewraps with the text', async ({
  context,
  origin,
  ext,
}) => {
  const page = await context.newPage();
  // Wide enough, whatever the font, that the phrase sits on the first line of its paragraph.
  await page.setViewportSize({ width: 1600, height: 800 });
  await page.goto(`${origin.a}/article.html`);
  await page.addStyleTag({ content: 'main{max-width:none}' });
  expect(await phraseLines(page)).toBe(1);
  const b = (await textBox(page, PHRASE))!;
  // A first pen touch loads the tools (a tap on a control leaves no ink); then pick the highlighter.
  const btn = (await page.locator('#btn').boundingBox())!;
  await tap(page, { x: btn.x + 10, y: btn.y + 10 });
  await expect.poll(async () => !!(await layerInfo(page))?.bar).toBe(true);
  await barClick(page, 'Highlighter');
  await expect.poll(async () => (await layerInfo(page))?.bar?.tool).toBe('Highlighter');
  const y = b.y + b.h / 2;
  await stroke(page, line({ x: b.x + 2, y }, { x: b.x + b.w - 2, y }, 6));

  await expect.poll(async () => (await allNotes(ext)).map((n) => n.kind)).toEqual(['textmark']);
  const n = (await allNotes(ext))[0]!;
  expect(n.mark?.style).toBe('highlight');
  expect(n.anchor.quote.exact).toContain('Borrowdale');
  expect(n.strokes).toHaveLength(0);
  const wide = (await layerInfo(page))!.marks[0]!.box;
  expect(wide.h).toBeLessThan(b.h * 1.6);
  await page.screenshot({ path: shotPath('mark-wide') });

  // A column narrower than the phrase cannot hold it on one line: the mark covers two lines now.
  // The body has 40 px of padding on each side.
  await page.setViewportSize({ width: 80 + Math.floor(b.w * 0.6), height: 800 });
  expect(await phraseLines(page)).toBeGreaterThan(1);
  await expect.poll(async () => (await layerInfo(page))?.marks[0]?.box.h ?? 0).toBeGreaterThan(wide.h * 1.6);
  await page.screenshot({ path: shotPath('mark-narrow') });
});

test('eraser, undo, redo and lasso move', async ({ context, origin, ext }) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/article.html`);
  const w = (await textBox(page, 'Borrowdale'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);
  const first = (await allNotes(ext))[0]!;

  // Eraser across the circle removes the stroke and its note.
  await barClick(page, 'Eraser');
  await stroke(page, line({ x: w.x - 20, y: w.y - 6 }, { x: w.x + w.w + 20, y: w.y + w.h + 6 }, 4));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(0);
  await expect.poll(async () => (await allNotes(ext)).length).toBe(0);

  await barClick(page, 'Undo');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);
  await barClick(page, 'Redo');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(0);
  await barClick(page, 'Undo');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  const back = (await allNotes(ext))[0]!;
  expect(back.strokes).toHaveLength(first.strokes.length);

  // Lasso around the note, then drag it onto another paragraph.
  await barClick(page, 'Lasso');
  const box = (await layerInfo(page))!.notes[0]!.box;
  await stroke(page, ring(centre(box), box.w / 2 + 24, box.h / 2 + 24, 32));
  const target = (await textBox(page, 'centuries'))!;
  const from = centre(box);
  const to = centre(target);
  await stroke(page, line(from, to, 8));
  await expect
    .poll(async () => {
      const b = (await layerInfo(page))?.notes[0]?.box;
      return b ? Math.hypot(centre(b).x - to.x, centre(b).y - to.y) : 999;
    })
    .toBeLessThan(6);
  await expect
    .poll(async () => (await allNotes(ext)).map((n) => n.anchor.quote.exact).join('|'))
    .toContain('centuries');
  // The move wrote a copy under a new id and dropped the old one.
  const moved = await allNotes(ext);
  expect(moved).toHaveLength(1);
  expect(moved[0]!.id).not.toBe(back.id);

  await page.reload();
  await expect
    .poll(async () => {
      const b = (await layerInfo(page))?.notes[0]?.box;
      const t = await textBox(page, 'centuries');
      return b && t ? Math.hypot(centre(b).x - centre(t).x, centre(b).y - centre(t).y) : 999;
    })
    .toBeLessThan(6);
});

test('a pen tap still works the page controls', async ({ context, origin }) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/article.html`);
  // Write once so the tools own pen input, as they would on a page in use.
  const w = (await textBox(page, 'Pencils came later'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 6, w.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);

  const at = async (sel: string) => {
    const b = (await page.locator(sel).boundingBox())!;
    return { x: b.x + Math.min(20, b.width / 2), y: b.y + b.height / 2 };
  };
  await tap(page, await at('#btn'));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { hits: { btn: number } }).hits.btn))
    .toBe(1);
  await tap(page, await at('#link'));
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#linked');
  await tap(page, await at('#txt'));
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('txt');
  await page.keyboard.type('pen');
  await expect(page.locator('#txt')).toHaveValue('pen');
  await tap(page, await at('#ce'));
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('ce');
  await tap(page, await at('#sel'));
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('sel');
  await page.keyboard.press('Escape');
  // No ink was left by any of the taps.
  expect((await layerInfo(page))?.notes.length).toBe(1);
});
