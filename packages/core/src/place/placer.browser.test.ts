import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { InkLayer } from '../render/layer';
import { createLayer } from '../render/layer';
import { budget } from '../testkit';
import type { Note, Placed, Placer, PlacerHost } from '../types';
import { createPlacer } from './placer';
import {
  type FakeResolver,
  fakeResolver,
  frame,
  inkNote,
  manualClock,
  markNote,
  quiet,
  spy,
  squiggle,
} from './testkit';

const cleanups: (() => void)[] = [];
let stage: HTMLElement;

beforeEach(() => {
  document.body.style.cssText = 'margin:0;padding:0;font:16px/1.5 sans-serif;background:#fff';
  stage = document.createElement('div');
  stage.id = 'stage';
  document.body.append(stage);
  cleanups.push(() => stage.remove());
});

afterEach(async () => {
  while (cleanups.length) cleanups.pop()!();
  document.documentElement.removeAttribute('style');
  window.scrollTo(0, 0);
  await frame();
});

function para(
  id: string,
  css = '',
  text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
  parent: Element = stage,
) {
  const p = document.createElement('p');
  p.id = id;
  p.textContent = text;
  p.setAttribute('style', `margin:0;${css}`);
  parent.append(p);
  return p;
}

interface Rig {
  placer: Placer;
  layer: InkLayer;
  resolver: FakeResolver;
  log: string[];
  timings: { name: string; ms: number }[];
  changes: { placed: Placed[]; unplaced: Note[] }[];
}

function rig(opts: { spyLayer?: boolean; log?: string[]; now?: () => number } = {}): Rig {
  const log = opts.log ?? [];
  const real = createLayer(document, { theme: 'light' }) as InkLayer;
  const layer = opts.spyLayer ? spy(real, log, 'W') : real;
  const resolver = fakeResolver(document);
  const timings: Rig['timings'] = [];
  const changes: Rig['changes'] = [];
  const host: PlacerHost = {
    doc: document,
    resolver,
    layer,
    onChange: (placed, unplaced) => changes.push({ placed, unplaced }),
    onTiming: (name, ms) => {
      timings.push({ name, ms });
      if (name === 'place.pass') log.push('|');
    },
  };
  if (opts.now) host.now = opts.now;
  const placer = createPlacer(host);
  cleanups.push(() => {
    placer.destroy();
    real.destroy();
  });
  return { placer, layer, resolver, log, timings, changes };
}

const settle = async (r: Rig, cond: () => boolean = () => true, timeout = 15_000): Promise<void> => {
  await vi.waitFor(
    () => {
      if (!cond()) throw new Error('not yet');
    },
    { timeout, interval: 10 },
  );
  void r;
};

function pathTop(layer: InkLayer, strokeId: string): DOMRect {
  const p = layer.root.querySelector(`[data-stroke="${strokeId}"]`);
  if (!p) throw new Error(`no path for ${strokeId}`);
  return p.getBoundingClientRect();
}

describe('placement', () => {
  test('places a note at its anchor pose and answers get, all and toLocal', async () => {
    const p = para('a', 'position:absolute;left:100px;top:200px;width:300px');
    const r = rig();
    const n = inkNote('a');
    r.placer.setNotes([n]);
    await settle(r, () => !!r.placer.get(n.id));
    const pl = r.placer.get(n.id)!;
    expect(pl.origin).toEqual({ x: 100, y: 200 });
    expect(pl.scale).toBe(1);
    expect(pl.docked).toBe(false);
    expect(pl.anchorBox.w).toBeCloseTo(p.getBoundingClientRect().width, 0);
    expect(r.placer.all().map((x) => x.id)).toEqual([n.id]);
    expect(r.placer.toLocal(n.id, { x: 110, y: 220 })).toEqual({ x: 10, y: 20 });
    expect(r.placer.toLocal('nope', { x: 0, y: 0 })).toBeUndefined();
    const box = pathTop(r.layer, n.strokes[0]!.id);
    expect(box.left).toBeGreaterThanOrEqual(99);
    expect(box.top).toBeGreaterThanOrEqual(199);
    expect(r.changes.at(-1)!.placed.length).toBe(1);
  });

  test('upsert with a known pose draws at once and does not jump', async () => {
    para('a', 'position:absolute;left:100px;top:200px;width:300px');
    const r = rig();
    r.resolver.nudge = { x: 7, y: 7 };
    const n = inkNote('a');
    r.placer.upsert(n, { origin: { x: 100, y: 200 }, scale: 1 });
    // Drawn before any frame, with no resolve.
    expect(r.resolver.calls).toBe(0);
    expect(r.placer.get(n.id)!.origin).toEqual({ x: 100, y: 200 });
    expect(r.layer.root.querySelector(`[data-stroke="${n.strokes[0]!.id}"]`)).not.toBeNull();
    await frame();
    await frame();
    expect(r.placer.get(n.id)!.origin).toEqual({ x: 100, y: 200 });
    // A real page change places it from the anchor again.
    r.placer.refresh('test');
    await settle(r, () => r.placer.get(n.id)!.origin.x === 107);
  });

  test('upsert without a pose, then remove', async () => {
    para('a', 'position:absolute;left:10px;top:10px;width:300px');
    const r = rig();
    const n = inkNote('a');
    r.placer.upsert(n);
    await settle(r, () => !!r.placer.get(n.id));
    const more = { ...n, strokes: [...n.strokes, squiggle()] };
    r.placer.upsert(more);
    await settle(r, () => !!r.layer.root.querySelector(`[data-stroke="${more.strokes[1]!.id}"]`));
    r.placer.remove(n.id);
    expect(r.placer.get(n.id)).toBeUndefined();
    expect(r.layer.drawn()).toEqual([]);
  });

  test('setNotes replaces the set', async () => {
    para('a');
    para('b');
    const r = rig();
    const a = inkNote('a');
    const b = inkNote('b');
    r.placer.setNotes([a, b]);
    await settle(r, () => r.placer.all().length === 2);
    r.placer.setNotes([b]);
    await settle(r, () => r.placer.all().length === 1);
    expect(r.layer.drawn()).toEqual([b.id]);
  });

  test('text marks are drawn from the range rects in document space', async () => {
    addSpacer(500);
    const p = para('t', 'width:200px', 'one two three four five six seven eight nine ten eleven twelve');
    addSpacer(3000);
    window.scrollTo(0, 300);
    expect(window.scrollY).toBe(300);
    const r = rig();
    const m = markNote('t', 4, 50);
    r.placer.setNotes([m]);
    await settle(r, () => !!r.placer.get(m.id));
    const range = document.createRange();
    range.setStart(p.firstChild!, 4);
    range.setEnd(p.firstChild!, 50);
    const lines = [...range.getClientRects()].filter((q) => q.width > 0);
    expect(lines.length).toBeGreaterThan(1);
    const pl = r.placer.get(m.id)!;
    expect(pl.bbox.y).toBeCloseTo(lines[0]!.top + 300, 0);
    const path = r.layer.root.querySelector('[data-mark="highlight"]')!.getBoundingClientRect();
    expect(path.top).toBeLessThan(lines[0]!.top + 2);
    expect(path.bottom).toBeGreaterThan(lines.at(-1)!.bottom - 2);
  });
});

function addSpacer(h: number, parent: Element = stage): HTMLElement {
  const d = document.createElement('div');
  d.style.height = `${h}px`;
  parent.append(d);
  return d;
}

describe('batching', () => {
  // The placer ends a pass when its clock says the time budget is spent, and goes on in
  // the next frame or idle slot. Here the test drives that clock, so where a pass ends never
  // depends on how busy the machine is. Step 0 never runs out. Step 2 runs out every few notes,
  // so the continuation passes are checked too.
  const clocks = [
    ['a clock that never runs out', 0],
    ['every pass cut short by its budget', 2],
  ] as const;
  for (const [name, step] of clocks) {
    test(`no layout read happens after the first write in a pass, with ${name}`, async () => {
      const log: string[] = [];
      const R = (key: string) => () => log.push(`R:${key}`);
      const restore: (() => void)[] = [];
      const wrap = <T extends object>(proto: T, key: keyof T & string) => {
        const orig = proto[key] as unknown as (...a: unknown[]) => unknown;
        const tap = R(key);
        (proto as Record<string, unknown>)[key] = function (this: unknown, ...a: unknown[]) {
          tap();
          return orig.apply(this, a);
        };
        restore.push(() => {
          (proto as Record<string, unknown>)[key] = orig;
        });
      };

      // A fixed width, so the resize below changes every anchor whatever the viewport is.
      stage.style.width = '400px';
      const sc = document.createElement('div');
      sc.dataset.scroller = '';
      sc.style.cssText = 'height:150px;overflow:auto';
      stage.append(sc);
      para('in-sc', '', 'scrolling text', sc);
      addSpacer(600, sc);
      const notes: Note[] = [inkNote('in-sc')];
      for (let i = 0; i < 30; i++) {
        para(`p${i}`, 'width:60%');
        notes.push(inkNote(`p${i}`, { place: i % 3 === 0 ? 'right' : 'on' }));
        if (i % 5 === 0) notes.push(markNote(`p${i}`, 0, 20));
      }
      let clock = 1000;
      const r = rig({ spyLayer: true, log, now: () => (clock += step) });
      wrap(Element.prototype, 'getBoundingClientRect');
      wrap(Element.prototype, 'getClientRects');
      wrap(Range.prototype, 'getClientRects');
      wrap(Range.prototype, 'getBoundingClientRect');
      const origResolve = r.resolver.resolve;
      r.resolver.resolve = (a, f) => {
        log.push('R:resolve');
        return origResolve(a, f);
      };
      let before = 0;
      try {
        r.placer.setNotes(notes);
        // Every note is placed and drawn, with nothing left for later.
        await settle(r, () => r.timings.some((t) => t.name === 'place.all'), 10000);
        before = log.filter((e) => e === '|').length;
        stage.style.width = '700px';
        // Paragraphs grow from 240 to 420 px. Every note has been placed again at the new width.
        await settle(
          r,
          () => r.placer.all().length === notes.length && r.placer.all().every((p) => p.anchorBox.w >= 419),
          10000,
        );
      } finally {
        for (const f of restore) f();
      }
      const passes = log.join(' ').split('|');
      expect(passes.length).toBeGreaterThan(2);
      if (step) {
        // The budget did split the work: the 37 notes took many passes, both before and after the resize.
        expect(before).toBeGreaterThan(4);
        expect(passes.length - 1 - before).toBeGreaterThan(4);
      }
      let writes = 0;
      for (const pass of passes) {
        const ev = pass.trim().split(' ').filter(Boolean);
        const firstWrite = ev.findIndex((e) => e.startsWith('W:'));
        if (firstWrite < 0) continue;
        writes++;
        const lateRead = ev.slice(firstWrite).find((e) => e.startsWith('R:'));
        expect(lateRead, `read after write in pass: ${pass.slice(0, 200)}`).toBeUndefined();
      }
      expect(writes).toBeGreaterThan(1);
    });
  }
});

describe('near the viewport first', () => {
  test('notes within two screens are drawn in the first pass, the rest later', async () => {
    const vh = window.innerHeight;
    const notes: Note[] = [];
    for (let i = 0; i < 200; i++) {
      para(`p${i}`, 'height:100px');
      notes.push(inkNote(`p${i}`));
    }
    window.scrollTo(0, 100 * 100);
    const log: string[] = [];
    const r = rig({ spyLayer: true, log });
    // Reverse order, so ordering cannot come from the input.
    r.placer.setNotes([...notes].reverse());
    await settle(r, () => r.layer.drawn().length === 200);
    const first = log.join(' ').split('|')[0]!;
    const firstDrawn = (first.match(/W:drawNote/g) ?? []).length;
    expect(firstDrawn).toBeGreaterThan(0);
    expect(firstDrawn).toBeLessThan(200);
    // Everything drawn in the first pass is near; the order of drawNote calls tells which.
    const order: string[] = [];
    const r2 = rig();
    const orig = r2.layer.drawNote;
    r2.layer.drawNote = (n, pose) => {
      order.push(n.id);
      orig(n, pose);
    };
    r2.placer.setNotes([...notes].reverse());
    await settle(r2, () => order.length === 200);
    const near = (id: string) => {
      const pl = r2.placer.get(id)!;
      return pl.bbox.y + pl.bbox.h >= 10000 - 2 * vh && pl.bbox.y <= 10000 + 3 * vh;
    };
    const firstFar = order.findIndex((id) => !near(id));
    expect(firstFar).toBeGreaterThan(0);
    expect(order.slice(firstFar).every((id) => !near(id))).toBe(true);
    expect(r.timings.find((t) => t.name === 'place.first')).toBeDefined();
  });
});

describe('re-placement triggers', () => {
  test('a resize of the anchor moves a margin note', async () => {
    const p = para('a', 'width:300px');
    const r = rig();
    const n = inkNote('a', { place: 'right', strokes: [squiggle(60, 20)] });
    r.placer.setNotes([n]);
    await settle(r, () => !!r.placer.get(n.id));
    expect(r.placer.get(n.id)!.origin.x).toBeCloseTo(300, 0);
    p.style.width = '250px';
    await settle(r, () => Math.abs(r.placer.get(n.id)!.origin.x - 250) < 1);
    expect(pathTop(r.layer, n.strokes[0]!.id).left).toBeLessThan(260);
  });

  test('a resize before the first observer report on a new anchor still moves the note', async () => {
    const p = para('a', 'width:300px');
    const r = rig();
    const n = inkNote('a', { place: 'right', strokes: [squiggle(60, 20)] });
    r.placer.setNotes([n]);
    // Runs in the same frame as the first pass, after it: the anchor is observed from here on,
    // and the observer's first report already carries the new size.
    requestAnimationFrame(() => {
      p.style.width = '250px';
    });
    await settle(r, () => !!r.placer.get(n.id));
    for (let i = 0; i < 6; i++) await frame();
    await settle(r, () => Math.abs(r.placer.get(n.id)!.origin.x - 250) < 1);
  });

  test('a font size change rescales the note', async () => {
    para('a', 'font-size:1rem;width:300px');
    const r = rig();
    const n = inkNote('a');
    r.placer.setNotes([n]);
    await settle(r, () => r.placer.get(n.id)?.scale === 1);
    document.documentElement.style.fontSize = '20px';
    await settle(r, () => r.placer.get(n.id)?.scale === 1.25);
  });

  test('an image load above the anchor moves the note', async () => {
    // Fixed sizes, so only the load event can tell the placer.
    stage.style.cssText = 'height:3000px;overflow:hidden';
    const img = document.createElement('img');
    img.style.cssText = 'display:block';
    stage.append(img);
    para('a', 'width:300px');
    const r = rig();
    const n = inkNote('a');
    r.placer.setNotes([n]);
    await settle(r, () => !!r.placer.get(n.id));
    const y0 = r.placer.get(n.id)!.origin.y;
    const c = document.createElement('canvas');
    c.width = 10;
    c.height = 120;
    img.src = c.toDataURL('image/png');
    await settle(r, () => Math.abs(r.placer.get(n.id)!.origin.y - (y0 + 120)) < 1);
  });

  test('content inserted above the anchor moves the note and refreshes the resolver', async () => {
    para('a', 'width:300px');
    const r = rig();
    const n = inkNote('a');
    r.placer.setNotes([n]);
    await settle(r, () => !!r.placer.get(n.id));
    const y0 = r.placer.get(n.id)!.origin.y;
    const inv = r.resolver.invalidations;
    stage.prepend(addSpacer(300));
    await settle(r, () => Math.abs(r.placer.get(n.id)!.origin.y - (y0 + 300)) < 1);
    expect(r.resolver.invalidations).toBeGreaterThan(inv);
  });

  test('a note whose content is missing waits and attaches when it appears', async () => {
    const r = rig();
    const n = inkNote('late');
    r.placer.setNotes([n]);
    await settle(r, () => r.placer.unplaced().length === 1);
    expect(r.changes.at(-1)!.unplaced.map((x) => x.id)).toEqual([n.id]);
    expect(r.layer.drawn()).toEqual([]);
    para('late');
    // How soon is a budget, measured in budget.browser.test.ts.
    await settle(r, () => r.layer.drawn().includes(n.id));
    expect(r.placer.unplaced()).toEqual([]);
  });

  test('a note whose content goes away is taken off the layer and reported', async () => {
    const p = para('gone');
    const r = rig();
    const n = inkNote('gone');
    r.placer.setNotes([n]);
    await settle(r, () => r.layer.drawn().includes(n.id));
    p.remove();
    await settle(r, () => r.placer.unplaced().length === 1);
    expect(r.layer.drawn()).toEqual([]);
  });

  test('changes inside our own layer start no pass', async () => {
    para('a');
    const r = rig();
    r.placer.setNotes([inkNote('a')]);
    await settle(r, () => r.placer.all().length === 1);
    await quiet();
    const passes = r.timings.filter((t) => t.name === 'place.pass').length;
    r.layer.setBadge(3);
    r.layer.setSelected([r.placer.all()[0]!.id]);
    const other = createLayer(document);
    other.destroy();
    await quiet();
    expect(r.timings.filter((t) => t.name === 'place.pass').length).toBe(passes);
  });
});

describe('more triggers', () => {
  const events: [string, () => void][] = [
    ['web font load', () => document.fonts.dispatchEvent(new Event('loadingdone'))],
    ['orientation change', () => window.dispatchEvent(new Event('orientationchange'))],
    ['visual viewport resize', () => window.visualViewport!.dispatchEvent(new Event('resize'))],
  ];
  for (const [name, fire] of events) {
    test(`${name} starts a pass`, async () => {
      // A move that no observer can see: only the event tells the placer.
      // The move comes from a constructed style sheet, which no mutation observer reports.
      stage.style.cssText = 'position:relative;height:2000px;overflow:hidden';
      para('a', 'width:300px');
      const r = rig();
      const n = inkNote('a');
      r.placer.setNotes([n]);
      await settle(r, () => !!r.placer.get(n.id));
      await quiet();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('#stage{top:90px}');
      // The array is live, so it is copied.
      const before = [...document.adoptedStyleSheets];
      document.adoptedStyleSheets = [...before, sheet];
      cleanups.push(() => {
        document.adoptedStyleSheets = before;
      });
      expect(document.getElementById('a')!.getBoundingClientRect().top).toBeCloseTo(90, 0);
      // Nothing is scheduled, so without the event the note stays where it was.
      await quiet();
      expect(r.placer.get(n.id)!.origin.y).toBeCloseTo(0, 0);
      fire();
      await settle(r, () => Math.abs(r.placer.get(n.id)!.origin.y - 90) < 1);
    });
  }

  test('a pass where nothing moved makes no layer calls', async () => {
    for (let i = 0; i < 10; i++) para(`p${i}`);
    const log: string[] = [];
    const r = rig({ spyLayer: true, log });
    r.placer.setNotes(Array.from({ length: 10 }, (_, i) => inkNote(`p${i}`)));
    await settle(r, () => r.timings.some((t) => t.name === 'place.all'));
    await quiet();
    log.length = 0;
    r.placer.refresh('test');
    await settle(r, () => log.includes('|'));
    expect(log.filter((e) => /^W:(draw|remove|setScroller)/.test(e))).toEqual([]);
  });

  test('the layer theme follows a page theme switch on body', async () => {
    para('a');
    const real = createLayer(document, { theme: 'auto' }) as InkLayer;
    const placer = createPlacer({ doc: document, resolver: fakeResolver(document), layer: real });
    cleanups.push(() => {
      placer.destroy();
      real.destroy();
    });
    placer.setNotes([inkNote('a')]);
    await settle({} as Rig, () => placer.all().length === 1);
    expect(real.theme()).toBe('light');
    document.body.style.background = '#101010';
    await settle({} as Rig, () => real.theme() === 'dark');
  });
});

describe('inner scrollers and pinned content', () => {
  test('scroller notes follow its scroll and are clipped to it', async () => {
    const sc = document.createElement('div');
    sc.dataset.scroller = '';
    sc.style.cssText = 'position:absolute;left:40px;top:60px;width:300px;height:200px;overflow:auto';
    stage.append(sc);
    addSpacer(100, sc);
    para('in', '', 'inside', sc);
    addSpacer(1000, sc);
    const r = rig();
    const n = inkNote('in');
    r.placer.setNotes([n]);
    await settle(r, () => r.layer.drawn().includes(n.id));
    const before = pathTop(r.layer, n.strokes[0]!.id).top;
    const y0 = r.placer.get(n.id)!.origin.y;
    sc.scrollTop = 50;
    await settle(r, () => Math.abs(pathTop(r.layer, n.strokes[0]!.id).top - (before - 50)) < 1);
    expect(r.placer.get(n.id)!.origin.y).toBeCloseTo(y0 - 50, 0);
    const clip = r.layer.root.querySelector(`[data-stroke="${n.strokes[0]!.id}"]`)!.closest('svg')!;
    expect(clip.getAttribute('overflow')).toBe('hidden');
    expect([clip.getAttribute('x'), clip.getAttribute('y')]).toEqual(['40', '60']);
  });

  test('a note just written with a known pose moves into its scroller and follows it', async () => {
    const sc = document.createElement('div');
    sc.dataset.scroller = '';
    sc.style.cssText = 'position:absolute;left:40px;top:60px;width:300px;height:200px;overflow:auto';
    stage.append(sc);
    addSpacer(100, sc);
    const p = para('in', '', 'inside', sc);
    addSpacer(1000, sc);
    const r = rig();
    const n = inkNote('in');
    const pr = p.getBoundingClientRect();
    r.placer.upsert(n, { origin: { x: pr.left + scrollX, y: pr.top + scrollY }, scale: 1 });
    await settle(r, () => r.layer.drawn().includes(n.id));
    await frame();
    await frame();
    const before = pathTop(r.layer, n.strokes[0]!.id).top;
    sc.scrollTop = 50;
    await settle(r, () => Math.abs(pathTop(r.layer, n.strokes[0]!.id).top - (before - 50)) < 1);
    expect(pathTop(r.layer, n.strokes[0]!.id).top).toBeCloseTo(before - 50, 0);
  });

  test('pinned notes follow the viewport, with a window listener only while they exist', async () => {
    addSpacer(4000);
    const bar = document.createElement('div');
    bar.dataset.pinned = '';
    bar.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:40px;background:#eee';
    stage.append(bar);
    para('fx', '', 'fixed text', bar);
    const added: string[] = [];
    const removed: string[] = [];
    const add = window.addEventListener;
    const rem = window.removeEventListener;
    window.addEventListener = function (this: Window, type: string, ...rest: unknown[]) {
      added.push(type);
      return (add as (...a: unknown[]) => void).call(this, type, ...rest);
    } as typeof window.addEventListener;
    window.removeEventListener = function (this: Window, type: string, ...rest: unknown[]) {
      removed.push(type);
      return (rem as (...a: unknown[]) => void).call(this, type, ...rest);
    } as typeof window.removeEventListener;
    cleanups.push(() => {
      window.addEventListener = add;
      window.removeEventListener = rem;
    });
    const r = rig();
    const n = inkNote('fx');
    r.placer.setNotes([n]);
    await settle(r, () => r.layer.drawn().includes(n.id));
    expect(added.filter((t) => t === 'scroll').length).toBe(1);
    const top0 = pathTop(r.layer, n.strokes[0]!.id).top;
    window.scrollTo(0, 800);
    await frame();
    await frame();
    expect(pathTop(r.layer, n.strokes[0]!.id).top).toBeCloseTo(top0, 0);
    await settle(r, () => Math.abs(r.placer.get(n.id)!.origin.y - 800) < 1);
    r.placer.remove(n.id);
    expect(removed.filter((t) => t === 'scroll').length).toBe(1);
  });
});

// A note just written is drawn at once where the pen was. Its first pass comes a frame or two
// later. These tests change the page in between, in the same task as the write, so the order
// is fixed: the change always lands before the pass. The clock is held still, so no pass is cut
// short by its time budget.
describe('a change between writing and the first pass', () => {
  // A font load or a dialog event left from page start would also reset the known pose.
  beforeAll(async () => {
    await document.fonts.ready;
    await quiet();
  });
  const corner = (el: Element): { x: number; y: number } => {
    const b = el.getBoundingClientRect();
    return { x: b.left + scrollX, y: b.top + scrollY };
  };
  const pane = (parent: Element = stage, css = 'position:absolute;left:40px;top:60px'): HTMLElement => {
    const sc = document.createElement('div');
    sc.dataset.scroller = '';
    sc.style.cssText = `${css};width:300px;height:200px;overflow:auto`;
    parent.append(sc);
    addSpacer(100, sc);
    return sc;
  };
  /** Writes a note at its anchor and returns how far the ink sits below the anchor on screen. */
  const write = (r: Rig, n: Note, p: Element): number => {
    r.placer.upsert(n, { origin: corner(p), scale: 1 });
    return pathTop(r.layer, n.strokes[0]!.id).top - p.getBoundingClientRect().top;
  };
  const gap = (r: Rig, n: Note, p: Element): number =>
    pathTop(r.layer, n.strokes[0]!.id).top - p.getBoundingClientRect().top;

  test('an inner pane scrolled before the pass: the ink moves with the pane', async () => {
    const sc = pane();
    const p = para('in', '', 'inside', sc);
    addSpacer(1000, sc);
    const r = rig({ now: manualClock().now });
    r.resolver.nudge = { x: 7, y: 7 };
    const n = inkNote('in');
    const off = write(r, n, p);
    const y0 = r.placer.get(n.id)!.origin.y;
    sc.scrollTop = 50;
    await quiet();
    expect(r.resolver.calls).toBeGreaterThan(0);
    expect(gap(r, n, p)).toBeCloseTo(off, 0);
    // Still the pose it was written at, moved by the scroll. Not the resolved one.
    expect(r.placer.get(n.id)!.origin.y).toBeCloseTo(y0 - 50, 1);
    // And it goes on following the pane.
    sc.scrollTop = 120;
    await quiet();
    expect(gap(r, n, p)).toBeCloseTo(off, 0);
  });

  test('a pane nested in another, both scrolled before the pass', async () => {
    const outer = pane();
    const inner = pane(outer, 'position:relative;margin-left:10px');
    addSpacer(1000, outer);
    const p = para('in', '', 'inside', inner);
    addSpacer(1000, inner);
    outer.scrollTop = 20;
    const r = rig({ now: manualClock().now });
    r.resolver.nudge = { x: 7, y: 7 };
    const n = inkNote('in');
    const off = write(r, n, p);
    outer.scrollTop = 60;
    inner.scrollTop = 30;
    await quiet();
    expect(r.resolver.calls).toBeGreaterThan(0);
    expect(gap(r, n, p)).toBeCloseTo(off, 0);
    inner.scrollTop = 80;
    await quiet();
    expect(gap(r, n, p)).toBeCloseTo(off, 0);
  });

  test('the page scrolled before the pass: ink on normal content stays on it', async () => {
    addSpacer(300);
    const p = para('a');
    addSpacer(3000);
    const r = rig({ now: manualClock().now });
    r.resolver.nudge = { x: 7, y: 7 };
    const n = inkNote('a');
    const off = write(r, n, p);
    const o = { ...r.placer.get(n.id)!.origin };
    window.scrollTo(0, 250);
    await quiet();
    expect(r.resolver.calls).toBeGreaterThan(0);
    expect(gap(r, n, p)).toBeCloseTo(off, 0);
    expect(r.placer.get(n.id)!.origin).toEqual(o);
  });

  test('fixed content, the page scrolled before the pass and after it: the ink stays on it', async () => {
    addSpacer(4000);
    const bar = document.createElement('div');
    bar.dataset.pinned = '';
    bar.style.cssText = 'position:fixed;left:0;top:40px;width:400px;height:40px';
    stage.append(bar);
    const p = para('fx', '', 'fixed text', bar);
    const r = rig({ now: manualClock().now });
    r.resolver.nudge = { x: 7, y: 7 };
    const n = inkNote('fx');
    const off = write(r, n, p);
    window.scrollTo(0, 300);
    await quiet();
    expect(r.resolver.calls).toBeGreaterThan(0);
    expect(gap(r, n, p)).toBeCloseTo(off, 0);
    window.scrollTo(0, 700);
    await quiet();
    expect(gap(r, n, p)).toBeCloseTo(off, 0);
  });

  test('sticky content that sticks before the pass: the ink stays on it', async () => {
    addSpacer(100);
    const bar = document.createElement('div');
    bar.dataset.pinned = '';
    bar.style.cssText = 'position:sticky;top:0;height:40px;background:#eee';
    stage.append(bar);
    const p = para('st', '', 'sticky text', bar);
    addSpacer(4000);
    const r = rig({ now: manualClock().now });
    r.resolver.nudge = { x: 7, y: 7 };
    const n = inkNote('st');
    const off = write(r, n, p);
    window.scrollTo(0, 300);
    await quiet();
    expect(r.resolver.calls).toBeGreaterThan(0);
    expect(p.getBoundingClientRect().top).toBeCloseTo(0, 0);
    expect(gap(r, n, p)).toBeCloseTo(off, 0);
  });

  test('a resize before the pass places the note from its anchor again', async () => {
    const p = para('a', 'position:absolute;left:100px;top:200px;width:300px');
    const r = rig({ now: manualClock().now });
    r.resolver.nudge = { x: 7, y: 7 };
    const n = inkNote('a');
    write(r, n, p);
    p.style.left = '150px';
    window.dispatchEvent(new Event('resize'));
    await quiet();
    expect(r.placer.get(n.id)!.origin).toEqual({ x: 157, y: 207 });
  });

  test('a font load before the pass rescales the note from its anchor', async () => {
    const p = para('a', 'position:absolute;left:100px;top:200px;width:300px');
    const r = rig({ now: manualClock().now });
    r.resolver.nudge = { x: 7, y: 7 };
    const n = inkNote('a');
    write(r, n, p);
    p.style.fontSize = '24px';
    document.fonts.dispatchEvent(new Event('loadingdone'));
    await quiet();
    expect(r.placer.get(n.id)!.scale).toBeCloseTo(1.5, 3);
    expect(r.placer.get(n.id)!.origin).toEqual({ x: 107, y: 207 });
  });

  test('a pane in a modal dialog scrolled before the pass: the ink moves with it', async () => {
    const dlg = document.createElement('dialog');
    dlg.style.cssText = 'padding:0;border:0;margin:40px;width:320px;height:240px';
    stage.append(dlg);
    dlg.showModal();
    cleanups.push(() => dlg.close());
    // The dialog's own toggle event comes a task later. Let it pass before the test starts.
    await quiet();
    const sc = pane(dlg, 'position:relative');
    const p = para('in', '', 'inside', sc);
    addSpacer(1000, sc);
    const r = rig({ now: manualClock().now });
    r.resolver.nudge = { x: 7, y: 7 };
    const n = inkNote('in');
    // The top layer host has a closed root, so the drawing is checked through its pose.
    r.placer.upsert(n, { origin: corner(p), scale: 1 });
    sc.scrollTop = 50;
    await quiet();
    expect(r.resolver.calls).toBeGreaterThan(0);
    expect(r.layer.drawn()).toContain(n.id);
    const o = r.placer.get(n.id)!.origin;
    expect(o.x).toBeCloseTo(corner(p).x, 1);
    expect(o.y).toBeCloseTo(corner(p).y, 1);
  });
});

describe('docking', () => {
  test('a margin note on a narrow viewport docks below its paragraph, readable, with a leader line', async () => {
    const w0 = window.innerWidth;
    const h0 = window.innerHeight;
    await page.viewport(500, 700);
    cleanups.push(() => void page.viewport(w0, h0));
    // Lines that fill the width, so no ragged line end leaves room beside the text.
    para(
      'a',
      'width:300px;margin:0 auto;text-align:justify;text-align-last:justify',
      'A paragraph with a note in its right margin.',
    );
    // Text below that runs to several lines with any font, so the ink written on it stays within
    // its lines and leaves the space under them free.
    const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
    para('b', 'width:300px;margin:0 auto', text.repeat(4));
    const r = rig();
    const n = inkNote('a', { place: 'right', strokes: [squiggle(150, 40)] });
    const on = inkNote('b', { place: 'on', strokes: [squiggle(800, 40)] });
    r.placer.setNotes([n, on]);
    await settle(r, () => r.placer.all().length === 2);
    const pl = r.placer.get(n.id)!;
    expect(pl.docked).toBe(true);
    // The sides have 100 px each, which would shrink the ink to about half. Below, it keeps its size.
    expect(pl.scale).toBeGreaterThanOrEqual(0.75);
    expect(pl.bbox.y).toBeGreaterThanOrEqual(pl.anchorBox.y + pl.anchorBox.h);
    expect(pl.bbox.x).toBeGreaterThanOrEqual(0);
    expect(pl.bbox.x + pl.bbox.w).toBeLessThanOrEqual(document.documentElement.clientWidth);
    expect(r.layer.root.querySelector('.lead')).not.toBeNull();
    expect(r.placer.get(on.id)!.docked).toBe(false);
  });

  test('two docked notes beside one paragraph do not overlap', async () => {
    para('a', 'width:300px;margin-left:20px', 'Paragraph text that is long enough to wrap onto a few lines.');
    const r = rig();
    const a = inkNote('a', { place: 'right', strokes: [squiggle(4000, 30)] });
    const b = inkNote('a', { place: 'right', strokes: [squiggle(4000, 30)] });
    r.placer.setNotes([a, b]);
    await settle(r, () => r.placer.all().length === 2);
    const pa = r.placer.get(a.id)!;
    const pb = r.placer.get(b.id)!;
    expect(pa.docked && pb.docked).toBe(true);
    const overlap =
      pa.bbox.x < pb.bbox.x + pb.bbox.w &&
      pb.bbox.x < pa.bbox.x + pa.bbox.w &&
      pa.bbox.y < pb.bbox.y + pb.bbox.h &&
      pb.bbox.y < pa.bbox.y + pa.bbox.h;
    expect(overlap).toBe(false);
  });
});

describe('cost', () => {
  // The Long Tasks API exists only in Chromium, so WebKit and Firefox cannot measure this.
  const longTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
  // A budget test: the limit grows with a workload measured in the same run (testkit.budget).
  test.runIf(longTasks)(
    'budget: 200 notes, no long task over 50 ms, and timing marks are reported',
    async () => {
      const strokes = () => Array.from({ length: 12 }, () => squiggle(160, 40, 40));
      const notes: Note[] = [];
      for (let i = 0; i < 200; i++) {
        para(
          `p${i}`,
          'width:60%',
          `Paragraph ${i}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.`,
        );
        notes.push(
          i % 4 === 3
            ? markNote(`p${i}`, 0, 40)
            : inkNote(`p${i}`, { strokes: strokes(), place: i % 5 === 0 ? 'right' : 'on' }),
        );
      }
      window.scrollTo(0, 3000);
      // Measured before the long task observer starts: the calibration is one long task itself.
      const limit = budget(50);
      // Its long task ends before the observer starts.
      await frame();
      const long: number[] = [];
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) long.push(e.duration);
      });
      po.observe({ type: 'longtask', buffered: false });
      cleanups.push(() => po.disconnect());
      // Prove the observer sees long tasks in this frame before trusting an empty list.
      await new Promise<void>((done) =>
        setTimeout(() => {
          const t = performance.now();
          while (performance.now() - t < 70) {}
          done();
        }, 0),
      );
      await vi.waitFor(() => expect(long.some((d) => d >= 60)).toBe(true), { timeout: 2000 });
      long.length = 0;
      await frame();
      const r = rig();
      r.placer.setNotes(notes);
      await settle(r, () => r.timings.some((t) => t.name === 'place.all'));
      await quiet();
      const passes = r.timings.filter((t) => t.name === 'place.pass').map((t) => t.ms);
      const first = r.timings.find((t) => t.name === 'place.first')!.ms;
      const all = r.timings.find((t) => t.name === 'place.all')!.ms;
      const report = {
        first: Math.round(first * 10) / 10,
        all: Math.round(all * 10) / 10,
        passes: passes.length,
        maxPass: Math.round(Math.max(...passes) * 10) / 10,
        longTasks: long.map((d) => Math.round(d)),
      };
      console.log(`TIMING 200 notes ${JSON.stringify(report)}`);
      expect(r.layer.drawn().length).toBe(200);
      expect(Math.max(...passes)).toBeLessThan(limit);
      expect(long.filter((d) => d > limit)).toEqual([]);

      // A resize that moves every note stays chunked too.
      long.length = 0;
      r.timings.length = 0;
      stage.style.width = '80%';
      await settle(r, () => r.timings.some((t) => t.name === 'place.pass'));
      await quiet();
      const rp = r.timings.filter((t) => t.name === 'place.pass').map((t) => t.ms);
      console.log(
        `TIMING 200 notes resize ${JSON.stringify({ passes: rp.length, maxPass: Math.round(Math.max(...rp) * 10) / 10, longTasks: long.map(Math.round) })}`,
      );
      expect(Math.max(...rp)).toBeLessThan(limit);
      expect(long.filter((d) => d > limit)).toEqual([]);
    },
  );

  test('no scroll listener and no work on scroll for a normal page', async () => {
    const types: string[] = [];
    const targets = [window, document] as EventTarget[];
    const origs = targets.map((t) => t.addEventListener);
    targets.forEach((t, i) => {
      t.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
        types.push(type);
        return (origs[i] as (...a: unknown[]) => void).call(this, type, ...rest);
      } as typeof t.addEventListener;
    });
    cleanups.push(() => {
      targets.forEach((t, i) => {
        t.addEventListener = origs[i]!;
      });
    });
    for (let i = 0; i < 40; i++) para(`p${i}`, 'height:100px');
    const r = rig();
    r.placer.setNotes(Array.from({ length: 40 }, (_, i) => inkNote(`p${i}`)));
    await settle(r, () => r.timings.some((t) => t.name === 'place.all'));
    await quiet();
    expect(types).not.toContain('scroll');
    expect(types).not.toContain('wheel');
    const passes = r.timings.length;
    window.scrollTo(0, 1500);
    await frame();
    await frame();
    window.scrollTo(0, 2500);
    await frame();
    await frame();
    expect(r.timings.length).toBe(passes);
  });

  test('destroy removes every listener, observer and drawing', async () => {
    const live = new Set<string>();
    const tag = (t: EventTarget, type: string) =>
      `${t === window ? 'win' : t === document ? 'doc' : 'el'}:${type}`;
    const proto = EventTarget.prototype;
    const add = proto.addEventListener;
    const rem = proto.removeEventListener;
    proto.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      live.add(tag(this, type));
      return (add as (...a: unknown[]) => void).call(this, type, ...rest);
    } as typeof proto.addEventListener;
    proto.removeEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      live.delete(tag(this, type));
      return (rem as (...a: unknown[]) => void).call(this, type, ...rest);
    } as typeof proto.removeEventListener;
    const observers: { disconnected: boolean }[] = [];
    const RO = window.ResizeObserver;
    const MO = window.MutationObserver;
    window.ResizeObserver = class extends RO {
      rec = { disconnected: false };
      constructor(cb: ResizeObserverCallback) {
        super(cb);
        observers.push(this.rec);
      }
      override disconnect() {
        this.rec.disconnected = true;
        super.disconnect();
      }
    };
    window.MutationObserver = class extends MO {
      rec = { disconnected: false };
      constructor(cb: MutationCallback) {
        super(cb);
        observers.push(this.rec);
      }
      override disconnect() {
        this.rec.disconnected = true;
        super.disconnect();
      }
    };
    cleanups.push(() => {
      proto.addEventListener = add;
      proto.removeEventListener = rem;
      window.ResizeObserver = RO;
      window.MutationObserver = MO;
    });

    const sc = document.createElement('div');
    sc.dataset.scroller = '';
    sc.style.cssText = 'height:100px;overflow:auto';
    stage.append(sc);
    para('in', '', 'inside', sc);
    addSpacer(500, sc);
    const bar = document.createElement('div');
    bar.dataset.pinned = '';
    bar.style.cssText = 'position:fixed;left:0;bottom:0';
    stage.append(bar);
    para('fx', '', 'fixed', bar);
    para('a');
    const layer = createLayer(document) as InkLayer;
    const placer = createPlacer({ doc: document, resolver: fakeResolver(document), layer });
    placer.setNotes([inkNote('in'), inkNote('fx'), inkNote('a'), inkNote('missing')]);
    await settle({} as Rig, () => placer.all().length === 3);
    expect(live.size).toBeGreaterThan(0);
    placer.destroy();
    layer.destroy();
    expect([...live]).toEqual([]);
    expect(observers.length).toBeGreaterThan(0);
    expect(observers.every((o) => o.disconnected)).toBe(true);
    expect(document.querySelector('ink-layer')).toBeNull();
    // Nothing runs after destroy.
    para('missing');
    await quiet();
    expect(placer.all()).toEqual([]);
  });
});
