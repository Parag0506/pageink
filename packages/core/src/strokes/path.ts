/**
 * Compact SVG path writing and reading for stroke outlines.
 *
 * Paths use only M, L, Q, C and Z. The first point is absolute and the rest are
 * relative, so numbers stay short. Relative values are taken between rounded
 * absolute points, so rounding never drifts along the path. With only these
 * commands every number pair is a point, which makes moving and scaling exact.
 */

export type SegCmd = 'M' | 'L' | 'Q' | 'C' | 'Z';

/** One path command with absolute coordinates as flat x, y pairs. */
export interface Seg {
  c: SegCmd;
  p: number[];
}

const tenths = (v: number): number => Math.round(v * 10);

/** Number in tenths to its shortest text: 12 -> "1.2", 5 -> ".5", -5 -> "-.5". */
function num(n: number): string {
  if (n === 0) return '0';
  const neg = n < 0;
  const a = neg ? -n : n;
  const whole = Math.floor(a / 10);
  const frac = a % 10;
  let s = frac ? `${whole ? whole : ''}.${frac}` : `${whole}`;
  if (neg) s = `-${s}`;
  return s;
}

/** Join numbers with the fewest separators the SVG grammar allows. */
function joinNums(parts: string[]): string {
  let out = '';
  let prev = '';
  for (const s of parts) {
    if (prev === '') out += s;
    else if (s[0] === '-') out += s;
    else if (s[0] === '.' && prev.includes('.')) out += s;
    else out += `,${s}`;
    prev = s;
  }
  return out;
}

/** Write segments as a compact path string with at most one decimal. */
export function writePath(segs: Seg[]): string {
  let out = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const s of segs) {
    if (s.c === 'Z') {
      out += 'Z';
      cx = sx;
      cy = sy;
      continue;
    }
    const q = s.p.map(tenths);
    if (s.c === 'M') {
      cx = q[0] ?? 0;
      cy = q[1] ?? 0;
      sx = cx;
      sy = cy;
      out += `M${joinNums([num(cx), num(cy)])}`;
      continue;
    }
    const parts: string[] = [];
    for (let i = 0; i < q.length; i += 2) {
      parts.push(num((q[i] ?? 0) - cx), num((q[i + 1] ?? 0) - cy));
    }
    out += s.c.toLowerCase() + joinNums(parts);
    cx = q[q.length - 2] ?? cx;
    cy = q[q.length - 1] ?? cy;
  }
  return out;
}

const ARGS: Record<string, number> = { m: 2, l: 2, q: 4, c: 6, z: 0 };

/** Read a path with M, L, Q, C, Z in either case. Returns absolute segments. */
export function readPath(d: string): Seg[] {
  const out: Seg[] = [];
  const re = /([MLQCZmlqcz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  let cmd = '';
  let buf: number[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const flush = (): void => {
    const lower = cmd.toLowerCase();
    const rel = cmd === lower;
    const p = buf;
    buf = [];
    if (rel && lower !== 'm') {
      for (let i = 0; i < p.length; i += 2) {
        p[i] = (p[i] ?? 0) + cx;
        p[i + 1] = (p[i + 1] ?? 0) + cy;
      }
    }
    if (lower === 'm') {
      // A relative moveto is relative to the current point.
      cx = (p[0] ?? 0) + (rel ? cx : 0);
      cy = (p[1] ?? 0) + (rel ? cy : 0);
      sx = cx;
      sy = cy;
      out.push({ c: 'M', p: [cx, cy] });
      return;
    }
    out.push({ c: lower.toUpperCase() as SegCmd, p });
    cx = p[p.length - 2] ?? cx;
    cy = p[p.length - 1] ?? cy;
  };
  for (let m = re.exec(d); m; m = re.exec(d)) {
    if (m[1]) {
      cmd = m[1];
      if (cmd === 'z' || cmd === 'Z') {
        out.push({ c: 'Z', p: [] });
        cx = sx;
        cy = sy;
      }
      continue;
    }
    if (!cmd || cmd === 'z' || cmd === 'Z') continue;
    buf.push(Number(m[2]));
    const lower = cmd.toLowerCase();
    if (buf.length < (ARGS[lower] ?? 2)) continue;
    flush();
    // Pairs that follow a moveto are implicit linetos.
    if (lower === 'm') cmd = cmd === 'm' ? 'l' : 'L';
  }
  return out;
}

/** Map every point of a path through f. */
export function mapPath(segs: Seg[], f: (x: number, y: number) => [number, number]): Seg[] {
  return segs.map((s) => {
    const p: number[] = [];
    for (let i = 0; i < s.p.length; i += 2) {
      const [x, y] = f(s.p[i] ?? 0, s.p[i + 1] ?? 0);
      p.push(x, y);
    }
    return { c: s.c, p };
  });
}

/** Bounding box of all points, control points included. Null for an empty path. */
export function pathBox(segs: Seg[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const s of segs) {
    for (let i = 0; i < s.p.length; i += 2) {
      const x = s.p[i] ?? 0;
      const y = s.p[i + 1] ?? 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}
