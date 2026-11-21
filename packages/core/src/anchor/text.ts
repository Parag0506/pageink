/**
 * Document text model (FORMAT "Document text").
 *
 * The text nodes of <body> in flat tree order, shadow trees included, with
 * script, style, noscript, template, hidden content and our own layer skipped.
 * Every run of white space is folded to one space. A block boundary or <br>
 * counts as white space, so words in neighbouring blocks never run together.
 */
import type { AnchorContext } from '../types';

/** One text node in the model. */
export interface Seg {
  node: Text;
  /** Model offset of the first character. */
  start: number;
  /** Model length. */
  len: number;
  /** Raw length of node.data when the model was built. Used to spot stale nodes. */
  raw: number;
  /** Model index to DOM offset, length len + 1. Absent when the two are equal. */
  map?: Int32Array;
  /** Nearest block ancestor. */
  block: Element;
}

export interface MediaEntry {
  el: Element;
  /** Model offset where the element sits. */
  at: number;
}

export interface Span {
  start: number;
  end: number;
}

/** Elements whose content never counts as text. */
const SKIP = new Set([
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
]);

/** Replaced or graphic content. Recorded as media, not walked for text. */
const OPAQUE = new Set(['img', 'video', 'audio', 'canvas', 'svg', 'picture', 'iframe', 'object', 'embed']);

/** Media for anchoring. Tables and figures are walked for text too. */
export const MEDIA_TAGS = new Set(['img', 'picture', 'figure', 'svg', 'table', 'video', 'canvas', 'iframe']);

/** Tags that flow inline. Anything else starts a block. Checked by tag, never by style. */
const INLINE = new Set([
  'a',
  'abbr',
  'acronym',
  'b',
  'bdi',
  'bdo',
  'big',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'label',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'slot',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
  'img',
  'picture',
  'svg',
  'math',
  'button',
  'input',
  'output',
  'meter',
  'progress',
]);

export function isInlineTag(el: Element): boolean {
  const t = el.localName;
  if (INLINE.has(t)) return true;
  // Custom elements usually wrap blocks, but some are inline. They count as blocks.
  return false;
}

export function isMediaEl(el: Element): boolean {
  return el.hasAttribute('data-ink-media') || MEDIA_TAGS.has(el.localName);
}

const WS = /[ \t\n\r\f ]+/g;

/**
 * The only elements a shadow root can be attached to (DOM standard, attachShadow), besides
 * custom elements, whose names hold a hyphen. Asking the extension for the closed root of
 * any other element is a call across into the browser that always answers null, and the
 * text walk would make it for every element of the page.
 */
const SHADOW_HOSTS = new Set([
  'article',
  'aside',
  'blockquote',
  'body',
  'div',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'main',
  'nav',
  'p',
  'section',
  'span',
]);

/** Open or closed shadow root of an element, when the context can reach it. */
export function shadowOf(ctx: AnchorContext, el: Element): ShadowRoot | null {
  const open = el.shadowRoot;
  if (open || !ctx.shadowRootOf) return open;
  const n = el.localName;
  return n.includes('-') || SHADOW_HOSTS.has(n) ? ctx.shadowRootOf(el) : null;
}

/** Parent in the flat tree: assigned slot, then shadow host, then DOM parent. */
export function flatParent(n: Node): Element | null {
  const slot = (n as Element | Text).assignedSlot;
  if (slot) return slot;
  const p = n.parentNode;
  if (!p) return null;
  if (p.nodeType === 11) return (p as ShadowRoot).host ?? null;
  return p.nodeType === 1 ? (p as Element) : null;
}

/** Where a model starts. Default: the children of <body>. */
export interface ModelRoot {
  /** Walk only this element's content, as the full model walks it. */
  el: Element;
  /** Whether text directly inside el shows, as the full model would decide it. */
  shown: boolean;
  /**
   * Walk only these children of el, in order. The first must be a block the full model
   * walks, so the text starts the same way. The model then gives no span for el itself.
   */
  nodes?: Node[];
}

type Check = Element & { checkVisibility(o?: { visibilityProperty?: boolean }): boolean };

/** One step of the walk: a node to visit, the rest of a sibling list, or the close of an element. */
type Frame =
  | { k: 0; n: Node; block: Element; shown: boolean }
  | { k: 1; next: Node | null; block: Element; shown: boolean }
  | { k: 2; list: Node[]; i: number; block: Element; shown: boolean }
  | { k: 3; el: Element; entry: number };

export class TextModel {
  text = '';
  segs: Seg[] = [];
  /** Segment starts, for binary search. */
  starts: Int32Array = new Int32Array(0);
  nodeIndex = new Map<Text, number>();
  /** Text span of every block-level element that holds text. */
  blocks = new Map<Element, Span>();
  /** Blocks that directly hold text (the nearest block of some text node), in order. */
  blockList: Element[] = [];
  media: MediaEntry[] = [];
  shadowRoots: ShadowRoot[] = [];
  readonly doc: Document;
  readonly ctx: AnchorContext;
  /** The element this model covers. Body for a full model. */
  readonly root: Element | null;
  /** Milliseconds the build took, summed over its slices. */
  buildMs = 0;
  /** True once the walk has finished. */
  done = false;

  private stack: Frame[] = [];
  private parts: string[] = [];
  private len = 0;
  private lastSpace = true;
  private leaf = new Set<Element>();
  private scratch = new Int32Array(256);
  private hasCheck = false;
  /** Covers only some children of root. */
  private part = false;

  /**
   * Builds at once unless `lazy` is set; then step() builds it in slices.
   * With `root`, the model covers that element only. Its text is then the same
   * as the full model's text over that element's span.
   */
  constructor(ctx: AnchorContext, opts: { root?: ModelRoot; lazy?: boolean } = {}) {
    this.ctx = ctx;
    this.doc = ctx.doc;
    const r = opts.root;
    this.root = r ? r.el : this.doc.body;
    this.hasCheck =
      typeof (this.doc.documentElement as Element & { checkVisibility?: unknown }).checkVisibility ===
      'function';
    if (this.root) {
      const shown = r ? r.shown : true;
      const sr = r ? shadowOf(ctx, r.el) : null;
      if (r?.nodes) {
        this.part = true;
        this.stack.push({ k: 2, list: r.nodes, i: 0, block: this.root, shown });
      } else if (sr) {
        this.shadowRoots.push(sr);
        this.stack.push({ k: 1, next: sr.firstChild, block: this.root, shown });
      } else if (r && r.el.localName === 'slot') {
        const a = (r.el as HTMLSlotElement).assignedNodes();
        if (a.length) this.stack.push({ k: 2, list: a, i: 0, block: this.root, shown });
        else this.stack.push({ k: 1, next: r.el.firstChild, block: this.root, shown });
      } else this.stack.push({ k: 1, next: this.root.firstChild, block: this.root, shown });
    }
    if (!opts.lazy) this.step(Number.POSITIVE_INFINITY);
  }

  /** Walk until the clock passes `until` (ctx.now(), or performance.now()). True when the model is complete. */
  step(until: number): boolean {
    if (this.done) return true;
    const c = this.ctx;
    const now = c.now ? () => c.now!() : () => performance.now();
    const t0 = now();
    const stack = this.stack;
    const ctx = this.ctx;
    const media = this.media;
    const view = this.doc.defaultView;
    const hasCheck = this.hasCheck;

    const hidden = (el: Element): boolean => {
      if (el.hasAttribute('hidden')) return true;
      // checkVisibility reads style, not layout, and style is computed once for the page.
      if (hasCheck) {
        if ((el as Check).checkVisibility()) return false;
        return view ? view.getComputedStyle(el).display !== 'contents' : true;
      }
      return view ? view.getComputedStyle(el).display === 'none' : false;
    };
    // An element hidden by visibility still takes space, and a child can show itself again,
    // so only the text it holds itself is left out.
    const invisible = (el: Element): boolean =>
      hasCheck
        ? !(el as Check).checkVisibility({ visibilityProperty: true })
        : view?.getComputedStyle(el).visibility === 'hidden';

    let count = 0;
    while (stack.length) {
      if ((++count & 127) === 0 && now() > until) {
        this.buildMs += now() - t0;
        return false;
      }
      const f = stack.pop()!;
      if (f.k === 1) {
        if (!f.next) continue;
        stack.push({ k: 1, next: f.next.nextSibling, block: f.block, shown: f.shown });
        stack.push({ k: 0, n: f.next, block: f.block, shown: f.shown });
        continue;
      }
      if (f.k === 2) {
        if (f.i >= f.list.length) continue;
        stack.push({ k: 2, list: f.list, i: f.i + 1, block: f.block, shown: f.shown });
        stack.push({ k: 0, n: f.list[f.i]!, block: f.block, shown: f.shown });
        continue;
      }
      if (f.k === 3) {
        if (this.len > f.entry) this.blocks.set(f.el, { start: f.entry, end: this.len });
        this.space();
        continue;
      }
      const n = f.n;
      if (n.nodeType === 3) {
        if (f.shown) this.addText(n as Text, f.block);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      const tag = el.localName;
      if (SKIP.has(tag)) {
        if (tag === 'iframe' && !hidden(el)) media.push({ el, at: this.len });
        continue;
      }
      if (ctx.isOurs?.(el)) continue;
      if (tag === 'br') {
        this.space();
        continue;
      }
      // One style check in the common case: shown with visibility counted means shown at all.
      let vis = true;
      if (el.hasAttribute('hidden')) continue;
      if (!hasCheck || !(el as Check).checkVisibility({ visibilityProperty: true })) {
        if (hidden(el)) continue;
        vis = !invisible(el);
      }
      const isMedia = el.hasAttribute('data-ink-media') || MEDIA_TAGS.has(tag);
      if (isMedia) media.push({ el, at: this.len });
      if (OPAQUE.has(tag)) continue;
      const inline = isInlineTag(el);
      const nextBlock = inline ? f.block : el;
      if (!inline) {
        this.space();
        stack.push({ k: 3, el, entry: this.len });
      }
      const root = shadowOf(ctx, el);
      if (root) {
        this.shadowRoots.push(root);
        stack.push({ k: 1, next: root.firstChild, block: nextBlock, shown: vis });
      } else if (tag === 'slot') {
        const assigned = (el as HTMLSlotElement).assignedNodes();
        if (assigned.length) stack.push({ k: 2, list: assigned, i: 0, block: nextBlock, shown: vis });
        else stack.push({ k: 1, next: el.firstChild, block: nextBlock, shown: vis });
      } else {
        stack.push({ k: 1, next: el.firstChild, block: nextBlock, shown: vis });
      }
    }
    if (this.root && !this.part) this.blocks.set(this.root, { start: 0, end: this.len });
    this.text = this.parts.join('');
    this.parts = [];
    const segs = this.segs;
    const starts = new Int32Array(segs.length);
    for (let i = 0; i < segs.length; i++) starts[i] = segs[i]!.start;
    this.starts = starts;
    this.leaf.clear();
    this.done = true;
    this.buildMs += now() - t0;
    return true;
  }

  private space(): void {
    if (!this.lastSpace) {
      this.parts.push(' ');
      this.len++;
      this.lastSpace = true;
    }
  }

  private addText(node: Text, block: Element): void {
    const data = node.data;
    if (!data) return;
    WS.lastIndex = 0;
    let folded = data.replace(WS, ' ');
    let dropLead = 0;
    if (this.lastSpace && folded.charCodeAt(0) === 32) {
      folded = folded.slice(1);
      dropLead = 1;
    }
    if (!folded) return;
    let map: Int32Array | undefined;
    if (folded.length !== data.length) {
      if (this.scratch.length < folded.length + 1) this.scratch = new Int32Array(folded.length * 2 + 1);
      const scratch = this.scratch;
      let k = 0;
      let i = 0;
      const n = data.length;
      let skipFirst = dropLead === 1;
      while (i < n) {
        const c = data.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 160) {
          const runStart = i;
          while (
            i < n &&
            (data.charCodeAt(i) === 32 ||
              data.charCodeAt(i) === 9 ||
              data.charCodeAt(i) === 10 ||
              data.charCodeAt(i) === 13 ||
              data.charCodeAt(i) === 12 ||
              data.charCodeAt(i) === 160)
          )
            i++;
          if (skipFirst) {
            skipFirst = false;
            continue;
          }
          scratch[k++] = runStart;
        } else {
          skipFirst = false;
          scratch[k++] = i;
          i++;
        }
      }
      scratch[k] = n;
      map = scratch.slice(0, folded.length + 1);
    }
    const seg: Seg = { node, start: this.len, len: folded.length, raw: data.length, block };
    if (map) seg.map = map;
    this.nodeIndex.set(node, this.segs.length);
    this.segs.push(seg);
    this.parts.push(folded);
    this.len += folded.length;
    this.lastSpace = folded.charCodeAt(folded.length - 1) === 32;
    if (!this.leaf.has(block)) {
      this.leaf.add(block);
      this.blockList.push(block);
    }
  }

  /** Index of the last segment whose start is at or before offset, or -1. */
  segAt(offset: number): number {
    const s = this.starts;
    let lo = 0;
    let hi = s.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid]! <= offset) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** DOM point for a model offset. Bias says which side to take on a boundary. */
  point(offset: number, bias: 'start' | 'end'): { node: Text; offset: number } | null {
    const segs = this.segs;
    if (!segs.length) return null;
    let i = this.segAt(offset);
    if (bias === 'start') {
      // On a boundary or a virtual space, the start belongs to the next segment.
      if (i < 0 || offset >= segs[i]!.start + segs[i]!.len) i++;
      if (i >= segs.length) return null;
      const s = segs[i]!;
      const k = Math.max(0, offset - s.start);
      return { node: s.node, offset: s.map ? s.map[k]! : k };
    }
    // An end at the start of a segment belongs to the one before.
    if (i >= 0 && offset === segs[i]!.start && i > 0) i--;
    if (i < 0) return null;
    const s = segs[i]!;
    const k = Math.min(s.len, Math.max(0, offset - s.start));
    return { node: s.node, offset: s.map ? s.map[k]! : k };
  }

  /** DOM Range for a model span, or null when the span holds no text. */
  range(start: number, end: number): Range | null {
    const a = this.point(start, 'start');
    const b = this.point(Math.max(start, end), 'end');
    if (!a || !b) return null;
    const r = this.doc.createRange();
    try {
      r.setStart(a.node, Math.min(a.offset, a.node.length));
      r.setEnd(b.node, Math.min(b.offset, b.node.length));
    } catch {
      return null;
    }
    // Nodes in different shadow trees cannot share a Range; it collapses. Treat as missing.
    if (r.collapsed && end > start) return null;
    return r;
  }

  /** Model offset for a DOM point inside a text node of the model, or -1. */
  offsetOf(node: Node, domOffset: number): number {
    const i = this.nodeIndex.get(node as Text);
    if (i === undefined) return -1;
    const s = this.segs[i]!;
    if (!s.map) return s.start + Math.min(s.len, Math.max(0, domOffset));
    const m = s.map;
    let lo = 0;
    let hi = s.len;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (m[mid]! <= domOffset) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return s.start + ans;
  }

  /** Model span of an element's text. Null when it holds none. */
  spanOf(el: Element): Span | null {
    const b = this.blocks.get(el);
    if (b) return b;
    const first = this.edgeText(el, true);
    if (!first) return null;
    const last = this.edgeText(el, false)!;
    const a = this.segs[this.nodeIndex.get(first)!]!;
    const z = this.segs[this.nodeIndex.get(last)!]!;
    return { start: a.start, end: z.start + z.len };
  }

  /** First or last model text node inside el, in flat tree order. */
  private edgeText(el: Element, first: boolean): Text | null {
    const visit = (n: Node): Text | null => {
      if (n.nodeType === 3) return this.nodeIndex.has(n as Text) ? (n as Text) : null;
      if (n.nodeType !== 1 && n.nodeType !== 11) return null;
      let kids: ArrayLike<Node>;
      const root = n.nodeType === 1 ? shadowOf(this.ctx, n as Element) : null;
      if (root) kids = root.childNodes;
      else if ((n as Element).localName === 'slot') {
        const a = (n as HTMLSlotElement).assignedNodes();
        kids = a.length ? a : n.childNodes;
      } else kids = n.childNodes;
      if (first) {
        for (let i = 0; i < kids.length; i++) {
          const t = visit(kids[i]!);
          if (t) return t;
        }
      } else {
        for (let i = kids.length - 1; i >= 0; i--) {
          const t = visit(kids[i]!);
          if (t) return t;
        }
      }
      return null;
    };
    return visit(el);
  }

  private own: Map<Element, number[]> | null = null;

  /** Indexes of the segments whose nearest block is el: the text it holds itself. */
  ownSegs(el: Element): number[] {
    if (!this.own) {
      const own = new Map<Element, number[]>();
      this.segs.forEach((s, i) => {
        const list = own.get(s.block);
        if (list) list.push(i);
        else own.set(s.block, [i]);
      });
      this.own = own;
    }
    return this.own.get(el) ?? [];
  }

  /** Nearest block for a model offset. */
  blockAt(offset: number): Element | null {
    let i = this.segAt(offset);
    if (i < 0) i = 0;
    const s = this.segs[i];
    if (!s) return null;
    if (offset >= s.start + s.len && this.segs[i + 1]) return this.segs[i + 1]!.block;
    return s.block;
  }

  /** True when the segments under a span still match the page. */
  fresh(start: number, end: number): boolean {
    let i = Math.max(0, this.segAt(start));
    const segs = this.segs;
    for (; i < segs.length && segs[i]!.start < Math.max(end, start + 1); i++) {
      const s = segs[i]!;
      if (!s.node.isConnected || s.node.length !== s.raw) return false;
    }
    return true;
  }
}

/** Fold white space the way the model does, for text that is not in the model. */
export function fold(s: string): string {
  WS.lastIndex = 0;
  return s.replace(WS, ' ').trim();
}

const WORD = /[\p{L}\p{N}_'’-]/u;

export function isWordChar(c: string | undefined): boolean {
  return !!c && WORD.test(c);
}

/** Widen [start, end) to whole words and trim white space at both ends. */
export function widenToWords(text: string, start: number, end: number): Span {
  let s = start;
  let e = end;
  while (s < e && text.charCodeAt(s) === 32) s++;
  while (e > s && text.charCodeAt(e - 1) === 32) e--;
  if (s === e) return { start: s, end: e };
  while (s > 0 && isWordChar(text[s - 1]) && isWordChar(text[s])) s--;
  while (e < text.length && isWordChar(text[e]) && isWordChar(text[e - 1])) e++;
  return { start: s, end: e };
}

// One model per document and context, shared by describe and the resolver.
const cache = new WeakMap<Document, TextModel>();
// A model being built in slices, not yet complete.
const partial = new WeakMap<Document, TextModel>();

const sameCtx = (m: TextModel, ctx: AnchorContext): boolean =>
  m.ctx.shadowRootOf === ctx.shadowRootOf && m.ctx.isOurs === ctx.isOurs;

/** The complete model for ctx, building the rest of it now if needed. */
export function getModel(ctx: AnchorContext): TextModel {
  const m = cache.get(ctx.doc);
  if (m && sameCtx(m, ctx)) return m;
  const p = partial.get(ctx.doc);
  partial.delete(ctx.doc);
  const fresh = p && sameCtx(p, ctx) ? p : new TextModel(ctx, { lazy: true });
  fresh.step(Number.POSITIVE_INFINITY);
  cache.set(ctx.doc, fresh);
  return fresh;
}

/** True when the complete model for ctx is cached, so getModel builds nothing. */
export function hasModel(ctx: AnchorContext): boolean {
  const m = cache.get(ctx.doc);
  return !!m && sameCtx(m, ctx);
}

/**
 * Build the model in a slice that ends after about `ms`. True when it is complete.
 * The page may change between slices; whoever sees the change calls dropModel.
 */
export function buildModel(ctx: AnchorContext, ms: number): boolean {
  if (hasModel(ctx)) return true;
  let p = partial.get(ctx.doc);
  if (!p || !sameCtx(p, ctx)) {
    p = new TextModel(ctx, { lazy: true });
    partial.set(ctx.doc, p);
  }
  if (!p.step((ctx.now?.() ?? performance.now()) + ms)) return false;
  partial.delete(ctx.doc);
  cache.set(ctx.doc, p);
  return true;
}

export function dropModel(doc: Document): void {
  cache.delete(doc);
  partial.delete(doc);
}
