/**
 * The hand-off between the content script on a PDF address and the viewer
 * page in its frame (CONTRACT 6). The viewer frame says it is ready, the
 * content script answers with the bytes. Each side checks who sent a message
 * before it acts on it: the content script takes messages only from its own
 * frame on the extension origin, and the viewer takes bytes only from its
 * parent on the origin of the PDF address it was given.
 * This file must stay free of imports: the content script chunk includes it.
 */

/** Viewer to content script. */
export type FromViewer =
  | { ink: 'pdf-ready' }
  /** The PDF's own title, for the tab. */
  | { ink: 'pdf-title'; title: string }
  /** The viewer could not open the bytes. The built-in viewer comes back. */
  | { ink: 'pdf-failed' }
  /** This browser cannot run PDF.js. The built-in viewer comes back, with no offer to try again. */
  | { ink: 'pdf-unsupported' };

/** Content script to viewer. */
export interface ToViewer {
  ink: 'pdf-bytes';
  url: string;
  bytes: ArrayBuffer;
}

interface Msg {
  data: unknown;
  origin: string;
  source: unknown;
}

export function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o && o !== 'null' ? o : null;
  } catch {
    return null;
  }
}

/** Frame address: the viewer page with the PDF address in the fragment. */
export function viewerAddress(page: string, pdfUrl: string): string {
  return `${page.split('#')[0]}#src=${encodeURIComponent(pdfUrl)}`;
}

/** The PDF address a framed viewer was given, or null. Only web addresses. */
export function sourceOf(hash: string): string | null {
  const m = /^#src=(.+)$/.exec(hash);
  if (!m) return null;
  let url: string;
  try {
    url = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  return /^https?:\/\//i.test(url) && originOf(url) ? url : null;
}

/** A PDF starts with %PDF- within its first kilobyte. */
export function looksLikePdf(buf: ArrayBuffer): boolean {
  const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024));
  for (let i = 0; i + 4 < head.length; i++) {
    if (
      head[i] === 0x25 &&
      head[i + 1] === 0x50 &&
      head[i + 2] === 0x44 &&
      head[i + 3] === 0x46 &&
      head[i + 4] === 0x2d
    )
      return true;
  }
  return false;
}

/** Content script side: a message from its viewer frame, or null. */
export function fromViewer(e: Msg, frame: unknown, extOrigin: string): FromViewer | null {
  if (!frame || e.source !== frame || e.origin !== extOrigin) return null;
  const d = e.data as Partial<FromViewer> | null;
  if (!d || typeof d !== 'object') return null;
  if (d.ink === 'pdf-ready' || d.ink === 'pdf-failed' || d.ink === 'pdf-unsupported') return { ink: d.ink };
  if (d.ink === 'pdf-title' && typeof (d as { title?: unknown }).title === 'string')
    return { ink: 'pdf-title', title: (d as { title: string }).title.slice(0, 300) };
  return null;
}

/** Viewer side: the bytes from its parent, or null. src is the address the viewer was given. */
export function bytesFrom(e: Msg, parent: unknown, src: string): ArrayBuffer | null {
  const want = originOf(src);
  if (!want || !parent || e.source !== parent || e.origin !== want) return null;
  const d = e.data as Partial<ToViewer> | null;
  if (!d || typeof d !== 'object' || d.ink !== 'pdf-bytes' || d.url !== src) return null;
  const b = d.bytes;
  if (!(b instanceof ArrayBuffer) || !looksLikePdf(b)) return null;
  return b;
}
