import { hashKey, idxKey, pageKeyOf } from 'pageink-core/hash';
import {
  allNotes,
  type Box,
  centre,
  expect,
  inkCentroid,
  layerInfo,
  line,
  readStorage,
  ring,
  shotPath,
  stroke,
  test,
  textBox,
} from './fixtures';

const WORD = 'pomegranate';

/** Ink box and word box, relative: where the ink sits on its word. */
const rel = (ink: Box, word: Box) => ({ dx: ink.x - word.x, dy: ink.y - word.y });

test('a pen writes with no toggle, the record is stored, and the ink comes back on its words', async ({
  context,
  origin,
  ext,
}) => {
  const url = `${origin.a}/article.html`;
  const page = await context.newPage();
  await page.goto(url);
  const word = (await textBox(page, WORD))!;
  // A circle around the word, with the pen and no toggle.
  await stroke(page, ring(centre(word), word.w / 2 + 10, word.h / 2 + 8));
  await expect.poll(async () => (await layerInfo(page))?.notes.length ?? 0).toBe(1);

  // Stored under p:<hash of key> and indexed under idx:<hash of host>.
  const key = pageKeyOf(url);
  await expect.poll(async () => Object.keys(await readStorage(ext, [key]))).toEqual([key]);
  const all = await readStorage(ext);
  const rec = all[key] as { key: string; notes: { anchor: { type: string; quote: { exact: string } } }[] };
  expect(rec.key).toBe(url);
  expect(rec.notes).toHaveLength(1);
  expect(rec.notes[0]!.anchor.type).toBe('text');
  expect(rec.notes[0]!.anchor.quote.exact).toContain(WORD);
  expect((all[idxKey('localhost')] as { m: Record<string, string> }).m[hashKey(url)]).toBe(hashKey(url));

  const before = (await layerInfo(page))!.notes[0]!.box;
  const offset1 = rel(before, word);

  await page.reload();
  await expect.poll(async () => (await layerInfo(page))?.notes.length ?? 0).toBe(1);
  const after = (await layerInfo(page))!.notes[0]!.box;
  const word2 = (await textBox(page, WORD))!;
  const offset2 = rel(after, word2);
  expect(Math.abs(offset2.dx - offset1.dx)).toBeLessThan(2);
  expect(Math.abs(offset2.dy - offset1.dy)).toBeLessThan(2);
  // The pixels are read after the reload: the one-time hint beside the first ink has gone, and
  // with some fonts it would sit over the ring.
  const shot1 = await page.screenshot({ path: shotPath('article-before') });

  // Narrower: the word moves to another line and the ink follows it.
  await page.setViewportSize({ width: 560, height: 800 });
  const word3 = (await textBox(page, WORD))!;
  expect(Math.abs(word3.y - word2.y) + Math.abs(word3.x - word2.x)).toBeGreaterThan(20);
  await expect
    .poll(async () => {
      const b = (await layerInfo(page))?.notes[0]?.box;
      if (!b) return 99;
      const o = rel(b, word3);
      return Math.abs(o.dx - offset1.dx) + Math.abs(o.dy - offset1.dy);
    })
    .toBeLessThan(3);
  const shot2 = await page.screenshot({ path: shotPath('article-narrow') });

  // The same check on pixels: the dark ink around the word, in both screenshots.
  const pad = (b: Box, p: number) => ({ x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p });
  const ink = { r: 0x1f, g: 0x2a, b: 0x44, tol: 40 };
  const c1 = await inkCentroid(ext, shot1, pad(after, 2), ink);
  const box3 = (await layerInfo(page))!.notes[0]!.box;
  const c2 = await inkCentroid(ext, shot2, pad(box3, 2), ink);
  expect(c1 && c2).toBeTruthy();
  expect(c1!.n).toBeGreaterThan(30);
  const w1 = centre(word2);
  const w3 = centre(word3);
  expect(Math.abs(c1!.x - w1.x - (c2!.x - w3.x))).toBeLessThan(3);
  expect(Math.abs(c1!.y - w1.y - (c2!.y - w3.y))).toBeLessThan(3);
});

test('a stroke survives a reload or a closed tab right after it is written', async ({
  context,
  origin,
  ext,
}) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/article.html`);
  const w = (await textBox(page, WORD))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  await page.reload();
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);

  const w2 = (await textBox(page, 'Borrowdale'))!;
  await stroke(page, ring(centre(w2), w2.w / 2 + 8, w2.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  await page.close();
  await expect.poll(async () => (await allNotes(ext)).length).toBe(2);
});

test('the first pen stroke on a page without ink is kept whole while the tools load', async ({
  context,
  origin,
}) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/blank.html`);
  // No delay between samples: most of the line arrives before the tools are in.
  await stroke(page, line({ x: 100, y: 300 }, { x: 700, y: 300 }, 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  const b = (await layerInfo(page))!.notes[0]!.box;
  expect(b.x).toBeLessThan(102);
  expect(b.x + b.w).toBeGreaterThan(698);
});
