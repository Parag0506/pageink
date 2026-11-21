import type { Frame, Page } from '@playwright/test';
import { pageKeyOf } from 'pageink-core/hash';
import {
  centre,
  expect,
  type InkNote,
  inkState,
  layerInfo,
  readStorage,
  ring,
  shotPath,
  stroke,
  stubDone,
  tabId,
  test,
  textBox,
} from './fixtures';

// started() reads the viewer's mark, which only the bench build has.
test.use({ build: 'bench' });

const frameOf = (page: Page, part: string): Frame => page.frames().find((f) => f.url().includes(part))!;
const started = (f: Frame | Page) =>
  f.evaluate(() => performance.getEntriesByName('ink:view-start').length > 0);

/** Circle a word inside a frame, with page coordinates. */
async function circleIn(page: Page, frameSel: string, f: Frame, word: string) {
  const fb = (await page.locator(frameSel).boundingBox())!;
  const w = (await textBox(f, word))!;
  const c = centre(w);
  // Frame content starts inside the border.
  await stroke(page, ring({ x: fb.x + 1 + c.x, y: fb.y + 1 + c.y }, w.w / 2 + 8, w.h / 2 + 6));
}

test('writing in same-origin and cross-origin frames stores under the top page, and comes back in the frames', async ({
  context,
  origin,
  ext,
}) => {
  const top = `${origin.a}/frames.html?cross=${encodeURIComponent(`${origin.b}/child.html`)}`;
  const page = await context.newPage();
  await page.goto(top);
  const same = frameOf(page, `${origin.a}/child.html`);
  const cross = frameOf(page, `${origin.b}/child.html`);
  await stubDone(same);
  await stubDone(cross);
  // Nothing is loaded in any frame before the pen.
  expect(await started(page)).toBe(false);
  expect(await started(same)).toBe(false);

  await circleIn(page, '#same', same, 'Marginalia');
  await expect.poll(async () => (await layerInfo(same))?.notes.length ?? 0).toBe(1);
  // The circle is only as tall as the circle: no stray samples from the top page's coordinates.
  const word = (await textBox(same, 'Marginalia'))!;
  expect((await layerInfo(same))!.notes[0]!.box.h).toBeLessThan(word.h + 24);
  await circleIn(page, '#cross', cross, 'Marginalia');
  await expect.poll(async () => (await layerInfo(cross))?.notes.length ?? 0).toBe(1);

  // Both notes live in the top page's record, each with its frame.
  const key = pageKeyOf(top);
  await expect
    .poll(
      async () =>
        ((await readStorage(ext, [key]))[key] as { notes: InkNote[] } | undefined)?.notes.length ?? 0,
    )
    .toBe(2);
  const rec = (await readStorage(ext, [key]))[key] as { key: string; notes: InkNote[] };
  expect(rec.key).toBe(top);
  expect(rec.notes.map((n) => n.anchor.frame?.url).sort()).toEqual(
    [`${origin.a}/child.html`, `${origin.b}/child.html`].sort(),
  );
  expect(rec.notes.every((n) => n.anchor.quote.exact.includes('Marginalia'))).toBe(true);
  // The top page itself shows none of them.
  expect((await layerInfo(page))?.notes.length ?? 0).toBe(0);

  const where = async (f: Frame) => {
    const n = (await layerInfo(f))?.notes[0]?.box;
    const w = await textBox(f, 'Marginalia');
    return n && w ? { dx: n.x - w.x, dy: n.y - w.y } : null;
  };
  const before = { same: await where(same), cross: await where(cross) };

  await page.reload();
  const same2 = frameOf(page, `${origin.a}/child.html`);
  const cross2 = frameOf(page, `${origin.b}/child.html`);
  await expect.poll(async () => (await layerInfo(same2))?.notes.length ?? 0).toBe(1);
  await expect.poll(async () => (await layerInfo(cross2))?.notes.length ?? 0).toBe(1);
  // The frames were woken by the top page; the probe used in the next test sees that.
  expect(await started(same2)).toBe(true);
  expect(await started(cross2)).toBe(true);
  const after = { same: await where(same2), cross: await where(cross2) };
  for (const k of ['same', 'cross'] as const) {
    expect(Math.abs(after[k]!.dx - before[k]!.dx)).toBeLessThan(2);
    expect(Math.abs(after[k]!.dy - before[k]!.dy)).toBeLessThan(2);
  }
  await page.screenshot({ path: shotPath('frames') });
});

test('the top page wakes its frames only when its record has frame notes', async ({
  context,
  origin,
  ext,
  sw,
}) => {
  const top = `${origin.a}/frames.html?cross=${encodeURIComponent(`${origin.b}/child.html`)}`;
  const page = await context.newPage();
  await page.goto(top);
  // Ink on the top page only.
  const w = (await textBox(page, 'come from'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length ?? 0).toBe(1);
  const key = pageKeyOf(top);
  await expect.poll(async () => !!(await readStorage(ext, [key]))[key]).toBe(true);

  await page.reload();
  await expect.poll(async () => (await layerInfo(page))?.notes.length ?? 0).toBe(1);
  // The top viewer decides at its start, and sends any wake before its stub can answer.
  const tab = await tabId(ext, `${origin.a}/frames.html*`);
  await expect.poll(async () => (await inkState(ext, tab))?.loaded).toBe(true);
  // Asked through the worker, after the wake it would have passed on. A woken frame's answer
  // waits for the viewer it started, so it says loaded however slow that start is.
  const frames = await sw.evaluate(async (t) => {
    const all = await chrome.scripting.executeScript({
      target: { tabId: t, allFrames: true },
      func: () => 0,
    });
    const out: { frameId: number; loaded: boolean | null }[] = [];
    for (const r of all) {
      if (r.frameId === 0) continue;
      const s = (await chrome.tabs
        .sendMessage(t, { ink: 'state' }, { frameId: r.frameId })
        .catch(() => null)) as {
        loaded: boolean;
      } | null;
      out.push({ frameId: r.frameId, loaded: s ? s.loaded : null });
    }
    return out;
  }, tab);
  expect(frames).toHaveLength(2);
  for (const f of frames) expect(f.loaded).toBe(false);
  expect(await started(frameOf(page, `${origin.a}/child.html`))).toBe(false);
  expect(await started(frameOf(page, `${origin.b}/child.html`))).toBe(false);
});
