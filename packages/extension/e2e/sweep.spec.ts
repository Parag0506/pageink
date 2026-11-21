/**
 * Pen and page controls on awkward pages, in the real extension: the bar
 * never draws, pages that keep events to themselves, carousels, app shells,
 * right to left and vertical text, and browser zoom.
 */
import type { CDPSession, Page } from '@playwright/test';
import { note, record, seed } from '../src/testing/records';
import {
  allNotes,
  type Box,
  barClick,
  centre,
  expect,
  inLayer,
  layerInfo,
  layerPoint,
  line,
  ring,
  seedStorage,
  stroke,
  tabId,
  test,
  textBox,
} from './fixtures';

/** Turn the draw toggle on the way the toolbar button does. */
async function drawOn(ext: Page, url: string): Promise<void> {
  const tab = await tabId(ext, `${new URL(url).origin}/*`);
  await ext.evaluate((t) => chrome.tabs.sendMessage(t, { ink: 'draw', on: true }), tab);
}

const circle = (b: Box) => ring(centre(b), b.w / 2 + 8, b.h / 2 + 6);

/** Distance between the centres of two boxes. */
const gap = (a: Box, b: Box) => Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));

test('with the draw toggle on, mouse clicks on the bar never draw', async ({ context, origin, ext }) => {
  const url = `${origin.a}/article.html`;
  const page = await context.newPage();
  await page.goto(url);
  await drawOn(ext, url);
  await expect.poll(async () => (await layerInfo(page))?.bar?.draw).toBe(true);
  for (const label of [
    'Pen, second colour',
    'Highlighter',
    'Eraser',
    'Lasso',
    'Pen, first colour',
    'More',
    'More',
  ])
    await barClick(page, label);
  // A press on the bar that wanders a little is still not ink.
  const p = (await layerPoint(page, '.iu button[aria-label="Highlighter"]'))!;
  await stroke(page, line(p, { x: p.x + 6, y: p.y + 4 }, 2), { kind: 'mouse' });
  expect((await layerInfo(page))?.notes.length).toBe(0);
  expect((await layerInfo(page))?.bar?.draw).toBe(true);
  // The toggle is still on: the page itself takes ink. That note is saved after anything the
  // presses on the bar could have written, so once it is in storage it is the only one there.
  await stroke(page, circle((await textBox(page, 'Borrowdale'))!), { kind: 'mouse' });
  await expect
    .poll(async () => (await allNotes(ext)).some((n) => n.anchor.quote.exact.includes('Borrowdale')))
    .toBe(true);
  expect(await allNotes(ext)).toHaveLength(1);
});

test('a page that stops every event at the window and traps focus: the pen writes, bar and tray work', async ({
  context,
  origin,
  ext,
}) => {
  const url = `${origin.a}/trap.html`;
  // One note whose words are gone, so the tray has a row.
  await seedStorage(ext, seed(record(url, [note('gone', 'words that are not on this page')])));
  const page = await context.newPage();
  await page.goto(url);
  const w = (await textBox(page, 'pomegranate'))!;
  // One stroke on the text inside #app, which the page lets through, then one in the margin, which it stops.
  await stroke(page, circle(w));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  await stroke(page, line({ x: 760, y: 200 }, { x: 900, y: 240 }));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  expect(
    await page.evaluate(() => (window as unknown as { __stopped?: number }).__stopped ?? 0),
  ).toBeGreaterThan(0);

  // The bar: Undo removes the margin stroke, Redo brings it back.
  await barClick(page, 'Undo');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  await barClick(page, 'Redo');
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  // The menu opens and closes.
  await barClick(page, 'More');
  await expect
    .poll(() => inLayer(page, (r) => r.querySelector<HTMLElement>('.iu .menu')?.hidden))
    .toBe(false);
  await barClick(page, 'More');
  await expect.poll(() => inLayer(page, (r) => r.querySelector<HTMLElement>('.iu .menu')?.hidden)).toBe(true);
  // The tray opens, and its close button works.
  await barClick(page, 'Moved notes, 1');
  await expect
    .poll(() => inLayer(page, (r) => r.querySelector<HTMLElement>('.iu .tray')?.hidden))
    .toBe(false);
  const close = (await layerPoint(page, '.iu .tray button[aria-label="Close"]'))!;
  await page.mouse.click(close.x, close.y);
  await expect.poll(() => inLayer(page, (r) => r.querySelector<HTMLElement>('.iu .tray')?.hidden)).toBe(true);
  await expect.poll(async () => (await allNotes(ext)).length).toBe(3);
});

test('a carousel that takes touches and the pointer for itself still lets a pen write', async ({
  context,
  origin,
}) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/carousel.html`);
  // A first stroke outside the carousel loads the tools. Until then the page sees the pen.
  const b = (await textBox(page, 'Borrowdale'))!;
  await stroke(page, circle(b));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { __moved: number }).__moved = 0;
  });
  await page.waitForTimeout(1700);
  const w = (await textBox(page, 'marmalade'))!;
  await stroke(page, circle(w));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  const ns = (await layerInfo(page))!.notes;
  expect(Math.min(...ns.map((n) => gap(n.box, w)))).toBeLessThan(6);
  // The stroke is ink: the carousel saw at most the first small move before it became ink.
  expect(await page.evaluate(() => (window as unknown as { __moved: number }).__moved)).toBeLessThanOrEqual(
    1,
  );
});

test('an app shell with a hidden root overflow and an inner scroller: write, scroll, reload', async ({
  context,
  origin,
}) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/shell.html`);
  const w = (await textBox(page, 'Borrowdale'))!;
  await stroke(page, circle(w));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  const on = async (word: string) => {
    const b = (await textBox(page, word))!;
    const n = (await layerInfo(page))?.notes[0]?.box;
    return n ? gap(n, b) : 999;
  };
  expect(await on('Borrowdale')).toBeLessThan(6);
  // The pane scrolls; the ink moves with it, and is clipped to the pane.
  await page.evaluate(() => {
    document.getElementById('scroller')!.scrollTop = 120;
  });
  await expect.poll(() => on('Borrowdale')).toBeLessThan(6);
  // A wheel over the pane scrolls it, not the hidden root.
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => page.evaluate(() => document.getElementById('scroller')!.scrollTop))
    .toBeGreaterThan(200);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.evaluate(() => {
    document.getElementById('scroller')!.scrollTop = 0;
  });
  await page.reload();
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  await expect.poll(() => on('Borrowdale')).toBeLessThan(6);
  // A note at the far end of the pane, then a reload with the pane at its top.
  await page.evaluate(() => {
    const s = document.getElementById('scroller')!;
    s.scrollTop = s.scrollHeight;
  });
  const a = (await textBox(page, 'albatross'))!;
  await stroke(page, circle(a));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  await page.reload();
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  await page.evaluate(() => {
    const s = document.getElementById('scroller')!;
    s.scrollTop = s.scrollHeight;
  });
  await expect
    .poll(async () => {
      const b = (await textBox(page, 'albatross'))!;
      const ns = (await layerInfo(page))?.notes ?? [];
      return Math.min(...ns.map((n) => gap(n.box, b)));
    })
    .toBeLessThan(6);
});

/** Ink box in client space, and the box of the paragraph it belongs to. */
async function noteAndPara(page: Page, para: string): Promise<{ ink: Box; p: Box; vw: number }> {
  const ink = (await layerInfo(page))!.notes[0]!.box;
  const p = await page.evaluate((id) => {
    const r = document.getElementById(id)!.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, para);
  const vw = await page.evaluate(() => document.documentElement.clientWidth);
  return { ink, p, vw };
}

test('right to left: ink stays on its words, and a margin note stays in its margin or docks on screen', async ({
  context,
  origin,
}) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/rtl.html`);
  const w = (await textBox(page, 'pomegranate'))!;
  await stroke(page, circle(w));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  expect(gap((await layerInfo(page))!.notes[0]!.box, w)).toBeLessThan(6);

  // A note in the free margin on the left of the second paragraph.
  const p2 = await page.evaluate(() => {
    const r = document.getElementById('p2')!.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.waitForTimeout(1700);
  await stroke(page, line({ x: p2.x - 120, y: p2.y + 10 }, { x: p2.x - 30, y: p2.y + 30 }));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
  const margin = async () => {
    const notes = (await layerInfo(page))!.notes;
    const r = await page.evaluate(() => {
      const b = document.getElementById('p2')!.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, vw: document.documentElement.clientWidth };
    });
    // The margin note is the one left of the text.
    const n = notes.reduce((a, b) => (b.box.x < a.box.x ? b : a)).box;
    return { n, r };
  };
  let m = await margin();
  expect(m.n.x + m.n.w).toBeLessThanOrEqual(m.r.x + 2);

  // Narrower: the text column moves, the note keeps to the left of it or docks inside the window.
  await page.setViewportSize({ width: 700, height: 800 });
  // The placer lays the note out again after the resize.
  await expect
    .poll(async () => {
      m = await margin();
      return (
        m.n.x >= -1 && m.n.x + m.n.w <= m.r.vw + 1 && m.n.y + m.n.h > m.r.y - 40 && m.n.y < m.r.y + m.r.h + 40
      );
    })
    .toBe(true);
});

test('vertical writing: ink stays on its words through a reload and a resize', async ({
  context,
  origin,
}) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/vertical.html`);
  const w = (await textBox(page, 'pomegranate'))!;
  await stroke(page, circle(w));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  const off = async () => {
    const b = (await textBox(page, 'pomegranate'))!;
    const n = (await layerInfo(page))?.notes[0]?.box;
    return n ? { dx: n.x - b.x, dy: n.y - b.y } : null;
  };
  const o1 = (await off())!;
  await page.reload();
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  const o2 = (await off())!;
  expect(Math.abs(o2.dx - o1.dx) + Math.abs(o2.dy - o1.dy)).toBeLessThan(3);
  await page.setViewportSize({ width: 640, height: 800 });
  await expect
    .poll(async () => {
      const o = await off();
      return o ? Math.abs(o.dx - o1.dx) + Math.abs(o.dy - o1.dy) : 99;
    })
    .toBeLessThan(3);
  const { ink, vw } = await noteAndPara(page, 'p1');
  expect(ink.x).toBeGreaterThanOrEqual(-1);
  expect(ink.x + ink.w).toBeLessThanOrEqual(vw + 1);
});

/** Browser zoom: a CSS viewport scaled down by the zoom, with device pixels scaled up. */
async function zoomTo(cdp: CDPSession, z: number): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(1000 / z),
    height: Math.round(800 / z),
    deviceScaleFactor: z,
    mobile: false,
  });
}

for (const z of [0.67, 2]) {
  test(`browser zoom ${Math.round(z * 100)}%: ink written at 100% stays on its words, and ink written here too`, async ({
    context,
    origin,
  }) => {
    const page = await context.newPage();
    await page.goto(`${origin.a}/article.html`);
    const w = (await textBox(page, 'pomegranate'))!;
    await stroke(page, circle(w));
    await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
    const cdp = await context.newCDPSession(page);
    await zoomTo(cdp, z);
    const on = async (word: string) => {
      const b = (await textBox(page, word))!;
      const ns = (await layerInfo(page))?.notes ?? [];
      return Math.min(...ns.map((n) => gap(n.box, b)));
    };
    await expect.poll(() => on('pomegranate')).toBeLessThan(6);
    await page.waitForTimeout(1700);
    // At 200% the word can be below the window, depending on the font: show it before writing.
    await page.evaluate(() =>
      [...document.querySelectorAll('p')]
        .find((p) => p.textContent?.includes('Borrowdale'))!
        .scrollIntoView({ block: 'center' }),
    );
    const b = (await textBox(page, 'Borrowdale'))!;
    await stroke(page, circle(b));
    await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
    await expect.poll(() => on('Borrowdale')).toBeLessThan(6);
    await page.reload();
    await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(2);
    await expect.poll(() => on('pomegranate')).toBeLessThan(6);
    await expect.poll(() => on('Borrowdale')).toBeLessThan(6);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await expect.poll(() => on('Borrowdale')).toBeLessThan(6);
    await cdp.detach();
  });
}
