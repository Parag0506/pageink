// Small statistics for load runs: medians, robust spread, and whether a difference stands out from noise.

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return Number.NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

export const median = (xs: number[]) => quantile(xs, 0.5);
export const iqr = (xs: number[]) => quantile(xs, 0.75) - quantile(xs, 0.25);
/** Median absolute deviation from the median. */
export const mad = (xs: number[]) => {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
};

/**
 * Smallest difference that can count at all. Paint times land on frames, so a shift under
 * one 60 Hz frame cannot be told apart from where the frame boundary fell.
 */
export const FRAME_MS = 16.7;

export interface Compare {
  with: { median: number; iqr: number; mad: number; n: number };
  without: { median: number; iqr: number; mad: number; n: number };
  /** Median with the extension minus median without. */
  delta: number;
  /** Run-to-run spread: the larger interquartile range of the two arms. */
  noise: number;
  /** True when the difference is larger than the spread and than one frame. */
  beyondNoise: boolean;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export function compare(withExt: number[], withoutExt: number[]): Compare {
  const a = withExt.filter(Number.isFinite);
  const b = withoutExt.filter(Number.isFinite);
  const noise = Math.max(iqr(a), iqr(b));
  const delta = median(a) - median(b);
  return {
    with: { median: r1(median(a)), iqr: r1(iqr(a)), mad: r1(mad(a)), n: a.length },
    without: { median: r1(median(b)), iqr: r1(iqr(b)), mad: r1(mad(b)), n: b.length },
    delta: r1(delta),
    noise: r1(noise),
    beyondNoise: Number.isFinite(delta) && Math.abs(delta) > Math.max(noise, FRAME_MS),
  };
}
