/**
 * Geometry and element facts shared by describe and resolve. Both halves use the
 * same functions so that, for one page state, they compute the same origin.
 */
import { hashKey } from '../hash';
import type { Anchor, ClipEdge, Point, Rect } from '../types';
import { flatParent, fold, type Span, type TextModel } from './text';

export interface View {
  sx: number;
  sy: number;
}

export function viewOf(doc: Document): View {
  const w = doc.defaultView;
  return { sx: w?.scrollX ?? 0, sy: w?.scrollY ?? 0 };
}

export function toDoc(r: DOMRect | DOMRectReadOnly, v: View): Rect {
  return { x: r.left + v.sx, y: r.top + v.sy, w: r.width, h: r.height };
}

/** First line box of a range: its first non-empty client rect. */
export function firstRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (r.width > 0 && r.height > 0) return r;
  }
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    if (r.height > 0) return r;
  }
  return null;
}

/** Rect of one model character, or null for collapsed white space and boundaries. */
export function charRect(m: TextModel, k: number): DOMRect | null {
  if (k < 0 || k >= m.text.length) return null;
  const r = m.range(k, k + 1);
  if (!r) return null;
  // A word hyphenated at a line end gives the character after the break a second box, the
  // hyphen on the line above. The character itself is in the last box.
  const list = r.getClientRects();
  for (let i = list.length - 1; i >= 0 && list.length > 1; i--) {
    const q = list[i]!;
    if (q.width > 0 || q.height > 0) return q;
  }
  const b = r.getBoundingClientRect();
  return b.width > 0 || b.height > 0 ? b : null;
}

/** Nearest character at or after k (then before) that has a box, within the span. */
function probe(m: TextModel, k: number, span: Span): { k: number; r: DOMRect } | null {
  for (let j = k; j < Math.min(span.end, k + 12); j++) {
    const r = charRect(m, j);
    if (r) return { k: j, r };
  }
  for (let j = k - 1; j >= Math.max(span.start, k - 12); j--) {
    const r = charRect(m, j);
    if (r) return { k: j, r };
  }
  return null;
}

/** First offset in [a, b) whose character box passes test, assuming test is monotone in text order. */
function firstWhere(m: TextModel, a: number, b: number, test: (r: DOMRect) => boolean): number {
  let lo = a;
  let hi = b;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const p = probe(m, mid, { start: a, end: b });
    if (!p) return b;
    if (test(p.r)) hi = Math.min(mid, p.k);
    else lo = Math.max(mid, p.k) + 1;
  }
  return lo;
}

/** Most characters looked at one by one when text does not run top to bottom. */
const SCAN_LIMIT = 4000;

/**
 * The line at a client y found without assuming text order matches vertical order: the text
 * node whose box crosses y, then its characters on that line, widened while neighbours stay on it.
 */
function scanLine(m: TextModel, span: Span, y: number): Span | null {
  const range = m.doc.createRange();
  let k = -1;
  let box: DOMRect | null = null;
  for (let i = Math.max(0, m.segAt(span.start)); i < m.segs.length; i++) {
    const s = m.segs[i]!;
    if (s.start >= span.end) break;
    range.selectNodeContents(s.node);
    let crosses = false;
    for (const r of range.getClientRects()) if (r.height > 0 && y >= r.top && y < r.bottom) crosses = true;
    if (!crosses) continue;
    const from = Math.max(s.start, span.start);
    const to = Math.min(s.start + s.len, span.end, from + SCAN_LIMIT);
    for (let j = from; j < to; j++) {
      const r = charRect(m, j);
      if (r && r.width > 0 && y >= r.top && y < r.bottom) {
        k = j;
        box = r;
        break;
      }
    }
    if (k >= 0) break;
  }
  if (k < 0 || !box) return null;
  const mid = (r: DOMRect) => (r.top + r.bottom) / 2;
  const on = (j: number) => {
    const r = charRect(m, j);
    return !r || (mid(r) >= box!.top && mid(r) <= box!.bottom);
  };
  let s = k;
  let e = k + 1;
  while (s > span.start && k - s < SCAN_LIMIT && on(s - 1)) s--;
  while (e < span.end && e - k < SCAN_LIMIT && on(e)) e++;
  return { start: s, end: e };
}

/**
 * The line of a block at a client y, as a model span. which = 'first' or 'last'
 * takes the block's first or last line. In a gap between lines, the next line counts.
 */
export function lineAt(m: TextModel, span: Span, y: number | 'first' | 'last'): Span | null {
  if (span.end <= span.start) return null;
  let k: number;
  if (y === 'first') k = span.start;
  else if (y === 'last') k = span.end - 1;
  else {
    k = firstWhere(m, span.start, span.end, (r) => r.bottom > y);
    if (k >= span.end) k = span.end - 1;
  }
  const p = probe(m, k, span);
  if (!p) return null;
  const top = p.r.top;
  const bottom = p.r.bottom;
  // Floats and inline blocks break text order from top to bottom. When the search lands more
  // than half a line away from y, look for the line that really crosses y. In a gap between
  // lines none does, and the line the search found, the next one, still counts.
  const lh = bottom - top;
  const far = typeof y === 'number' && (y < top - lh / 2 || y > bottom + lh / 2);
  const hit = far ? scanLine(m, span, y) : null;
  let s = hit ? hit.start : firstWhere(m, span.start, p.k + 1, (r) => (r.top + r.bottom) / 2 > top);
  let e = hit ? hit.end : firstWhere(m, p.k, span.end, (r) => (r.top + r.bottom) / 2 > bottom);
  const t = m.text;
  while (s < e && t.charCodeAt(s) === 32) s++;
  while (e > s && t.charCodeAt(e - 1) === 32) e--;
  return e > s ? { start: s, end: e } : null;
}

/** Hash of a block's normalised text. */
export function blockHash(m: TextModel, el: Element): string {
  const span = m.spanOf(el);
  const t = span ? m.text.slice(span.start, span.end).trim() : fold(el.textContent ?? '');
  return hashKey(t);
}

export function quoteAt(m: TextModel, start: number, end: number, ctxLen = 32) {
  const t = m.text;
  return {
    exact: t.slice(start, end),
    prefix: t.slice(Math.max(0, start - ctxLen), start),
    suffix: t.slice(end, end + ctxLen),
  };
}

/** Href of the link the element sits in, else the first link it contains. */
export function linkOf(el: Element): string | undefined {
  for (let e: Element | null = el; e; e = flatParent(e)) {
    if (e.localName === 'a' && e.hasAttribute('href')) return (e as HTMLAnchorElement).href;
  }
  const a = el.querySelector?.('a[href]') as HTMLAnchorElement | null;
  return a ? a.href : undefined;
}

/** Style facts per element, read once until the cache is dropped. */
export class StyleMemo {
  private pin = new Map<Element, boolean>();
  private scroll = new Map<Element, Element | null>();
  private bodyOwn: boolean | undefined;
  constructor(private doc: Document) {}

  private style(el: Element): CSSStyleDeclaration | null {
    return this.doc.defaultView?.getComputedStyle(el) ?? null;
  }

  /** True when el or an ancestor is position fixed or sticky. */
  pinned(el: Element): boolean {
    const hit = this.pin.get(el);
    if (hit !== undefined) return hit;
    const s = this.style(el);
    const own = !!s && (s.position === 'fixed' || s.position === 'sticky');
    const p = flatParent(el);
    const v = own || (p ? this.pinned(p) : false);
    this.pin.set(el, v);
    return v;
  }

  /**
   * True when <body> scrolls by itself instead of the window. That happens only when
   * <html> does not pass its overflow on to the viewport, so body keeps its own.
   */
  private bodyScrolls(): boolean {
    if (this.bodyOwn !== undefined) return this.bodyOwn;
    const html = this.style(this.doc.documentElement);
    const body = this.doc.body ? this.style(this.doc.body) : null;
    const ok = (o: string) => o === 'auto' || o === 'scroll' || o === 'overlay';
    this.bodyOwn =
      !!html &&
      !!body &&
      (html.overflowX !== 'visible' || html.overflowY !== 'visible') &&
      (ok(body.overflowY) || ok(body.overflowX));
    return this.bodyOwn;
  }

  /** Nearest ancestor whose overflow style lets it scroll. */
  private scrollStyled(el: Element): Element | null {
    const hit = this.scroll.get(el);
    if (hit !== undefined) return hit;
    const p = flatParent(el);
    let v: Element | null = null;
    if (p && p === this.doc.body && this.bodyScrolls()) v = p;
    else if (p && p !== this.doc.documentElement && p !== this.doc.body) {
      const s = this.style(p);
      const ok = (o: string) => o === 'auto' || o === 'scroll' || o === 'overlay';
      v = s && (ok(s.overflowY) || ok(s.overflowX)) ? p : this.scrollStyled(p);
    }
    this.scroll.set(el, v);
    return v;
  }

  /** Nearest inner scrolling ancestor that has something to scroll right now. */
  scroller(el: Element): Element | null {
    for (let s = this.scrollStyled(el); s; s = this.scrollStyled(s)) {
      if (s.scrollHeight > s.clientHeight + 1 || s.scrollWidth > s.clientWidth + 1) return s;
    }
    return null;
  }

  private clipMemo = new Map<Element, ClipEdge[]>();

  /**
   * Ancestors that clip el, nearest first: overflow other than visible on an axis, or paint
   * containment. An absolutely positioned element escapes ancestors below its containing
   * block, a fixed one escapes all but transformed ones. Stops at el's inner scroller, which
   * the layer clips to already. A body whose overflow belongs to the viewport does not clip.
   */
  clips(el: Element): ClipEdge[] {
    const hit = this.clipMemo.get(el);
    if (hit) return hit;
    const out: ClipEdge[] = [];
    const stop = this.scroller(el);
    const root = this.doc.documentElement;
    const posOf = (e: Element): 'any' | 'cb' | 'fixed' => {
      const p = this.style(e)?.position;
      return p === 'absolute' ? 'cb' : p === 'fixed' ? 'fixed' : 'any';
    };
    let need = posOf(el);
    for (let a = flatParent(el); a && a !== root && a !== stop; a = flatParent(a)) {
      const s = this.style(a);
      if (!s || s.display === 'contents') continue;
      const contain = s.contain || '';
      const paint = /paint|strict|content/.test(contain);
      const transformed = s.transform !== 'none' || s.filter !== 'none' || s.perspective !== 'none';
      if (need === 'cb' && s.position === 'static' && !transformed && !paint && !/layout/.test(contain))
        continue;
      if (need === 'fixed' && !transformed && !paint && !/layout/.test(contain)) continue;
      const viewport = a === this.doc.body && !this.bodyScrolls();
      const x = !viewport && (paint || s.overflowX !== 'visible');
      const y = !viewport && (paint || s.overflowY !== 'visible');
      if (x || y) out.push({ el: a, x, y });
      need = posOf(a);
    }
    this.clipMemo.set(el, out);
    return out;
  }

  /** Font size as drawn, CSS zoom included, so ink scales with zoomed text. */
  fontPx(el: Element): number {
    const s = this.style(el);
    const v = s ? Number.parseFloat(s.fontSize) : Number.NaN;
    const k = this.zoom(el);
    return Number.isFinite(v) && v > 0 ? v * k : 16 * k;
  }

  /**
   * The CSS zoom el is drawn at. currentCSSZoom gives it where the browser has it. Where it
   * does not (WebKit on Linux, for one), the computed zooms up the tree are multiplied.
   */
  zoom(el: Element): number {
    const z = (el as Element & { currentCSSZoom?: number }).currentCSSZoom;
    if (typeof z === 'number') return z > 0 ? z : 1;
    let k = 1;
    for (let e: Element | null = el; e; e = flatParent(e))
      k *= Number.parseFloat(this.style(e)?.zoom ?? '') || 1;
    return k;
  }
}

export interface MediaInfo {
  src: string;
  alt: string;
  caption: string;
}

function firstMediaChild(el: Element): Element | null {
  return el.querySelector('img, video, iframe, canvas, svg');
}

export function srcOf(el: Element): string {
  const t = el.localName;
  const mark = el.getAttribute('data-ink-media');
  if (mark) return mark;
  if (t === 'img') return (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || '';
  if (t === 'video') {
    const v = el as HTMLVideoElement;
    return v.currentSrc || v.src || v.poster || v.querySelector('source')?.src || '';
  }
  if (t === 'iframe') return (el as HTMLIFrameElement).src || '';
  if (t === 'svg') {
    const img = el.querySelector('image');
    return img?.getAttribute('href') ?? img?.getAttribute('xlink:href') ?? '';
  }
  if (t === 'picture' || t === 'figure') {
    const c = firstMediaChild(el);
    return c ? srcOf(c) : '';
  }
  return '';
}

export function mediaInfo(m: TextModel, el: Element): MediaInfo {
  let alt = el.getAttribute('alt') ?? el.getAttribute('aria-label') ?? '';
  if (!alt && (el.localName === 'picture' || el.localName === 'figure')) {
    alt = el.querySelector('img')?.getAttribute('alt') ?? '';
  }
  let caption = '';
  const fig = el.localName === 'figure' ? el : el.closest('figure');
  const capEl =
    fig?.querySelector('figcaption') ?? (el.localName === 'table' ? el.querySelector('caption') : null);
  if (capEl) {
    const span = m.spanOf(capEl);
    caption = span ? m.text.slice(span.start, span.end).trim() : fold(capEl.textContent ?? '');
  }
  if (!caption) caption = fold(el.getAttribute('title') ?? '');
  return { src: srcOf(el), alt: fold(alt), caption };
}

/** File name of an address, lower-case, without query. */
export function fileName(src: string): string {
  const clean = src.split(/[?#]/)[0] ?? '';
  const last = clean.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last).toLowerCase();
  } catch {
    return last.toLowerCase();
  }
}

/** Model span that stands for a media element: its own text, or the point where it sits. */
export function mediaSpan(m: TextModel, el: Element): Span {
  const own = m.spanOf(el);
  if (own) return own;
  for (const e of m.media) if (e.el === el) return { start: e.at, end: e.at };
  return { start: 0, end: 0 };
}

export function docSize(doc: Document): { w: number; h: number } {
  const r = doc.documentElement;
  return { w: Math.max(1, r.scrollWidth), h: Math.max(1, r.scrollHeight) };
}

/** Last tag of a positional path, for checking that a path still points at the same kind of element. */
export function tagOfPath(a: Anchor): string {
  const last = a.path.xpath.split('/').pop() ?? '';
  return last.replace(/\[\d+\]$/, '');
}

export function add(p: Point, v: View): Point {
  return { x: p.x + v.sx, y: p.y + v.sy };
}
