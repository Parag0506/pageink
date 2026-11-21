// Document text as defined in FORMAT "Document text": text nodes of <body> in order,
// open shadow trees included, script, style, noscript, template and hidden elements skipped,
// every run of white space folded to one space. Runs in the page.

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'script', 'style']);

export interface TextIndex {
  text: string;
  /** Text node for each character of text. */
  nodes: Text[];
  nodeOf: Int32Array;
  offOf: Int32Array;
}

export interface WalkOpts {
  shadowRootOf?(el: Element): ShadowRoot | null;
  isOurs?(el: Element): boolean;
  /** Keep the text of hidden elements too: closed sections, hidden tabs and menus. */
  all?: boolean;
}

function hidden(el: Element): boolean {
  if ((el as HTMLElement).hidden) return true;
  const cs = getComputedStyle(el);
  return cs.display === 'none' || cs.visibility === 'hidden' || cs.contentVisibility === 'hidden';
}

export function buildIndex(doc: Document, o: WalkOpts = {}): TextIndex {
  const parts: string[] = [];
  const nodes: Text[] = [];
  const nodeOf: number[] = [];
  const offOf: number[] = [];
  let lastSpace = true;
  const visit = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n as Text;
      const s = t.data;
      let k = -1;
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 160;
        if (ws) {
          if (lastSpace) continue;
          lastSpace = true;
          if (k < 0) k = nodes.push(t) - 1;
          parts.push(' ');
          nodeOf.push(k);
          offOf.push(i);
        } else {
          lastSpace = false;
          if (k < 0) k = nodes.push(t) - 1;
          parts.push(s[i]!);
          nodeOf.push(k);
          offOf.push(i);
        }
      }
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    if (SKIP.has(el.tagName) || o.isOurs?.(el) || (!o.all && hidden(el))) return;
    const root = el.shadowRoot ?? o.shadowRootOf?.(el) ?? null;
    if (root) {
      for (let c = root.firstChild; c; c = c.nextSibling) visit(c);
      return;
    }
    for (let c = el.firstChild; c; c = c.nextSibling) visit(c);
  };
  if (doc.body) visit(doc.body);
  return { text: parts.join(''), nodes, nodeOf: Int32Array.from(nodeOf), offOf: Int32Array.from(offOf) };
}

/** Range for [start, end) in index text. */
export function rangeOf(ix: TextIndex, start: number, end: number): Range | null {
  if (start < 0 || end > ix.text.length || end <= start) return null;
  const r = ix.nodes[0]!.ownerDocument.createRange();
  const a = ix.nodes[ix.nodeOf[start]!]!;
  const b = ix.nodes[ix.nodeOf[end - 1]!]!;
  r.setStart(a, ix.offOf[start]!);
  r.setEnd(b, ix.offOf[end - 1]! + 1);
  return r;
}

const posCache = new WeakMap<TextIndex, Map<Text, number>>();
const startCache = new WeakMap<TextIndex, number[]>();

function nodePos(ix: TextIndex): Map<Text, number> {
  let m = posCache.get(ix);
  if (!m) {
    m = new Map(ix.nodes.map((n, k) => [n, k]));
    posCache.set(ix, m);
  }
  return m;
}

/** First index offset of each node, in node order. */
function nodeStarts(ix: TextIndex): number[] {
  let s = startCache.get(ix);
  if (!s) {
    s = [];
    for (let i = 0; i < ix.nodeOf.length; i++) if (s[ix.nodeOf[i]!] === undefined) s[ix.nodeOf[i]!] = i;
    startCache.set(ix, s);
  }
  return s;
}

/** Index text offset of a DOM position, or -1. */
export function offsetOf(ix: TextIndex, node: Node, off: number): number {
  const k = nodePos(ix).get(node as Text);
  if (k === undefined) return -1;
  let best = -1;
  for (let i = nodeStarts(ix)[k]!; i < ix.nodeOf.length; i++) {
    if (ix.nodeOf[i] === k) {
      if (ix.offOf[i]! >= off) return i;
      best = i + 1;
    } else if (best >= 0) return best;
  }
  return best;
}

/** Index text range covered by an element: [start, end). */
export function spanOf(ix: TextIndex, el: Element): [number, number] {
  const pos = nodePos(ix);
  const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let first = -1;
  let last = -1;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const k = pos.get(n as Text);
    if (k === undefined) continue;
    if (first < 0) first = k;
    last = k;
  }
  if (first < 0) return [-1, -1];
  const starts = nodeStarts(ix);
  return [starts[first]!, starts[last + 1] ?? ix.text.length];
}

export const norm = (s: string): string => s.replace(/[\s ]+/g, ' ').trim();

export function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** First line box of a range, in document space. */
export function firstRect(r: Range): DOMRect | null {
  for (const rc of Array.from(r.getClientRects())) if (rc.width > 0 && rc.height > 0) return rc;
  return null;
}

export const toDoc = (r: { left: number; top: number }): { x: number; y: number } => ({
  x: r.left + scrollX,
  y: r.top + scrollY,
});

const BLOCK_DISPLAY = /^(block|list-item|table|table-cell|table-caption|flex|grid|flow-root)$/;

/** Nearest block-level ancestor of a node. */
export function blockOf(n: Node): Element | null {
  let el: Element | null = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
  while (el && el !== el.ownerDocument.body) {
    if (BLOCK_DISPLAY.test(getComputedStyle(el).display)) return el;
    el = el.parentElement;
  }
  return el;
}
