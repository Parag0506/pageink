// Runs in the page. Writes notes on version A and checks where they land on version B.
// The truth here is independent of the anchor module under test: it finds the content
// by its own text search and computes where FORMAT "Units" says the origin must be.
import type { Anchor, CreateResolver, Describe, Described, Point, Rect, Resolved } from 'pageink-core/types';
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
} from './text.ts';

export type NoteKind =
  | 'word'
  | 'line'
  | 'margin-left'
  | 'margin-right'
  | 'gap'
  | 'figure'
  | 'table'
  | 'heading';

export interface Truth {
  kind: 'text' | 'block' | 'gap' | 'media' | 'table';
  /** Text written on (text) or the line the note is level with (block). */
  exact?: string;
  prefix?: string;
  suffix?: string;
  blockText?: string;
  /** Tag of the block written on. Breaks ties between repeats. */
  tag?: string;
  /** Offset of exact from the start of its block. */
  blockOff?: number;
  /** The blocks on each side of a gap. `tail` is the end of the block above, which borders the gap. */
  before?: { exact: string; blockText: string; tail?: string };
  after?: { exact: string; blockText: string };
  media?: { src: string; alt: string; caption: string; tag: string; relTop: number };
  /** A table: its caption, header row, first column, and the text just before and after it. */
  table?: { caption: string; head: string; firstCol: string; before?: string; after?: string };
  /** Position in the document text, 0 to 1. Breaks ties between repeats. */
  relY: number;
}

export interface GenNote {
  id: string;
  kind: NoteKind;
  box: Rect;
  truth: Truth;
}

export interface Written extends GenNote {
  described?: Described;
  error?: string;
  /** Distance on A between describe's origin and the truth rule. */
  aDist?: number;
  aDelta?: Point;
  aCand?: number;
  aHow?: string;
  /** On A, where the anchor's quote starts relative to the truth's words, in characters. */
  aTextOff?: number;
  /** The truth content was painted on A. Only such content can be closed on B. */
  aShown?: boolean;
}

export interface NoteResult {
  id: string;
  kind: NoteKind;
  anchorType?: string;
  place?: string;
  /**
   * hidden: the note is hidden with its content, and the content is there but not shown on B
   * (a closed section, a hidden tab). Correct, like a note in the tray whose content is gone.
   */
  outcome: 'right' | 'tray-gone' | 'tray-edited' | 'miss' | 'wrong' | 'hidden' | 'error' | 'unwritten';
  method?: string;
  score?: number;
  present: boolean;
  truthHow: string;
  dist?: number;
  tol: number;
  got?: Point;
  expected?: Point;
  ms: number;
  cause: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], r: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const docRect = (r: DOMRect): Rect => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
const words = (s: string) =>
  new Set(
    norm(s)
      .toLowerCase()
      .split(' ')
      .filter((w) => w.length > 2),
  );

function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : true;
}

const describeEl = (el: Element | null | undefined): string => {
  if (!el) return '';
  const id = el.id ? `#${el.id}` : '';
  const cls =
    typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
  return `${el.tagName.toLowerCase()}${id}${cls} "${norm(el.textContent ?? '').slice(0, 50)}"`;
};

/** True when there is a glyph of text right under the client point. */
function textAt(x: number, y: number): boolean {
  const c = document.caretRangeFromPoint?.(x, y);
  if (!c || c.startContainer.nodeType !== Node.TEXT_NODE) return false;
  const t = c.startContainer as Text;
  for (const off of [c.startOffset - 1, c.startOffset]) {
    if (off < 0 || off >= t.length) continue;
    const r = document.createRange();
    r.setStart(t, off);
    r.setEnd(t, off + 1);
    const b = r.getBoundingClientRect();
    if (x >= b.left - 1 && x <= b.right + 1 && y >= b.top && y <= b.bottom) return true;
  }
  return false;
}

/** Scroll so that a document box is in view, as it is when someone writes there. */
function bringIntoView(box: Rect): void {
  const x = Math.max(0, box.x + box.w / 2 - innerWidth / 2);
  const y = Math.max(0, box.y + Math.min(box.h, innerHeight / 2) / 2 - innerHeight * 0.4);
  scrollTo(x, y);
}

/** True when a document box is empty page area beside `owner` (no text, no other content on top). */
function emptyBeside(box: Rect, owner: Element): boolean {
  bringIntoView(box);
  const pts: [number, number][] = [
    [box.x + box.w / 2, box.y + box.h / 2],
    [box.x + 2, box.y + 2],
    [box.x + box.w - 2, box.y + box.h - 2],
  ];
  for (const [dx, dy] of pts) {
    const x = dx - scrollX;
    const y = dy - scrollY;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    if (textAt(x, y)) return false;
    const top = document.elementFromPoint(x, y);
    if (!top || !(top.contains(owner) || top === document.documentElement)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Lines of a block
// ---------------------------------------------------------------------------

interface Line {
  top: number;
  bottom: number;
  left: number;
  right: number;
  start: number;
  end: number;
  words: { start: number; end: number; rect: DOMRect }[];
}

function linesOf(ix: TextIndex, el: Element, max = 14): Line[] {
  const [s, e] = spanOf(ix, el);
  if (s < 0) return [];
  const lines: Line[] = [];
  const re = /\S+/g;
  const text = ix.text.slice(s, e);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const ws = s + m.index;
    const we = ws + m[0].length;
    const r = rangeOf(ix, ws, we);
    if (!r) continue;
    const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0);
    if (rects.length !== 1) continue;
    const rc = rects[0]!;
    let line = lines[lines.length - 1];
    if (!line || Math.abs(rc.top - line.top) > rc.height / 2) {
      if (lines.length >= max) break;
      line = {
        top: rc.top,
        bottom: rc.bottom,
        left: rc.left,
        right: rc.right,
        start: ws,
        end: we,
        words: [],
      };
      lines.push(line);
    }
    line.bottom = Math.max(line.bottom, rc.bottom);
    line.right = Math.max(line.right, rc.right);
    line.left = Math.min(line.left, rc.left);
    line.end = we;
    line.words.push({ start: ws, end: we, rect: rc });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function contentRoot(): Element {
  const pick = [
    '#mw-content-text',
    'article.ltx_document',
    'main',
    '[role=main]',
    'article',
    '#content',
    '.content',
    '.document',
  ];
  for (const s of pick) {
    const el = document.querySelector(s);
    if (el && norm(el.textContent ?? '').length > 500) return el;
  }
  return document.body;
}

const EXCLUDE =
  'nav, header, footer, aside, table, figure, figcaption, .navbox, .infobox, .reflist, .references, .mw-references-wrap, .toc, #toc, .sidebar, .hatnote, .metadata';

/** Context on both sides, across block edges, so short quotes such as headings are told apart. */
function ctxAround(
  ix: TextIndex,
  s: number,
  e: number,
  _bs: number,
  _be: number,
): { prefix: string; suffix: string } {
  return {
    prefix: ix.text.slice(Math.max(0, s - 32), s),
    suffix: ix.text.slice(e, Math.min(ix.text.length, e + 32)),
  };
}

/**
 * The element each generated note was drawn beside, and the note's offset from it. Pages that lay
 * out lazily (content-visibility) move content as they scroll, so the box is taken again from the
 * element right before the note is written, in the layout the page has at that moment.
 */
const refs = new Map<string, { el: Element; dx: number; dy: number }>();

/** The note's box in the current layout. */
function currentBox(n: GenNote): Rect {
  const r = refs.get(n.id);
  if (!r?.el.isConnected) return n.box;
  const b = r.el.getBoundingClientRect();
  return { ...n.box, x: b.left + scrollX + r.dx, y: b.top + scrollY + r.dy };
}

export function generate(seed: string, count = 20): GenNote[] {
  refs.clear();
  const r = rng(seed);
  const ix = buildIndex(document);
  const total = Math.max(1, ix.text.length);
  const root = contentRoot();
  const used = new Set<Element>();
  const notes: GenNote[] = [];
  // Each note remembers the element it was drawn beside and its offset from it.
  let ref: Element | null = null;
  const add = (kind: NoteKind, box: Rect, truth: Truth) => {
    const id = `${kind}-${notes.length}`;
    notes.push({ id, kind, box, truth });
    if (ref) {
      const r = ref.getBoundingClientRect();
      refs.set(id, { el: ref, dx: box.x - (r.left + scrollX), dy: box.y - (r.top + scrollY) });
    }
  };

  const paras = shuffle(
    Array.from(root.querySelectorAll('p, li, dd, blockquote')).filter((el) => {
      if (el.closest(EXCLUDE)) return false;
      if (el.tagName !== 'P' && el.querySelector('p, li, ul, ol')) return false;
      const t = norm(el.textContent ?? '');
      return (
        t.length >= (el.tagName === 'P' ? 120 : 50) && visible(el) && el.getBoundingClientRect().width >= 200
      );
    }),
    r,
  );
  const nextPara = (): Element | undefined => {
    for (let round = 0; round < 2; round++) {
      for (const p of paras) {
        if (!used.has(p)) {
          used.add(p);
          return p;
        }
      }
      // Asked for more notes than there are paragraphs (stress records). Reuse them.
      if (count <= 20) break;
      used.clear();
    }
    return undefined;
  };
  const blockCtx = (el: Element) => {
    const [bs, be] = spanOf(ix, el);
    return { bs, be, blockText: ix.text.slice(bs, be), tag: el.tagName };
  };

  const plan: NoteKind[] = [
    'word',
    'word',
    'word',
    'word',
    'word',
    'line',
    'line',
    'line',
    'margin-left',
    'margin-left',
    'margin-right',
    'margin-right',
    'margin-right',
    'gap',
    'gap',
    'figure',
    'figure',
    'table',
    'heading',
    'heading',
  ];
  const scaled =
    count <= plan.length
      ? plan.slice(0, count)
      : [...plan, ...Array<NoteKind>(count - plan.length).fill('word')];
  let fallback = 0;

  const makeWord = (): boolean => {
    const p = nextPara();
    if (!p) return false;
    const lines = linesOf(ix, p);
    const cand = lines.filter((l) => l.words.length >= 5);
    if (!cand.length) return false;
    const line = cand[Math.floor(r() * cand.length)]!;
    const n = 1 + Math.floor(r() * 3);
    const i = 1 + Math.floor(r() * (line.words.length - n - 1));
    const ws = line.words.slice(i, i + n);
    if (!ws.length) return false;
    const L = ws[0]!.rect.left;
    const R = ws[ws.length - 1]!.rect.right;
    const T = Math.min(...ws.map((w) => w.rect.top));
    const B = Math.max(...ws.map((w) => w.rect.bottom));
    const box = { x: L + scrollX + 1, y: T + scrollY + 1, w: R - L - 2, h: B - T - 2 };
    const s = ws[0]!.start;
    const e = ws[ws.length - 1]!.end;
    const { bs, be, blockText, tag } = blockCtx(p);
    ref = p;
    add('word', box, {
      kind: 'text',
      exact: ix.text.slice(s, e),
      ...ctxAround(ix, s, e, bs, be),
      blockText,
      tag,
      blockOff: s - bs,
      relY: s / total,
    });
    return true;
  };

  const makeLine = (): boolean => {
    const p = nextPara();
    if (!p) return false;
    const lines = linesOf(ix, p).filter((l) => l.words.length >= 4);
    if (lines.length < 2) return false;
    const line = lines[Math.floor(r() * (lines.length - 1))]!;
    const box = {
      x: line.left + scrollX + 1,
      y: line.top + scrollY + 1,
      w: line.right - line.left - 2,
      h: line.bottom - line.top - 2,
    };
    const { bs, be, blockText, tag } = blockCtx(p);
    ref = p;
    add('line', box, {
      kind: 'text',
      exact: ix.text.slice(line.start, line.end),
      ...ctxAround(ix, line.start, line.end, bs, be),
      blockText,
      tag,
      blockOff: line.start - bs,
      relY: line.start / total,
    });
    return true;
  };

  const makeMargin = (side: 'left' | 'right'): boolean => {
    for (let tries = 0; tries < 8; tries++) {
      const p = nextPara();
      if (!p) return false;
      const pr = p.getBoundingClientRect();
      const lines = linesOf(ix, p);
      if (!lines.length) continue;
      const line = lines[Math.floor(r() * Math.min(lines.length, 6))]!;
      const w = 36;
      const x = side === 'left' ? pr.left + scrollX - 14 - w : pr.right + scrollX + 14;
      const box = { x, y: line.top + scrollY, w, h: Math.max(8, line.bottom - line.top) };
      if (box.x < 2 || box.x + box.w > document.documentElement.scrollWidth - 2) continue;
      if (!emptyBeside(box, p)) continue;
      const { bs, be, blockText, tag } = blockCtx(p);
      const e = Math.min(line.end, line.start + 60);
      ref = p;
      add(`margin-${side}`, box, {
        kind: 'block',
        exact: ix.text.slice(line.start, e),
        ...ctxAround(ix, line.start, e, bs, be),
        blockText,
        tag,
        blockOff: line.start - bs,
        relY: line.start / total,
      });
      return true;
    }
    return false;
  };

  const makeGap = (): boolean => {
    for (const p of paras) {
      if (used.has(p) || p.tagName !== 'P') continue;
      const q = p.nextElementSibling;
      if (q?.tagName !== 'P' || used.has(q) || !paras.includes(q)) continue;
      const a = p.getBoundingClientRect();
      const b = q.getBoundingClientRect();
      const gap = b.top - a.bottom;
      if (gap < 6) continue;
      const box = {
        x: a.left + scrollX + a.width * 0.3,
        y: a.bottom + scrollY + 1,
        w: 60,
        h: Math.max(4, gap - 2),
      };
      if (!emptyBeside(box, p)) continue;
      used.add(p);
      used.add(q);
      const pa = blockCtx(p);
      const pb = blockCtx(q);
      ref = p;
      add('gap', box, {
        kind: 'gap',
        before: { exact: pa.blockText.slice(0, 60), blockText: pa.blockText, tail: pa.blockText.slice(-70) },
        after: { exact: pb.blockText.slice(0, 60), blockText: pb.blockText },
        relY: pa.be / total,
      });
      return true;
    }
    return false;
  };

  const imgs = shuffle(
    Array.from(root.querySelectorAll('img')).filter((im) => {
      const b = im.getBoundingClientRect();
      return b.width >= 100 && b.height >= 80 && visible(im) && !im.closest('table, nav, header, footer');
    }),
    r,
  );
  const makeFigure = (): boolean => {
    const im = imgs.shift();
    if (!im) return false;
    const b = docRect(im.getBoundingClientRect());
    const box = { x: b.x + b.w * 0.3, y: b.y + b.h * 0.3, w: b.w * 0.4, h: Math.min(b.h * 0.4, 200) };
    const [s] = spanOf(ix, im.parentElement ?? im);
    ref = im;
    add('figure', box, {
      kind: 'media',
      media: {
        src: im.getAttribute('data-ink-src') ?? im.src,
        alt: im.alt,
        caption: captionOf(im),
        tag: 'img',
        relTop: b.y / document.documentElement.scrollHeight,
      },
      relY: Math.max(0, s) / total,
    });
    return true;
  };

  const tables = shuffle(
    Array.from(root.querySelectorAll('table')).filter((t) => {
      const b = t.getBoundingClientRect();
      return (
        t.rows.length >= 3 &&
        b.width >= 250 &&
        b.height >= 100 &&
        visible(t) &&
        !t.parentElement?.closest('table')
      );
    }),
    r,
  );
  const makeTable = (): boolean => {
    const t = tables.shift();
    if (!t) return false;
    const b = docRect(t.getBoundingClientRect());
    const box = {
      x: b.x + b.w * 0.15,
      y: b.y + Math.min(b.h * 0.25, 60),
      w: b.w * 0.5,
      h: Math.min(b.h * 0.4, 200),
    };
    const [s] = spanOf(ix, t);
    ref = t;
    add('table', box, {
      kind: 'table',
      table: { ...tableKey(t), ...tableSides(ix, t) },
      relY: Math.max(0, s) / total,
    });
    return true;
  };

  const heads = shuffle(
    Array.from(document.querySelectorAll('h1, h2, h3, h4')).filter(
      (h) =>
        norm(h.textContent ?? '').length >= 4 &&
        visible(h) &&
        !h.closest('nav, footer, aside, .toc, #toc') &&
        (root.contains(h) || h.tagName === 'H1'),
    ),
    r,
  );
  const makeHeading = (): boolean => {
    const h = heads.shift();
    if (!h) return false;
    const lines = linesOf(ix, h, 1);
    const line = lines[0];
    if (!line?.words.length) return false;
    const ws = line.words.slice(0, Math.min(line.words.length, 1 + Math.floor(r() * 3)));
    const L = ws[0]!.rect.left;
    const R = ws[ws.length - 1]!.rect.right;
    const box = {
      x: L + scrollX + 1,
      y: line.top + scrollY + 1,
      w: R - L - 2,
      h: line.bottom - line.top - 2,
    };
    const s = ws[0]!.start;
    const e = ws[ws.length - 1]!.end;
    const { bs, be, blockText, tag } = blockCtx(h);
    ref = h;
    add('heading', box, {
      kind: 'text',
      exact: ix.text.slice(s, e),
      ...ctxAround(ix, s, e, bs, be),
      blockText,
      tag,
      blockOff: s - bs,
      relY: s / total,
    });
    return true;
  };

  const makers: Record<NoteKind, () => boolean> = {
    word: makeWord,
    line: makeLine,
    'margin-left': () => makeMargin('left'),
    'margin-right': () => makeMargin('right'),
    gap: makeGap,
    figure: makeFigure,
    table: makeTable,
    heading: makeHeading,
  };
  for (const k of scaled) {
    if (makers[k]()) continue;
    // Not enough of this kind on the page. Fall back to other kinds of text notes.
    const order: NoteKind[] = ['word', 'line', 'margin-right', 'margin-left', 'heading'];
    for (let i = 0; i < order.length; i++) if (makers[order[(fallback + i) % order.length]!]()) break;
    fallback++;
  }
  scrollTo(0, 0);
  return notes;
}

function captionOf(im: Element): string {
  const fig = im.closest('figure, .thumb, .gallerybox, .ltx_figure');
  const cap = fig?.querySelector('figcaption, .thumbcaption, .gallerytext, .ltx_caption');
  return norm(cap?.textContent ?? '').slice(0, 200);
}

function tableKey(t: HTMLTableElement): { caption: string; head: string; firstCol: string } {
  return {
    caption: norm(t.caption?.textContent ?? '').slice(0, 200),
    head: norm(t.rows[0]?.textContent ?? '').slice(0, 200),
    firstCol: Array.from(t.rows)
      .slice(1, 30)
      .map((row) => norm(row.cells[0]?.textContent ?? ''))
      .join(' | ')
      .slice(0, 600),
  };
}

// ---------------------------------------------------------------------------
// Truth: find the same content and the origin FORMAT "Units" asks for
// ---------------------------------------------------------------------------

export interface Located {
  present: boolean;
  how: string;
  el?: Element;
  start?: number;
}

function locateText(
  ix: TextIndex,
  t: { exact: string; prefix?: string; suffix?: string; blockText?: string; tag?: string; blockOff?: number },
  relY: number,
): Located {
  const total = Math.max(1, ix.text.length);
  const tagAt = (i: number) => {
    const r = rangeOf(ix, i, i + 1);
    return (r && blockOf(r.startContainer)?.tagName) ?? '';
  };
  const pick = (idxs: number[], off: number): number => {
    const same = t.tag && idxs.length > 1 ? idxs.filter((i) => tagAt(i + off) === t.tag) : [];
    const pool = same.length ? same : idxs;
    return pool.reduce((best, i) =>
      Math.abs((i + off) / total - relY) < Math.abs((best + off) / total - relY) ? i : best,
    );
  };
  const prefix = t.prefix ?? '';
  const suffix = t.suffix ?? '';
  // Context search ignores spaces: pages differ in white space between blocks, not in words.
  const sq = squeezed(ix);
  // It also skips footnote markers, which are renumbered whenever a reference is added above.
  const find = (pre: string, suf: string): number[] => {
    const pp = squeeze(pre);
    const ex = squeeze(t.exact);
    if (!ex) return [];
    return allIndexes(sq.text, pp + ex + squeeze(suf)).map((i) => sq.orig[i + pp.length]!);
  };
  const full = find(prefix, suffix);
  if (full.length) return withEl(ix, pick(full, 0), full.length > 1 ? 'context-repeat' : 'context');
  const short = find(prefix.slice(-12), suffix.slice(0, 12));
  if (short.length) return withEl(ix, pick(short, 0), 'context-short');
  // One whole side of the context still runs straight into the words: the words are at the
  // same place in the text, and only the text on the other side was edited.
  if (prefix.length >= 24 || suffix.length >= 24) {
    const one = [
      ...(prefix.length >= 24 ? find(prefix, '') : []),
      ...(suffix.length >= 24 ? find('', suffix) : []),
    ];
    const uniq = [...new Set(one)];
    if (uniq.length)
      return withEl(ix, pick(uniq, 0), uniq.length > 1 ? 'context-one-side-repeat' : 'context-one-side');
  }
  if (t.exact.length >= 3 && t.blockText) {
    const occ = allIndexes(ix.text, t.exact);
    // A long quote that occurs once only needs a loosely similar block. Short ones need a close match.
    const bar = occ.length === 1 && t.exact.length >= 12 ? 0.3 : 0.7;
    // Rank by similarity, then same tag, then nearest to where it was.
    let best: { i: number; key: number[] } | null = null;
    for (const i of occ.slice(0, 200)) {
      const r = rangeOf(ix, i, i + 1);
      const el = r && blockOf(r.startContainer);
      if (!el) continue;
      const sim = similarity(el.textContent ?? '', t.blockText);
      if (sim < bar) continue;
      const key = [Math.round(sim * 20), el.tagName === t.tag ? 1 : 0, -Math.abs(i / total - relY)];
      if (
        !best ||
        key[0]! > best.key[0]! ||
        (key[0] === best.key[0] &&
          (key[1]! > best.key[1]! || (key[1] === best.key[1] && key[2]! > best.key[2]!)))
      ) {
        best = { i, key };
      }
    }
    if (best) return withEl(ix, best.i, 'block');
  }
  // The words were edited. If the block survives, find where they were from what is left around them.
  if (t.blockText) {
    const el = similarBlock(ix, t.blockText);
    if (el) {
      const [bs, be] = spanOf(ix, el);
      const local = ix.text.slice(bs, be);
      const ws = t.exact.split(' ');
      const head = ws.slice(0, 4).join(' ');
      const tail = ws.slice(-4).join(' ');
      const pk = prefix.length >= 12 ? local.indexOf(prefix.slice(-16)) : -1;
      if (pk >= 0) return withEl(ix, bs + pk + prefix.slice(-16).length, 'edited');
      const hk = head.length >= 12 ? local.indexOf(head) : -1;
      if (hk >= 0) return withEl(ix, bs + hk, 'edited');
      const tk = tail.length >= 12 ? local.indexOf(tail) : -1;
      if (tk >= 0) return withEl(ix, Math.max(bs, bs + tk + tail.length - t.exact.length), 'edited');
      if (t.blockOff !== undefined && t.blockOff < 4) return withEl(ix, bs, 'edited');
    }
  }
  return { present: false, how: 'gone' };
}

const sqCache = new WeakMap<TextIndex, { text: string; orig: number[] }>();

/** Footnote markers such as [12]. They are renumbered whenever a reference is added above them. */
const FOOTNOTE = /\[\d{1,4}\]/g;

/** Text as context search compares it: no spaces, no footnote markers, no marker cut in half at an edge. */
export function squeeze(s: string): string {
  return s
    .replace(/ /g, '')
    .replace(FOOTNOTE, '')
    .replace(/^\d{0,4}\]/, '')
    .replace(/\[\d{0,4}$/, '');
}

/** Index text without spaces and footnote markers, with a map back to index offsets. */
function squeezed(ix: TextIndex): { text: string; orig: number[] } {
  let c = sqCache.get(ix);
  if (!c) {
    const orig: number[] = [];
    const chars: string[] = [];
    for (let i = 0; i < ix.text.length; i++) {
      if (ix.text[i] === ' ') continue;
      orig.push(i);
      chars.push(ix.text[i]!);
    }
    const raw = chars.join('');
    const keep: number[] = [];
    let text = '';
    let last = 0;
    for (const m of raw.matchAll(FOOTNOTE)) {
      text += raw.slice(last, m.index);
      for (let k = last; k < m.index!; k++) keep.push(orig[k]!);
      last = m.index! + m[0].length;
    }
    text += raw.slice(last);
    for (let k = last; k < raw.length; k++) keep.push(orig[k]!);
    keep.push(ix.text.length);
    c = { text, orig: keep };
    sqCache.set(ix, c);
  }
  return c;
}

function withEl(ix: TextIndex, start: number, how: string): Located {
  const r = rangeOf(ix, start, start + 1);
  return { present: true, how, start, el: (r && blockOf(r.startContainer)) ?? undefined };
}

/** Block in the page most like `blockText`, found through a few of its phrases. */
function similarBlock(ix: TextIndex, blockText: string): Element | null {
  const ws = blockText.split(' ');
  const seen = new Set<Element>();
  let best: { el: Element; sim: number } | null = null;
  let second = 0;
  for (let i = 0; i + 5 <= ws.length; i += 5) {
    const phrase = ws.slice(i, i + 5).join(' ');
    if (phrase.length < 20) continue;
    for (const k of allIndexes(ix.text, phrase).slice(0, 5)) {
      const r = rangeOf(ix, k, k + 1);
      const el = r && blockOf(r.startContainer);
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const sim = similarity(el.textContent ?? '', blockText);
      if (!best || sim > best.sim) {
        second = best?.sim ?? 0;
        best = { el, sim };
      } else second = Math.max(second, sim);
    }
  }
  // Templated blocks (feeds, lists) look alike. Only a clear winner counts.
  return best && best.sim >= 0.6 && best.sim - second >= 0.15 ? best.el : null;
}

function locateMedia(m: NonNullable<Truth['media']>): Located {
  const imgs = Array.from(document.querySelectorAll('img'));
  const src = (im: HTMLImageElement) => im.getAttribute('data-ink-src') ?? im.src;
  const file = (s: string) => (s.startsWith('data:') ? s : (s.split(/[?#]/)[0]!.split('/').pop() ?? ''));
  const H = document.documentElement.scrollHeight || 1;
  // The same picture can appear more than once. Take the one nearest to where it was.
  const nearestOf = (xs: HTMLImageElement[]) =>
    xs.reduce((a, b) => {
      const ya = (a.getBoundingClientRect().top + scrollY) / H;
      const yb = (b.getBoundingClientRect().top + scrollY) / H;
      return Math.abs(yb - (m.relTop ?? 0)) < Math.abs(ya - (m.relTop ?? 0)) ? b : a;
    });
  const steps: [string, (im: HTMLImageElement) => boolean][] = [
    ['src', (im) => src(im) === m.src],
    ['file', (im) => file(src(im)) === file(m.src)],
    ['caption-alt', (im) => !!m.caption && captionOf(im) === m.caption && (!m.alt || im.alt === m.alt)],
    ['caption', (im) => !!m.caption && captionOf(im) === m.caption],
    ['alt', (im) => m.alt.length >= 8 && im.alt === m.alt],
  ];
  for (const [how, f] of steps) {
    const hits = imgs.filter(f);
    if (hits.length) return { present: true, how, el: nearestOf(hits) };
  }
  return { present: false, how: 'gone' };
}

/** 32 characters of document text on each side of a table, without spaces. */
function tableSides(ix: TextIndex, t: Element): { before: string; after: string } {
  const [s, e] = spanOf(ix, t);
  if (s < 0) return { before: '', after: '' };
  const sq = (x: string) => x.replace(/ /g, '');
  return {
    before: sq(ix.text.slice(Math.max(0, s - 48), s)).slice(-32),
    after: sq(ix.text.slice(e, e + 48)).slice(0, 32),
  };
}

function locateTable(ix: TextIndex, k: NonNullable<Truth['table']>, relY: number): Located {
  const ts = Array.from(document.querySelectorAll('table'));
  if (k.caption) {
    const hit = ts.find((t) => norm(t.caption?.textContent ?? '').slice(0, 200) === k.caption);
    if (hit) return { present: true, how: 'caption', el: hit };
  }
  // A table at the same place in the text, with nearly the same header row, is the same table even
  // when a column was added or removed. Two tables can share a header, so the place comes first.
  if (k.before || k.after) {
    const total = Math.max(1, ix.text.length);
    const placed = ts
      .filter((t) => {
        const sides = tableSides(ix, t);
        const ctxOk =
          ((k.before ?? '').length >= 16 && sides.before === k.before) ||
          ((k.after ?? '').length >= 16 && sides.after === k.after);
        return ctxOk && similarity(tableKey(t).head, k.head) >= 0.5;
      })
      .sort((a, b) => Math.abs(spanOf(ix, a)[0] / total - relY) - Math.abs(spanOf(ix, b)[0] / total - relY));
    if (placed[0]) return { present: true, how: 'place', el: placed[0] };
  }
  const same = ts.filter((t) => tableKey(t).head === k.head);
  const scored = same
    .map((t) => ({ t, s: similarity(tableKey(t).firstCol, k.firstCol) }))
    .sort((a, b) => b.s - a.s);
  if (scored[0] && (scored[0].s >= 0.5 || (same.length === 1 && k.head.length > 10))) {
    return { present: true, how: 'head', el: scored[0].t };
  }
  // A header row edited a little (a dash, a date range) still names the table, when it is clearly the
  // closest: most of its words kept, and no other table keeps even a third of them.
  if (k.head.length > 20) {
    const sims = ts.map((t) => ({ t, s: similarity(tableKey(t).head, k.head) })).sort((a, b) => b.s - a.s);
    if (sims[0] && sims[0].s >= 0.6 && (sims[1]?.s ?? 0) < 0.3)
      return { present: true, how: 'head-similar', el: sims[0].t };
  }
  return { present: false, how: 'gone' };
}

/** Where the content of a note is now. For gaps the anchor decides which neighbour it belongs to. */
export function locate(ix: TextIndex, t: Truth, anchor?: Anchor): Located {
  switch (t.kind) {
    case 'text':
      return locateText(ix, t as Required<Pick<Truth, 'exact'>> & Truth, t.relY);
    case 'block': {
      const l = locateText(ix, t as Required<Pick<Truth, 'exact'>> & Truth, t.relY);
      if (l.present) return l;
      // A note beside a paragraph belongs to the paragraph, even when its line was reworded.
      const el = t.blockText ? similarBlock(ix, t.blockText) : null;
      return el ? { present: true, how: 'block-similar', el } : l;
    }
    case 'gap': {
      const q = anchor?.quote.exact ? norm(anchor.quote.exact) : '';
      const useAfter =
        anchor?.place === 'above' ||
        (anchor?.place !== 'below' &&
          q !== '' &&
          t.after!.blockText.includes(q) &&
          !t.before!.blockText.includes(q));
      const side = useAfter ? t.after! : t.before!;
      let l = locateText(ix, { exact: side.exact, blockText: side.blockText }, t.relY);
      let el = similarBlock(ix, side.blockText) ?? l.el;
      // The block above a gap ends where the gap starts. When its opening was rewritten, its end still finds it.
      // The last few characters (a footnote number) may change too, so the text just before them is tried as well.
      const tail = t.before!.tail ?? '';
      for (const exact of [tail, tail.slice(0, -10)]) {
        if (l.present || el || useAfter || exact.length < 40) break;
        const end = locateText(ix, { exact, blockText: side.blockText }, t.relY);
        if (end.present && end.el) {
          l = { ...end, how: `tail-${end.how}` };
          el = end.el;
        }
      }
      if (l.present || el)
        return {
          ...l,
          present: true,
          el,
          how: `${useAfter ? 'after' : 'before'}-${l.present ? l.how : 'similar'}`,
        };
      return l;
    }
    case 'media':
      return locateMedia(t.media!);
    case 'table':
      return locateTable(ix, t.table!, t.relY);
  }
}

/** Element and up to two block ancestors of about the same size. Any of them is a fair anchor box. */
function boxes(el: Element): Element[] {
  const out = [el];
  const base = el.getBoundingClientRect();
  let p = el.parentElement;
  while (p && out.length < 3 && p !== document.body) {
    const b = p.getBoundingClientRect();
    if (b.width > base.width * 1.6 + 40 || b.height > base.height * 1.6 + 60) break;
    out.push(p);
    p = p.parentElement;
  }
  return out;
}

function lineTopAt(ix: TextIndex, start: number): number | null {
  const r = rangeOf(ix, start, Math.min(ix.text.length, start + 1));
  const rc = r && firstRect(r);
  return rc ? rc.top + scrollY : null;
}

/** Start of the anchor's own quote near the located content, when it is there. */
function quoteNear(
  ix: TextIndex,
  anchor: Anchor,
  el: Element | undefined,
  start: number | undefined,
): number | undefined {
  const q = anchor.quote.exact;
  if (!q) return undefined;
  const nq = norm(q);
  const [bs, be] = el ? spanOf(ix, el) : [-1, -1];
  const from = Math.max(0, Math.min(start ?? bs, bs < 0 ? Infinity : bs) - 300);
  const to = Math.min(ix.text.length, Math.max(start ?? be, be) + 300);
  const window = ix.text.slice(from, to);
  const hits = allIndexes(window, nq);
  if (!hits.length) return undefined;
  const target = (start ?? bs) - from;
  return from + hits.reduce((b, i) => (Math.abs(i - target) < Math.abs(b - target) ? i : b));
}

/**
 * Acceptable origins for this anchor on the located content, per FORMAT "Units".
 * When the anchor's own quote is no longer there (the words were edited), its start is taken
 * at the same distance from the truth's words as it had on A (`textOff`).
 */
export function expectedPoints(ix: TextIndex, anchor: Anchor, loc: Located, textOff = 0): Point[] {
  if (!loc.present || !loc.el) return [];
  const out: Point[] = [];
  const shifted = loc.start === undefined ? undefined : Math.max(0, loc.start + textOff);
  if (anchor.type === 'text') {
    const s = quoteNear(ix, anchor, loc.el, loc.start) ?? shifted;
    if (s !== undefined) {
      const r = rangeOf(ix, s, Math.min(ix.text.length, s + Math.max(1, norm(anchor.quote.exact).length)));
      const rc = r && firstRect(r);
      if (rc) out.push({ x: rc.left + scrollX, y: rc.top + scrollY });
    }
    return out;
  }
  if (anchor.type === 'block') {
    const qs = quoteNear(ix, anchor, loc.el, loc.start) ?? shifted;
    for (const el of boxes(loc.el)) {
      const b = docRect(el.getBoundingClientRect());
      const x = anchor.place === 'right' ? b.x + b.w : b.x;
      let y: number;
      if (anchor.place === 'below') y = b.y + b.h;
      else if (!anchor.quote.exact) y = b.y;
      else y = (qs !== undefined ? lineTopAt(ix, qs) : null) ?? b.y;
      out.push({ x, y });
    }
    return out;
  }
  // media, viewport: the element box.
  for (const el of boxes(loc.el)) {
    const b = docRect(el.getBoundingClientRect());
    out.push({ x: b.x, y: b.y });
  }
  return out;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function nearest(p: Point, cands: Point[]): { d: number; i: number } {
  let best = { d: Number.POSITIVE_INFINITY, i: -1 };
  cands.forEach((c, i) => {
    const d = dist(p, c);
    if (d < best.d) best = { d, i };
  });
  return best;
}

function fontPx(el: Element | undefined): number {
  return el ? Number.parseFloat(getComputedStyle(el).fontSize) || 16 : 16;
}

const tolFor = (el: Element | undefined) => Math.max(8, 0.75 * fontPx(el));

// ---------------------------------------------------------------------------
// Entry points used by score.ts and the scorer tests
// ---------------------------------------------------------------------------

/** The truth for one note on the current page, for the scorer tests. */
export function truthHere(
  t: Truth,
  anchor?: Anchor,
  textOff = 0,
): { present: boolean; how: string; elId: string; points: Point[] } {
  const ix = buildIndex(document);
  const loc = locate(ix, t, anchor);
  return {
    present: loc.present,
    how: loc.how,
    elId: loc.el?.id ?? '',
    points: anchor ? expectedPoints(ix, anchor, loc, textOff) : [],
  };
}

interface AnchorModule {
  describe: Describe;
  createResolver: CreateResolver;
}

function mod(): AnchorModule {
  return (window as unknown as { __inkTest: { anchor: AnchorModule } }).__inkTest.anchor;
}

/** Generate notes on version A, describe each and check describe against the truth rule. */
/** Two animation frames: enough for the page to render what scrolling brought into view. */
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

export async function write(seed: string, count: number): Promise<Written[]> {
  const notes = generate(seed, count);
  const { describe } = mod();
  const ix = buildIndex(document);
  const out: Written[] = [];
  for (const n of notes) {
    const w: Written = { ...n };
    try {
      // Bring the note into view until the layout stops moving under it.
      let box = n.box;
      for (let k = 0; k < 6; k++) {
        bringIntoView(box);
        await frames();
        const now = currentBox(n);
        const still = Math.abs(now.x - box.x) < 1 && Math.abs(now.y - box.y) < 1;
        box = now;
        if (still && k > 0) break;
      }
      w.box = box;
      w.described = describe({ doc: document }, w.box);
    } catch (e) {
      w.error = String(e);
    }
    out.push(w);
    if (!w.described) continue;
    // Truth on A in the same layout describe saw.
    const loc = locate(ix, w.truth, w.described.anchor);
    const pts = expectedPoints(ix, w.described.anchor, loc);
    const near = nearest(w.described.origin, pts);
    w.aHow = loc.how;
    // Both the truth content and the element the anchor names must be painted on A.
    let onA: Resolved | null = null;
    try {
      onA = mod().createResolver({ doc: document }).resolve(w.described.anchor, w.described.frame);
    } catch {
      onA = null;
    }
    w.aShown = (!loc.el || shownNow(loc.el)) && (!onA || shownNow(onA.el, onA.clips));
    const qs = loc.start !== undefined ? quoteNear(ix, w.described.anchor, loc.el, loc.start) : undefined;
    if (qs !== undefined && loc.start !== undefined && Math.abs(qs - loc.start) < 200)
      w.aTextOff = qs - loc.start;
    if (near.i >= 0) {
      w.aDist = near.d;
      w.aCand = near.i;
      w.aDelta = { x: w.described.origin.x - pts[near.i]!.x, y: w.described.origin.y - pts[near.i]!.y };
    }
  }
  scrollTo(0, 0);
  return JSON.parse(JSON.stringify(out)) as Written[];
}

let shared: ReturnType<CreateResolver> | null = null;

/**
 * The outcome of one note on B. `content` says whether the truth content is shown, there but not
 * shown (closed, hidden), or gone; it is asked only when the answer matters.
 */
export function classify(o: {
  error: boolean;
  found: boolean;
  hiddenNote: boolean;
  present: boolean;
  edited: boolean;
  content: () => 'shown' | 'unseen' | 'gone';
  near: boolean;
}): NoteResult['outcome'] {
  if (o.error) return 'error';
  if (o.hiddenNote) {
    // Hidden with its content: right only when that content is really not shown.
    const c = o.content();
    return c === 'unseen' ? 'hidden' : c === 'shown' ? 'miss' : 'tray-gone';
  }
  if (!o.found) return o.present ? (o.edited ? 'tray-edited' : 'miss') : 'tray-gone';
  if (!o.present) return 'wrong';
  // Painted while its content is hidden: ink where nothing of the page shows.
  if (o.content() === 'unseen') return 'wrong';
  return o.near ? 'right' : 'wrong';
}

type Checkable = Element & {
  checkVisibility?(o?: { opacityProperty?: boolean; visibilityProperty?: boolean }): boolean;
};

/** Ancestors that clip an element, nearest first, up to its scroller: as the resolver lists them. */
function clipsOf(el: Element): { el: Element; x: boolean; y: boolean }[] {
  const out: { el: Element; x: boolean; y: boolean }[] = [];
  for (
    let a = el.parentElement;
    a && a !== document.body && a !== document.documentElement;
    a = a.parentElement
  ) {
    const cs = getComputedStyle(a);
    const ox = cs.overflowX;
    const oy = cs.overflowY;
    if (/(auto|scroll)/.test(ox + oy)) break;
    const x = ox === 'hidden' || ox === 'clip';
    const y = oy === 'hidden' || oy === 'clip';
    if (x || y) out.push({ el: a, x, y });
  }
  return out;
}

/**
 * True when the element is painted on B: visible, not transparent, and not cut away by the
 * ancestors that clip it. The same test the placer makes before it paints a note: an ancestor
 * cuts only on an axis where it is cutting its own content.
 */
export function shownNow(el: Element, clips?: { el: Element; x: boolean; y: boolean }[]): boolean {
  const c = el as Checkable;
  if (c.checkVisibility && !c.checkVisibility({ visibilityProperty: true })) return false;
  // Transparent counts as closed, but not while a fade is running: the page is still loading in.
  for (let a: Element | null = el; a; a = a.parentElement) {
    if (getComputedStyle(a).opacity === '0' && !a.getAnimations().length) return false;
  }
  let x0 = -1e7;
  let y0 = -1e7;
  let x1 = 1e7;
  let y1 = 1e7;
  for (const k of clips ?? clipsOf(el)) {
    const a = k.el;
    const cx = k.x && a.scrollWidth > a.clientWidth + 1;
    const cy = k.y && a.scrollHeight > a.clientHeight + 1;
    if (!cx && !cy) continue;
    const b = a.getBoundingClientRect();
    if (cx) {
      x0 = Math.max(x0, b.left + a.clientLeft);
      x1 = Math.min(x1, b.left + a.clientLeft + a.clientWidth);
    }
    if (cy) {
      y0 = Math.max(y0, b.top + a.clientTop);
      y1 = Math.min(y1, b.top + a.clientTop + a.clientHeight);
    }
  }
  return x1 > x0 && y1 > y0;
}

/**
 * Resolve every note on version B and classify where it landed.
 * With reuse, the resolver from the previous call is kept and invalidated, as a viewer does
 * after the page changes.
 */
export function score(
  notes: Written[],
  reuse = false,
): { results: NoteResult[]; firstMs: number; totalMs: number } {
  const { createResolver } = mod();
  if (reuse && shared) shared.invalidate();
  else shared = createResolver({ doc: document });
  const resolver = shared;
  const ix = buildIndex(document);
  let ixAll: ReturnType<typeof buildIndex> | null = null;
  const results: NoteResult[] = [];
  let totalMs = 0;
  let firstMs = 0;
  for (const n of notes) {
    if (!n.described) {
      results.push({
        id: n.id,
        kind: n.kind,
        outcome: 'unwritten',
        present: false,
        truthHow: '',
        tol: 0,
        ms: 0,
        cause: { error: n.error },
      });
      continue;
    }
    const { anchor, frame } = n.described;
    let res: Resolved | null = null;
    let err = '';
    const t0 = performance.now();
    try {
      res = resolver.resolve(anchor, frame);
    } catch (e) {
      err = String(e);
    }
    const ms = performance.now() - t0;
    if (!results.length) firstMs = ms;
    totalMs += ms;
    const loc = locate(ix, n.truth, anchor);
    let pts = expectedPoints(ix, anchor, loc, n.aTextOff);
    // Edited words move a little inside their sentence, so the tolerance is wider there.
    const tol = tolFor(loc.el) * (loc.how === 'edited' ? 3 : 1);
    // When describe on A disagreed with the truth rule, carry the same offset over to B.
    const mismatch = n.aDist !== undefined && n.aDist > tol && n.aDelta;
    if (mismatch) pts = pts.map((p) => ({ x: p.x + n.aDelta!.x, y: p.y + n.aDelta!.y }));
    const near = res ? nearest(res.origin, pts) : { d: Number.NaN, i: -1 };
    // The note is hidden with its content when the viewer would hide it: the anchor is found but
    // not painted, or not found while its element still holds the quote unseen.
    // Content that was not painted on A either (text kept for screen readers, say) is scored as
    // before: only content that was shown on A can be closed on B.
    const shownOnA = n.aShown !== false;
    let hiddenNote = false;
    if (!err && res) hiddenNote = shownOnA && !shownNow(res.el, res.clips);
    else if (!err && resolver.hidden) hiddenNote = shownOnA && !!resolver.hidden(anchor);
    /** The truth content on B: shown, there but not shown, or gone. */
    const content = (): 'shown' | 'unseen' | 'gone' => {
      if (loc.present) return !shownOnA || !loc.el || shownNow(loc.el) ? 'shown' : 'unseen';
      ixAll ??= buildIndex(document, { all: true });
      return locate(ixAll, n.truth, anchor).present ? 'unseen' : 'gone';
    };
    const outcome = classify({
      error: !!err,
      found: !!res,
      hiddenNote,
      present: loc.present,
      edited: loc.how === 'edited',
      content,
      near: near.d <= tol,
    });
    const exp = pts[Math.max(0, near.i)];
    const pathEl = (() => {
      try {
        return (
          (anchor.path.id && document.getElementById(anchor.path.id)) ||
          (anchor.path.css && document.querySelector(anchor.path.css))
        );
      } catch {
        return null;
      }
    })();
    const qn = norm(anchor.quote.exact);
    results.push({
      id: n.id,
      kind: n.kind,
      anchorType: anchor.type,
      place: anchor.place,
      outcome,
      method: res?.method,
      score: res?.score,
      present: loc.present,
      truthHow: loc.how,
      dist: res && pts.length ? Math.round(near.d * 10) / 10 : undefined,
      tol: Math.round(tol * 10) / 10,
      got: res ? { x: Math.round(res.origin.x), y: Math.round(res.origin.y) } : undefined,
      expected: exp ? { x: Math.round(exp.x), y: Math.round(exp.y) } : undefined,
      ms: Math.round(ms * 100) / 100,
      cause: {
        error: err || undefined,
        quote: qn.slice(0, 80),
        truthText: (
          n.truth.exact ??
          n.truth.media?.caption ??
          n.truth.table?.caption ??
          n.truth.before?.exact ??
          ''
        ).slice(0, 80),
        quoteCountB: qn ? allIndexes(ix.text, qn).length : 0,
        pathFound: !!pathEl,
        pathHasQuote: pathEl ? norm(pathEl.textContent ?? '').includes(qn) : false,
        describeOffA: n.aDist !== undefined ? Math.round(n.aDist) : null,
        describeMismatch: !!mismatch,
        resolvedEl: res ? describeEl(res.el) : undefined,
        truthEl: describeEl(loc.el),
      },
    });
  }
  return { results, firstMs, totalMs };
}

/** Text offset of a client point, for debugging a fixture by hand. */
export function offsetAt(x: number, y: number): number {
  const ix = buildIndex(document);
  const c = document.caretRangeFromPoint(x, y);
  return c ? offsetOf(ix, c.startContainer, c.startOffset) : -1;
}
