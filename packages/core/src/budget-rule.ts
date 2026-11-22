// How a time budget is judged in a test (withinBudget in testkit.ts, and in the extension's
// e2e fixtures). No browser needed, so the rule has unit tests of its own.
//
// A time measured with the wall clock is the code's own time plus whatever else the machine did
// meanwhile. So it can only come out too long, never too short, and a test that judges one
// measure against a fixed limit fails now and then for no fault of the code. The rule:
//
// 1. A fixed piece of work, the calibration, is timed right before and right after each
//    measure. The limit is the budget times how much slower than the reference the slower of
//    the two ran, never below the budget. A machine that is slow for the whole run is judged
//    against a larger limit.
// 2. When the two calibrations differ by more than STEADY, the machine changed pace while the
//    measure was taken. That measure says nothing about the code and is not judged.
// 3. The calibration is one short task on one thread, and a machine busy with other work runs
//    that nearly as fast as a quiet one, while a page load, which needs several processes at
//    once, takes much longer. So where the test can ask the system, it also reads how many
//    cores sat idle right before and right after the measure. With fewer free than a browser
//    needs (minFreeCores), other work was running and the measure is not judged.
// 4. The measure is taken up to TRIES times, and no more once one found the machine busy: the
//    next would meet the same. A measure that may be judged and is within its limits passes. When every such measure is over a limit, the budget is missed: the code was
//    too slow each time the machine was steady and free. When no measure may be judged, nothing
//    is judged. The test passes and says that it judged nothing.
//
// Code that got slower is slower in every try, so it still fails. Other work on the machine
// would have to slow the code without showing in the calibration or the free cores, in every try.

/** One measure: times by name, in ms, with the state of the machine right before and right after it. */
export interface Try {
  values: Record<string, number>;
  /** The calibration time before and after, in ms. */
  before: number;
  after: number;
  /** Cores that sat idle before and after, of how many, where the test could ask the system. */
  free?: { before: number; after: number; cores: number };
}

export interface Judged {
  verdict: 'pass' | 'fail' | 'not judged';
  /** The limits were multiplied by this for the try that decided. 1 when nothing was judged. */
  scale: number;
  /** One line for the test output: every value against its limit, or why nothing was judged. */
  note: string;
}

/** The slower calibration of a try may be at most this many times the faster one. */
export const STEADY = 1.5;
/** How many times a measure is taken at most. */
export const TRIES = 3;

/**
 * A browser needs this many cores to itself for a timed load: four, or half of a machine with
 * fewer than eight. With fewer free, other work takes the page's core.
 */
export const minFreeCores = (cores: number): number => Math.min(4, cores / 2);

/**
 * Idle cores between two readings of the system's CPU counters (os.cpus()): the idle share of
 * all the time the cores spent, times the number of cores. All of them when no time passed.
 */
export function freeCores(
  before: { times: Record<string, number> }[],
  after: { times: Record<string, number> }[],
): number {
  let idle = 0;
  let all = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const a = before[i]!.times;
    const b = after[i]!.times;
    for (const k of Object.keys(b)) {
      const d = Math.max(0, (b[k] ?? 0) - (a[k] ?? 0));
      all += d;
      if (k === 'idle') idle += d;
    }
  }
  return all > 0 ? (idle / all) * after.length : after.length;
}

/** How much slower than the reference the machine ran around this try. Never below 1. */
export const scaleOf = (t: Try, ref: number): number => Math.max(1, Math.max(t.before, t.after) / ref);

/** The machine kept its pace over the measure. */
export const isSteady = (t: Try): boolean =>
  t.before > 0 && t.after > 0 && Math.max(t.before, t.after) <= Math.min(t.before, t.after) * STEADY;

/** Other work was running beside the measure, as far as the test could tell. */
export const isBusy = (t: Try): boolean =>
  !!t.free && Math.min(t.free.before, t.free.after) < minFreeCores(t.free.cores);

/** The largest value over limit ratio of a try. At most 1 when every value is within its limit. */
function worst(t: Try, budgets: Record<string, number>, ref: number): number {
  const scale = scaleOf(t, ref);
  let w = 0;
  for (const [name, ms] of Object.entries(budgets)) {
    const v = t.values[name];
    // A measure that is missing is over any limit.
    w = Math.max(w, v === undefined || Number.isNaN(v) ? Number.POSITIVE_INFINITY : v / (ms * scale));
  }
  return w;
}

const r1 = (x: number): string => (Math.round(x * 10) / 10).toString();

function line(t: Try, budgets: Record<string, number>, ref: number): string {
  const scale = scaleOf(t, ref);
  const parts = Object.entries(budgets).map(
    ([name, ms]) => `${name} ${r1(t.values[name] ?? Number.NaN)} ms of ${r1(ms * scale)}`,
  );
  return `${parts.join(', ')} (machine ${r1(scale)} times the reference)`;
}

/** Why a try may not be judged. */
function why(t: Try): string {
  if (isBusy(t)) {
    const f = t.free!;
    return `other work was running: ${r1(Math.min(f.before, f.after))} of ${f.cores} cores free`;
  }
  return `the machine changed pace: calibration ${r1(t.before)} then ${r1(t.after)} ms`;
}

/**
 * The verdict over the tries taken so far. `budgets` are the limits by name in ms on the
 * reference machine, and `ref` is the calibration time there.
 */
export function judge(tries: Try[], budgets: Record<string, number>, ref: number): Judged {
  const good = tries.filter((t) => isSteady(t) && !isBusy(t));
  if (!good.length) {
    const n = tries.length;
    return {
      verdict: 'not judged',
      scale: 1,
      note: `not judged in ${n === 1 ? 'the one measure' : `any of ${n} measures`} (${tries.map(why).join('; ') || 'none taken'})`,
    };
  }
  let best = good[0]!;
  for (const t of good) if (worst(t, budgets, ref) < worst(best, budgets, ref)) best = t;
  const ok = worst(best, budgets, ref) < 1;
  const count = good.length === 1 ? 'the one measure judged' : `the best of ${good.length} measures judged`;
  return {
    verdict: ok ? 'pass' : 'fail',
    scale: scaleOf(best, ref),
    note: ok ? line(best, budgets, ref) : `over budget in ${count}: ${line(best, budgets, ref)}`,
  };
}
