/**
 * Ink in a section that closes: it hides with the section, raises no badge or marker, and
 * comes back when the section opens, also after a reload with the section closed.
 */
import { allNotes, centre, expect, inLayer, layerInfo, ring, stroke, test, textBox } from './fixtures';

const markers = (page: import('@playwright/test').Page) =>
  inLayer(page, (root) => root.querySelectorAll('.mks .mk').length);

test('a note in a closed <details> hides with it and returns when it opens', async ({
  context,
  origin,
  ext,
}) => {
  const url = `${origin.a}/collapse.html`;
  const page = await context.newPage();
  await page.goto(url);
  const word = (await textBox(page, 'marigold'))!;
  await stroke(page, ring(centre(word), word.w / 2 + 8, word.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  // A second note, on a paragraph the reload below deletes: it is missing, not hidden.
  const bird = (await textBox(page, 'Blackbirds'))!;
  await stroke(page, ring(centre(bird), bird.w / 2 + 8, bird.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  // The saves have landed before the section closes.
  await expect.poll(async () => (await allNotes(ext)).length).toBe(2);

  await page.evaluate(() => {
    (document.getElementById('d') as HTMLDetailsElement).open = false;
  });
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);

  // A reload with the section closed and the other paragraph gone. Once the page settles the
  // missing note raises the badge and a marker. The hidden note adds to neither, since it is
  // hidden with its content, not missing.
  await page.goto(`${url}#closed-gone`);
  await page.reload();
  await expect.poll(async () => (await layerInfo(page))?.badge).toEqual({ hidden: false, text: '1' });
  const info = (await layerInfo(page))!;
  expect(info.notes).toEqual([]);
  expect(await markers(page)).toBe(1);

  // Opening the section brings its ink back. Its spot is checked by pageink-core's collapse tests.
  await page.evaluate(() => {
    (document.getElementById('d') as HTMLDetailsElement).open = true;
  });
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
});
