// One placement slice reads layout, then writes, and never reads after it wrote: a read after a
// write makes the browser lay the page out again inside the slice. The docking read for margin
// notes skips content a closed section hides, which the browser would lay out for each read, and
// it stops when the slice's time is up, so an idle slice yields. DESIGN 11.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import type { InkLayer } from '../render/layer';
import { createLayer } from '../render/layer';
import type { Note, Placed, Placer } from '../types';
import { createPlacer } from './placer';
import { fakeResolver, frame, manualClock, margin, quiet, until } from './testkit';

const cleanups: (() => void | Promise<void>)[] = [];
let stage: HTMLElement;
const W0 = window.innerWidth;
const H0 = window.innerHeight;

beforeEach(async () => {
  await page.viewport(390, 844);
  document.body.style.cssText = 'margin:0;padding:0;font:16px/1.5 sans-serif;background:#fff;color:#d00000';
  stage = document.createElement('div');
  stage.id = 'stage';
  stage.style.padding = '0 16px';
  document.body.append(stage);
  await frame();
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  stage.remove();
  document.body.removeAttribute('style');
  window.scrollTo(0, 0);
  await page.viewport(W0, H0);
  await frame();
});

const TEXT =
  'Iron gall ink was the standard writing ink in Europe for over a thousand years. It bites into the paper, so a seed of ink can last as long as the sheet itself.';

function para(id: string, html = TEXT): HTMLElement {
  const p = document.createElement('p');
  p.id = id;
  p.style.margin = '0 0 8px';
  p.innerHTML = html;
  stage.append(p);
  return p;
}

/**
 * A phone article whose margin notes must all dock, with content a closed section skips between
 * the paragraphs: a closed <details>, a box with content-visibility: hidden, a hidden="until-found"
 * box (display: none where that is not known) and, still shown, text inside display: contents.
 * Skipped parts carry data-skip.
 */
function article(n: number): HTMLElement[] {
  const ps: HTMLElement[] = [];
  for (let i = 0; i < n; i++) {
    ps.push(para(`p${i}`, i % 5 === 2 ? `<span style="display:contents">${TEXT}</span>` : TEXT));
    const k = i % 4;
    const box = document.createElement(k === 0 ? 'details' : 'div');
    box.dataset.skip = '';
    if (k === 0) box.innerHTML = `<summary>More</summary><p>${TEXT}</p><p>${TEXT}</p>`;
    else if (k === 1) {
      box.style.contentVisibility = 'hidden';
      box.innerHTML = `<p>${TEXT}</p><p>${TEXT}</p>`;
    } else if (k === 2) {
      box.setAttribute('hidden', 'until-found');
      box.innerHTML = `<p>${TEXT}</p><img width="40" height="40" alt="">`;
    } else continue;
    stage.append(box);
  }
  return ps;
}

/** True for a node that a closed section skips: inside a [data-skip] element, a closed details' summary aside. */
function skipped(n: Node): boolean {
  const el = n instanceof Element ? n : n.parentElement;
  const root = el?.closest('[data-skip]');
  if (!el || !root || root === el) return false;
  if (root.localName === 'details') return el.closest('summary')?.parentElement !== root;
  return true;
}

interface Slice {
  /** A frame pass (a frame or resize observation) or an idle slice (an idle callback or timer). */
  kind: 'frame' | 'idle' | 'other';
  /** Notes whose anchor the slice began to read. */
  notes: number;
  /** Reads made past the slice's budget while a note other than its first was being read. */
  over: number;
  reads: number;
  /** Layout reads made after a DOM write in the same slice. */
  late: string[];
  /** Layout reads of content a closed section skips. */
  skip: string[];
  /** Time the clock moved in the slice: the cost of its reads. */
  ms: number;
}

/**
 * Watch every layout read and DOM write the page's own code makes. A slice is one callback the
 * browser runs: a frame, an idle callback, a timer or a resize or mutation observation. With a
 * clock, every text box read moves it by `perRead` ms, so the code under test sees time pass as
 * it reads, the same in every run.
 */
function watch(clock?: { advance(ms: number): void }, perRead = 0): { slices: Slice[]; note(): void } {
  const slices: Slice[] = [];
  let cur: Slice | null = null;
  let depth = 0;
  let wrote = false;
  const begin = (kind: Slice['kind']): void => {
    if (depth++ === 0) {
      cur = { kind, notes: 0, over: 0, reads: 0, late: [], skip: [], ms: 0 };
      slices.push(cur);
      wrote = false;
    }
  };
  const end = (): void => {
    if (--depth === 0) cur = null;
  };
  const read = (name: string, node: Node | null): void => {
    if (!cur) return;
    cur.reads++;
    if (wrote) cur.late.push(name);
    // checkVisibility is how the reader tells that content is skipped. It lays nothing out.
    if (node && name !== 'checkVisibility' && skipped(node)) cur.skip.push(name);
  };
  const write = (): void => {
    if (cur) wrote = true;
  };
  const undo: (() => void)[] = [];
  const patch = (obj: object, name: string, wrap: (orig: PropertyDescriptor) => PropertyDescriptor) => {
    let o: object | null = obj;
    while (o && !Object.getOwnPropertyDescriptor(o, name)) o = Object.getPrototypeOf(o);
    if (!o) return;
    const d = Object.getOwnPropertyDescriptor(o, name)!;
    if (!d.configurable) return;
    Object.defineProperty(o, name, wrap(d));
    const at = o;
    undo.push(() => Object.defineProperty(at, name, d));
  };
  const method = (
    obj: object,
    name: string,
    kind: 'read' | 'write',
    nodeOf?: (self: unknown) => Node | null,
  ) =>
    patch(obj, name, (d) => ({
      ...d,
      value(this: unknown, ...args: unknown[]) {
        if (kind === 'write') write();
        else read(name, nodeOf ? nodeOf(this) : this instanceof Node ? this : null);
        return (d.value as (...a: unknown[]) => unknown).apply(this, args);
      },
    }));
  const getter = (obj: object, name: string) =>
    patch(obj, name, (d) =>
      d.get
        ? {
            ...d,
            get(this: unknown) {
              read(name, this instanceof Node ? this : null);
              return d.get!.call(this);
            },
          }
        : d,
    );
  const setter = (obj: object, name: string) =>
    patch(obj, name, (d) =>
      d.set
        ? {
            ...d,
            set(this: unknown, v: unknown) {
              write();
              d.set!.call(this, v);
            },
          }
        : d,
    );

  // Reads that need layout or style.
  for (const n of ['getBoundingClientRect', 'getClientRects', 'checkVisibility'])
    method(Element.prototype, n, 'read');
  method(Range.prototype, 'getBoundingClientRect', 'read', (r) => (r as Range).startContainer);
  patch(Range.prototype, 'getClientRects', (d) => ({
    ...d,
    value(this: Range) {
      read('getClientRects', this.startContainer);
      if (clock && cur) {
        // Placement budgets: 6 ms of reads in a frame pass, 8 ms for an idle slice.
        if (cur.notes > 1 && cur.ms >= (cur.kind === 'frame' ? 6 : 8)) cur.over++;
        clock.advance(perRead);
        cur.ms += perRead;
      }
      return (d.value as () => DOMRectList).call(this);
    },
  }));
  method(window, 'getComputedStyle', 'read', () => null);
  for (const n of [
    'scrollTop',
    'scrollLeft',
    'scrollWidth',
    'scrollHeight',
    'clientTop',
    'clientLeft',
    'clientWidth',
    'clientHeight',
  ])
    getter(Element.prototype, n);
  for (const n of ['offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight'])
    getter(HTMLElement.prototype, n);
  for (const n of ['scrollX', 'scrollY', 'pageXOffset', 'pageYOffset']) getter(window, n);

  // Writes to the DOM, our own layer's included.
  for (const n of ['appendChild', 'insertBefore', 'removeChild', 'replaceChild'])
    method(Node.prototype, n, 'write');
  for (const n of [
    'setAttribute',
    'setAttributeNS',
    'removeAttribute',
    'toggleAttribute',
    'append',
    'prepend',
    'replaceChildren',
    'remove',
    'before',
    'after',
    'replaceWith',
  ])
    method(Element.prototype, n, 'write');
  for (const n of ['append', 'prepend', 'replaceChildren']) method(DocumentFragment.prototype, n, 'write');
  for (const n of ['setProperty', 'removeProperty']) method(CSSStyleDeclaration.prototype, n, 'write');
  for (const n of ['add', 'remove', 'toggle', 'replace']) method(DOMTokenList.prototype, n, 'write');
  setter(Node.prototype, 'textContent');
  setter(CSSStyleDeclaration.prototype, 'cssText');
  setter(HTMLElement.prototype, 'hidden');

  // Slices: each callback the browser runs.
  const w = window as Window & typeof globalThis;
  const raf = w.requestAnimationFrame;
  const ric = w.requestIdleCallback;
  const st0 = w.setTimeout;
  const st = st0.bind(w) as unknown as (h: TimerHandler, ms?: number, ...a: unknown[]) => number;
  const RO = w.ResizeObserver;
  const MO = w.MutationObserver;
  const inSlice =
    <A extends unknown[]>(cb: (...a: A) => void, kind: Slice['kind']) =>
    (...a: A): void => {
      begin(kind);
      try {
        cb(...a);
      } finally {
        end();
      }
    };
  w.requestAnimationFrame = (cb) => raf.call(w, inSlice(cb, 'frame'));
  if (ric) w.requestIdleCallback = (cb, o) => ric.call(w, inSlice(cb, 'idle'), o);
  w.setTimeout = ((cb: TimerHandler, ms?: number, ...args: unknown[]) =>
    typeof cb === 'function'
      ? st(inSlice(cb as (...a: unknown[]) => void, 'idle'), ms, ...args)
      : st(cb, ms, ...args)) as unknown as typeof setTimeout;
  w.ResizeObserver = class extends RO {
    constructor(cb: ResizeObserverCallback) {
      super(inSlice(cb, 'frame'));
    }
  };
  w.MutationObserver = class extends MO {
    constructor(cb: MutationCallback) {
      super(inSlice(cb, 'other'));
    }
  };
  cleanups.push(() => {
    for (const f of undo.splice(0).reverse()) f();
    w.requestAnimationFrame = raf;
    if (ric) w.requestIdleCallback = ric;
    w.setTimeout = st0;
    w.ResizeObserver = RO;
    w.MutationObserver = MO;
  });
  return {
    slices,
    note() {
      if (cur) cur.notes++;
    },
  };
}

interface Rig {
  placer: Placer;
  layer: InkLayer;
  passes: { name: string; ms: number }[];
}

/** A placer on the real layer. Notes it cannot place get page edge markers, as the viewer draws them. */
function rig(now?: () => number, onResolve?: () => void): Rig {
  const layer = createLayer(document, { theme: 'light' }) as InkLayer;
  const passes: Rig['passes'] = [];
  const resolver = fakeResolver(document);
  const resolve = resolver.resolve;
  resolver.resolve = (a, f) => {
    onResolve?.();
    return resolve(a, f);
  };
  const placer = createPlacer({
    doc: document,
    resolver,
    layer,
    onTiming: (name, ms) => passes.push({ name, ms }),
    onChange: (_placed, un) =>
      layer.setMarkers(un.map((n) => ({ id: n.id, relY: 0.5, label: 'Moved note' }))),
    ...(now ? { now } : {}),
  });
  cleanups.push(() => {
    placer.destroy();
    layer.destroy();
  });
  return { placer, layer, passes };
}

const boxes = (placed: Placed[]): Record<string, string> =>
  Object.fromEntries(
    placed.map((p) => [p.id, `${p.bbox.x.toFixed(1)},${p.bbox.y.toFixed(1)},${p.bbox.w.toFixed(1)}`]),
  );

/** Margin notes beside every paragraph, so each docks, and one note whose anchor is gone. */
function notesFor(ps: HTMLElement[]): Note[] {
  const out = ps.map((p, i) => margin(p.id, i % 2 ? 'left' : 'right', i % 3 ? 'yes' : 'star'));
  out.push(margin('gone', 'right'));
  return out;
}

describe('placement slices', () => {
  test('no slice reads layout after it wrote, and none reads content a closed section skips', async () => {
    const ps = article(40);
    const { slices } = watch();
    const r = rig();
    r.placer.setNotes(notesFor(ps));
    await until(() => r.placer.all().length === ps.length && r.placer.unplaced().length === 1);
    await quiet();
    // Scrolling and a resize place the notes again.
    window.scrollTo(0, 1200);
    window.dispatchEvent(new Event('resize'));
    await quiet();
    const placing = slices.filter((s) => s.reads > 0);
    expect(placing.length).toBeGreaterThan(1);
    expect(slices.flatMap((s) => s.late)).toEqual([]);
    expect(slices.flatMap((s) => s.skip)).toEqual([]);
    expect(r.placer.all().every((p) => p.docked)).toBe(true);
  });

  test('text shown through display: contents still keeps a docked note off its words', async () => {
    const ps = article(10);
    const r = rig();
    r.placer.setNotes(notesFor(ps).slice(0, ps.length));
    await until(() => r.placer.all().length === ps.length);
    const range = document.createRange();
    const lines: DOMRect[] = [];
    for (const p of ps) {
      const t = p.querySelector('span')?.firstChild ?? p.firstChild!;
      range.selectNodeContents(t);
      lines.push(...[...range.getClientRects()].filter((c) => c.width > 0.5));
    }
    for (const p of r.placer.all())
      for (const l of lines) {
        const x = l.left + scrollX;
        const y = l.top + scrollY;
        const hit =
          p.bbox.x < x + l.width &&
          x < p.bbox.x + p.bbox.w &&
          p.bbox.y < y + l.height &&
          y < p.bbox.y + p.bbox.h;
        expect(hit, `${p.id} covers a line at ${x},${y}`).toBe(false);
      }
  });

  test('a slice stops a docking read when its time is up, and every note lands where one long pass puts it', async () => {
    // Long contents lists here and there: the first note near one reads all its lines.
    const ps = article(40);
    for (const p of ps.filter((_, i) => i % 8 === 4)) {
      const ul = document.createElement('ul');
      ul.style.margin = '0 0 8px';
      ul.innerHTML = Array.from({ length: 30 }, (_, i) => `<li>Section ${i + 1}</li>`).join('');
      p.after(ul);
    }
    const notes = notesFor(ps);
    // Reference: a clock that never moves, so every pass does all its work at once.
    const still = manualClock();
    const a = rig(still.now);
    a.placer.setNotes(notes);
    await until(() => a.placer.all().length === ps.length);
    await quiet();
    const want = boxes(a.placer.all());
    a.placer.destroy();
    a.layer.destroy();
    await frame();

    // Each text box read now costs 0.25 ms of the slice's time.
    const clock = manualClock();
    const w = watch(clock, 0.25);
    const b = rig(clock.now, w.note);
    b.placer.setNotes(notes);
    await until(() => b.placer.all().length === ps.length);
    await quiet();
    expect(boxes(b.placer.all())).toEqual(want);
    const reading = w.slices.filter((s) => s.ms > 0);
    expect(reading.length).toBeGreaterThan(3);
    // Once the slice's time is up, a note after its first reads at most the one box that crossed it.
    expect(reading.map((s) => s.over).filter((n) => n > 1)).toEqual([]);
  });
});
