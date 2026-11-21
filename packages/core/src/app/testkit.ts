// Test helpers for the app folder: fixture pages, pen input (real through CDP in
// Chromium, built by hand elsewhere), and a viewer whose internals the test can read.

import { LAYER_TAG } from '../brand';
import { fromTest, type Kind, mouseInput } from '../capture/testkit';
import { memoryKV } from '../store/memory';
import { frame, quiet, until } from '../testkit';
import type { InkCommands, KV, Note, Placed, Rect, Viewer, ViewerInternals, ViewerOptions } from '../types';
import { resetUiSession } from '../ui/ui';
import { attachTools, resetToolSession } from './tools';
import { createViewer } from './view';

export { fromTest, isChromium, mouseInput, NEEDS_CDP } from '../capture/testkit';
export { frame, manualClock, quiet, until } from '../testkit';
export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until placement passes, idle slices and debounces have all run. */
export const settle = (): Promise<void> => quiet('settle');

// ---- pointer input -------------------------------------------------------------

const mouse = mouseInput;

/** One stroke through client points, with a hover first for a pen. */
export async function stroke(pts: [number, number][], kind: Kind = 'pen', modifiers = 0): Promise<void> {
  const [x0, y0] = pts[0]!;
  if (kind === 'pen') await mouse('mouseMoved', x0, y0, kind);
  await mouse('mousePressed', x0, y0, kind, { force: 0.5, modifiers });
  for (const [x, y] of pts.slice(1))
    await mouse('mouseMoved', x, y, kind, { down: true, force: 0.6, modifiers });
  const [x1, y1] = pts[pts.length - 1]!;
  await mouse('mouseReleased', x1, y1, kind, { modifiers });
}

/** Straight line from a to b in steps. */
export function line(a: [number, number], b: [number, number], steps = 12): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++)
    out.push([a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]);
  return out;
}

/** Loop around a client rect, like circling a word. */
export function loop(
  r: { left: number; top: number; width: number; height: number },
  pad = 4,
): [number, number][] {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const rx = r.width / 2 + pad;
  const ry = r.height / 2 + pad;
  const out: [number, number][] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2.1;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

/**
 * Tap a control of our closed layer (the badge, an edge marker) once it shows, which it does
 * after a timer of its own, and tap again until cond() holds. The point hits the layer's host
 * once the control is there. WebKit drops a click that comes too soon after a scroll, so a
 * tap that changed nothing is repeated.
 */
export async function tapUntil(
  at: () => [number, number],
  cond: () => boolean,
  label: string,
): Promise<void> {
  const onLayer = (): boolean => document.elementFromPoint(...at())?.localName === LAYER_TAG;
  await until(onLayer, `${label} on screen`);
  const end = performance.now() + 15_000;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`timed out tapping for ${label}`);
    const [x, y] = at();
    await tap(x, y);
    for (let i = 0; i < 40 && !cond(); i++) await frame();
  }
}

/** A pen or mouse tap with no movement. */
export async function tap(x: number, y: number, kind: Kind = 'mouse'): Promise<void> {
  await mouse('mousePressed', x, y, kind, { force: 0.5 });
  await mouse('mouseReleased', x, y, kind);
}

// ---- pages ---------------------------------------------------------------------

const WORDS =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim minim veniam quis nostrud exercitation ullamco laboris nisi aliquip commodo consequat'.split(
    ' ',
  );

/** Deterministic filler text so every paragraph is unique. */
export function filler(seed: number, n: number): string {
  const out: string[] = [];
  let s = seed * 7919 + 13;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(WORDS[s % WORDS.length]!);
  }
  return out.join(' ');
}

export const ARTICLE_STYLE =
  'body{margin:0;font:18px/1.6 Georgia,serif;color:#222;background:#fff}' +
  'main{width:560px;margin:40px 0 0 60px}h1{font-size:30px;margin:0 0 16px}p{margin:0 0 18px}';

/** An article with distinct words to write on. */
export function articleHtml(paras = 8): string {
  const ps: string[] = [];
  for (let i = 0; i < paras; i++) {
    const extra = i === 2 ? ' The <b id="w-target">pomegranate</b> grows in warm valleys.' : '';
    const hl =
      i === 4 ? ' <span id="w-line">Bright yellow marks follow the text wherever it wraps.</span>' : '';
    ps.push(`<p id="p${i}">Paragraph ${i} opens here. ${filler(i + 1, 22)}.${extra}${hl}</p>`);
  }
  return `<style id="fx">${ARTICLE_STYLE}</style><main id="main"><h1>The orchard notes</h1>${ps.join('')}</main>`;
}

export function setPage(html: string): void {
  document.body.innerHTML = html;
  window.scrollTo(0, 0);
}

/**
 * Client rect of the first occurrence of text inside el. When the text is above or below the
 * window, the window scrolls just enough to show it first, so a stroke at the rect lands on the
 * page. How far down a paragraph sits depends on the font, so a test cannot count on it.
 */
export function textRect(el: Element, text: string): DOMRect {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = (n as Text).data.indexOf(text);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + text.length);
    const b = r.getBoundingClientRect();
    if (b.bottom > innerHeight) window.scrollBy(0, b.bottom - innerHeight + 40);
    else if (b.top < 0) window.scrollBy(0, b.top - 40);
    return r.getBoundingClientRect();
  }
  throw new Error(`text not found: ${text}`);
}

export const toDocRect = (r: DOMRect): Rect => ({
  x: r.left + scrollX,
  y: r.top + scrollY,
  w: r.width,
  h: r.height,
});

export function centreIn(inner: Rect, outer: Rect, slack = 4): boolean {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return (
    cx >= outer.x - slack &&
    cx <= outer.x + outer.w + slack &&
    cy >= outer.y - slack &&
    cy <= outer.y + outer.h + slack
  );
}

// ---- viewers -----------------------------------------------------------------------

export interface Rig {
  viewer: Viewer;
  kv: KV;
  /** Internals, filled once the tools are loaded. */
  v: ViewerInternals | null;
  cmd(): Promise<InkCommands>;
  notes(): Note[];
  placed(id: string): Placed | undefined;
}

const rigs: Rig[] = [];

export async function openViewer(kv: KV = memoryKV(), opts: Partial<ViewerOptions> = {}): Promise<Rig> {
  const rig: Rig = {
    kv,
    v: null,
    viewer: null as unknown as Viewer,
    async cmd() {
      const c = await rig.viewer.tools();
      return c;
    },
    notes: () => rig.v?.record().notes ?? [],
    placed: (id) => rig.v?.placer.get(id),
  };
  rig.viewer = await createViewer({
    kv,
    // The pen and touch this kit builds count as real input. Events a test makes itself do not.
    real: fromTest,
    loadTools: async () => ({
      attachTools: (v) => {
        rig.v = v;
        return attachTools(v);
      },
    }),
    ...opts,
  });
  rigs.push(rig);
  return rig;
}

/** Destroy every viewer opened by the test and reset session choices. */
export function closeAll(): void {
  for (const r of rigs.splice(0)) r.viewer.destroy();
  resetToolSession();
  resetUiSession();
  for (const el of document.querySelectorAll('ink-layer')) el.remove();
}

/** What is on screen for a note: the union of its drawn paths, in document space. */
export function drawn(rig: Rig, id: string): Rect | null {
  const root = rig.v?.layer.root;
  if (!root) return null;
  const rs: DOMRect[] = [];
  for (const g of root.querySelectorAll(`g[data-note="${id}"] path`)) {
    const r = g.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) rs.push(r);
  }
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map((r) => r.left));
  const y0 = Math.min(...rs.map((r) => r.top));
  const x1 = Math.max(...rs.map((r) => r.right));
  const y1 = Math.max(...rs.map((r) => r.bottom));
  return { x: x0 + scrollX, y: y0 + scrollY, w: x1 - x0, h: y1 - y0 };
}

/** True when the drawn ink of a note is centred on the given client rect. */
export function drawnOn(rig: Rig, id: string, r: DOMRect | Rect, slack = 4): boolean {
  const d = drawn(rig, id);
  const box = 'left' in r ? toDocRect(r as DOMRect) : (r as Rect);
  return !!d && centreIn(d, box, slack);
}
