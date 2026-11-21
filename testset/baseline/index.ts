// Baseline anchor: exact quote match plus element path, nothing else.
// It implements the same types as pageink-core/anchor so the test set pipeline can be checked
// before the real module exists, and so the real module has a floor to beat.
import { hashKey } from 'pageink-core/hash';
import type {
  Anchor,
  AnchorContext,
  CreateResolver,
  Describe,
  Described,
  ElementPath,
  NoteFrame,
  Place,
  Point,
  Rect,
  Resolved,
  Resolver,
} from 'pageink-core/types';
import {
  allIndexes,
  blockOf,
  buildIndex,
  firstRect,
  norm,
  offsetOf,
  rangeOf,
  spanOf,
  type TextIndex,
} from '../page/text.ts';

const MEDIA = 'img, video, canvas, iframe, svg, picture';
const QUOTE_SIDE = 32;

function cssPath(el: Element): string {
  const parts: string[] = [];
  let e: Element | null = el;
  while (e && e.nodeType === 1 && e !== e.ownerDocument.documentElement) {
    if (e.id) {
      parts.unshift(`#${CSS.escape(e.id)}`);
      break;
    }
    let i = 1;
    for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
    parts.unshift(`${e.tagName.toLowerCase()}:nth-of-type(${i})`);
    e = e.parentElement;
  }
  return parts.join(' > ');
}

function xPath(el: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e.nodeType === 1; e = e.parentElement) {
    let i = 1;
    for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
    parts.unshift(`${e.tagName.toLowerCase()}[${i}]`);
  }
  return `/${parts.join('/')}`;
}

const pathOf = (el: Element): ElementPath => ({ id: el.id || undefined, css: cssPath(el), xpath: xPath(el) });

function findPath(doc: Document, p: ElementPath): Element | null {
  try {
    if (p.id) {
      const el = doc.getElementById(p.id);
      if (el) return el;
    }
    return doc.querySelector(p.css);
  } catch {
    return null;
  }
}

const docRect = (r: DOMRect): Rect => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
const fontOf = (el: Element) => Number.parseFloat(getComputedStyle(el).fontSize) || 16;

function quoteAt(ix: TextIndex, s: number, e: number) {
  return {
    exact: ix.text.slice(s, e),
    prefix: ix.text.slice(Math.max(0, s - QUOTE_SIDE), s),
    suffix: ix.text.slice(e, e + QUOTE_SIDE),
  };
}

function widen(ix: TextIndex, s: number, e: number): [number, number] {
  while (s > 0 && /\S/.test(ix.text[s - 1]!)) s--;
  while (e < ix.text.length && /\S/.test(ix.text[e]!)) e++;
  while (s < e && ix.text[s] === ' ') s++;
  while (e > s && ix.text[e - 1] === ' ') e--;
  return [s, e];
}

const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, dd, dt, figcaption, td, th, caption';

function nearestBlock(doc: Document, box: Rect): { el: Element; place: Place } | null {
  let best: { el: Element; score: number; place: Place } | null = null;
  for (const el of Array.from(doc.querySelectorAll(BLOCKS))) {
    if (el.querySelector(BLOCKS.replace(/, (td|th|caption|figcaption)/g, ''))) continue;
    const r = docRect(el.getBoundingClientRect());
    if (r.w < 1 || r.h < 1) continue;
    const overlap = Math.min(r.y + r.h, box.y + box.h) - Math.max(r.y, box.y);
    const dx = box.x + box.w < r.x ? r.x - (box.x + box.w) : box.x > r.x + r.w ? box.x - (r.x + r.w) : 0;
    const dy = overlap > 0 ? 0 : Math.min(Math.abs(r.y - (box.y + box.h)), Math.abs(box.y - (r.y + r.h)));
    const score = (overlap > 0 ? -overlap : dy * 4) + dx;
    let place: Place = 'on';
    if (overlap > 0) place = box.x + box.w <= r.x ? 'left' : box.x >= r.x + r.w ? 'right' : 'on';
    else place = box.y >= r.y + r.h ? 'below' : 'above';
    if (!best || score < best.score) best = { el, score, place };
  }
  return best;
}

function lineStartAt(ix: TextIndex, el: Element, y: number): number {
  const [bs, be] = spanOf(ix, el);
  let last = bs;
  for (let i = bs; i < be; i++) {
    if (ix.text[i] === ' ' && i > bs) continue;
    const r = rangeOf(ix, i, i + 1);
    const rc = r && firstRect(r);
    if (!rc) continue;
    if (rc.top + scrollY > y) return last;
    if (i === bs || ix.text[i - 1] === ' ') last = i;
  }
  return last;
}

function originFor(anchor: Anchor, el: Element, range: Range | null): Point {
  const b = docRect(el.getBoundingClientRect());
  if (anchor.type === 'media' || anchor.type === 'viewport') return { x: b.x, y: b.y };
  const rc = range ? firstRect(range) : null;
  if (anchor.type === 'text') return rc ? { x: rc.left + scrollX, y: rc.top + scrollY } : { x: b.x, y: b.y };
  if (anchor.place === 'below') return { x: b.x, y: b.y + b.h };
  return { x: anchor.place === 'right' ? b.x + b.w : b.x, y: rc ? rc.top + scrollY : b.y };
}

export const describe: Describe = (ctx: AnchorContext, box: Rect): Described => {
  const doc = ctx.doc;
  const ix = buildIndex(doc, ctx);
  const cx = box.x + box.w / 2 - scrollX;
  const cy = box.y + box.h / 2 - scrollY;
  const under = doc.elementsFromPoint(cx, cy).filter((e) => !ctx.isOurs?.(e));
  const frameFor = (el: Element, r: Rect): NoteFrame => ({
    w: r.w,
    h: r.h,
    fontPx: fontOf(el),
    viewportW: innerWidth,
  });
  const base = (type: Anchor['type'], el: Element, s: number, e: number, place: Place): Anchor => {
    const [bs, be] = spanOf(ix, el);
    return {
      type,
      quote: s >= 0 ? quoteAt(ix, s, e) : { exact: '', prefix: '', suffix: '' },
      path: pathOf(el),
      pos: { start: Math.max(0, s), end: Math.max(0, e) },
      hash: hashKey(ix.text.slice(Math.max(0, bs), Math.max(0, be))),
      place,
    };
  };

  // Media: an image, video, canvas or a table under the note.
  const top = under[0];
  const media =
    top?.closest('[data-ink-media]') ??
    under.find((e) => e.matches(MEDIA)) ??
    (box.w * box.h > 4000 ? top?.closest('table') : null);
  if (media) {
    const r = docRect(media.getBoundingClientRect());
    const [s, e] = spanOf(ix, media.closest('figure') ?? media);
    const anchor = base('media', media, s, Math.min(e, s + 64), 'on');
    anchor.media = {
      src: media.getAttribute('src') ?? '',
      alt: media.getAttribute('alt') ?? '',
      caption: norm(media.closest('figure')?.querySelector('figcaption')?.textContent ?? ''),
    };
    return { anchor, frame: frameFor(media, r), origin: { x: r.x, y: r.y } };
  }

  // Text: words under the note, widened to whole words.
  const left = doc.caretRangeFromPoint(box.x - scrollX + 1, cy);
  const right = doc.caretRangeFromPoint(box.x + box.w - scrollX - 1, cy);
  const hit = (c: Range | null) => {
    if (!c || c.startContainer.nodeType !== Node.TEXT_NODE) return false;
    const b = (c.startContainer.parentElement ?? doc.body).getBoundingClientRect();
    return cy >= b.top && cy <= b.bottom && cx >= b.left && cx <= b.right;
  };
  if (left && right && hit(left) && hit(right)) {
    let s = offsetOf(ix, left.startContainer, left.startOffset);
    let e = offsetOf(ix, right.startContainer, right.startOffset);
    if (s >= 0 && e >= s) {
      [s, e] = widen(ix, s, Math.max(e, s + 1));
      const r = rangeOf(ix, s, e);
      const el = r ? (blockOf(r.startContainer) ?? doc.body) : doc.body;
      const anchor = base('text', el, s, e, 'on');
      const rc = r && firstRect(r);
      if (rc) {
        const bb = docRect(el.getBoundingClientRect());
        return { anchor, frame: frameFor(el, bb), origin: { x: rc.left + scrollX, y: rc.top + scrollY } };
      }
    }
  }

  // Beside text: the nearest block by vertical overlap.
  const nb = nearestBlock(doc, box);
  if (nb) {
    const el = nb.el;
    const [bs, be] = spanOf(ix, el);
    const bb = docRect(el.getBoundingClientRect());
    let s = bs;
    if (nb.place === 'left' || nb.place === 'right' || nb.place === 'on')
      s = lineStartAt(ix, el, box.y + box.h / 2);
    const e = Math.min(be, s + 40);
    const anchor = base('block', el, bs < 0 ? -1 : s, e, nb.place);
    const r = bs < 0 ? null : rangeOf(ix, s, Math.max(s + 1, e));
    return { anchor, frame: frameFor(el, bb), origin: originFor(anchor, el, r) };
  }

  // Nothing usable: tie to the page.
  const de = doc.documentElement;
  const anchor = base('viewport', doc.body, -1, -1, 'on');
  anchor.frac = { x: box.x / de.scrollWidth, y: box.y / de.scrollHeight };
  return {
    anchor,
    frame: { w: box.w, h: box.h, fontPx: 16, viewportW: innerWidth },
    origin: { x: box.x, y: box.y },
  };
};

export const createResolver: CreateResolver = (ctx: AnchorContext): Resolver => {
  let ix: TextIndex | null = null;
  const index = () => {
    ix ??= buildIndex(ctx.doc, ctx);
    return ix;
  };
  const done = (
    anchor: Anchor,
    frame: NoteFrame,
    el: Element,
    range: Range | null,
    method: Resolved['method'],
  ): Resolved => {
    const scale =
      anchor.type === 'media'
        ? el.getBoundingClientRect().width / (frame.w || 1)
        : anchor.type === 'viewport'
          ? 1
          : fontOf(el) / (frame.fontPx || 16);
    return {
      origin: originFor(anchor, el, range),
      scale,
      box: docRect(el.getBoundingClientRect()),
      el,
      range: range ?? undefined,
      method,
      score: 1,
    };
  };
  return {
    invalidate() {
      ix = null;
    },
    resolve(anchor: Anchor, frame: NoteFrame): Resolved | null {
      const t = index();
      const q = anchor.quote;
      const exact = norm(q.exact);
      if (anchor.type === 'viewport') {
        const de = ctx.doc.documentElement;
        const el = findPath(ctx.doc, anchor.path) ?? ctx.doc.body;
        if (anchor.frac) {
          return {
            origin: { x: anchor.frac.x * de.scrollWidth, y: anchor.frac.y * de.scrollHeight },
            scale: 1,
            box: docRect(el.getBoundingClientRect()),
            el,
            method: 'viewport',
            score: 0.5,
          };
        }
        return done(anchor, frame, el, null, 'viewport');
      }
      if (anchor.type === 'media') {
        const el = findPath(ctx.doc, anchor.path);
        if (el && (el.getAttribute('src') ?? '') === (anchor.media?.src ?? ''))
          return done(anchor, frame, el, null, 'path');
        const src = anchor.media?.src;
        const same = src
          ? Array.from(ctx.doc.querySelectorAll(MEDIA)).find((m) => m.getAttribute('src') === src)
          : null;
        return same ? done(anchor, frame, same, null, 'media') : null;
      }
      // 1. Structural path, confirmed by the quote.
      const el = findPath(ctx.doc, anchor.path);
      if (el) {
        const [bs, be] = spanOf(t, el);
        const local = bs >= 0 ? t.text.slice(bs, be) : '';
        const hits = exact ? allIndexes(local, exact) : [];
        if (hits.length === 1 || (!exact && hashKey(local) === anchor.hash)) {
          const s = bs + (hits[0] ?? 0);
          return done(anchor, frame, el, exact ? rangeOf(t, s, s + exact.length) : null, 'path');
        }
      }
      // 2. Exact quote search, prefix and suffix choose between repeats, position breaks ties.
      if (!exact) return null;
      const hits = allIndexes(t.text, exact);
      if (!hits.length) return null;
      const sc = (i: number) => {
        let s = 0;
        const pre = t.text.slice(Math.max(0, i - q.prefix.length), i);
        const suf = t.text.slice(i + exact.length, i + exact.length + q.suffix.length);
        for (
          let k = 1;
          k <= Math.min(pre.length, q.prefix.length) && pre[pre.length - k] === q.prefix[q.prefix.length - k];
          k++
        )
          s++;
        for (let k = 0; k < Math.min(suf.length, q.suffix.length) && suf[k] === q.suffix[k]; k++) s++;
        return s * 1e6 - Math.abs(i - anchor.pos.start);
      };
      const best = hits.reduce((a, b) => (sc(b) > sc(a) ? b : a));
      const r = rangeOf(t, best, best + exact.length);
      if (!r) return null;
      const block = blockOf(r.startContainer) ?? ctx.doc.body;
      return done(anchor, frame, block, r, 'exact');
    },
  };
};
