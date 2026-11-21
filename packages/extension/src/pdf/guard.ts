/**
 * Starts the viewer page, or says plainly that the browser is too old.
 * PDF.js loads as its own chunk. When that chunk fails to load (a syntax the
 * browser does not know), or the built-ins it needs are still missing after
 * its polyfills ran, or starting throws, the page shows a short message
 * instead of staying blank. In a frame on a PDF address it also tells the
 * content script, which puts the browser's own viewer back.
 */
import { NAME } from '../brand';
import { type FromViewer, originOf, sourceOf } from './handoff';

export const TOO_OLD = `This browser is too old to open PDFs with ${NAME}. Update the browser, or open the file in its own viewer.`;

/**
 * Built-ins the viewer needs once PDF.js and its polyfills have loaded. Each
 * is a path from the global object. Anything missing here would fail later,
 * in the middle of opening a file.
 */
export const NEEDED = [
  'Promise.withResolvers',
  'Promise.try',
  'AbortSignal.any',
  'ArrayBuffer.prototype.transferToFixedLength',
  'Map.prototype.getOrInsertComputed',
  'WeakMap.prototype.getOrInsertComputed',
  'Math.sumPrecise',
  'Iterator.prototype.map',
  'Iterator.prototype.toArray',
  'Uint8Array.fromBase64',
  'Uint8Array.prototype.toHex',
  'URL.parse',
  'structuredClone',
] as const;

/** The paths from NEEDED that are not functions on g. */
export function missingBuiltins(g: object = globalThis): string[] {
  return NEEDED.filter((path) => {
    let v: unknown = g;
    for (const k of path.split('.')) {
      v = v == null ? undefined : (v as Record<string, unknown>)[k];
    }
    return typeof v !== 'function';
  });
}

/** Replaces the page with the message, and tells the content script when framed. */
export function showTooOld(doc: Document, win: Window): void {
  doc.documentElement.classList.add('too-old');
  doc.documentElement.classList.remove('loading', 'has-doc');
  const bar = doc.getElementById('bar');
  if (bar) bar.hidden = true;
  const status = doc.getElementById('status');
  if (status) status.hidden = true;
  const empty = doc.getElementById('empty') ?? doc.body;
  const p = doc.createElement('p');
  p.id = 'too-old';
  p.textContent = TOO_OLD;
  empty.replaceChildren(p);
  empty.hidden = false;
  const src = sourceOf(win.location.hash);
  const o = src ? originOf(src) : null;
  if (o && win.parent !== win) win.parent.postMessage({ ink: 'pdf-unsupported' } satisfies FromViewer, o);
}

export interface GuardDeps<M> {
  doc: Document;
  win: Window;
  /** Loads the viewer chunk with PDF.js. */
  load: () => Promise<M>;
  /** Starts the viewer from the loaded chunk. */
  start: (m: M) => void;
  /** The global to check. Default: win. */
  global?: object;
}

/** Loads and starts the viewer. Resolves true when it started. */
export async function startGuarded<M>(d: GuardDeps<M>): Promise<boolean> {
  try {
    const m = await d.load();
    const missing = missingBuiltins(d.global ?? d.win);
    if (missing.length) throw new Error(`Missing: ${missing.join(', ')}`);
    d.start(m);
    return true;
  } catch (e) {
    console.error(e);
    showTooOld(d.doc, d.win);
    return false;
  }
}
