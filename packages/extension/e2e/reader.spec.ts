/**
 * What a reader relies on: only their own input counts, draw mode is kept per site and never
 * traps them, a drag on a page slider goes to the page, and ink on a modal dialog shows above it.
 */
import type { Page } from '@playwright/test';
import {
  allNotes,
  barClick,
  centre,
  expect,
  inLayer,
  layerInfo,
  line,
  readStorage,
  ring,
  stroke,
  test,
  textBox,
} from './fixtures';

/** A page script making every kind of input it can: pen, eraser end, touch, clicks and keys. */
async function fakeEverything(page: Page): Promise<void> {
  await page.evaluate(() => {
    const at = document.getElementById('intro') ?? document.body;
    const r = at.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const pe = (type: string, x: number, o: PointerEventInit) =>
      at.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          ...o,
        }),
      );
    for (const [id, o] of [
      [51, { pointerType: 'pen', button: 0, buttons: 1 }],
      [52, { pointerType: 'pen', button: 5, buttons: 32 }],
      [53, { pointerType: 'touch', button: 0, buttons: 1 }],
      [1, { pointerType: 'mouse', button: 0, buttons: 1, altKey: true }],
    ] as [number, PointerEventInit][]) {
      pe('pointerdown', r.left + 4, { ...o, pointerId: id });
      for (let i = 1; i < 10; i++) pe('pointermove', r.left + 4 + i * 30, { ...o, pointerId: id });
      pe('pointerup', r.left + 300, { ...o, pointerId: id, buttons: 0 });
    }
    const t = new Touch({ identifier: 9, target: at, clientX: r.left + 4, clientY: y });
    at.dispatchEvent(new TouchEvent('touchstart', { touches: [t], changedTouches: [t], bubbles: true }));
    // Clicks aimed at our host, at every point of the bar, as if on its buttons.
    const host = document.querySelector('ink-layer') as HTMLElement;
    for (let x = 0; x < innerWidth; x += 12)
      for (let yy = 0; yy < innerHeight; yy += 12) {
        const o = { bubbles: true, composed: true, clientX: x, clientY: yy, detail: 1 };
        host.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerType: 'pen', pointerId: 60 }));
        host.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerType: 'pen', pointerId: 60 }));
        host.dispatchEvent(new MouseEvent('click', o));
      }
    for (const init of [
      { key: 'z', ctrlKey: true },
      { key: 'z', metaKey: true },
      { key: 'e' },
      { key: 'Escape' },
    ])
      document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

/**
 * A real pen ring in the empty area below the content. Its note is saved after anything earlier
 * input wrote, so once it shows, a check that earlier input wrote nothing is final.
 */
async function barrier(page: Page): Promise<string> {
  const at = { x: 300, y: 680 };
  await stroke(page, ring(at, 30, 18));
  const hit = async () =>
    ((await layerInfo(page))?.notes ?? []).find(
      (n) =>
        n.box.x <= at.x &&
        at.x <= n.box.x + n.box.w &&
        n.box.y <= at.y + 20 &&
        at.y - 20 <= n.box.y + n.box.h,
    )?.id;
  await expect.poll(hit).toBeTruthy();
  return (await hit())!;
}

test('events a page script makes never write, erase, undo, press the bar or leave draw mode', async ({
  context,
  origin,
  ext,
}) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/controls.html`);
  const w = (await textBox(page, 'tamarind'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);
  const before = await allNotes(ext);
  await barClick(page, 'Draw');
  await expect.poll(async () => (await layerInfo(page))?.bar?.draw).toBe(true);
  await fakeEverything(page);
  const last = await barrier(page);
  await expect.poll(async () => (await allNotes(ext)).some((n) => n.id === last)).toBe(true);
  expect(await allNotes(ext)).toHaveLength(2);
  const ids = new Set(before.map((n) => n.id));
  expect((await allNotes(ext)).filter((n) => ids.has(n.id))).toEqual(before);
  const info = (await layerInfo(page))!;
  expect(info.notes).toHaveLength(2);
  expect(info.bar).toMatchObject({ draw: true, tool: 'Pen, first colour' });
  // The menu and its clear step were never opened.
  expect(await inLayer(page, (root) => (root.querySelector('[role=menu]') as HTMLElement).hidden)).toBe(true);
  // Real keys still work.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await layerInfo(page))?.bar?.draw).toBe(false);
});

test('draw mode is kept for the site, comes back with the bar up, never traps, and links still work', async ({
  context,
  origin,
  ext,
}) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/controls.html`);
  const w = (await textBox(page, 'tamarind'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await barClick(page, 'Draw');
  await expect
    .poll(async () => ((await readStorage(ext, ['cfg'])).cfg as { drawOn?: string[] })?.drawOn)
    .toEqual(['localhost']);

  // Another page on the same site: draw mode is on from the start, and the bar says so.
  await page.goto(`${origin.a}/article.html`);
  await expect.poll(async () => (await layerInfo(page))?.bar).toMatchObject({ hidden: false, draw: true });
  expect(await inLayer(page, (root) => root.querySelector('.note .msg')?.textContent)).toContain(
    'Draw mode is on for this site',
  );
  // A plain click on a link is still a click.
  await page.click('#link');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#linked');
  // Esc turns it off, for this page and for the next visit.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await layerInfo(page))?.bar?.draw).toBe(false);
  await expect
    .poll(async () => ((await readStorage(ext, ['cfg'])).cfg as { drawOn?: string[] })?.drawOn)
    .toEqual([]);
  await page.reload();
  // A pen note loads the viewer and its tools. Draw mode left on for the site would be back on
  // before that note is drawn, so once it is there the bar tells which way the setting went.
  const w2 = (await textBox(page, 'Borrowdale'))!;
  await stroke(page, ring(centre(w2), w2.w / 2 + 8, w2.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  expect((await layerInfo(page))?.bar?.draw).toBe(false);
});

test('a pen drag on a slider goes to the page and writes nothing', async ({ context, origin }) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/controls.html`);
  // A first note loads the tools.
  const w = (await textBox(page, 'tamarind'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  // The slider gets the whole gesture, untouched: every move, none stopped or held back.
  await page.evaluate(() => {
    const seen = { moves: 0, blocked: 0 };
    (window as unknown as { seen: typeof seen }).seen = seen;
    document.getElementById('rng')!.addEventListener('pointermove', (e) => {
      if (e.buttons) seen.moves++;
      queueMicrotask(() => {
        if (e.defaultPrevented) seen.blocked++;
      });
    });
  });
  const rng = (await page.locator('#rng').boundingBox())!;
  const y = rng.y + rng.height / 2;
  await stroke(page, line({ x: rng.x + 40, y }, { x: rng.x + 300, y }, 8));
  const seen = await page.evaluate(
    () => (window as unknown as { seen: { moves: number; blocked: number } }).seen,
  );
  expect(seen.moves).toBeGreaterThan(20);
  expect(seen.blocked).toBe(0);
  await barrier(page);
  expect((await layerInfo(page))?.notes ?? []).toHaveLength(2);
});

test('ink on a modal dialog shows above it, in a host that goes when the dialog closes', async ({
  context,
  origin,
}) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/controls.html`);
  await page.click('#open');
  const w = (await textBox(page, 'persimmon', '#dlg'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('ink-layer').length)).toBe(2);
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll('ink-layer')].some((h) => h.matches(':popover-open')),
    ),
  ).toBe(true);
  // The dialog still takes input.
  await page.click('#close');
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('ink-layer').length)).toBe(1);
});
