// The budget "no long task over 50 ms caused by ink, 200 notes" (DESIGN 11), as a rule over the
// tasks of traced loads. A task that ran ink script has a length and an ink part: time inside the
// extension's calls, layout they forced included. The rest is the page's own work.

export interface InkTask {
  /** Task length, ms. */
  ms: number;
  /** Time inside the extension's calls, layout they forced included, ms. */
  inkMs: number;
}

export interface Limits {
  /** A task longer than this is a long task. */
  longMs: number;
  /** The ink part of any one task may be at most this: one frame. */
  frameMs: number;
}

export const LIMITS: Limits = { longMs: 50, frameMs: 16.7 };

/**
 * True when ink caused a long task: the task is over the limit and would have been within it
 * without its ink part, or its ink part alone is over the limit. A long task made long by the
 * page's own work does not count here; the frame rule below still bounds the ink inside it.
 */
export function causedByInk(t: InkTask, l: Limits = LIMITS): boolean {
  if (t.inkMs > l.longMs) return true;
  return t.ms > l.longMs && t.ms - t.inkMs <= l.longMs;
}

export interface Arm {
  /** Tasks that ran ink script, per load, on the page with the extension. */
  ink: InkTask[][];
  /** The longest main-thread task of each load of the same page without the extension, ms. */
  plain: number[];
}

export interface Verdict {
  /** Tasks over the limit that ink caused. */
  caused: InkTask[];
  /** The largest ink part of any one task, ms. */
  maxInkMs: number;
  /** Tasks whose ink part is over one frame. */
  overFrame: InkTask[];
  /** Tasks with ink script over the limit, caused or not. */
  long: InkTask[];
  /**
   * Long tasks that ran ink script, in an arm where the page without the extension never had a
   * task over the limit. Then the ink made them long after all, if only by moving the page's own
   * work. Lengths in ms. Tasks with no ink script in them are published beside, not judged here:
   * the browser runs long tasks of its own in the page with or without the extension.
   */
  onlyWithInk: number[];
  pass: boolean;
}

export function verdict(arms: Arm[], l: Limits = LIMITS): Verdict {
  const all = arms.flatMap((a) => a.ink.flat());
  const caused = all.filter((t) => causedByInk(t, l));
  const overFrame = all.filter((t) => t.inkMs > l.frameMs);
  const long = all.filter((t) => t.ms > l.longMs);
  const onlyWithInk = arms.flatMap((a) =>
    a.plain.some((ms) => ms > l.longMs)
      ? []
      : a.ink
          .flat()
          .map((t) => t.ms)
          .filter((ms) => ms > l.longMs),
  );
  return {
    caused,
    maxInkMs: Math.max(0, ...all.map((t) => t.inkMs)),
    overFrame,
    long,
    onlyWithInk,
    pass: caused.length === 0 && overFrame.length === 0 && onlyWithInk.length === 0,
  };
}
