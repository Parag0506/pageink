// Placement while the document text is not built: the quick rung, slices, bounded passes.
// The placer runs on a clock the test moves, and the text is built only when the test lets it,
// so what a pass does never depends on how busy the machine is.
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { InkLayer } from '../render/layer';
import { createLayer } from '../render/layer';
import type { Anchor, NoteFrame, Placer, Resolved, Resolver } from '../types';
import { createPlacer } from './placer';
import { fakeResolver, frame, inkNote, manualClock, until } from './testkit';

const cleanups: (() => void)[] = [];
let stage: HTMLElement;

beforeEach(() => {
  clock = manualClock();
  document.body.style.cssText = 'margin:0;padding:0;font:16px/1.5 sans-serif;background:#fff';
  stage = document.createElement('div');
  document.body.append(stage);
  cleanups.push(() => stage.remove());
});

afterEach(async () => {
  while (cleanups.length) cleanups.pop()!();
  window.scrollTo(0, 0);
  await frame();
});

function paras(n: number, from = 0): void {
  for (let i = from; i < from + n; i++) {
    const p = document.createElement('p');
    p.id = `q${i}`;
    p.textContent = `Paragraph ${i} with some words to hold a note.`;
    p.style.margin = '0 0 8px';
    stage.append(p);
  }
}

/** The placer's clock. It moves only when the test or a resolve moves it. */
let clock = manualClock();

/**
 * A resolver with the quick rung. The document text takes `slices` calls of prepare() to build,
 * and none of them counts while `gate.held` is true. `quickCan` says which anchors the quick
 * rung decides, `quickAt` moves its answer, `quickMs` is what one quick resolve costs on the clock.
 */
function stagedResolver(o: {
  slices?: number;
  quickMs?: number;
  quickCan?: (a: Anchor) => boolean;
  quickAt?: (a: Anchor) => { x: number; y: number };
  held?: boolean;
}) {
  const base = fakeResolver(document);
  let left = o.slices ?? 3;
  const calls = { quick: 0, full: 0, prepare: 0 };
  const gate = { held: o.held ?? false };
  const r: Resolver = {
    resolve(a: Anchor, f: NoteFrame) {
      calls.full++;
      return base.resolve(a, f);
    },
    invalidate() {
      left = o.slices ?? 3;
    },
    quick(a: Anchor, f: NoteFrame): Resolved | undefined {
      calls.quick++;
      clock.advance(o.quickMs ?? 0);
      if (o.quickCan && !o.quickCan(a)) return undefined;
      const got = base.resolve(a, f);
      if (!got) return undefined;
      if (o.quickAt) got.origin = o.quickAt(a);
      return got;
    },
    locate: (a: Anchor) => (a.path.id ? document.getElementById(a.path.id) : null),
    ready: () => left <= 0,
    prepare() {
      calls.prepare++;
      if (gate.held) return false;
      left--;
      return left <= 0;
    },
  };
  return { r, calls, gate };
}

function rig(resolver: Resolver) {
  const layer = createLayer(document, { theme: 'light' }) as InkLayer;
  const passes: number[] = [];
  const unplaced: number[] = [];
  const placer: Placer = createPlacer({
    doc: document,
    resolver,
    layer,
    onChange: (_p, un) => unplaced.push(un.length),
    onTiming: (name, ms) => {
      if (name === 'place.pass') passes.push(ms);
    },
    now: clock.now,
  });
  cleanups.push(() => {
    placer.destroy();
    layer.destroy();
  });
  return { placer, layer, passes, unplaced };
}

test('every pass stays near its budget, the first one included, even with 300 slow notes', async () => {
  paras(300);
  const { r } = stagedResolver({ quickMs: 0.3, slices: 1000 });
  const g = rig(r);
  g.placer.setNotes(Array.from({ length: 300 }, (_, i) => inkNote(`q${i}`)));
  await until(() => g.passes.length > 3, 'passes');
  // Each quick resolve costs 0.3 ms on the placer's clock, so 300 of them would take 90 ms.
  // The read budget is 6 ms. One more resolve and the writes may follow it.
  expect(Math.max(...g.passes)).toBeLessThan(12);
  expect(Math.max(...g.passes)).toBeGreaterThan(5);
  // Near notes come first: what is on screen is drawn in the first pass.
  expect(g.placer.get(g.placer.all()[0]!.id)).toBeDefined();
  const firstScreen = g.placer.all().filter((p) => p.bbox.y < innerHeight);
  expect(firstScreen.length).toBeGreaterThan(0);
});

test('a pass runs after the browser lays the page out, from a resize observation, not from an animation frame', async () => {
  paras(5);
  const { r } = stagedResolver({ slices: 1 });
  const raf = window.requestAnimationFrame;
  let calls = 0;
  // The first frame callback runs: it adds the observation. The fallback frame never comes,
  // so the pass can only come from the resize observation after layout.
  window.requestAnimationFrame = (cb) => (++calls === 1 ? raf(cb) : 1);
  try {
    const g = rig(r);
    g.placer.setNotes([inkNote('q0'), inkNote('q4')]);
    await until(() => g.placer.all().length === 2, 'placed without the fallback frame');
  } finally {
    window.requestAnimationFrame = raf;
  }
});

test('a note the quick rung places is checked by the full ladder once the text is built, and moves if they differ', async () => {
  paras(5);
  const { r, calls, gate } = stagedResolver({ slices: 2, quickAt: () => ({ x: 3, y: 3 }), held: true });
  const g = rig(r);
  const n = inkNote('q2');
  g.placer.setNotes([n]);
  await until(() => !!g.placer.get(n.id), 'quick place');
  // The text is not built yet, so the full ladder has not run.
  await until(() => calls.prepare > 0, 'a slice tried');
  expect(calls.full).toBe(0);
  expect(g.placer.get(n.id)!.origin).toEqual({ x: 3, y: 3 });
  gate.held = false;
  await until(() => calls.full > 0 && g.placer.get(n.id)!.origin.y !== 3, 'checked and moved');
  const want = document.getElementById('q2')!.getBoundingClientRect();
  expect(g.placer.get(n.id)!.origin.y).toBeCloseTo(want.top + scrollY, 0);
  expect(calls.prepare).toBeGreaterThanOrEqual(2);
});

test('a note the quick rung cannot decide waits for the text instead of going to the tray', async () => {
  paras(5);
  const { r, calls, gate } = stagedResolver({ slices: 4, quickCan: (a) => a.path.id !== 'q1', held: true });
  const g = rig(r);
  const wait = inkNote('q1');
  const gone = inkNote('nowhere');
  g.placer.setNotes([inkNote('q0'), wait, gone]);
  await until(() => g.placer.all().length >= 1, 'first placed');
  // Slices run and the text is still not built: the two notes keep waiting, none goes to the tray.
  await until(() => calls.prepare > 2, 'slices tried');
  expect(g.placer.waiting!()).toBe(2);
  expect(g.placer.unplaced()).toEqual([]);
  gate.held = false;
  await until(() => g.placer.waiting!() === 0, 'decided');
  expect(g.placer.get(wait.id)).toBeDefined();
  expect(g.placer.unplaced().map((x) => x.id)).toEqual([gone.id]);
});

test('a pass in a frame draws only notes on the screen, so it holds back no paint for the rest; idle time draws them', async () => {
  paras(120);
  const vh = innerHeight;
  const { r } = stagedResolver({ slices: 1 });
  // Which callback each drawing happened in: a frame (animation frame or resize observation) or idle time.
  // Browsers without idle callbacks get a timer from the placer instead; there only the passes are checked.
  let inIdle = false;
  let waitingAtIdle = -1;
  let placerRef: Placer | null = null;
  const ric = window.requestIdleCallback as typeof window.requestIdleCallback | undefined;
  if (ric) {
    window.requestIdleCallback = (cb, o) =>
      ric.call(
        window,
        (d) => {
          if (waitingAtIdle < 0 && placerRef) waitingAtIdle = placerRef.waiting!();
          inIdle = true;
          try {
            cb(d);
          } finally {
            inIdle = false;
          }
        },
        o,
      );
    cleanups.push(() => {
      window.requestIdleCallback = ric;
    });
  }
  const g = rig(r);
  placerRef = g.placer;
  const drawn: { id: string; idle: boolean; pass: number }[] = [];
  const orig = g.layer.drawNote;
  g.layer.drawNote = (n, pose) => {
    drawn.push({ id: n.anchor.path.id!, idle: inIdle, pass: g.passes.length });
    orig(n, pose);
  };
  const notes = Array.from({ length: 120 }, (_, i) => inkNote(`q${i}`));
  g.placer.setNotes(notes);
  await until(() => g.passes.length >= 1, 'first pass');
  const top = (id: string) => document.getElementById(id)!.getBoundingClientRect().top + scrollY;
  const first = drawn.filter((d) => d.pass === 0);
  // Every note whose anchor is on the screen is in the first pass, and nothing far below it.
  const onScreen = notes.map((n) => n.anchor.path.id!).filter((id) => top(id) < vh);
  expect(first.map((d) => d.id).sort()).toEqual(expect.arrayContaining(onScreen));
  expect(first.every((d) => top(d.id) < vh * 1.5)).toBe(true);
  expect(first.every((d) => !d.idle)).toBe(true);
  await until(() => g.placer.all().length === 120 && g.placer.waiting!() === 0, 'all placed');
  // The rest of the near band was drawn in idle time, not in a frame.
  const band = drawn.filter((d) => top(d.id) >= vh * 1.5 && top(d.id) < 3 * vh);
  expect(band.length).toBeGreaterThan(0);
  expect(band.every((d) => d.pass > 0)).toBe(true);
  if (ric) {
    expect(band.every((d) => d.idle)).toBe(true);
    // Until then they counted as not decided, so a viewer waiting for its first pass waited for them.
    expect(waitingAtIdle).toBeGreaterThan(0);
  }
});

test('an on-screen note the quick rung cannot decide is decided in the same frame when the text builds within the pass', async () => {
  paras(5);
  const { r, calls } = stagedResolver({ slices: 1, quickCan: (a) => a.path.id !== 'q1' });
  const g = rig(r);
  const wait = inkNote('q1');
  g.placer.setNotes([inkNote('q0'), wait]);
  await until(() => g.passes.length >= 1, 'first pass');
  expect(g.passes).toHaveLength(1);
  expect(calls.full).toBeGreaterThan(0);
  expect(g.placer.get(wait.id)).toBeDefined();
  expect(g.placer.waiting!()).toBe(0);
});

test('a parsed page whose text builds within the pass is read whole first, a longer one gets the quick rung', async () => {
  paras(5);
  const short = stagedResolver({ slices: 1 });
  const g = rig(short.r);
  g.placer.setNotes([inkNote('q0'), inkNote('q1')]);
  await until(() => g.placer.all().length === 2, 'placed');
  expect(g.passes).toHaveLength(1);
  expect(short.calls.quick).toBe(0);
  expect(short.calls.full).toBe(2);
  const long = stagedResolver({ slices: 2, held: true });
  const h = rig(long.r);
  h.placer.setNotes([inkNote('q2'), inkNote('q3')]);
  await until(() => h.placer.all().length === 2, 'placed by the quick rung');
  expect(long.calls.quick).toBe(2);
  expect(long.calls.full).toBe(0);
});

test('a long backlog costs each pass only its budget: anchor boxes read once are kept across passes', async () => {
  paras(600);
  const { r } = stagedResolver({ slices: 2 });
  // Each box read costs 0.05 ms on the placer's clock, so reading all 600 anchors costs 30 ms,
  // five times a frame pass's budget.
  const orig = Element.prototype.getBoundingClientRect;
  let reads = 0;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.id.startsWith('q')) {
      reads++;
      clock.advance(0.05);
    }
    return orig.call(this);
  };
  cleanups.push(() => {
    Element.prototype.getBoundingClientRect = orig;
  });
  const g = rig(r);
  g.placer.setNotes(Array.from({ length: 600 }, (_, i) => inkNote(`q${i}`)));
  await until(() => g.placer.all().length === 600 && g.placer.waiting!() === 0, 'all placed', 20_000);
  // Ordering the backlog in every pass by reading every anchor's box would read each box once
  // per pass, and the budget would leave room for a note or two per pass.
  expect(reads / 600).toBeLessThan(6);
  expect(g.passes.length).toBeLessThan(150);
  expect(Math.max(...g.passes)).toBeLessThan(20);
});

test('notes away from the screen wait for the text: the quick rung is spent on the first screen only', async () => {
  paras(400);
  const { r, calls } = stagedResolver({ slices: 3 });
  const g = rig(r);
  g.placer.setNotes([inkNote('q0'), inkNote('q399')]);
  await until(() => g.placer.waiting!() === 0 && g.placer.all().length === 2, 'both placed');
  expect(calls.quick).toBe(1);
});
