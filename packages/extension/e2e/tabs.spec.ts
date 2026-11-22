import type { Page } from '@playwright/test';
import { pageKeyOf } from 'pageink-core/hash';
import {
  allNotes,
  centre,
  expect,
  layerInfo,
  readStorage,
  ring,
  stroke,
  tabId,
  test,
  textBox,
} from './fixtures';

const circle = async (page: Page, word: string) => {
  const w = (await textBox(page, word))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
};
const strokes = (r: unknown) =>
  ((r as { notes?: { strokes: unknown[] }[] } | undefined)?.notes ?? []).reduce(
    (k, n) => k + n.strokes.length,
    0,
  );

test('two tabs on one page: a stroke in one shows in the other, and none is lost when both write', async ({
  context,
  origin,
  ext,
}) => {
  const url = `${origin.a}/article.html`;
  const a = await context.newPage();
  await a.goto(url);
  await circle(a, 'pomegranate');
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);
  const b = await context.newPage();
  await b.goto(url);
  await expect.poll(async () => (await layerInfo(b))?.notes.length).toBe(1);

  await circle(a, 'Borrowdale');
  await expect.poll(async () => (await layerInfo(b))?.notes.length).toBe(2);

  // Both write at the same moment, several times.
  const words = [
    ['centuries', 'thousand'],
    ['broad nib', 'Pencils came'],
    ['rags', 'standard'],
  ];
  for (const [wa, wb] of words) await Promise.all([circle(a, wa!), circle(b, wb!)]);
  const key = pageKeyOf(url);
  await expect.poll(async () => strokes((await readStorage(ext, [key]))[key])).toBe(8);
  await expect.poll(async () => (await layerInfo(a))?.notes.reduce((k, n) => k + n.strokes, 0)).toBe(8);
  await expect.poll(async () => (await layerInfo(b))?.notes.reduce((k, n) => k + n.strokes, 0)).toBe(8);
  void tabId;
});
