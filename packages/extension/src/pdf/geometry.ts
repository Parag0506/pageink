/**
 * Page geometry for the PDF viewer. Pure, so it is easy to test.
 * Every page container has a fixed size for the current zoom whether or not
 * it is rendered, so the ink anchored to it never moves.
 */

/** CSS pixels per PDF point at 100%. */
export const CSS_PER_PT = 96 / 72;
/** Space between pages and around them, CSS px. */
export const GAP = 12;
export const PAD = 16;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
/** Auto zoom fits the width but never goes above this. */
export const AUTO_MAX = 1.25;
export const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** A page size in PDF points, after its rotation. */
export interface PageSize {
  w: number;
  h: number;
}

export interface Layout {
  zoom: number;
  /** Container sizes in CSS px. */
  widths: number[];
  heights: number[];
  /** Container tops from the top of the page list, CSS px. */
  tops: number[];
  /** Height of the page list, padding included. */
  total: number;
}

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** CSS size of one page at a zoom. Whole pixels, so the canvas and the text layer agree. */
export function pageCss(s: PageSize, zoom: number): { w: number; h: number } {
  return { w: Math.floor(s.w * zoom * CSS_PER_PT), h: Math.floor(s.h * zoom * CSS_PER_PT) };
}

export function layout(sizes: PageSize[], zoom: number, gap = GAP, pad = PAD): Layout {
  const widths: number[] = [];
  const heights: number[] = [];
  const tops: number[] = [];
  let y = pad;
  for (const s of sizes) {
    const c = pageCss(s, zoom);
    widths.push(c.w);
    heights.push(c.h);
    tops.push(y);
    y += c.h + gap;
  }
  const total = sizes.length ? y - gap + pad : 2 * pad;
  return { zoom, widths, heights, tops, total };
}

/** Zoom at which the widest page fills the view width. */
export function fitWidth(sizes: PageSize[], viewW: number, pad = PAD): number {
  const maxW = Math.max(1, ...sizes.map((s) => s.w));
  return clampZoom((viewW - 2 * pad) / (maxW * CSS_PER_PT));
}

/** Zoom on open: fit the width, but not larger than AUTO_MAX. */
export const autoZoom = (sizes: PageSize[], viewW: number): number =>
  Math.min(AUTO_MAX, fitWidth(sizes, viewW));

/** Next zoom step up (dir 1) or down (dir -1) from z. */
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOMS.find((s) => s > z + 1e-3) ?? MAX_ZOOM;
  return [...ZOOMS].reverse().find((s) => s < z - 1e-3) ?? MIN_ZOOM;
}

/** Index of the page that holds list-space y, or the nearest one. -1 with no pages. */
export function pageAt(lay: Layout, y: number): number {
  const n = lay.tops.length;
  if (!n) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lay.tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Pages that overlap [top - margin, bottom + margin] in list space, as an index range. */
export function nearPages(lay: Layout, top: number, bottom: number, margin: number): [number, number] {
  const n = lay.tops.length;
  if (!n) return [0, -1];
  let a = pageAt(lay, top - margin);
  if (lay.tops[a]! + lay.heights[a]! < top - margin && a < n - 1) a++;
  const b = pageAt(lay, bottom + margin);
  return [a, b];
}

/** A list-space y as a page and a fraction of that page's height, so a zoom can keep it in place. */
export function pointAt(lay: Layout, y: number): { page: number; frac: number } {
  const p = pageAt(lay, y);
  if (p < 0) return { page: 0, frac: 0 };
  const h = lay.heights[p]! || 1;
  return { page: p, frac: (y - lay.tops[p]!) / h };
}

/** Inverse of pointAt for another layout. */
export function yOf(lay: Layout, page: number, frac: number): number {
  const p = Math.min(Math.max(0, page), lay.tops.length - 1);
  if (p < 0) return 0;
  return lay.tops[p]! + frac * lay.heights[p]!;
}

/** Output scale for a canvas, capped so one page never takes more than maxPixels. */
export function canvasScale(cssW: number, cssH: number, dpr: number, maxPixels = 16_777_216): number {
  const area = cssW * cssH * dpr * dpr;
  return area > maxPixels ? Math.sqrt(maxPixels / (cssW * cssH)) : dpr;
}

/** Element id and media name of a page container. Numbers count from 1. */
export const pageId = (n: number): string => `ink-pdf-page-${n}`;

const ID_RE = /ink-pdf-page-(\d+)/;
const XPATH_RE = /\/main\[1\]\/div\[(\d+)\]/;

/**
 * The page a note sits on, from its anchor, counting from 1. Media notes name
 * the page container. Text marks carry a path inside it: by id, or by
 * position for pages whose id the path builder does not trust.
 */
export function pageOfAnchor(a: {
  path: { css: string; xpath: string; id?: string };
  media?: { src: string };
}): number | null {
  for (const s of [a.media?.src, a.path.id, a.path.css]) {
    const m = s ? ID_RE.exec(s) : null;
    if (m) return Number(m[1]);
  }
  const x = XPATH_RE.exec(a.path.xpath);
  return x ? Number(x[1]) : null;
}
