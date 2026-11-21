/**
 * Migration from the earlier pencil layer. It stored strokes per section as integer
 * triples (x, y, pressure times ten) in a 720 unit wide column, measured from the
 * section's top-left corner, and scaled them with the section width.
 *
 * Migrated notes are anchored as media to a thin surface element that covers the
 * section. Media notes scale with the element width, which is exactly how the earlier
 * layer drew them, so old ink stays where it was at every width.
 */
import { hashKey } from 'pageink-core';
import { makeStroke } from 'pageink-core/strokes';
import type { Anchor, ElementPath, InkColor, Note, Sample, Stroke } from 'pageink-core/types';

/** One stroke as the earlier pencil layer stored it. */
export interface LegacyStroke {
  /** "pen" or "hi" (highlighter). */
  k: 'pen' | 'hi' | (string & {});
  /** Pen colour index: 0 or 1. */
  c?: number;
  /** Width in column units. */
  w?: number;
  /** Flat list of integer triples: x, y, pressure times ten. */
  p: number[];
}

export interface MigrateOptions {
  /** Key the old data used for this section. Default: the section's id. */
  key?: string;
  /** Column width the old coordinates were written in. Default 720. */
  col?: number;
  /** Device name written into the notes. Default "legacy". */
  device?: string;
  /** Time written into the notes, epoch ms. Default now. */
  now?: number;
  /** Strokes closer than this, in column units, form one note. Default 40. */
  gap?: number;
}

const SURFACE = 'ink-surface';
const COL = 720;

const keyOf = (section: Element, key?: string): string => {
  const k = key ?? section.getAttribute('data-ink-legacy-key') ?? section.id;
  if (!k) throw new Error('The section needs an id, or pass the key its old ink was stored under.');
  return k;
};

/** The media source that ties migrated notes to their section. */
export const legacySrc = (key: string): string => `legacy:${key}`;

/**
 * The surface element migrated notes are anchored to, created when missing.
 * It is empty, covers the section, and takes no pointer events, so new ink still
 * anchors to the text under it. Call it for each section before mounting, or put
 * the element in the page's HTML.
 */
export function legacySurface(section: HTMLElement, key?: string): HTMLElement {
  const k = keyOf(section, key);
  const src = legacySrc(k);
  for (const c of section.children) {
    if (c.localName === SURFACE && c.getAttribute('data-ink-media') === src) return c as HTMLElement;
  }
  const doc = section.ownerDocument;
  const view = doc.defaultView;
  if (view && view.getComputedStyle(section).position === 'static') section.style.position = 'relative';
  const el = doc.createElement(SURFACE);
  el.setAttribute('data-ink-media', src);
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText =
    'position:absolute;left:0;top:0;width:100%;height:100%;margin:0;padding:0;border:0;pointer-events:none;display:block';
  // First child, where the earlier layer kept its own overlay, so sibling selectors see the same shape.
  section.prepend(el);
  return el;
}

function nthOfType(el: Element): number {
  let n = 1;
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling)
    if (s.localName === el.localName) n++;
  return n;
}

/** Structural address in the same shape anchor/ writes. The media source is the main locator. */
function pathOf(el: Element): ElementPath {
  const chain: Element[] = [];
  for (let e: Element | null = el; e; e = e.parentElement) chain.push(e);
  chain.reverse();
  const xpath = chain.map((e) => `/${e.localName}[${nthOfType(e)}]`).join('');
  const steps: string[] = [];
  for (let e: Element | null = el; e; e = e.parentElement) {
    if (e !== el && e.id && /^[A-Za-z][\w-]*$/.test(e.id)) {
      steps.push(`#${e.id}`);
      break;
    }
    if (e.localName === 'body' || e.localName === 'html') {
      steps.push(e.localName);
      break;
    }
    steps.push(`${e.localName}:nth-of-type(${nthOfType(e)})`);
  }
  return { css: steps.reverse().join(' > '), xpath };
}

const colorOf = (s: LegacyStroke): InkColor => (s.k === 'hi' ? 'hi-1' : s.c === 1 ? 'ink-2' : 'ink-1');

/** Longest gap between samples, in column units. The outline smooths corners of sparse input. */
const STEP = 2;

function samplesOf(p: number[]): Sample[] {
  const out: Sample[] = [];
  let t = 0;
  for (let i = 0; i + 1 < p.length; i += 3) {
    // The earlier layer read a missing pressure as 0.5.
    const s = { x: p[i]!, y: p[i + 1]!, p: Math.min(1, Math.max(0, (p[i + 2] || 5) / 10)), t: 0 };
    const last = out[out.length - 1];
    if (last) {
      const n = Math.ceil(Math.hypot(s.x - last.x, s.y - last.y) / STEP);
      for (let k = 1; k < n; k++) {
        const f = k / n;
        t += 4;
        out.push({
          x: last.x + (s.x - last.x) * f,
          y: last.y + (s.y - last.y) * f,
          p: last.p + (s.p - last.p) * f,
          t,
        });
      }
    }
    t += 4;
    out.push({ ...s, t });
  }
  return out;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxOf(samples: Sample[], pad: number): Box {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    x0 = Math.min(x0, s.x);
    y0 = Math.min(y0, s.y);
    x1 = Math.max(x1, s.x);
    y1 = Math.max(y1, s.y);
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

const near = (a: Box, b: Box, gap: number): boolean =>
  a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1;

/** Strokes that touch or sit close together become one note, like strokes written together. */
function groups(boxes: Box[], gap: number): number[][] {
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (near(boxes[i]!, boxes[j]!, gap)) parent[find(i)] = find(j);
    }
  }
  const by = new Map<number, number[]>();
  for (let i = 0; i < boxes.length; i++) {
    const r = find(i);
    const list = by.get(r) ?? [];
    list.push(i);
    by.set(r, list);
  }
  return [...by.values()].sort((a, b) => a[0]! - b[0]!);
}

function label(section: Element): string {
  const h = section.querySelector('h1, h2, h3, h4');
  const t = (h?.textContent ?? section.textContent ?? '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 80);
}

/**
 * Turn one section's old strokes into ink notes. Ids are derived from the old data,
 * so running the migration twice adds nothing new, and notes the reader erased stay erased.
 */
export function migrateLegacy(
  section: HTMLElement,
  legacyStrokes: readonly LegacyStroke[],
  opts: MigrateOptions = {},
): Note[] {
  const key = keyOf(section, opts.key);
  const col = opts.col ?? COL;
  const now = opts.now ?? Date.now();
  const gap = opts.gap ?? 40;
  const surface = legacySurface(section, key);
  const src = legacySrc(key);

  const items = legacyStrokes
    .map((s, i) => ({ s, i, samples: samplesOf(s.p ?? []) }))
    .filter((x) => x.samples.length > 0);
  if (!items.length) return [];

  const doc = section.ownerDocument;
  const view = doc.defaultView;
  const rect = surface.getBoundingClientRect();
  const sx = view?.scrollX ?? 0;
  const sy = view?.scrollY ?? 0;
  const root = doc.documentElement;
  const docW = Math.max(1, root.scrollWidth);
  const docH = Math.max(1, root.scrollHeight);
  const fontPx = view ? Number.parseFloat(view.getComputedStyle(section).fontSize) || 16 : 16;
  const title = label(section);

  const anchor: Anchor = {
    type: 'media',
    quote: { exact: title, prefix: '', suffix: '' },
    path: pathOf(surface),
    pos: { start: 0, end: 0 },
    hash: hashKey(src),
    media: { src, alt: title, caption: '' },
    place: 'on',
    frac: { x: (rect.left + sx) / docW, y: (rect.top + sy) / docH },
  };
  // Note-local units are the old column units: the placer scales by width / frame.w.
  const frame = {
    w: col,
    h: rect.width > 0 ? Math.round((rect.height * col) / rect.width) : 0,
    fontPx,
    viewportW: view?.innerWidth ?? root.clientWidth,
  };

  const strokes: Stroke[] = items.map(({ s, i, samples }) => {
    const tool = s.k === 'hi' ? 'hi' : 'pen';
    const w = s.w ?? (tool === 'hi' ? 18 : 3);
    const id = `lg${hashKey(`${key}|${i}|${s.k}|${s.c ?? 0}|${w}|${s.p.join(',')}`)}`;
    return makeStroke(samples, { x: 0, y: 0 }, { tool, color: colorOf(s), w }, { id, t: now });
  });
  const boxes = items.map(({ s, samples }) => boxOf(samples, (s.w ?? 3) / 2));

  return groups(boxes, gap).map((g) => {
    const list = g.map((k) => strokes[k]!);
    return {
      id: `lg${hashKey(`${key}#${list.map((s) => s.id).join(',')}`)}`,
      createdAt: now,
      updatedAt: now,
      device: opts.device ?? 'legacy',
      kind: 'ink',
      anchor: { ...anchor, quote: { ...anchor.quote }, pos: { ...anchor.pos } },
      frame: { ...frame },
      strokes: list,
    } satisfies Note;
  });
}
