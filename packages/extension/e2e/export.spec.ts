import { readFileSync } from 'node:fs';
import {
  allNotes,
  barClick,
  centre,
  expect,
  inkCentroid,
  layerInfo,
  ring,
  stroke,
  test,
  textBox,
} from './fixtures';

test('save as image, notes as Markdown, and copy for chat', async ({ context, origin, ext }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: origin.a });
  const page = await context.newPage();
  await page.goto(`${origin.a}/article.html`);
  const w = (await textBox(page, 'pomegranate'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);
  const ink = (await layerInfo(page))!.notes[0]!.box;

  // The picture of the visible tab comes through captureVisible, with the ink on it.
  await barClick(page, 'More');
  const [img] = await Promise.all([page.waitForEvent('download'), barClick(page, 'Save as image')]);
  expect(img.suggestedFilename()).toMatch(/^article-page-\d{4}-\d\d-\d\d\.png$/);
  const png = readFileSync((await img.path())!);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  const seen = await inkCentroid(
    ext,
    png,
    { x: ink.x - 2, y: ink.y - 2, w: ink.w + 4, h: ink.h + 4 },
    {
      r: 0x1f,
      g: 0x2a,
      b: 0x44,
      tol: 40,
    },
  );
  expect(seen?.n ?? 0).toBeGreaterThan(30);

  await barClick(page, 'More');
  const [md] = await Promise.all([page.waitForEvent('download'), barClick(page, 'Save notes as Markdown')]);
  expect(md.suggestedFilename()).toBe('article-page-notes.md');
  const text = readFileSync((await md.path())!, 'utf8');
  expect(text).toContain('Article page');
  expect(text).toContain('pomegranate');

  await page.bringToFront();
  await barClick(page, 'More');
  await barClick(page, 'Copy for chat');
  const clip = await expect
    .poll(async () =>
      page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const types = items.flatMap((i) => i.types);
        const t = items.find((i) => i.types.includes('text/plain'));
        const text = t ? await (await t.getType('text/plain')).text() : '';
        const p = items.find((i) => i.types.includes('image/png'));
        const size = p ? (await p.getType('image/png')).size : 0;
        return {
          types: types.sort(),
          hasTitle: text.includes('Article page'),
          hasText: text.includes('Iron gall'),
          size,
        };
      }),
    )
    .toMatchObject({ types: ['image/png', 'text/plain'], hasTitle: true, hasText: true });
  void clip;
});

test('a note on a blank page keeps a thumbnail of at most 8 KB', async ({ context, origin, ext }) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/blank.html`);
  // Only the tab in front gets a picture of itself, as for a reader who is writing. This page is
  // in front: the first-run guide's tab opened before it (launch in fixtures.ts waits for that).
  await stroke(page, ring({ x: 400, y: 300 }, 80, 50));
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);
  await expect.poll(async () => (await allNotes(ext))[0]?.thumb ?? '').toMatch(/^data:image\//);
  const n = (await allNotes(ext))[0]!;
  console.log(`blank page note: anchor ${n.anchor.type}, thumbnail ${n.thumb!.length} characters`);
  expect(n.anchor.type).toBe('viewport');
  expect(n.thumb!.length).toBeLessThanOrEqual(8 * 1024);
});
