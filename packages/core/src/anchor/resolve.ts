/**
 * Finding anchors again (DESIGN 7.4). The ladder: structural path with a quote or
 * hash check, exact quote search, approximate search, the media ladder, and for
 * viewport anchors the tied element or the page fraction. Null sends the note to the tray.
 */
import { hashKey } from '../hash';
import type {
  Anchor,
  AnchorContext,
  CreateResolver,
  NoteFrame,
  Point,
  Rect,
  Resolved,
  Resolver,
} from '../types';
import {
  blockHash,
  docSize,
  fileName,
  firstRect,
  mediaInfo,
  mediaSpan,
  StyleMemo,
  srcOf,
  tagOfPath,
  toDoc,
  type View,
  viewOf,
} from './geom';
import { resolvePath } from './path';
import { acceptExact, contextScore, findExact, findFuzzy, type Match } from './search';
import {
  buildModel,
  dropModel,
  fold,
  getModel,
  hasModel,
  isInlineTag,
  isMediaEl,
  type ModelRoot,
  shadowOf,
  TextModel,
} from './text';

interface Found {
  el: Element;
  method: Resolved['method'];
  score: number;
  match?: Match;
}

const STALE = Symbol('stale');

function finish(
  m: TextModel,
  memo: StyleMemo,
  a: Anchor,
  frame: NoteFrame,
  f: Found,
  v: View,
): Resolved | null | typeof STALE {
  const el = f.el;
  let origin: Point;
  let box: Rect;
  let scale = 1;
  let range: Range | undefined;
  let fontEl: Element = el;
  if (f.match && !m.fresh(f.match.start, f.match.end)) return STALE;
  if (a.type === 'text') {
    if (!f.match) return null;
    const r = m.range(f.match.start, f.match.end);
    if (!r) return null;
    const first = firstRect(r);
    if (!first) return null;
    range = r;
    origin = { x: first.left + v.sx, y: first.top + v.sy };
    box = toDoc(r.getBoundingClientRect(), v);
    fontEl = r.startContainer.parentElement ?? el;
  } else if (a.type === 'block') {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    let qTop = rect.top;
    if (f.match && f.match.end > f.match.start) {
      const r = m.range(f.match.start, f.match.end);
      const first = r ? firstRect(r) : null;
      if (first) qTop = first.top;
    }
    const x = a.place === 'right' ? rect.right : rect.left;
    const y = a.place === 'below' ? rect.bottom : qTop;
    origin = { x: x + v.sx, y: y + v.sy };
    box = toDoc(rect, v);
  } else if (a.type === 'media') {
    const rect = el.getBoundingClientRect();
    origin = { x: rect.left + v.sx, y: rect.top + v.sy };
    box = toDoc(rect, v);
    scale = frame.w > 0 && rect.width > 0 ? rect.width / frame.w : 1;
  } else {
    // Viewport: the tied element, else the page fraction.
    if (el === m.doc.documentElement) {
      const { w, h } = docSize(m.doc);
      origin = { x: (a.frac?.x ?? 0) * w, y: (a.frac?.y ?? 0) * h };
      box = { x: origin.x, y: origin.y, w: 0, h: 0 };
    } else {
      const rect = el.getBoundingClientRect();
      origin = { x: rect.left + v.sx, y: rect.top + v.sy };
      box = toDoc(rect, v);
    }
  }
  if (a.type === 'text' || a.type === 'block') {
    scale = frame.fontPx > 0 ? memo.fontPx(fontEl) / frame.fontPx : 1;
  }
  const out: Resolved = { origin, scale, box, el, method: f.method, score: f.score };
  if (range) out.range = range;
  const sc = memo.scroller(el);
  if (sc) out.scroller = sc;
  if (memo.pinned(el)) out.pinned = true;
  // Ink is painted only where the content is: inside every ancestor that clips it.
  const clips = memo.clips(fontEl);
  if (clips.length) out.clips = clips;
  return out;
}

/** Leaf blocks by the hash of their text. Built once per text model, on first need. */
const hashIndexes = new WeakMap<TextModel, Map<string, Element[]>>();

function blocksByHash(m: TextModel): Map<string, Element[]> {
  let idx = hashIndexes.get(m);
  if (!idx) {
    idx = new Map();
    for (const el of m.blockList) {
      const h = blockHash(m, el);
      const list = idx.get(h);
      if (list) list.push(el);
      else idx.set(h, [el]);
    }
    hashIndexes.set(m, idx);
  }
  return idx;
}

/** True when the leaf block holding offset k has an identical twin elsewhere on the page. */
function hasTwin(m: TextModel, k: number): boolean {
  const blk = m.blockAt(k);
  return !!blk && (blocksByHash(m).get(blockHash(m, blk))?.length ?? 0) > 1;
}

/**
 * A block whose whole text and tag are unchanged is the same block, wherever its
 * surroundings moved. Used when the context around the quote changed on both sides.
 */
function findSameBlock(m: TextModel, a: Anchor, hint: number | undefined): Found | null {
  if (!a.hash || !a.quote.exact) return null;
  const tag = tagOfPath(a);
  let found: Found | null = null;
  for (const el of blocksByHash(m).get(a.hash) ?? []) {
    if (el.localName !== tag) continue;
    const span = m.spanOf(el);
    if (!span) continue;
    const best = findExact(m.text, a.quote, hint, span.start, span.end).filter((x) => x.end <= span.end)[0];
    if (!best) continue;
    // Two such blocks cannot be told apart. That is a guess, and a guess goes to the tray.
    if (found) return null;
    found = { el, method: 'exact', score: 0.6 + 0.4 * best.context, match: best };
  }
  return found;
}

/** Steps 1 to 3 for anchors that carry a quote in a block of text. */
function findQuoted(ctx: AnchorContext, m: TextModel, a: Anchor): Found | null {
  const q = a.quote;
  const text = m.text;
  const hint = a.pos?.start;

  // 1. Structural path, confirmed by the quote inside the element or by the block hash.
  for (const el of resolvePath(ctx, a.path)) {
    const span = m.spanOf(el);
    if (!q.exact) {
      if (a.type === 'block' && span && a.hash && blockHash(m, el) === a.hash) {
        return {
          el,
          method: 'path',
          score: 1,
          match: { start: span.start, end: span.start, score: 1, quote: 1, context: 1 },
        };
      }
      continue;
    }
    if (!span) continue;
    let ms = findExact(text, q, hint, span.start, span.end);
    if (a.type === 'block') ms = ms.filter((x) => x.end <= span.end);
    const best = ms[0];
    if (!best) continue;
    // A path can point at the wrong twin after an insertion, so the context must agree too.
    // A block with an identical twin elsewhere is left to the text position in step 2.
    if (hasTwin(m, best.start)) continue;
    if (best.context >= 0.8 || (best.context >= 0.5 && !!a.hash && blockHash(m, el) === a.hash)) {
      return { el: blockFor(m, a, best.start, el), method: 'path', score: best.score, match: best };
    }
  }
  if (!q.exact) return null;

  // 2. Exact quote anywhere, context picks between repeats, position breaks ties.
  const exact = findExact(text, q, hint);
  const top = exact[0];
  if (top && acceptExact(top, q, exact.length, exact[1], hint)) {
    return { el: blockFor(m, a, top.start), method: 'exact', score: top.score, match: top };
  }

  // 2b. The same block, whole and unchanged, though the text around it changed.
  if (top) {
    const same = findSameBlock(m, a, hint);
    if (same) return same;
  }

  // 3. Approximate quote, scored with its context, held to the similarity bar.
  const fz = findFuzzy(text, q, hint);
  if (fz) return { el: blockFor(m, a, fz.start), method: 'fuzzy', score: fz.score, match: fz };
  return null;
}

/** The block a match belongs to. For a path hit, keep the element the path found when it holds the match. */
function blockFor(m: TextModel, a: Anchor, start: number, pathEl?: Element): Element {
  const b = m.blockAt(start) ?? m.doc.body;
  if (a.type === 'text' || !pathEl) return b;
  return pathEl;
}

function textOk(s: string): boolean {
  return s.length >= 3;
}

/** Step 4: the media ladder. */
function findMedia(ctx: AnchorContext, m: TextModel, a: Anchor): Found | null {
  const want = a.media ?? { src: '', alt: '', caption: '' };
  const tag = tagOfPath(a);
  const wantFile = fileName(want.src);
  const ctxScore = (el: Element) => {
    const s = mediaSpan(m, el);
    return contextScore(m.text, s.start, s.end, {
      exact: '',
      prefix: a.quote.prefix,
      suffix: a.quote.suffix,
    });
  };
  const sameKind = (el: Element) => el.localName === tag;

  // Path, confirmed by what the element shows.
  for (const el of resolvePath(ctx, a.path)) {
    if (!isMediaEl(el) || el.localName !== tag) continue;
    const info = mediaInfo(m, el);
    // With no address, caption or alt to compare, the path is confirmed by the element's own text
    // (a table) or by the text around it. A path alone can point at the next table along.
    const nothingStored = !want.src && !want.alt && !want.caption;
    if (
      (nothingStored && (blockHash(m, el) === a.hash || ctxScore(el) >= 0.6)) ||
      (want.src && info.src === want.src) ||
      (wantFile && fileName(info.src) === wantFile) ||
      (textOk(want.caption) && info.caption === want.caption) ||
      (textOk(want.alt) && info.alt === want.alt)
    ) {
      return { el, method: 'path', score: 1 };
    }
  }

  const all = m.media.map((e) => e.el).filter((el) => !ctx.isOurs?.(el));
  const pick = (list: Element[], score: number): Found | null => {
    if (!list.length) return null;
    if (list.length === 1) return { el: list[0]!, method: 'media', score };
    let best = list[0]!;
    let bs = -1;
    for (const el of list) {
      const s = ctxScore(el);
      if (s > bs) {
        bs = s;
        best = el;
      }
    }
    return { el: best, method: 'media', score: score * (0.5 + bs / 2) };
  };
  const info = new Map<Element, ReturnType<typeof mediaInfo>>();
  const infoOf = (el: Element) => {
    let i = info.get(el);
    if (!i) {
      i = mediaInfo(m, el);
      info.set(el, i);
    }
    return i;
  };
  if (want.src) {
    const r = pick(
      all.filter((el) => srcOf(el) === want.src),
      1,
    );
    if (r) return r;
  }
  if (wantFile && wantFile.length >= 3) {
    const r = pick(
      all.filter((el) => fileName(srcOf(el)) === wantFile),
      0.9,
    );
    if (r) return r;
  }
  if (textOk(want.caption)) {
    const r = pick(
      all.filter((el) => infoOf(el).caption === want.caption),
      0.85,
    );
    if (r) return r;
  }
  if (textOk(want.alt)) {
    const r = pick(
      all.filter((el) => infoOf(el).alt === want.alt),
      0.8,
    );
    if (r) return r;
  }
  // Position among its neighbours: the same kind of element with the same text around it.
  if (a.quote.prefix || a.quote.suffix) {
    let best: Element | null = null;
    let bs = 0;
    for (const el of all) {
      if (!sameKind(el)) continue;
      const s = ctxScore(el);
      if (s > bs) {
        bs = s;
        best = el;
      }
    }
    if (best && bs >= 0.75) return { el: best, method: 'media', score: 0.6 * bs };
  }
  return null;
}

function findViewport(ctx: AnchorContext, _m: TextModel | null, a: Anchor): Found {
  const tag = tagOfPath(a);
  if (a.path.css || a.path.xpath || a.path.id) {
    for (const el of resolvePath(ctx, a.path)) {
      if (el.localName !== tag) continue;
      if (a.path.id && el.id !== a.path.id) continue;
      return { el, method: 'viewport', score: 1 };
    }
  }
  return { el: ctx.doc.documentElement, method: 'viewport', score: 0.5 };
}

function attempt(
  ctx: AnchorContext,
  m: TextModel,
  memo: StyleMemo,
  a: Anchor,
  frame: NoteFrame,
): Resolved | null | typeof STALE {
  const v = viewOf(ctx.doc);
  let f: Found | null;
  if (a.type === 'media') f = findMedia(ctx, m, a);
  else if (a.type === 'viewport') f = findViewport(ctx, m, a);
  else f = findQuoted(ctx, m, a);
  if (!f) return null;
  return finish(m, memo, a, frame, f, v);
}

/** Tags whose content the document text never walks. Same lists as the text model. */
const NOT_WALKED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'textarea',
  'select',
  'iframe',
  'frame',
  'object',
  'embed',
  'head',
  'title',
  'meta',
  'link',
  'img',
  'video',
  'audio',
  'canvas',
  'svg',
  'picture',
]);

type Visible = Element & { checkVisibility(o?: { visibilityProperty?: boolean }): boolean };

/** How the full model would treat el's own text: shown, hidden, or not walked at all. */
function shownOf(ctx: AnchorContext, el: Element): boolean | null {
  const v = el as Visible;
  if (el.hasAttribute('hidden') || NOT_WALKED.has(el.localName) || ctx.isOurs?.(el)) return null;
  if (v.checkVisibility({ visibilityProperty: true })) return true;
  // Not rendered at all, or display: contents. Left to the full model.
  if (!v.checkVisibility()) return null;
  return false;
}

/** Most block levels a local model climbs, and sibling blocks it adds on each side per level. */
const CLIMB = 6;
const WIDEN = 3;
/** Time one quick resolve may spend building local models. Past it, the full ladder decides. */
const LOCAL_MS = 1;

/** True for an element that starts a block the full model walks. */
const blockStart = (ctx: AnchorContext, n: Node | null): n is Element =>
  !!n && n.nodeType === 1 && !isInlineTag(n as Element) && shownOf(ctx, n as Element) !== null;

/**
 * A text model around `base` whose text equals the full model's text over the same nodes.
 * It starts with the nearest block, then adds sibling blocks on each side, then climbs a
 * level, until `need` holds. Undefined when that cannot be promised cheaply: shadow trees,
 * hidden or skipped ancestors, or not enough context in reach.
 */
function localModel(
  ctx: AnchorContext,
  base: Element,
  need: (m: TextModel) => boolean | null,
  memo: Map<Element, TextModel>,
  until: number,
): TextModel | undefined {
  const doc = ctx.doc;
  // A model that does not finish in time is dropped: big blocks are cheaper in the full model.
  const build = (root: ModelRoot): TextModel | undefined => {
    const m = new TextModel(ctx, { root, lazy: true });
    return m.step(until) ? m : undefined;
  };
  const body = doc.body;
  if (!body || typeof (base as Partial<Visible>).checkVisibility !== 'function') return undefined;
  if (base.getRootNode() !== doc || !body.contains(base) || base === body) return undefined;
  if (shadowOf(ctx, body)) return undefined;
  // Every ancestor must be walked by the full model the plain way.
  for (let a = base.parentElement; a && a !== body; a = a.parentElement) {
    if (NOT_WALKED.has(a.localName) || a.hasAttribute('hidden') || ctx.isOurs?.(a) || shadowOf(ctx, a))
      return undefined;
  }
  let r: Element | null = base;
  while (r && r !== body && isInlineTag(r)) r = r.parentElement;
  for (let i = 0; r && r !== body && i < CLIMB; i++) {
    let m = memo.get(r);
    if (!m) {
      const shown = shownOf(ctx, r);
      if (shown === null) return undefined;
      m = build({ el: r, shown });
      if (!m) return undefined;
      memo.set(r, m);
    }
    let ok = need(m);
    if (ok === null) return undefined;
    if (ok) return m;
    const p: Element | null = r.parentElement;
    if (!p) return undefined;
    // Neighbouring blocks under the same parent, before climbing to the whole parent.
    const pShown = p === body ? true : shownOf(ctx, p);
    if (pShown !== null && (p === body || !isInlineTag(p))) {
      let first: Element = r;
      let last: Node = r;
      for (let k = 0; k < WIDEN; k++) {
        let f: Node | null = first.previousSibling;
        while (f && !blockStart(ctx, f)) f = f.previousSibling;
        let l: Node | null = last.nextSibling;
        while (l && l.nodeType !== 1) l = l.nextSibling;
        if (!f && !l) break;
        if (f) first = f as Element;
        if (l) last = l;
        const nodes: Node[] = [];
        for (let n: Node | null = first; n; n = n.nextSibling) {
          nodes.push(n);
          if (n === last) break;
        }
        const run = build({ el: p, shown: pShown, nodes });
        if (!run) return undefined;
        ok = need(run);
        if (ok === null) return undefined;
        if (ok) return run;
      }
    }
    r = p;
    while (r && r !== body && isInlineTag(r)) r = r.parentElement;
  }
  return undefined;
}

type Local = (base: Element, need: (m: TextModel) => boolean | null) => TextModel | undefined;

/** Step 1 for quoted anchors on a local model. Same tests as findQuoted, except the twin check. */
function quickQuoted(ctx: AnchorContext, a: Anchor, local: Local): { m: TextModel; f: Found } | undefined {
  const q = a.quote;
  for (const el of resolvePath(ctx, a.path)) {
    if (!q.exact) {
      if (a.type !== 'block' || !a.hash) continue;
      const m = local(el, () => true);
      if (!m) return undefined;
      const span = m.spanOf(el);
      if (span && blockHash(m, el) === a.hash) {
        return {
          m,
          f: {
            el,
            method: 'path',
            score: 1,
            match: { start: span.start, end: span.start, score: 1, quote: 1, context: 1 },
          },
        };
      }
      continue;
    }
    // The model must hold every match with its whole context, and no match may run past its end.
    let ms: Match[] = [];
    const m = local(el, (lm) => {
      const span = lm.spanOf(el);
      if (!span) return true;
      const t = lm.text;
      ms = findExact(t, q, undefined, span.start, span.end);
      if (a.type === 'block') ms = ms.filter((x) => x.end <= span.end);
      else {
        // A match starting inside the span could run on into text this model does not hold.
        for (let k = 1; k < q.exact.length; k++) {
          const p = t.length - k;
          if (p < span.start) break;
          if (p < span.end && t.endsWith(q.exact.slice(0, k))) return false;
        }
      }
      return ms.every((x) => x.start >= q.prefix.length && x.end + q.suffix.length <= t.length);
    });
    if (!m) return undefined;
    const span = m.spanOf(el);
    if (!span) continue;
    const best = ms[0];
    if (!best) continue;
    // Equal scores are ordered by the old text position, which only the full model knows.
    if (ms.length >= 1000 || (ms[1] && ms[1].score === best.score)) return undefined;
    if (best.context >= 0.8 || (best.context >= 0.5 && !!a.hash && blockHash(m, el) === a.hash)) {
      return { m, f: { el: blockFor(m, a, best.start, el), method: 'path', score: best.score, match: best } };
    }
  }
  return undefined;
}

/** The path part of the media ladder on a local model. */
function quickMedia(ctx: AnchorContext, a: Anchor, local: Local): { m: TextModel; f: Found } | undefined {
  const want = a.media ?? { src: '', alt: '', caption: '' };
  const tag = tagOfPath(a);
  const wantFile = fileName(want.src);
  let first = true;
  for (const el of resolvePath(ctx, a.path)) {
    if (!isMediaEl(el) || el.localName !== tag) continue;
    // The full ladder checks this element first and takes it on the same address alone,
    // so no text around it is needed. Finishing a media note reads only its box.
    if (first) {
      first = false;
      const src = srcOf(el);
      if ((want.src && src === want.src) || (wantFile && fileName(src) === wantFile))
        return { m: new TextModel(ctx, { lazy: true }), f: { el, method: 'path', score: 1 } };
    }
    const fig = el.localName === 'figure' ? el : el.closest('figure');
    const m = local(fig && fig !== el && fig.contains(el) ? fig : el, (lm) => {
      const own = lm.spanOf(el);
      const at = own ? null : lm.media.find((e) => e.el === el);
      // Not in the text at all: the full model scores it at the top of the page.
      if (!own && !at) return null;
      const s = own ?? { start: at!.at, end: at!.at };
      return s.start >= a.quote.prefix.length && lm.text.length >= s.end + a.quote.suffix.length;
    });
    if (!m) return undefined;
    const info = mediaInfo(m, el);
    const s = mediaSpan(m, el);
    const ctxScore = () =>
      contextScore(m.text, s.start, s.end, { exact: '', prefix: a.quote.prefix, suffix: a.quote.suffix });
    const nothingStored = !want.src && !want.alt && !want.caption;
    if (
      (nothingStored && (blockHash(m, el) === a.hash || ctxScore() >= 0.6)) ||
      (want.src && info.src === want.src) ||
      (wantFile && fileName(info.src) === wantFile) ||
      (textOk(want.caption) && info.caption === want.caption) ||
      (textOk(want.alt) && info.alt === want.alt)
    ) {
      return { m, f: { el, method: 'path', score: 1 } };
    }
  }
  return undefined;
}

type Shown = Element & {
  checkVisibility(o?: { opacityProperty?: boolean; visibilityProperty?: boolean }): boolean;
};

/**
 * The element an anchor's path points at, when it is there but not shown and still holds
 * the anchored content: a closed section, a hidden tab, a closed menu. The text model leaves
 * such content out, so the quote is checked against the element's own text.
 */
function hiddenAnchor(ctx: AnchorContext, a: Anchor): Element | null {
  if (a.type === 'viewport') return null;
  const tag = tagOfPath(a);
  for (const el of resolvePath(ctx, a.path)) {
    const v = el as Shown;
    if (typeof v.checkVisibility !== 'function') return null;
    if (v.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    if (a.type === 'media') {
      if (el.localName === tag) return el;
      continue;
    }
    const text = fold(el.textContent ?? '');
    if (a.quote.exact) {
      if (text.includes(fold(a.quote.exact))) return el;
    } else if (a.hash && hashKey(text) === a.hash) return el;
  }
  return null;
}

export const createResolver: CreateResolver = (ctx: AnchorContext): Resolver => {
  let memo = new StyleMemo(ctx.doc);
  // Local models of blocks, kept until the page changes.
  let locals = new Map<Element, TextModel>();
  let until = 0;
  const local: Local = (base, need) => localModel(ctx, base, need, locals, until);
  const invalidate = () => {
    dropModel(ctx.doc);
    memo = new StyleMemo(ctx.doc);
    locals = new Map();
  };
  return {
    resolve(anchor: Anchor, frame: NoteFrame): Resolved | null {
      let r = attempt(ctx, getModel(ctx), memo, anchor, frame);
      if (r === STALE) {
        // The page changed under a cached node. Rebuild once and try again.
        invalidate();
        r = attempt(ctx, getModel(ctx), memo, anchor, frame);
      }
      return r === STALE ? null : r;
    },
    quick(anchor: Anchor, frame: NoteFrame): Resolved | undefined {
      until = (ctx.now?.() ?? performance.now()) + LOCAL_MS;
      let got: { m: TextModel; f: Found } | undefined;
      if (anchor.type === 'viewport') {
        got = { m: new TextModel(ctx, { lazy: true }), f: findViewport(ctx, null, anchor) };
      } else if (anchor.type === 'media') got = quickMedia(ctx, anchor, local);
      else got = quickQuoted(ctx, anchor, local);
      if (!got) return undefined;
      const r = finish(got.m, memo, anchor, frame, got.f, viewOf(ctx.doc));
      return r && r !== STALE ? r : undefined;
    },
    hidden: (anchor: Anchor) => hiddenAnchor(ctx, anchor),
    locate(anchor: Anchor): Element | null {
      for (const el of resolvePath(ctx, anchor.path)) return el;
      return null;
    },
    ready: () => hasModel(ctx),
    prepare: (ms: number) => buildModel(ctx, ms),
    invalidate,
  };
};
