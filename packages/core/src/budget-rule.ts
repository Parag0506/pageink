// How a time budget is judged in a test (withinBudget in testkit.ts). No browser needed, so
// the rule has unit tests of its own.
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
// 3. The measure is taken up to TRIES times. A steady measure within its limits passes. When
//    every steady measure is over a limit, the budget is missed: the code was too slow each
//    time the machine was steady. When no measure was steady, nothing is judged. The test
//    passes and says that it judged nothing.
//
// Code that got slower is slower in every try, so it still fails. Other work on the machine
// would have to slow the code without slowing the calibration beside it, in every try.

/** One measure: times by name, in ms, with the calibration time right before and right after it. */
export interface Try {
  values: Record<string, number>;
  before: number;
  after: number;
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

/** How much slower than the reference the machine ran around this try. Never below 1. */
export const scaleOf = (t: Try, ref: number): number => Math.max(1, Math.max(t.before, t.after) / ref);

export const isSteady = (t: Try): boolean =>
  t.before > 0 && t.after > 0 && Math.max(t.before, t.after) <= Math.min(t.before, t.after) * STEADY;

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

/**
 * The verdict over the tries taken so far. `budgets` are the limits by name in ms on the
 * reference machine, and `ref` is the calibration time there.
 */
export function judge(tries: Try[], budgets: Record<string, number>, ref: number): Judged {
  const steady = tries.filter(isSteady);
  if (!steady.length) {
    const seen = tries.map((t) => `${r1(t.before)} then ${r1(t.after)} ms`).join('; ');
    return {
      verdict: 'not judged',
      scale: 1,
      note: `not judged: the machine changed pace during ${tries.length === 1 ? 'the measure' : `each of ${tries.length} measures`} (calibration ${seen || 'not taken'})`,
    };
  }
  let best = steady[0]!;
  for (const t of steady) if (worst(t, budgets, ref) < worst(best, budgets, ref)) best = t;
  const ok = worst(best, budgets, ref) < 1;
  const count =
    steady.length === 1 ? 'the one steady measure' : `the best of ${steady.length} steady measures`;
  return {
    verdict: ok ? 'pass' : 'fail',
    scale: scaleOf(best, ref),
    note: ok ? line(best, budgets, ref) : `over budget in ${count}: ${line(best, budgets, ref)}`,
  };
}
