// How the quick gate judges a run on a machine other than the reference one.
//
// The published budgets are fixed times (5 ms, 50 ms, one frame) measured by the full run on the
// reference machine named in the results. A fixed time means something only on a machine like it.
// So a quick run first measures the machine: the same layout and script work the library's budget
// tests use (packages/core/src/testkit.ts calibrate()), in the same Chromium, and the core count.
// Against the reference values stored with the published results:
// - a machine within the bounds judges each fixed limit scaled by how much slower it ran the work;
// - any other machine does not judge fixed limits at all. Each such rule is reported as not judged,
//   with the measured value, the limit and the reason, and it does not fail the run.
// Rules that do not depend on the machine's speed are judged everywhere: structural rules, and
// first and largest paint against the control extension, which is judged against the run's own
// noise. How often a load has a long task counts loads over a fixed time, so it is a fixed limit
// like the others, though it is counted beside the control extension.

export interface MachineMeasure {
  /** Median time of the calibration work, ms. */
  calibrateMs: number;
  /** Logical cores the browser can use. */
  cores: number;
  /** The operating system, as Node names it (darwin, linux, win32). Older results hold none. */
  platform?: string;
}

export interface Fitness {
  fit: boolean;
  /** Limits are multiplied by this when fit: measured over reference, never below 1. */
  scale: number;
  /** Measured over reference calibration time, when there is a reference. */
  ratio: number | null;
  reason: string;
}

/** A machine is fit to judge fixed limits only within these bounds. */
export const BOUNDS = {
  /**
   * At most this many times slower at the calibration work than the reference. The calibration
   * work understates a slow machine: on GitHub's 2-core runner it ran about 1.4 to 1.7 times slower
   * than the reference, while first paint ran 2.6 times slower and script injection about 7 times
   * slower. So scaling a limit by the calibration ratio is sound only on a machine close to the
   * reference. A machine further away shows the fixed limits and does not judge them.
   */
  maxRatio: 1.25,
  /** At least this many cores: with fewer, the browser's own processes take the page's core. */
  minCores: 4,
  /**
   * The same operating system as the reference. The calibration work is layout and script. It
   * measures no painting, and another system paints with other code: GitHub's 4-core Linux runner
   * ran the calibration work 1.29 times slower than the reference Mac, held the first paint back
   * 17 to 23 ms where the Mac measured 4 to 14, and ran the stress page's first update as one task
   * of 37 to 50 ms where the Mac ran it in 47 to 73. No ratio of the calibration work carries a
   * fixed time from one to the other.
   */
  samePlatform: true,
};

export function fitness(m: MachineMeasure, ref: MachineMeasure | null, b = BOUNDS): Fitness {
  if (!ref || !(ref.calibrateMs > 0))
    return {
      fit: false,
      scale: 1,
      ratio: null,
      reason: 'the published results hold no machine measurement to compare with',
    };
  const ratio = Math.round((m.calibrateMs / ref.calibrateMs) * 100) / 100;
  if (b.samePlatform && m.platform && ref.platform && m.platform !== ref.platform)
    return {
      fit: false,
      scale: 1,
      ratio,
      reason: `it runs ${m.platform} and the reference machine runs ${ref.platform}, which paints with other code`,
    };
  if (m.cores < b.minCores)
    return { fit: false, scale: 1, ratio, reason: `${m.cores} cores, fewer than ${b.minCores}` };
  if (ratio > b.maxRatio)
    return {
      fit: false,
      scale: 1,
      ratio,
      reason: `${ratio} times slower than the reference machine at the calibration work, more than ${b.maxRatio}`,
    };
  return { fit: true, scale: Math.max(1, ratio), ratio, reason: 'within the bounds' };
}

export type Verdict = 'pass' | 'fail' | 'not judged';

export interface Judged {
  rule: string;
  value: number;
  limit: number;
  /** The limit the run was judged against: the limit times the scale. */
  judgedLimit: number;
  /** Against the unscaled limit, as the reference machine would judge it. */
  raw: 'pass' | 'fail';
  verdict: Verdict;
  reason?: string;
}

/**
 * A fixed limit. `over` says whether a value fails a limit: most rules fail above it, some fail
 * at it (a budget that must stay under).
 */
export function judgeLimit(
  rule: string,
  value: number,
  limit: number,
  f: Fitness,
  over: (v: number, l: number) => boolean = (v, l) => v > l,
): Judged {
  const judgedLimit = Math.round(limit * f.scale * 100) / 100;
  const raw = over(value, limit) ? 'fail' : 'pass';
  if (!f.fit) return { rule, value, limit, judgedLimit, raw, verdict: 'not judged', reason: f.reason };
  return { rule, value, limit, judgedLimit, raw, verdict: over(value, judgedLimit) ? 'fail' : 'pass' };
}

/** A fixed limit judged a second time: the verdict, with both figures. */
export interface Repeated extends Judged {
  /** The second figure, measured again from scratch; null when no second measure was needed or taken. */
  second: number | null;
  /** Over the judged limit the first time and not the second. */
  notRepeated: boolean;
}

/**
 * A quick run takes few loads, so on a fit machine a figure over the judged limit is measured again
 * from scratch, and it fails only when the second figure is over the judged limit too. Otherwise it
 * passes, marked as not repeated. A machine not fit to judge does not judge it either way.
 */
export function judgeRepeated(
  rule: string,
  first: number,
  second: number | null,
  limit: number,
  f: Fitness,
): Repeated {
  const j = judgeLimit(rule, first, limit, f);
  if (j.verdict !== 'fail') return { ...j, second: null, notRepeated: false };
  if (second !== null && second > j.judgedLimit) return { ...j, second, notRepeated: false };
  return { ...j, verdict: 'pass', second, notRepeated: true };
}

export interface Comparison {
  /** Median with PageInk minus median with the control extension, ms. */
  delta: number;
  /** Beyond the larger interquartile range of the two arms and beyond one frame (stats.ts compare). */
  beyondNoise: boolean;
}

/**
 * PageInk against the control extension on the same pages in the same run. Slower counts when it
 * is beyond the noise and one frame, in the first run and again in a second one.
 */
export function slowerThanControl(first: Comparison, second: Comparison | null): boolean {
  const slow = (c: Comparison) => c.beyondNoise && c.delta > 0;
  return slow(first) && !!second && slow(second);
}

/** Loads of one arm that lie together: none of them more than a frame from the next. */
export interface Group {
  n: number;
  median: number;
  min: number;
  max: number;
}

export interface Arm {
  median: number;
  iqr: number;
  n: number;
  /** The loads split where two neighbours lie more than a frame apart. One group when none do. */
  groups: Group[];
  runs: number[];
}

/**
 * How long the extension held back the first paint of the content under ink: the paint with it
 * minus the paint of the page alone, loads of the two arms interleaved. Loads are taken in pairs,
 * one of each arm back to back, and the machine drifts over a run (the first warm loads of both
 * arms are slower), so the figure is the median of the differences within pairs, and the noise
 * the interquartile range of those differences. With fewer than three pairs, the medians.
 *
 * Some pages paint their first screen in one of two ways from load to load (the stress page alone
 * sometimes merges two parse chunks into one long first update). A median of such an arm lands in
 * one group or the other by chance, and an interquartile range across both groups is no noise
 * figure. So an arm whose loads fall into groups more than a frame apart, each with at least a
 * third of the loads (and three), is compared group by group. A load or two slowed by the machine
 * stays a lone outlier, which the pairs below take out:
 * - both arms split in as many groups: each group against the group of the same rank;
 * - one arm splits: each of its groups against the median of the other arm;
 * - both split, in different numbers of groups: every group against every group.
 * The figure is the largest of those differences, so no group is hidden, and every group is reported.
 */
export interface HeldBack {
  with: Arm;
  alone: Arm;
  /** The figure judged, ms. */
  delta: number;
  /** Interquartile range of the differences within pairs, or the larger one of the two sides compared. */
  noise: number;
  /** What was compared: 'pairs', 'medians', or the two groups the figure came from. */
  basis: string;
}

const FRAME = 16.7;
const q = (xs: number[], p: number): number => {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return Number.NaN;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
};
const r1 = (x: number) => Math.round(x * 10) / 10;

export function groupsOf(xs: number[], gap = FRAME): Group[] {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  const out: number[][] = [];
  for (const x of s) {
    const g = out.at(-1);
    if (g && x - g.at(-1)! <= gap) g.push(x);
    else out.push([x]);
  }
  return out.map((g) => ({ n: g.length, median: r1(q(g, 0.5)), min: g[0]!, max: g.at(-1)! }));
}

export function armOf(xs: number[]): Arm {
  const v = xs.filter(Number.isFinite);
  return {
    median: r1(q(v, 0.5)),
    iqr: r1(q(v, 0.75) - q(v, 0.25)),
    n: v.length,
    groups: groupsOf(v),
    runs: v,
  };
}

/** The groups of an arm when they are a real second way of painting, else null. */
export function splitOf(a: Arm): Group[] | null {
  if (a.groups.length < 2) return null;
  return a.groups.every((g) => g.n >= Math.max(3, a.n / 3)) ? a.groups : null;
}

/** Per load of each arm, in the order taken: load i of one arm was taken next to load i of the other. A failed load is null. */
export function heldBack(withMs: (number | null)[], aloneMs: (number | null)[]): HeldBack {
  const fin = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null && Number.isFinite(x));
  const w = armOf(fin(withMs));
  const a = armOf(fin(aloneMs));
  const gw = splitOf(w);
  const ga = splitOf(a);
  if (!gw && !ga) {
    const diffs = withMs.flatMap((x, i) => {
      const y = aloneMs[i];
      return x != null && y != null && Number.isFinite(x) && Number.isFinite(y) ? [x - y] : [];
    });
    if (withMs.length === aloneMs.length && diffs.length >= 3)
      return {
        with: w,
        alone: a,
        delta: r1(q(diffs, 0.5)),
        noise: r1(q(diffs, 0.75) - q(diffs, 0.25)),
        basis: 'pairs',
      };
    return {
      with: w,
      alone: a,
      delta: r1(w.median - a.median),
      noise: Math.max(w.iqr, a.iqr),
      basis: 'medians',
    };
  }
  const whole = (arm: Arm): Group => ({ n: arm.n, median: arm.median, min: -Infinity, max: Infinity });
  const iqrIn = (arm: Arm, g: Group) => {
    const xs = arm.runs.filter((x) => x >= g.min && x <= g.max);
    return r1(q(xs, 0.75) - q(xs, 0.25));
  };
  const label = (side: string, g: Group, split: boolean) =>
    split ? `${side}, group of ${g.n} loads at ${g.median} ms` : `${side}, median of ${g.n} loads`;
  let pairs: [Group, Group][];
  if (gw && ga && gw.length === ga.length) pairs = gw.map((g, i) => [g, ga[i]!]);
  else if (gw && !ga) pairs = gw.map((g) => [g, whole(a)]);
  else if (ga && !gw) pairs = ga.map((g) => [whole(w), g]);
  // Both split, unevenly: every group with the extension against every group of the page alone.
  else pairs = gw!.flatMap((x) => ga!.map((y): [Group, Group] => [x, y]));
  let best: Omit<HeldBack, 'with' | 'alone'> | null = null;
  for (const [x, y] of pairs) {
    const delta = r1(x.median - y.median);
    if (best && delta <= best.delta) continue;
    best = {
      delta,
      noise: Math.max(iqrIn(w, x), iqrIn(a, y)),
      basis: `${label('with the extension', x, !!gw)} against ${label('page alone', y, !!ga)}`,
    };
  }
  return { with: w, alone: a, ...best! };
}

/** How many loads of an arm had a task over the long task limit, out of how many. */
export interface Count {
  long: number;
  loads: number;
}

const lnFact = (() => {
  const t = [0];
  return (n: number): number => {
    for (let i = t.length; i <= n; i++) t[i] = t[i - 1]! + Math.log(i);
    return t[n]!;
  };
})();

/**
 * One-sided Fisher exact test: the chance of seeing at least `a.long` long loads in arm a, were
 * long loads as common in both arms, given all the loads of the two. A small value means a has
 * long loads more often than b beyond chance.
 */
export function moreOftenP(a: Count, b: Count): number {
  const n = a.loads + b.loads;
  const k = a.long + b.long;
  const lnC = (x: number, y: number) => lnFact(x) - lnFact(y) - lnFact(x - y);
  const total = lnC(n, k);
  let p = 0;
  for (let x = a.long; x <= Math.min(k, a.loads); x++) {
    if (k - x > b.loads) continue;
    p += Math.exp(lnC(a.loads, x) + lnC(b.loads, k - x) - total);
  }
  return Math.min(1, p);
}

/** Below this chance, a difference in how often long tasks occur counts as real. */
export const OFTEN_ALPHA = 0.05;

/** One measure of the stress page: how often a load had a long task, in each arm. */
export interface Often {
  ext: Count;
  plain: Count;
  control: Count;
}

/**
 * True when the extension had long tasks more often than the control extension, beyond chance.
 * The page alone is counted and reported, but it is no baseline: with no extension at all the
 * parser runs its chunks differently, and on a loaded machine the page alone had a long task in
 * 7 of 10 loads where the control extension had one in 2 and 4 of 10. Against it, even an
 * extension that made every load long would pass.
 */
export const moreOften = (o: Often, alpha = OFTEN_ALPHA): boolean => moreOftenP(o.ext, o.control) < alpha;

/**
 * The rule "no long task only with the extension", over many loads per arm. The page itself
 * sometimes runs its first update as one long task and sometimes as two short ones, so a long task
 * in a few loads with the extension says nothing. What counts is whether loads with the extension
 * have one more often than loads with a do-nothing extension, beyond chance, in a first measure and
 * again in a second one, taken from scratch.
 *
 * A long task is one over a fixed time, so the count means something only on a machine fit to
 * judge fixed limits. Where the page's own first update runs a few ms under the limit, the ink
 * drawn in the same frame as the content puts most loads over it; where it runs well under or
 * well over, the same ink changes no count. `judged` false reports the counts and judges nothing.
 */
export type OftenVerdict = 'pass' | 'fail' | 'not repeated' | 'not judged';
export function judgeOften(first: Often, second: Often | null, judged = true): OftenVerdict {
  if (!judged) return 'not judged';
  if (!moreOften(first)) return 'pass';
  return second && moreOften(second) ? 'fail' : 'not repeated';
}
