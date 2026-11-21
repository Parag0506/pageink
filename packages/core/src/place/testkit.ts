/**
 * Test helpers for place/: a fake resolver that follows the Resolver type,
 * note builders and a layer spy. Used only by tests.
 */
import type { Anchor, Note, Place, Resolved, Resolver, Stroke } from '../types';

export interface FakeResolver extends Resolver {
  calls: number;
  invalidations: number;
  /** Return this origin instead of the real one, to tell known poses from resolved ones. */
  nudge: { x: number; y: number };
}

/**
 * Finds the anchor by id. Origin follows FORMAT "Units" for blocks, scale is
 * the font size ratio. Elements inside [data-scroller] report that scroller,
 * elements inside [data-pinned] are pinned.
 */
export function fakeResolver(doc: Document): FakeResolver {
  const win = doc.defaultView!;
  const fr: FakeResolver = {
    calls: 0,
    invalidations: 0,
    nudge: { x: 0, y: 0 },
    resolve(anchor, frame): Resolved | null {
      fr.calls++;
      const el = anchor.path.id ? doc.getElementById(anchor.path.id) : null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const box = { x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height };
      const fontPx = Number.parseFloat(win.getComputedStyle(el).fontSize) || 16;
      const scale = fontPx / frame.fontPx;
      const ox = anchor.place === 'right' ? box.x + box.w : box.x;
      const oy = anchor.place === 'below' ? box.y + box.h : box.y;
      const out: Resolved = {
        origin: { x: ox + fr.nudge.x, y: oy + fr.nudge.y },
        scale,
        box,
        el,
        method: 'path',
        score: 1,
      };
      const text = el.firstChild;
      if (text && text.nodeType === Node.TEXT_NODE && anchor.pos.end > anchor.pos.start) {
        const range = doc.createRange();
        const len = (text as Text).length;
        range.setStart(text, Math.min(anchor.pos.start, len));
        range.setEnd(text, Math.min(anchor.pos.end, len));
        out.range = range;
      }
      const sc = el.closest('[data-scroller]');
      if (sc) out.scroller = sc;
      if (el.closest('[data-pinned]')) out.pinned = true;
      return out;
    },
    invalidate() {
      fr.invalidations++;
    },
    locate: (anchor) => (anchor.path.id ? doc.getElementById(anchor.path.id) : null),
  };
  return fr;
}

let seq = 0;

/** A wavy stroke about w by h in note-local units, with a ready path. */
export function squiggle(w = 120, h = 30, n = 24): Stroke {
  const pts: number[] = [];
  const top: string[] = [];
  const bottom: string[] = [];
  let px = 0;
  let py = 0;
  for (let i = 0; i < n; i++) {
    const x = (w * i) / (n - 1);
    const y = h / 2 + (Math.sin(i / 2) * h) / 2.5;
    const qx = Math.round(x * 10);
    const qy = Math.round(y * 10);
    pts.push(qx - px, qy - py, i === 0 ? 50 : 0);
    px = qx;
    py = qy;
    top.push(`${x.toFixed(1)} ${(y - 1).toFixed(1)}`);
    bottom.unshift(`${x.toFixed(1)} ${(y + 1).toFixed(1)}`);
  }
  return {
    id: `s${++seq}`,
    t: seq,
    tool: 'pen',
    color: 'ink-1',
    w: 2,
    pts,
    d: `M${top.join('L')}L${bottom.join('L')}Z`,
  };
}

export function anchorFor(id: string, place: Place = 'on', extra: Partial<Anchor> = {}): Anchor {
  return {
    type: 'block',
    quote: { exact: '', prefix: '', suffix: '' },
    path: { id, css: `#${id}`, xpath: '' },
    pos: { start: 0, end: 0 },
    hash: '',
    place,
    ...extra,
  };
}

export function inkNote(
  anchorId: string,
  opts: { place?: Place; strokes?: Stroke[]; id?: string } = {},
): Note {
  return {
    id: opts.id ?? `n${++seq}`,
    createdAt: 1,
    updatedAt: 1,
    device: 'test',
    kind: 'ink',
    anchor: anchorFor(anchorId, opts.place ?? 'on'),
    frame: { w: 300, h: 40, fontPx: 16, viewportW: 1000 },
    strokes: opts.strokes ?? [squiggle()],
  };
}

export function markNote(
  anchorId: string,
  start: number,
  end: number,
  style: 'highlight' | 'underline' = 'highlight',
): Note {
  return {
    id: `m${++seq}`,
    createdAt: 1,
    updatedAt: 1,
    device: 'test',
    kind: 'textmark',
    anchor: anchorFor(anchorId, 'on', { type: 'text', pos: { start, end } }),
    frame: { w: 300, h: 40, fontPx: 16, viewportW: 1000 },
    strokes: [],
    mark: { style, color: 'hi-1' },
  };
}

/** Methods of our layer that read layout. The spy logs them as reads. */
const READS = new Set(['measure', 'readTheme']);

/** Wrap every function on an object so calls are logged. Other fields are shared. */
export function spy<T extends object>(target: T, log: string[], tag: string): T {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    const v = (target as Record<string, unknown>)[key];
    if (typeof v === 'function') {
      out[key] = (...args: unknown[]) => {
        log.push(READS.has(key) ? `R:${key}` : `${tag}:${key}`);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    } else {
      Object.defineProperty(out, key, { get: () => (target as Record<string, unknown>)[key] });
    }
  }
  return out as T;
}

let blobs = 0;
/** A pen stroke filling a w by h box at (x, y) in note-local units, with its outline path. */
export function blob(x: number, y: number, w: number, h: number): Stroke {
  const pts: number[] = [];
  const top: string[] = [];
  const bottom: string[] = [];
  let px = 0;
  let py = 0;
  const n = 16;
  for (let i = 0; i < n; i++) {
    const sx = x + (w * i) / (n - 1);
    const sy = y + h / 2 + (Math.sin(i) * h) / 2.6;
    const qx = Math.round(sx * 10);
    const qy = Math.round(sy * 10);
    pts.push(qx - px, qy - py, i === 0 ? 50 : 0);
    px = qx;
    py = qy;
    top.push(`${sx.toFixed(1)} ${(sy - 1.5).toFixed(1)}`);
    bottom.unshift(`${sx.toFixed(1)} ${(sy + 1.5).toFixed(1)}`);
  }
  return {
    id: `b${++blobs}`,
    t: blobs,
    tool: 'pen',
    color: 'ink-1',
    w: 3,
    pts,
    d: `M${top.join('L')}L${bottom.join('L')}Z`,
  };
}

/** A note written in a margin: a "yes!" (wide) or a star (square), beside the block's edge. */
export function margin(id: string, place: Place, kind: 'yes' | 'star' = 'yes', dy = 0): Note {
  const [w, h] = kind === 'yes' ? [64, 30] : [36, 36];
  const x = place === 'left' ? -14 - w : 14;
  return inkNote(id, { place, strokes: [blob(x, dy, w, h)] });
}

export { frame, manualClock, quiet, until } from '../testkit';
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
