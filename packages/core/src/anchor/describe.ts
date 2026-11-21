/**
 * Choosing the anchor when a note is written (DESIGN 7.2).
 */
import { hashKey } from '../hash';
import type { Anchor, AnchorContext, Describe, Described, DescribeRange, Place, Point, Rect } from '../types';
import {
  blockHash,
  docSize,
  firstRect,
  lineAt,
  linkOf,
  mediaInfo,
  mediaSpan,
  quoteAt,
  StyleMemo,
  toDoc,
  type View,
  viewOf,
} from './geom';
import { isStableId, pathOf } from './path';
import {
  dropModel,
  flatParent,
  getModel,
  isMediaEl,
  type Span,
  shadowOf,
  type TextModel,
  widenToWords,
} from './text';

/** Longest quote kept for a text anchor. The start is what places the note. */
const MAX_QUOTE = 200;
/** A block further than this from the note cannot hold it. */
const MAX_BLOCK_GAP = 160;

interface Caret {
  node: Node;
  offset: number;
}

type CaretDoc = Document & {
  caretPositionFromPoint?(
    x: number,
    y: number,
    opts?: { shadowRoots?: ShadowRoot[] },
  ): { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?(x: number, y: number): Range | null;
};

export function caretAt(m: TextModel, x: number, y: number): Caret | null {
  const d = m.doc as CaretDoc;
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y, { shadowRoots: m.shadowRoots });
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = d.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** Returned by glyphAt when the point is on text the model has not seen: the page changed. */
export const NEW_TEXT = -2;

const NOT_TEXT_PARENT = new Set(['textarea', 'select', 'option', 'script', 'style', 'noscript', 'template']);

function isNewText(n: Node): boolean {
  if (n.nodeType !== 3 || !n.isConnected || !/\S/.test((n as Text).data)) return false;
  const p = n.parentElement;
  return !p || !NOT_TEXT_PARENT.has(p.localName);
}

/** Model offset of the character drawn under a client point, -1 for none, NEW_TEXT for unseen text. */
export function glyphAt(m: TextModel, x: number, y: number, tol = 1, spaces = false): number {
  const c = caretAt(m, x, y);
  if (!c) return -1;
  const k = m.offsetOf(c.node, c.offset);
  if (k < 0) return isNewText(c.node) ? NEW_TEXT : -1;
  for (const j of [k, k - 1]) {
    if (j < 0 || j >= m.text.length || (!spaces && m.text.charCodeAt(j) === 32)) continue;
    const r = m.range(j, j + 1)?.getBoundingClientRect();
    if (!r || r.width === 0) continue;
    if (x >= r.left - tol && x <= r.right + tol && y >= r.top - tol && y <= r.bottom + tol) return j;
  }
  return -1;
}

/** Deepest element under a client point, looking into shadow trees and past our layer. */
export function elementAt(ctx: AnchorContext, x: number, y: number): Element | null {
  const pick = (list: Element[], root: Document | ShadowRoot): Element | null => {
    for (const e of list) {
      if (ctx.isOurs?.(e)) continue;
      if (root.nodeType === 11 && e.getRootNode() !== root) continue;
      return e;
    }
    return null;
  };
  let el = pick(ctx.doc.elementsFromPoint(x, y), ctx.doc);
  for (let i = 0; el && i < 32; i++) {
    const root = shadowOf(ctx, el);
    if (!root) break;
    const inner = pick(root.elementsFromPoint(x, y), root);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/** The media element a point is on. data-ink-media wins over everything inside it. */
export function mediaOf(el: Element, vh: number): Element | null {
  let inner: Element | null = null;
  for (let e: Element | null = el; e; e = flatParent(e)) {
    if (e.hasAttribute('data-ink-media')) return e;
    if (inner || !isMediaEl(e)) continue;
    if (e.localName === 'table') {
      // A table taller than the screen is page layout, not a figure.
      if (e.getBoundingClientRect().height > vh * 1.5) continue;
    }
    if (e.localName === 'svg') {
      let top = e;
      for (let p = flatParent(e); p && p.namespaceURI === e.namespaceURI; p = flatParent(p)) {
        if (p.localName === 'svg') top = p;
      }
      inner = top;
      continue;
    }
    inner = e;
  }
  return inner;
}

const LANDMARK = new Set(['main', 'nav', 'header', 'footer', 'aside', 'article', 'form']);
const LANDMARK_ROLE = new Set([
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'application',
]);

/** Element a viewport note is tied to: the nearest with a stable id or a landmark role. */
function tieOf(el: Element | null, doc: Document): Element | null {
  for (let e = el; e; e = flatParent(e)) {
    if (e === doc.body || e === doc.documentElement) return null;
    if (e.getRootNode() !== doc) continue;
    if (e.id && isStableId(e.id)) return e;
    if (LANDMARK.has(e.localName)) return e;
    const role = e.getAttribute('role');
    if (role && LANDMARK_ROLE.has(role)) return e;
  }
  return null;
}

interface Built {
  anchor: Anchor;
  frame: Described['frame'];
  origin: Point;
}

function base(type: Anchor['type'], el: Element, m: TextModel, memo: StyleMemo, box: Rect): Anchor {
  const a: Anchor = {
    type,
    quote: { exact: '', prefix: '', suffix: '' },
    path: pathOf(el),
    pos: { start: 0, end: 0 },
    hash: blockHash(m, el),
    place: 'on',
  };
  const { w, h } = docSize(m.doc);
  a.frac = { x: box.x / w, y: box.y / h };
  const link = linkOf(el);
  if (link) a.link = link;
  const sc = memo.scroller(el);
  if (sc) a.scroller = pathOf(sc);
  return a;
}

function viewportW(doc: Document): number {
  return doc.defaultView?.innerWidth ?? doc.documentElement.clientWidth;
}

/** Text anchor for the model span [s, e). Shared by describe and describeRange. */
export function textAnchor(m: TextModel, memo: StyleMemo, span: Span, v: View, box?: Rect): Built | null {
  let { start, end } = span;
  if (end - start > MAX_QUOTE) {
    end = start + MAX_QUOTE;
    const sp = m.text.lastIndexOf(' ', end);
    if (sp > start + 20) end = sp;
  }
  let range = m.range(start, end);
  if (!range) {
    // The span crosses into another shadow tree. Keep the part in the first block.
    const b = m.spanOf(m.blockAt(start)!);
    if (b) end = Math.min(end, b.end);
    while (end > start && m.text.charCodeAt(end - 1) === 32) end--;
    range = m.range(start, end);
  }
  if (!range) return null;
  const first = firstRect(range);
  if (!first) return null;
  const block = m.blockAt(start)!;
  const textEl = (range.startContainer.parentElement ?? block) as Element;
  const bound = range.getBoundingClientRect();
  const anchorBox = box ?? toDoc(bound, v);
  const a = base('text', block, m, memo, anchorBox);
  a.quote = quoteAt(m, start, end);
  a.pos = { start, end };
  const startLink = linkOf(textEl);
  if (startLink) a.link = startLink;
  return {
    anchor: a,
    frame: { w: bound.width, h: bound.height, fontPx: memo.fontPx(textEl), viewportW: viewportW(m.doc) },
    origin: { x: first.left + v.sx, y: first.top + v.sy },
  };
}

/** Block anchor: the block, the side, and the line the note is level with. */
export function blockAnchor(
  m: TextModel,
  memo: StyleMemo,
  el: Element,
  place: Place,
  box: Rect,
  v: View,
): Built {
  const rect = el.getBoundingClientRect();
  const span = m.spanOf(el);
  let line: Span | null = null;
  if (span) {
    if (place === 'above') line = lineAt(m, span, 'first');
    else if (place === 'below') line = lineAt(m, span, 'last');
    else {
      const y = Math.min(Math.max(box.y - v.sy, rect.top), rect.bottom - 1);
      line = lineAt(m, span, y);
    }
  }
  const a = base('block', el, m, memo, box);
  a.place = place;
  let qTop = rect.top;
  if (line) {
    a.quote = quoteAt(m, line.start, line.end);
    a.pos = { start: line.start, end: line.end };
    const r = m.range(line.start, line.end);
    const f = r ? firstRect(r) : null;
    if (f) qTop = f.top;
    else a.quote.exact = '';
  } else if (span) a.pos = { start: span.start, end: span.start };
  const x = place === 'right' ? rect.right : rect.left;
  const y = place === 'below' ? rect.bottom : a.quote.exact ? qTop : rect.top;
  return {
    anchor: a,
    frame: { w: rect.width, h: rect.height, fontPx: memo.fontPx(el), viewportW: viewportW(m.doc) },
    origin: { x: x + v.sx, y: y + v.sy },
  };
}

export function mediaAnchor(m: TextModel, memo: StyleMemo, el: Element, box: Rect, v: View): Built {
  const rect = el.getBoundingClientRect();
  const a = base('media', el, m, memo, box);
  const info = mediaInfo(m, el);
  a.media = info;
  const span = mediaSpan(m, el);
  const q = quoteAt(m, span.start, span.end);
  a.quote = { exact: info.caption || info.alt, prefix: q.prefix, suffix: q.suffix };
  a.pos = { start: span.start, end: span.end };
  if (span.end === span.start) a.hash = hashKey(info.src || info.alt || info.caption || el.localName);
  return {
    anchor: a,
    frame: { w: rect.width, h: rect.height, fontPx: memo.fontPx(el), viewportW: viewportW(m.doc) },
    origin: { x: rect.left + v.sx, y: rect.top + v.sy },
  };
}

function viewportAnchor(m: TextModel, memo: StyleMemo, tie: Element | null, box: Rect, v: View): Built {
  const doc = m.doc;
  const { w, h } = docSize(doc);
  const el = tie ?? doc.documentElement;
  let origin: Point = { x: box.x, y: box.y };
  let fw = 0;
  let fh = 0;
  let a: Anchor;
  if (tie) {
    a = base('viewport', tie, m, memo, box);
    const r = tie.getBoundingClientRect();
    origin = { x: r.left + v.sx, y: r.top + v.sy };
    fw = r.width;
    fh = r.height;
  } else {
    // Nothing to tie to: only the page fraction is left.
    a = {
      type: 'viewport',
      quote: { exact: '', prefix: '', suffix: '' },
      path: { css: '', xpath: '' },
      pos: { start: 0, end: 0 },
      hash: '',
      place: 'on',
    };
  }
  a.frac = { x: origin.x / w, y: origin.y / h };
  return {
    anchor: a,
    frame: { w: fw, h: fh, fontPx: memo.fontPx(el), viewportW: viewportW(doc) },
    origin,
  };
}

const CHROME_TAG = new Set(['nav', 'aside', 'button', 'menu', 'dialog']);
const CHROME_ROLE = new Set([
  'navigation',
  'complementary',
  'banner',
  'contentinfo',
  'menu',
  'menubar',
  'toolbar',
  'tablist',
  'tab',
  'button',
  'search',
  'dialog',
]);

/**
 * True for page chrome: navigation, sidebars, buttons, menus, and anything fixed or sticky.
 * Such blocks hold a margin note only when no running text is level with it.
 */
export function isChrome(el: Element, memo: StyleMemo): boolean {
  if (memo.pinned(el)) return true;
  for (let e: Element | null = el; e; e = flatParent(e)) {
    const t = e.localName;
    if (t === 'body' || t === 'main' || t === 'article') return false;
    if (CHROME_TAG.has(t)) return true;
    const role = e.getAttribute('role');
    if (role && CHROME_ROLE.has(role)) return true;
    // A page header or footer outside the article is chrome. Inside it, it is a title or byline.
    if ((t === 'header' || t === 'footer') && !e.closest('main, article, [role=main]')) return true;
  }
  return false;
}

/** Union of the boxes of the text a block holds itself, not through child blocks. */
function ownTextBox(m: TextModel, el: Element): DOMRect | null {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  const range = m.doc.createRange();
  for (const i of m.ownSegs(el)) {
    const s = m.segs[i]!;
    if (s.len === 1 && m.text.charCodeAt(s.start) === 32) continue;
    range.selectNodeContents(s.node);
    for (const q of range.getClientRects()) {
      if (q.width <= 0 || q.height <= 0) continue;
      l = Math.min(l, q.left);
      t = Math.min(t, q.top);
      r = Math.max(r, q.right);
      b = Math.max(b, q.bottom);
    }
  }
  return l < r && t < b ? new DOMRect(l, t, r - l, b - t) : null;
}

type Visible = Element & { checkVisibility?(o?: { contentVisibilityAuto?: boolean }): boolean };

/** False for content that content-visibility skips right now. */
function rendered(el: Element): boolean {
  const v = el as Visible;
  return typeof v.checkVisibility !== 'function' || v.checkVisibility({ contentVisibilityAuto: true });
}

type Shown = Element & {
  checkVisibility?(o?: { opacityProperty?: boolean; visibilityProperty?: boolean }): boolean;
};

/** False for content that is transparent or not visible, though it may still take the pointer. */
function shownEl(el: Element): boolean {
  const v = el as Shown;
  return (
    typeof v.checkVisibility !== 'function' ||
    v.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  );
}

/** The part of a client rect its clipping ancestors leave visible. Null when nothing is left. */
function visiblePart(memo: StyleMemo, el: Element, r: DOMRect): DOMRect | null {
  let l = r.left;
  let t = r.top;
  let rt = r.right;
  let b = r.bottom;
  for (const c of memo.clips(el)) {
    // Only an ancestor cutting its content right now hides any of it.
    const cx = c.x && c.el.scrollWidth > c.el.clientWidth + 1;
    const cy = c.y && c.el.scrollHeight > c.el.clientHeight + 1;
    if (!cx && !cy) continue;
    const q = c.el.getBoundingClientRect();
    const x0 = q.left + c.el.clientLeft;
    const y0 = q.top + c.el.clientTop;
    if (cx) {
      l = Math.max(l, x0);
      rt = Math.min(rt, x0 + c.el.clientWidth);
    }
    if (cy) {
      t = Math.max(t, y0);
      b = Math.min(b, y0 + c.el.clientHeight);
    }
  }
  return l < rt && t < b ? new DOMRect(l, t, rt - l, b - t) : null;
}

/** The nearest floating box around el: a menu, panel or popup positioned over the page. */
function floatingBox(el: Element | null, doc: Document): Element | null {
  for (let e = el; e && e !== doc.body && e !== doc.documentElement; e = flatParent(e)) {
    const p = doc.defaultView?.getComputedStyle(e).position;
    if (p === 'absolute' || p === 'fixed') return e;
  }
  return null;
}

/** Most text-node boxes measured for one block. Longer blocks use their element box. */
const OWN_BOX_LIMIT = 400;

/**
 * Nearest block of text to a box: by vertical overlap, then horizontal distance.
 * Distance is measured to the text a block holds itself, so a wrapper that holds a stray
 * line of text cannot claim a note beside one of its paragraphs. When running text is level
 * with the note, page chrome is never chosen.
 */
export function nearestBlock(
  m: TextModel,
  memo: StyleMemo,
  box: Rect,
  v: View,
  within?: Element | null,
): { el: Element; place: Place } | null {
  const top = box.y - v.sy;
  const bottom = top + box.h;
  const left = box.x - v.sx;
  const right = left + box.w;
  const cx = (left + right) / 2;
  type Cand = {
    el: Element;
    cost: number;
    area: number;
    overlap: number;
    r: DOMRect;
    level: boolean;
    chrome: boolean;
  };
  const cands: Cand[] = [];
  for (const el of m.blockList) {
    if (el === m.doc.body) continue;
    const span = m.spanOf(el);
    if (!span || !/\S/.test(m.text.slice(span.start, Math.min(span.end, span.start + 64)))) continue;
    const er = el.getBoundingClientRect();
    if (er.width <= 0 || er.height <= 0) continue;
    if (Math.max(er.top - bottom, top - er.bottom) > MAX_BLOCK_GAP) continue;
    // Content skipped by content-visibility is not painted, and its boxes can spill over the
    // part of the page that is. It cannot be what the note was drawn beside.
    if (!rendered(el)) continue;
    // Transparent content, and content its clipping ancestors cut away, is not on screen.
    if (!shownEl(el)) continue;
    const seen = visiblePart(
      memo,
      el,
      (m.ownSegs(el).length <= OWN_BOX_LIMIT ? ownTextBox(m, el) : null) ?? er,
    );
    if (!seen) continue;
    const r = seen;
    const overlap = Math.min(bottom, r.bottom) - Math.max(top, r.top);
    const vGap = overlap > 0 ? 0 : Math.max(r.top - bottom, top - r.bottom);
    const hGap = right < r.left ? r.left - right : left > r.right ? left - r.right : 0;
    if (vGap > MAX_BLOCK_GAP) continue;
    // Margin notes look sideways, gap notes look up and down. Sideways reach is wider.
    const cost = hGap * 0.5 + vGap * 2 - Math.min(overlap, box.h) * 0.01;
    cands.push({
      el,
      cost,
      area: er.width * er.height,
      overlap: Math.max(0, Math.min(overlap, box.h)),
      r,
      level: overlap > 0,
      chrome: false,
    });
  }
  // Written on a menu or panel open over the page: its own blocks, never the page behind it.
  if (within && cands.some((c) => within.contains(c.el))) {
    for (let i = cands.length - 1; i >= 0; i--) if (!within.contains(cands[i]!.el)) cands.splice(i, 1);
  }
  for (const c of cands) c.chrome = isChrome(c.el, memo);
  const textLevel = cands.some((c) => c.level && !c.chrome && c.cost <= 600);
  let best: Cand | null = null;
  for (const c of cands) {
    if (c.chrome && textLevel) continue;
    // On a near tie, the block level with more of the note wins, then the smaller block.
    const tie = best && Math.abs(c.cost - best.cost) <= 0.5;
    if (
      !best ||
      c.cost < best.cost - 0.5 ||
      (tie && c.overlap > best.overlap + 1) ||
      (tie && Math.abs(c.overlap - best.overlap) <= 1 && c.area < best.area)
    ) {
      best = c;
    }
  }
  if (!best || best.cost > 600) return null;
  const r = best.r;
  const overlap = Math.min(bottom, r.bottom) - Math.max(top, r.top);
  let place: Place;
  if (overlap > 0) place = cx < r.left ? 'left' : cx > r.right ? 'right' : 'on';
  else place = bottom <= r.top ? 'above' : 'below';
  return { el: best.el, place };
}

function sampleGrid(box: Rect): Point[] {
  const nx = Math.max(3, Math.min(7, Math.round(box.w / 16)));
  const ny = Math.max(3, Math.min(7, Math.round(box.h / 14)));
  const pts: Point[] = [{ x: box.x + box.w / 2, y: box.y + box.h / 2 }];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      pts.push({ x: box.x + (box.w * (i + 0.5)) / nx, y: box.y + (box.h * (j + 0.5)) / ny });
    }
  }
  return pts;
}

export const describe: Describe = (ctx: AnchorContext, box: Rect): Described => describeIn(ctx, box, false);

function describeIn(ctx: AnchorContext, box: Rect, retried: boolean): Described {
  const m = getModel(ctx);
  const doc = ctx.doc;
  const v = viewOf(doc);
  const memo = new StyleMemo(doc);
  const win = doc.defaultView;
  const vw = win?.innerWidth ?? 0;
  const vh = win?.innerHeight ?? 0;

  const pts = sampleGrid(box);
  let inView = 0;
  let centerGlyph = false;
  const mediaCount = new Map<Element, number>();
  const glyphs: number[] = [];
  let centerEl: Element | null = null;
  for (let i = 0; i < pts.length; i++) {
    const cx = pts[i]!.x - v.sx;
    const cy = pts[i]!.y - v.sy;
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
    inView++;
    const el = elementAt(ctx, cx, cy);
    if (i === 0) centerEl = el;
    // A transparent element can still take the pointer. What it holds is not what was written on.
    if (el && !shownEl(el)) continue;
    const med = el ? mediaOf(el, vh) : null;
    if (med) {
      mediaCount.set(med, (mediaCount.get(med) ?? 0) + (i === 0 ? 2 : 1));
      continue;
    }
    const g = glyphAt(m, cx, cy);
    if ((g === NEW_TEXT || (g >= 0 && !m.fresh(g, g + 1))) && !retried) {
      // The page changed since the model was built.
      dropModel(doc);
      return describeIn(ctx, box, true);
    }
    if (g >= 0) {
      glyphs.push(g);
      if (i === 0) centerGlyph = true;
    }
  }

  // Media: most samples on one media element.
  let media: Element | null = null;
  let mediaHits = 0;
  for (const [el, n] of mediaCount) {
    if (n > mediaHits) {
      media = el;
      mediaHits = n;
    }
  }
  if (inView === 0) {
    const c = { x: box.x + box.w / 2 - v.sx, y: box.y + box.h / 2 - v.sy };
    for (const e of m.media) {
      const r = e.el.getBoundingClientRect();
      if (c.x >= r.left && c.x <= r.right && c.y >= r.top && c.y <= r.bottom) {
        media = mediaOf(e.el, vh) ?? e.el;
        mediaHits = 1;
      }
    }
  }
  const useMedia = media && (inView === 0 || mediaHits * 2 >= inView + 1);
  let out: Built | null = null;
  if (useMedia && media) out = mediaAnchor(m, memo, media, box, v);
  else if (glyphs.length && (centerGlyph || glyphs.length >= Math.max(1, inView * 0.15))) {
    const s = Math.min(...glyphs);
    const e = Math.max(...glyphs) + 1;
    out = textAnchor(m, memo, widenToWords(m.text, s, e), v, box);
  }
  if (!out) {
    const nb = nearestBlock(m, memo, box, v, floatingBox(centerEl, doc));
    if (nb) out = blockAnchor(m, memo, nb.el, nb.place, box, v);
  }
  if (!out) out = viewportAnchor(m, memo, tieOf(centerEl, doc), box, v);
  if (out.anchor.type !== 'viewport') {
    const { w, h } = docSize(doc);
    out.anchor.frac = { x: box.x / w, y: box.y / h };
  }
  return out;
}

function rebuild(ctx: AnchorContext): TextModel {
  dropModel(ctx.doc);
  return getModel(ctx);
}

/** Model offset for a Range boundary, looking into element containers. */
function boundary(m: TextModel, node: Node, offset: number, side: 'start' | 'end'): number {
  if (node.nodeType === 3) return m.offsetOf(node, offset);
  const kids = node.childNodes;
  if (side === 'start') {
    for (let i = offset; i < kids.length; i++) {
      const k = kids[i]!;
      if (k.nodeType === 3 && m.nodeIndex.has(k as Text)) return m.offsetOf(k, 0);
      if (k.nodeType === 1) {
        const s = m.spanOf(k as Element);
        if (s) return s.start;
      }
    }
  } else {
    for (let i = offset - 1; i >= 0; i--) {
      const k = kids[i]!;
      if (k.nodeType === 3 && m.nodeIndex.has(k as Text)) return m.offsetOf(k, (k as Text).length);
      if (k.nodeType === 1) {
        const s = m.spanOf(k as Element);
        if (s) return s.end;
      }
    }
  }
  return node.nodeType === 1 ? (m.spanOf(node as Element)?.[side] ?? -1) : -1;
}

export const describeRange: DescribeRange = (ctx: AnchorContext, range: Range): Described => {
  let m = getModel(ctx);
  let s = boundary(m, range.startContainer, range.startOffset, 'start');
  let e = boundary(m, range.endContainer, range.endOffset, 'end');
  if (s < 0 || e < 0 || !m.fresh(s, e)) {
    m = rebuild(ctx);
    s = boundary(m, range.startContainer, range.startOffset, 'start');
    e = boundary(m, range.endContainer, range.endOffset, 'end');
  }
  const v = viewOf(ctx.doc);
  const memo = new StyleMemo(ctx.doc);
  if (s >= 0 && e > s) {
    while (s < e && m.text.charCodeAt(s) === 32) s++;
    while (e > s && m.text.charCodeAt(e - 1) === 32) e--;
    const out = textAnchor(m, memo, { start: s, end: e }, v);
    if (out) return out;
  }
  // No text in the range: fall back to the box it covers.
  const r = range.getBoundingClientRect();
  return describe(ctx, toDoc(r, v));
};
