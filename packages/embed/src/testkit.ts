// Test helpers: pen and touch input (real through CDP in Chromium, built by hand in WebKit
// and Firefox, see pageink-core's capture/testkit.ts), the built script in the page, and a KV
// that records keys.
import { GLOBAL, LAYER_TAG } from 'pageink-core/brand';
import {
  ALT,
  isChromium,
  mouseInput,
  STEP_MS,
  swipeAlong,
  type TouchPoint,
  touchInput,
} from '../../core/src/capture/testkit';
import inkSource from '../dist/pageink.js?raw';
import type * as Api from './iife';

export { ALT, fromTest, isChromium, touchEmulation } from '../../core/src/capture/testkit';
export { frame, quiet, until } from '../../core/src/testkit';
export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Kind = 'pen' | 'mouse';

/** One stroke through client points, with a hover first for a pen. Its events are STEP_MS apart on the input clock. */
export async function stroke(pts: [number, number][], kind: Kind = 'pen', modifiers = 0): Promise<void> {
  const [x0, y0] = pts[0]!;
  const next = { gap: STEP_MS };
  if (kind === 'pen') await mouseInput('mouseMoved', x0, y0, kind);
  await mouseInput('mousePressed', x0, y0, kind, { force: 0.5, modifiers, ...(kind === 'pen' ? next : {}) });
  for (const [x, y] of pts.slice(1))
    await mouseInput('mouseMoved', x, y, kind, { down: true, force: 0.6, modifiers, ...next });
  const [x1, y1] = pts[pts.length - 1]!;
  await mouseInput('mouseReleased', x1, y1, kind, { modifiers, ...next });
}

/**
 * Why a test of the built script runs in Chromium only. The script takes only input the browser
 * made, and only CDP makes trusted pen and touch input. The same rules are tested from source in
 * every engine through the test seam (options.browser.test.ts).
 */
export const NEEDS_TRUSTED_PEN = 'needs trusted pen or touch input, which only CDP makes';

/**
 * Ink as a reader writes it, with input the browser trusts: a pen in Chromium, and elsewhere a
 * real mouse with Alt held, which writes with the toggle off.
 */
export const write = (pts: [number, number][]): Promise<void> =>
  isChromium ? stroke(pts, 'pen') : stroke(pts, 'mouse', ALT);

/** A zigzag, which is ink and never a text mark. */
export function zigzag(x: number, y: number, w = 120, h = 30, n = 6): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n * 4; i++) out.push([x + (w * i) / (n * 4), y + (i % 4 < 2 ? 0 : h)]);
  return out;
}

export const touch = (
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  touchPoints: TouchPoint[],
): Promise<void> => touchInput(type, touchPoints);

/** One finger along a path, as one gesture on the input clock (pageink-core's capture/testkit.ts). */
export const finger = (pts: [number, number][]): Promise<void> => swipeAlong([pts]);

export type InkGlobal = typeof Api;

const globalOf = (): InkGlobal | undefined =>
  (window as unknown as Record<string, InkGlobal | undefined>)[GLOBAL];

/** Run the built dist/pageink.js in this page from a script tag with the given attributes. */
export function loadInk(attrs: Record<string, string> = {}): InkGlobal {
  const s = document.createElement('script');
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  s.textContent = inkSource;
  document.body.append(s);
  const g = globalOf();
  if (!g) throw new Error(`dist/pageink.js did not set the ${GLOBAL} global`);
  return g;
}

/** In-memory KV that remembers every key written. */
export function recordingKV(): Api.KV & { data: Map<string, unknown>; written: string[] } {
  const data = new Map<string, unknown>();
  const written: string[] = [];
  const subs = new Set<(c: Record<string, unknown | undefined>) => void>();
  const tell = (c: Record<string, unknown | undefined>) =>
    queueMicrotask(() => {
      for (const s of [...subs]) s(structuredClone(c));
    });
  return {
    data,
    written,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        data.set(k, structuredClone(v));
        written.push(k);
      }
      tell(items);
    },
    async remove(keys) {
      const c: Record<string, undefined> = {};
      for (const k of keys) {
        data.delete(k);
        c[k] = undefined;
      }
      tell(c);
    },
    async keys(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

export const ARTICLE = `
<style>
  body{margin:0;font:18px/1.6 Georgia,serif;color:#222;background:#fff}
  main{width:560px;margin:40px 0 0 60px}
  p{margin:0 0 18px}
  #code{background:#f4f4f4;padding:12px;height:140px;overflow:auto}
</style>
<main id="main">
  <h1>Notes on rivers</h1>
  <p id="p0">Rivers carry water from high ground to the sea, and they shape the land as they go.</p>
  <p id="p1">A meander forms where the outer bank wears away and the inner bank gathers sand.</p>
  <div id="code" data-ink-off><pre>let flow = depth * width * speed;</pre></div>
  <p id="p2">Floods spread silt across the plain, which is why river valleys are good farmland.</p>
  <div style="height:1200px"></div>
</main>`;

/** Remove every trace a test may leave: handles, layers, scripts and storage. */
export async function clean(): Promise<void> {
  const g = globalOf();
  await g?.auto?.destroy();
  for (const el of document.querySelectorAll(`${LAYER_TAG}, script[data-ink], script[data-ink-test]`))
    el.remove();
  // The script declares the global with var, so it can be cleared but not deleted.
  (window as unknown as Record<string, InkGlobal | undefined>)[GLOBAL] = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
  await new Promise<void>((r) => {
    const req = indexedDB.deleteDatabase('ink');
    req.onsuccess = req.onerror = req.onblocked = () => r();
  });
}
