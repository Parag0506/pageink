// Margin notes on layouts with no margin: they dock into free space beside their block, fold into
// a marker when there is none, and never cover a word. DESIGN 7.4, the paragraph on docking.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { isChromium, mouseInput, STEP_MS, touchEmulation, touchGesture } from '../capture/testkit';
import type { InkLayer } from '../render/layer';
import { createLayer } from '../render/layer';
import { budget } from '../testkit';
import type { Note, Placed, Placer, Rect } from '../types';
import { createPlacer } from './placer';
import { blob, type FakeResolver, fakeResolver, frame, inkNote, margin, quiet } from './testkit';

const cleanups: (() => void | Promise<void>)[] = [];
let stage: HTMLElement;
const W0 = window.innerWidth;
const H0 = window.innerHeight;

beforeEach(() => {
  document.body.style.cssText = 'margin:0;padding:0;font:16px/1.5 sans-serif;background:#fff;color:#d00000';
  stage = document.createElement('div');
  stage.id = 'stage';
  document.body.append(stage);
  cleanups.push(() => stage.remove());
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  document.body.removeAttribute('style');
  window.scrollTo(0, 0);
  await frame();
});

const viewport = async (w: number, h = 844): Promise<void> => {
  await page.viewport(w, h);
  cleanups.push(() => page.viewport(W0, H0));
  await frame();
};

const TEXT =
  'Iron gall ink was the standard writing ink in Europe for over a thousand years. It bites into the paper, so a seed of ink can last as long as the sheet itself.';

function block(tag: string, id: string, css = '', text = TEXT, parent: Element = stage): HTMLElement {
  const el = document.createElement(tag);
  el.id = id;
  el.textContent = text;
  el.setAttribute('style', css);
  parent.append(el);
  return el;
}

interface Rig {
  placer: Placer;
  layer: InkLayer;
  resolver: FakeResolver;
  timings: { name: string; ms: number }[];
}

function rig(): Rig {
  const layer = createLayer(document, { theme: 'light' }) as InkLayer;
  const resolver = fakeResolver(document);
  const timings: Rig['timings'] = [];
  const placer = createPlacer({
    doc: document,
    resolver,
    layer,
    onTiming: (name, ms) => timings.push({ name, ms }),
  });
  cleanups.push(() => {
    placer.destroy();
    layer.destroy();
  });
  return { placer, layer, resolver, timings };
}

const until = (cond: () => boolean, timeout = 15_000): Promise<void> =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error('not yet');
    },
    { timeout, interval: 10 },
  );

/** Every text line piece under an element, document space. */
function textLines(root: Element = stage): Rect[] {
  const out: Rect[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (!/\S/.test(t.nodeValue ?? '')) continue;
    r.selectNodeContents(t);
    for (const c of r.getClientRects())
      if (c.width > 0.5) out.push({ x: c.left + scrollX, y: c.top + scrollY, w: c.width, h: c.height });
  }
  return out;
}

const meets = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** No placed margin note, docked or folded, covers a line of text, and all are inside the page. */
function expectClear(placed: Placed[], lines: Rect[]): void {
  const docW = document.documentElement.clientWidth;
  for (const p of placed) {
    const hit = lines.find((l) => meets(p.bbox, l));
    expect(hit, `note ${p.id} at ${JSON.stringify(p.bbox)} covers ${JSON.stringify(hit)}`).toBeUndefined();
    expect(p.bbox.x).toBeGreaterThanOrEqual(-0.5);
    expect(p.bbox.x + p.bbox.w).toBeLessThanOrEqual(docW + 0.5);
  }
}

/** Two notes never sit on each other. */
function expectApart(placed: Placed[]): void {
  for (const a of placed)
    for (const b of placed) if (a !== b) expect(meets(a.bbox, b.bbox), `${a.id} on ${b.id}`).toBe(false);
}

/** Base64 PNG pixels of the test frame, for sampling. */
async function shot(): Promise<{ at(x: number, y: number): number[] }> {
  const b64 = await page.screenshot({ save: false });
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const dpr = c.width / document.documentElement.clientWidth;
  return {
    at(x, y) {
      const i = (Math.round(y * dpr) * c.width + Math.round(x * dpr)) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    },
  };
}
/** The pen colour in the light theme, #1f2a44. The page text is red. */
const isInk = (p: number[]) => p[0]! < 70 && p[1]! < 80 && p[2]! < 110 && p[2]! > p[0]!;

/** A phone article: 16 px gutters and paragraphs 8 px apart, too tight for a note between them. */
function phoneArticle(n: number, parent: Element = stage): HTMLElement[] {
  (parent as HTMLElement).style.padding = '0 16px';
  return Array.from({ length: n }, (_, i) => block('p', `p${i}`, 'margin:0 0 8px', TEXT, parent));
}

const markerOf = (r: Rig, id: string): HTMLButtonElement | null =>
  r.layer.root.querySelector<HTMLButtonElement>(`button.dk[data-note="${id}"]`);
const popShown = (r: Rig): boolean => {
  const p = r.layer.root.querySelector<HTMLElement>('.pop');
  return !!p && !p.hidden && p.getBoundingClientRect().width > 0;
};

describe('docking on narrow layouts', () => {
  test('a two-column page reflowed to one column: margin notes leave the text', async () => {
    await viewport(1000, 800);
    stage.style.cssText = 'display:grid;grid-template-columns:520px 240px;column-gap:140px;padding:0 20px';
    const main = document.createElement('div');
    const side = document.createElement('aside');
    stage.append(main, side);
    for (let i = 0; i < 6; i++) block('p', `m${i}`, 'margin:0 0 10px', TEXT, main);
    block('p', 'aside', 'margin:0', `${TEXT} ${TEXT}`, side);
    const r = rig();
    const notes = [
      margin('m1', 'right', 'yes'),
      margin('m3', 'right', 'star'),
      margin('m4', 'right', 'yes', 20),
    ];
    r.placer.setNotes(notes);
    await until(() => r.placer.all().length === 3);
    // Wide: each note sits in the gutter where it was written.
    expect(r.placer.all().every((p) => !p.docked)).toBe(true);
    expectClear(r.placer.all(), textLines());
    // One column: the article takes the whole width and the sidebar goes below it.
    stage.style.gridTemplateColumns = '1fr';
    await until(() => r.placer.all().every((p) => p.docked));
    expectClear(r.placer.all(), textLines());
    expectApart(r.placer.all());
  });

  test('a 390 px article with tight paragraphs: no note covers a word, by geometry and by pixels', async () => {
    await viewport(390);
    const ps = phoneArticle(8);
    const r = rig();
    const notes = [
      margin('p1', 'right', 'yes'),
      margin('p1', 'right', 'star', 30),
      margin('p1', 'left', 'star'),
      margin('p3', 'left', 'yes'),
      margin('p4', 'right', 'star'),
      margin('p4', 'right', 'yes', 20),
      margin('p4', 'right', 'star', 50),
    ];
    r.placer.setNotes(notes);
    await until(() => r.placer.all().length === notes.length);
    const placed = r.placer.all();
    expect(placed.every((p) => p.docked)).toBe(true);
    const lines = textLines();
    expectClear(placed, lines);
    expectApart(placed);
    // The words around the notes, where the old docking painted them, show no ink.
    await frame();
    const px = await shot();
    const docW = document.documentElement.clientWidth;
    let sampled = 0;
    const inked: string[] = [];
    for (const l of lines) {
      if (l.y - scrollY > window.innerHeight - 4) continue;
      for (let y = l.y + 3; y < l.y + l.h - 3; y += 2)
        for (let x = Math.max(l.x, 0); x < Math.min(l.x + l.w, docW); x += 2) {
          sampled++;
          if (isInk(px.at(x - scrollX, y - scrollY))) inked.push(`${x},${y}`);
        }
    }
    expect(sampled).toBeGreaterThan(5000);
    expect(inked.slice(0, 10)).toEqual([]);
    // Ink drawn on the words would have been seen: an on-text note shows up in the same sampling.
    const on = inkNote('p0', { place: 'on', strokes: [blob(40, 4, 120, 14)] });
    r.placer.setNotes([...notes, on]);
    await until(() => !!r.placer.get(on.id));
    await frame();
    const px2 = await shot();
    const l0 = textLines(ps[0])[0]!;
    let seen = 0;
    for (let x = l0.x + 40; x < l0.x + 160; x += 2)
      for (let y = l0.y; y < l0.y + l0.h; y += 2) if (isInk(px2.at(x, y))) seen++;
    expect(seen).toBeGreaterThan(0);
  });

  test('a note beside a heading stays beside its words, with no leader', async () => {
    await viewport(390);
    stage.style.padding = '0 16px';
    block('h2', 'h', 'margin:0 0 8px;font:600 22px/1.3 sans-serif', 'Results');
    phoneArticle(3, stage);
    const r = rig();
    const n = margin('h', 'right', 'yes');
    r.placer.setNotes([n]);
    await until(() => !!r.placer.get(n.id));
    const p = r.placer.get(n.id)!;
    expect(p.docked).toBe(true);
    expect(p.collapsed).toBeFalsy();
    const head = textLines(document.getElementById('h')!)[0]!;
    expect(p.bbox.x).toBeGreaterThan(head.x + head.w);
    expect(p.bbox.y).toBeLessThan(head.y + head.h);
    expect(p.bbox.y + p.bbox.h).toBeGreaterThan(head.y);
    expectClear([p], textLines());
    expect(r.layer.root.querySelector('.lead')).toBeNull();
  });

  test('right to left pages: notes on both sides stay off the words', async () => {
    await viewport(390);
    stage.dir = 'rtl';
    const he =
      'דיו מברזל היה דיו הכתיבה הרגיל באירופה במשך יותר מאלף שנה. הוא נוגס בנייר ולכן טיפה של דיו מחזיקה כל עוד הדף קיים.';
    stage.style.padding = '0 16px';
    for (let i = 0; i < 6; i++) block('p', `r${i}`, 'margin:0 0 8px', he);
    const r = rig();
    const notes = [margin('r1', 'right', 'yes'), margin('r1', 'left', 'star'), margin('r3', 'left', 'yes')];
    r.placer.setNotes(notes);
    await until(() => r.placer.all().length === 3);
    expectClear(r.placer.all(), textLines());
    expectApart(r.placer.all());
  });

  test('several notes beside one paragraph each get their own space', async () => {
    await viewport(600);
    stage.style.padding = '0 16px';
    block('p', 'a', 'width:300px;margin:0 auto 40px', TEXT);
    block('p', 'b', 'width:300px;margin:0 auto 40px', TEXT);
    const r = rig();
    const notes = [0, 20, 40, 60].map((dy) =>
      inkNote('a', { place: 'right', strokes: [blob(14, dy, 200, 30)] }),
    );
    r.placer.setNotes(notes);
    await until(() => r.placer.all().length === 4);
    expectClear(r.placer.all(), textLines());
    expectApart(r.placer.all());
  });
});

describe('a folded note', () => {
  /** A press at a client point by pen, touch or mouse. Pen and touch reach the closed root by hand outside Chromium. */
  async function press(r: Rig, x: number, y: number, kind: 'pen' | 'touch' | 'mouse'): Promise<void> {
    if (isChromium || kind === 'mouse') {
      // A press and a lift a few ms apart on the input clock, so the browser reads a tap.
      if (kind === 'touch') {
        await touchGesture([
          { type: 'touchStart', points: [{ x, y, id: 1 }] },
          { type: 'touchEnd', points: [] },
        ]);
      } else {
        await mouseInput('mouseMoved', x, y, kind);
        await mouseInput('mousePressed', x, y, kind, { gap: STEP_MS });
        await mouseInput('mouseReleased', x, y, kind, { gap: STEP_MS });
      }
      await frame();
      return;
    }
    const el = r.layer.root.elementFromPoint(x, y) ?? document.elementFromPoint(x, y) ?? document.body;
    const init = {
      pointerType: kind,
      clientX: x,
      clientY: y,
      bubbles: true,
      composed: true,
      isPrimary: true,
    };
    el.dispatchEvent(new PointerEvent('pointerover', init));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', init));
    el.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
    await frame();
  }
  async function hoverAt(r: Rig, x: number, y: number, kind: 'pen' | 'mouse'): Promise<void> {
    if (isChromium || kind === 'mouse') {
      await mouseInput('mouseMoved', x, y, kind);
      return;
    }
    const el = r.layer.root.elementFromPoint(x, y) ?? document.body;
    el.dispatchEvent(
      new PointerEvent('pointerover', {
        pointerType: kind,
        clientX: x,
        clientY: y,
        bubbles: true,
        composed: true,
      }),
    );
  }
  async function hoverOff(r: Rig, x: number, y: number, kind: 'pen' | 'mouse', from: Element): Promise<void> {
    if (isChromium || kind === 'mouse') {
      await mouseInput('mouseMoved', x, y, kind);
      return;
    }
    from.dispatchEvent(new PointerEvent('pointerout', { pointerType: kind, bubbles: true, composed: true }));
    void r;
  }

  async function folded(): Promise<{ r: Rig; n: Note; b: HTMLButtonElement; at: { x: number; y: number } }> {
    await viewport(390);
    phoneArticle(30);
    const r = rig();
    const n = margin('p2', 'right', 'yes');
    r.placer.setNotes([n]);
    await until(() => !!markerOf(r, n.id));
    expect(r.placer.get(n.id)!.collapsed).toBe(true);
    const b = markerOf(r, n.id)!;
    const box = b.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(7);
    // The marker itself covers no word.
    const doc = { x: box.left + scrollX, y: box.top + scrollY, w: box.width, h: box.height };
    expect(textLines().some((l) => meets(doc, l))).toBe(false);
    // The ink is not painted while folded.
    const ink = r.layer.root.querySelector(`[data-stroke="${n.strokes[0]!.id}"]`)!;
    expect(ink.getBoundingClientRect().width).toBe(0);
    return { r, n, b, at: { x: box.left + box.width / 2, y: box.top + box.height / 2 } };
  }

  for (const kind of ['pen', 'mouse'] as const) {
    test(`${kind}: hover shows the note at reading size, leaving hides it, a press keeps it until a press elsewhere`, async () => {
      const { r, b, at } = await folded();
      await hoverAt(r, at.x, at.y, kind);
      await until(() => popShown(r));
      const svg = r.layer.root.querySelector('.pop svg')!.getBoundingClientRect();
      // Readable: the note's own size, as it was written.
      expect(svg.width).toBeGreaterThan(60);
      expect(b.getAttribute('aria-expanded')).toBe('true');
      await hoverOff(r, 10, 600, kind, b);
      await until(() => !popShown(r));
      await press(r, at.x, at.y, kind);
      await until(() => popShown(r));
      // A pressed note has no close timer pending: once short timers have run, it still shows.
      await quiet();
      expect(popShown(r)).toBe(true);
      await press(r, 200, 700, kind);
      await until(() => !popShown(r));
      expect(b.getAttribute('aria-expanded')).toBe('false');
    });
  }

  test('touch: a tap shows the note and a tap elsewhere hides it', async () => {
    if (isChromium) await touchEmulation(true);
    cleanups.push(() => touchEmulation(false));
    const { r, at } = await folded();
    await press(r, at.x, at.y, 'touch');
    await until(() => popShown(r));
    await press(r, 200, 700, 'touch');
    await until(() => !popShown(r));
  });

  test('keyboard: the marker takes focus, Enter shows the note and Escape hides it', async () => {
    const { r, b } = await folded();
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('aria-label')).toBeTruthy();
    b.focus();
    await userEvent.keyboard('{Enter}');
    await until(() => popShown(r));
    expect(b.getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard('{Escape}');
    await until(() => !popShown(r));
  });

  test('it unfolds by itself when the layout has room again', async () => {
    const { r, n } = await folded();
    await viewport(1100);
    stage.style.maxWidth = '640px';
    await until(() => !markerOf(r, n.id) && r.placer.get(n.id)?.docked === false);
    const ink = r.layer.root.querySelector(`[data-stroke="${n.strokes[0]!.id}"]`)!;
    expect(ink.getBoundingClientRect().width).toBeGreaterThan(30);
  });
});

describe('stability', () => {
  test('ink written in a margin, viewed narrow, then wide again, returns to exactly where it was written', async () => {
    await viewport(1000, 800);
    stage.style.cssText = 'max-width:560px;padding:0 20px';
    phoneArticle(6);
    stage.style.padding = '0 20px';
    const r = rig();
    const p = document.getElementById('p2')!.getBoundingClientRect();
    const n = margin('p2', 'right', 'yes', 10);
    // Written with the pen: drawn at once where the writer saw it.
    const origin = { x: p.right + scrollX, y: p.top + scrollY };
    r.placer.upsert(n, { origin, scale: 1 });
    await frame();
    const written = { ...r.placer.get(n.id)!.bbox };
    const drawn = r.layer.root.querySelector(`[data-stroke="${n.strokes[0]!.id}"]`)!.getBoundingClientRect();
    await viewport(390);
    await until(() => !!r.placer.get(n.id)?.docked);
    expectClear([r.placer.get(n.id)!], textLines());
    await viewport(1000, 800);
    await until(() => r.placer.get(n.id)?.docked === false);
    const back = r.placer.get(n.id)!;
    expect(back.origin).toEqual(origin);
    expect(back.scale).toBe(1);
    expect(back.bbox).toEqual(written);
    const again = r.layer.root.querySelector(`[data-stroke="${n.strokes[0]!.id}"]`)!.getBoundingClientRect();
    expect(again.left).toBeCloseTo(drawn.left, 1);
    expect(again.top).toBeCloseTo(drawn.top, 1);
  });

  test('a docked note does not jump on small layout changes, and is placed again on each', async () => {
    await viewport(600);
    stage.style.padding = '0 16px';
    const a = block('p', 'a', 'width:330px;margin:0 auto 60px', TEXT);
    block('p', 'b', 'width:330px;margin:0 auto 60px', TEXT);
    const r = rig();
    const n = inkNote('a', { place: 'right', strokes: [blob(14, 0, 160, 30)] });
    r.placer.setNotes([n]);
    await until(() => !!r.placer.get(n.id)?.docked);
    const first = r.placer.get(n.id)!;
    // Beside the text means right of the end of its longest line. Where the lines end inside the
    // block depends on the font, so the block's own box cannot tell.
    const side = (p: Placed) =>
      p.bbox.x >= Math.max(...textLines(a).map((l) => l.x + l.w)) - 0.5 ? 'side' : 'gap';
    const kind = side(first);
    for (const w of [329, 331, 328, 332, 330]) {
      const calls = r.resolver.calls;
      a.style.width = `${w}px`;
      await until(() => r.resolver.calls > calls && Math.abs(r.placer.get(n.id)!.anchorBox.w - w) < 1);
      const p = r.placer.get(n.id)!;
      expect(side(p)).toBe(kind);
      expect(Math.abs(p.bbox.y - first.bbox.y)).toBeLessThan(4);
    }
  });

  test('orientation change and content change place docked notes again', async () => {
    await viewport(390);
    // p3 is the last paragraph, with empty room under it, so the note has a free place next to
    // its own block with any font. With more text below, how far the nearest gap is would depend
    // on how tall the font makes the paragraphs.
    phoneArticle(4);
    block('div', 'room', 'height:400px', '');
    const r = rig();
    const n = margin('p3', 'right', 'yes');
    r.placer.setNotes([n]);
    await until(() => !!r.placer.get(n.id)?.docked);
    const calls = r.resolver.calls;
    window.dispatchEvent(new Event('orientationchange'));
    await until(() => r.resolver.calls > calls);
    const before = r.placer.get(n.id)!.bbox;
    // New text above the note: it moves with its paragraph, still clear of every word.
    const extra = document.createElement('p');
    extra.textContent = TEXT;
    stage.prepend(extra);
    await until(() => r.placer.get(n.id)!.bbox.y > before.y + 20);
    expectClear([r.placer.get(n.id)!], textLines());
  });
});

describe('cost', () => {
  // The Long Tasks API exists only in Chromium, so WebKit and Firefox cannot measure this.
  const longTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
  // A budget test: the limit grows with work measured in the same run (testkit.budget).
  test.runIf(longTasks)('budget: 200 margin notes on a phone layout, no long task over 50 ms', async () => {
    await viewport(390);
    const ps = phoneArticle(200);
    const notes = ps.map((_, i) => margin(`p${i}`, i % 2 ? 'left' : 'right', i % 3 ? 'yes' : 'star'));
    window.scrollTo(0, 4000);
    // Before the observer starts: the calibration is one long task itself.
    const limit = budget(50);
    // Its long task ends before the observer starts.
    await frame();
    const long: number[] = [];
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) long.push(e.duration);
    });
    po.observe({ type: 'longtask', buffered: false });
    cleanups.push(() => po.disconnect());
    await frame();
    const r = rig();
    r.placer.setNotes(notes);
    await until(() => r.timings.some((t) => t.name === 'place.all'));
    await quiet();
    const passes = r.timings.filter((t) => t.name === 'place.pass').map((t) => t.ms);
    const reads = r.timings.filter((t) => t.name === 'place.read').map((t) => Math.round(t.ms * 10) / 10);
    console.log(
      `TIMING 200 margin notes at 390 px ${JSON.stringify({ reads, passes: passes.length, maxPass: Math.round(Math.max(...passes) * 10) / 10, longTasks: long.map(Math.round) })}`,
    );
    expect(r.layer.drawn().length).toBe(200);
    expect(Math.max(...passes)).toBeLessThan(limit);
    expect(long.filter((d) => d > limit)).toEqual([]);
    expectClear(r.placer.all(), textLines());
  });
});
