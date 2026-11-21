import type { InkColor, Note, Rect, StrokeTool } from '../types';

const NS = 'http://www.w3.org/2000/svg';
const ARGS: Record<string, number> = { m: 2, l: 2, t: 2, h: 1, v: 1, c: 6, s: 4, q: 4, a: 7, z: 0 };

/**
 * Box around every point and control point of the given path data.
 * Control points can make it a little larger than the true box, which is fine
 * for fitting a thumbnail. It needs no layout, so it works in a hidden panel.
 */
export function pathsBox(ds: string[]): Rect | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = x0;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = x1;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const d of ds) {
    const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
    let cx = 0;
    let cy = 0;
    let sx = 0;
    let sy = 0;
    let cmd = '';
    let i = 0;
    while (i < toks.length) {
      const tk = toks[i] as string;
      if (/[a-zA-Z]/.test(tk)) {
        cmd = tk;
        i++;
        if (cmd === 'z' || cmd === 'Z') {
          cx = sx;
          cy = sy;
        }
        continue;
      }
      const lo = cmd.toLowerCase();
      const n = ARGS[lo];
      if (!n) {
        i++;
        continue;
      }
      const a = toks.slice(i, i + n).map(Number);
      i += n;
      if (a.length < n) break;
      const rel = cmd !== cmd.toUpperCase();
      const bx = rel ? cx : 0;
      const by = rel ? cy : 0;
      if (lo === 'h') {
        cx = bx + (a[0] as number);
      } else if (lo === 'v') {
        cy = by + (a[0] as number);
      } else if (lo === 'a') {
        cx = bx + (a[5] as number);
        cy = by + (a[6] as number);
      } else {
        for (let k = 0; k < n - 2; k += 2) add(bx + (a[k] as number), by + (a[k + 1] as number));
        cx = bx + (a[n - 2] as number);
        cy = by + (a[n - 1] as number);
      }
      add(cx, cy);
      if (lo === 'm') {
        sx = cx;
        sy = cy;
        // Pairs after a moveto are linetos of the same kind.
        cmd = rel ? 'l' : 'L';
      }
    }
  }
  return x1 >= x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Small picture of a note's ink, fitted to its box by the viewBox. */
export function inkThumb(
  doc: Document,
  note: Note,
  color: (c: InkColor, tool: StrokeTool) => string,
): SVGSVGElement {
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ink');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  if (note.kind === 'textmark' || note.strokes.length === 0) {
    // Text marks have no strokes. A short band in the mark colour stands for them.
    svg.setAttribute('viewBox', '0 0 40 24');
    const r = doc.createElementNS(NS, 'rect');
    for (const [k, v] of Object.entries({ x: 4, y: 9, width: 32, height: 6, rx: 2 }))
      r.setAttribute(k, String(v));
    r.setAttribute('fill', color(note.mark?.color ?? 'hi-1', 'hi'));
    svg.append(r);
    return svg;
  }
  for (const s of note.strokes) {
    const p = doc.createElementNS(NS, 'path');
    p.setAttribute('d', s.d);
    p.setAttribute('fill', color(s.color, s.tool));
    if (s.tool === 'hi') p.setAttribute('fill-opacity', '0.55');
    svg.append(p);
  }
  const b = pathsBox(note.strokes.map((s) => s.d));
  if (b) {
    const pad = Math.max(b.w, b.h) * 0.06 + 1;
    svg.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`);
  }
  return svg;
}
