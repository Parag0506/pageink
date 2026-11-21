import type { Sample } from '../types';

/**
 * Drop samples that add nothing visible. Douglas-Peucker on x, y and a scaled
 * pressure, so a change in pressure on a straight line is kept.
 */
export function simplify<T extends Pick<Sample, 'x' | 'y' | 'p'>>(
  samples: T[],
  eps: number,
  pScale: number,
): T[] {
  const n = samples.length;
  if (n <= 2) return samples.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    const A = samples[a] as T;
    const B = samples[b] as T;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const L2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const P = samples[i] as T;
      const t = L2 ? Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / L2)) : (i - a) / (b - a);
      const ex = A.x + t * dx - P.x;
      const ey = A.y + t * dy - P.y;
      const ep = (A.p + t * (B.p - A.p) - P.p) * pScale;
      const d = Math.sqrt(ex * ex + ey * ey + ep * ep);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > eps && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return samples.filter((_, i) => keep[i]);
}
