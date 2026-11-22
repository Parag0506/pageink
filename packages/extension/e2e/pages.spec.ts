import type { Page } from '@playwright/test';
import { pageKeyOf } from 'pageink-core/hash';
import {
  type Box,
  centre,
  expect,
  type InkNote,
  layerInfo,
  layerPoint,
  readStorage,
  records,
  ring,
  shotPath,
  stroke,
  test,
  textBox,
} from './fixtures';

const circle = async (page: Page, word: string) => {
  const w = (await textBox(page, word))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
};
/** Offset from a word to the ink around it: the note whose box holds the word's centre. */
const offsetAround = async (page: Page, word: string) => {
  const w = await textBox(page, word);
  if (!w) return null;
  const c = centre(w);
  const n = (await layerInfo(page))?.notes.find(
    (x) => x.box.x <= c.x && c.x <= x.box.x + x.box.w && x.box.y <= c.y && c.y <= x.box.y + x.box.h,
  )?.box;
  return n ? { dx: n.x - w.x, dy: n.y - w.y } : null;
};
const offsetOn = async (page: Page, i: number, word: string) => {
  const n = (await layerInfo(page))?.notes[i]?.box;
  const w = await textBox(page, word);
  return n && w ? { dx: n.x - w.x, dy: n.y - w.y } : null;
};

test('shadow DOM: text in open and closed roots is anchored and found again', async ({
  context,
  origin,
  ext,
}) => {
  const url = `${origin.a}/shadow.html`;
  const page = await context.newPage();
  await page.goto(url);
  await circle(page, 'lighthouses');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  await page.waitForTimeout(1700);
  await circle(page, 'glaciers');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  const key = pageKeyOf(url);
  await expect
    .poll(
      async () => ((await readStorage(ext, [key]))[key] as { notes: InkNote[] } | undefined)?.notes.length,
    )
    .toBe(2);
  const notes = ((await readStorage(ext, [key]))[key] as { notes: InkNote[] }).notes;
  const byWord = (w: string) => notes.find((n) => n.anchor.quote.exact.includes(w));
  expect(byWord('lighthouses')?.anchor.type).toBe('text');
  // Closed roots are read through the extension-only accessor.
  expect(byWord('glaciers')?.anchor.type).toBe('text');

  const ids = (await layerInfo(page))!.notes.map((n) => n.id);
  const o1 = await Promise.all(['lighthouses', 'glaciers'].map((w, i) => offsetOn(page, i, w)));
  await page.reload();
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  expect((await layerInfo(page))!.notes.map((n) => n.id)).toEqual(ids);
  const o2 = await Promise.all(['lighthouses', 'glaciers'].map((w, i) => offsetOn(page, i, w)));
  for (let i = 0; i < 2; i++) {
    expect(Math.abs(o2[i]!.dx - o1[i]!.dx)).toBeLessThan(2);
    expect(Math.abs(o2[i]!.dy - o1[i]!.dy)).toBeLessThan(2);
  }
  // Content above the components grows: the notes follow their words.
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.textContent = 'An added paragraph that pushes everything down. '.repeat(6);
    document.querySelector('h1')!.after(p);
  });
  await expect
    .poll(async () => {
      const o = await offsetOn(page, 1, 'glaciers');
      return o ? Math.abs(o.dy - o1[1]!.dy) + Math.abs(o.dx - o1[1]!.dx) : 99;
    })
    .toBeLessThan(2);
  await page.screenshot({ path: shotPath('shadow') });
});

test('single-page app: each route has its own notes, they swap on navigation and return on back', async ({
  context,
  origin,
  ext,
}) => {
  const one = `${origin.a}/app/one`;
  const two = `${origin.a}/app/two`;
  const page = await context.newPage();
  await page.goto(one);
  await circle(page, 'Owls');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  const o1 = await offsetOn(page, 0, 'Owls');

  await page.click('a[href="/app/two"]');
  await expect(page.locator('#a')).toContainText('Bees');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(0);
  await circle(page, 'Bees');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  await expect
    .poll(async () =>
      Object.values(await records(ext))
        .map((r) => `${r.key}:${r.notes.length}`)
        .sort(),
    )
    .toEqual([`${one}:1`, `${two}:1`].sort());
  const quote = async (u: string) => (await records(ext))[pageKeyOf(u)]?.notes[0]?.anchor.quote.exact ?? '';
  expect(await quote(one)).toContain('Owls');
  expect(await quote(two)).toContain('Bees');

  await page.goBack();
  await expect(page.locator('#a')).toContainText('Owls');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  await expect
    .poll(async () => {
      const o = await offsetOn(page, 0, 'Owls');
      return o ? Math.abs(o.dx - o1!.dx) + Math.abs(o.dy - o1!.dy) : 99;
    })
    .toBeLessThan(2);
  await page.goForward();
  await expect(page.locator('#a')).toContainText('Bees');
  await expect
    .poll(async () => {
      const o = await offsetOn(page, 0, 'Bees');
      return o ? Math.abs(o.dx) + Math.abs(o.dy) : 99;
    })
    .toBeLessThan(40);
  // A full load of route two shows its note too.
  await page.goto(two);
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
});

test('late content: a note waits for its passage, raises no badge while the page settles, and attaches when it appears', async ({
  context,
  origin,
  ext,
}) => {
  const url = `${origin.a}/late.html`;
  const page = await context.newPage();
  await page.goto(url);
  await circle(page, 'Comets');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  // Past the grouping gap of 1.5 s, so the next ring starts a note of its own.
  await page.waitForTimeout(1700);
  await circle(page, 'closing paragraph');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  const key = pageKeyOf(url);
  await expect
    .poll(
      async () => ((await readStorage(ext, [key]))[key] as { notes: unknown[] } | undefined)?.notes.length,
    )
    .toBe(2);
  const o1 = await offsetAround(page, 'Comets');

  // The page counts as settled only after its load event. An image the test holds back keeps
  // that from coming, so the page is still settling for as long as the checks below take.
  let release = (): void => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/held.png', async (route) => {
    await held;
    await route.fulfill({ status: 204 });
  });
  await page.goto('about:blank');
  // The test adds the passage itself, so it is missing for as long as the checks take.
  await page.goto(`${url}#manual-hold`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as { fill?: unknown }).fill === 'function');
  expect(await page.locator('#late').count()).toBe(0);
  // The note on the closing paragraph is drawn, so a pass has run and found the other one
  // without its passage: no ink for it, and no badge while the page settles.
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  // No badge element yet, or one that is hidden.
  const early = (await layerInfo(page))!.badge;
  expect(early === null || early.hidden).toBe(true);
  // Once the load comes and the page settles, the badge offers the note.
  release();
  await expect.poll(async () => (await layerInfo(page))?.badge).toEqual({ hidden: false, text: '1' });

  await page.evaluate(() => (window as unknown as { fill: () => void }).fill());
  await page.locator('#late').waitFor();
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  await expect.poll(async () => (await layerInfo(page))?.badge?.hidden).toBe(true);
  const o2 = await offsetAround(page, 'Comets');
  expect(Math.abs(o2!.dx - o1!.dx) + Math.abs(o2!.dy - o1!.dy)).toBeLessThan(2);
});

test('a deleted passage puts the note in the tray, and Place re-anchors it with a tap', async ({
  context,
  origin,
  ext,
}) => {
  const url = `${origin.a}/late.html`;
  const page = await context.newPage();
  await page.goto(url);
  await circle(page, 'Comets');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  const key = pageKeyOf(url);
  await expect.poll(async () => !!(await readStorage(ext, [key]))[key]).toBe(true);
  const oldId = ((await readStorage(ext, [key]))[key] as { notes: InkNote[] }).notes[0]!.id;

  await page.goto('about:blank');
  await page.goto(`${url}#gone`);
  // Once the page settles the badge offers the moved note.
  await expect.poll(async () => (await layerInfo(page))?.badge).toEqual({ hidden: false, text: '1' });
  await page.screenshot({ path: shotPath('tray-badge') });
  const badge = (await layerPoint(page, '.badge'))!;
  await page.mouse.click(badge.x, badge.y);
  // The tray opens; the bar now carries the count and the badge steps aside.
  await expect.poll(async () => !!(await layerPoint(page, '.iu .tray'))).toBe(true);
  await expect.poll(async () => (await layerInfo(page))?.badge?.hidden).toBe(true);
  expect((await layerInfo(page))?.bar?.tray).toBe('1');
  await page.screenshot({ path: shotPath('tray-open') });
  const place = (await layerPoint(page, '.iu button[aria-label="Place this note"]'))!;
  await page.mouse.click(place.x, place.y);
  await expect.poll(async () => !!(await layerPoint(page, '.iu .ban'))).toBe(true);

  // Tap on the closing paragraph: the note lands centred on the tap.
  const target = (await textBox(page, 'closing paragraph'))!;
  const at = centre(target);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  const box: Box = (await layerInfo(page))!.notes[0]!.box;
  expect(Math.abs(centre(box).x - at.x)).toBeLessThan(4);
  expect(Math.abs(centre(box).y - at.y)).toBeLessThan(4);
  // The tray button hides when the bar updates, which can come just after the note is placed.
  await expect.poll(async () => (await layerInfo(page))?.bar?.trayHidden).toBe(true);
  await expect
    .poll(async () => ((await readStorage(ext, [key]))[key] as { notes: InkNote[] }).notes.map((n) => n.id))
    .not.toContain(oldId);
  const placed = ((await readStorage(ext, [key]))[key] as { notes: InkNote[] }).notes;
  expect(placed).toHaveLength(1);
  expect(placed[0]!.anchor.quote.exact).toContain('closing paragraph');

  // It stays there after a reload.
  await page.reload();
  await expect
    .poll(async () => {
      const b = (await layerInfo(page))?.notes[0]?.box;
      const t = await textBox(page, 'closing paragraph');
      return b && t ? Math.hypot(centre(b).x - centre(t).x, centre(b).y - centre(t).y) : 99;
    })
    .toBeLessThan(4);
});
