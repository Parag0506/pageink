import { describe, expect, test } from 'vitest';
import {
  armOf,
  BOUNDS,
  fitness,
  groupsOf,
  heldBack,
  judgeLimit,
  judgeOften,
  judgeRepeated,
  moreOften,
  moreOftenP,
  slowerThanControl,
  splitOf,
} from './judge.ts';

const ref = { calibrateMs: 30, cores: 11 };

describe('the machine', () => {
  test('a machine like the reference judges fixed limits, scaled by how much slower it is', () => {
    const f = fitness({ calibrateMs: 36, cores: 4 }, ref);
    expect(f.fit).toBe(true);
    expect(f.scale).toBe(1.2);
    const ok = judgeLimit('extension main-thread time', 5.5, 5, f, (v, l) => v >= l);
    expect(ok.raw).toBe('fail');
    expect(ok.judgedLimit).toBe(6);
    expect(ok.verdict).toBe('pass');
    expect(judgeLimit('ink part of one task', 30, 16.7, f).verdict).toBe('fail');
  });

  test('a faster machine is never judged more loosely than the reference', () => {
    const f = fitness({ calibrateMs: 20, cores: 8 }, ref);
    expect(f.fit).toBe(true);
    expect(f.scale).toBe(1);
    expect(judgeLimit('visible', 51, 50, f).verdict).toBe('fail');
  });

  test('only a machine close to the reference is fit: the calibration work understates a slow one', () => {
    expect(BOUNDS.maxRatio).toBe(1.25);
    expect(fitness({ calibrateMs: 37.5, cores: 4 }, ref).fit).toBe(true);
    // Like GitHub's 2-core runner at its best, with four cores: 1.4 times slower at the calibration work.
    const f = fitness({ calibrateMs: 42, cores: 4 }, ref);
    expect(f.fit).toBe(false);
    expect(f.reason).toContain('1.4 times slower');
    expect(judgeLimit('visible', 60, 50, f).verdict).toBe('not judged');
  });

  test('a machine much slower than the reference does not judge fixed limits', () => {
    const f = fitness({ calibrateMs: 90, cores: 8 }, ref);
    expect(f.fit).toBe(false);
    expect(f.reason).toContain('3 times slower');
    const j = judgeLimit('visible', 120, 50, f);
    expect(j.verdict).toBe('not judged');
    expect(j.raw).toBe('fail');
    expect(j.value).toBe(120);
    expect(j.reason).toBe(f.reason);
  });

  test('a machine with another operating system does not judge fixed limits, however close its speed', () => {
    const mac = { ...ref, platform: 'darwin' };
    // GitHub's 4-core Linux runner on a good day: within the speed bound, with enough cores.
    const f = fitness({ calibrateMs: 33, cores: 4, platform: 'linux' }, mac);
    expect(f.fit).toBe(false);
    expect(f.reason).toContain('linux');
    expect(f.reason).toContain('darwin');
    expect(judgeLimit('first paint held back', 22.9, 16.7, f).verdict).toBe('not judged');
    // The same system is judged as before, and so is a reference stored before the system was.
    expect(fitness({ calibrateMs: 33, cores: 4, platform: 'darwin' }, mac).fit).toBe(true);
    expect(fitness({ calibrateMs: 33, cores: 4, platform: 'linux' }, ref).fit).toBe(true);
  });

  test('a 2-core machine does not judge fixed limits, however fast its core', () => {
    const f = fitness({ calibrateMs: 30, cores: 2 }, ref);
    expect(f.fit).toBe(false);
    expect(f.reason).toContain('2 cores');
    expect(judgeLimit('stub', 11, 5, f).verdict).toBe('not judged');
  });

  test('without a reference measurement nothing fixed is judged', () => {
    const f = fitness({ calibrateMs: 30, cores: 8 }, null);
    expect(f.fit).toBe(false);
    expect(judgeLimit('stub', 1, 5, f).verdict).toBe('not judged');
  });
});

describe('against the control extension', () => {
  test('slower beyond the noise in both runs counts, on any machine', () => {
    expect(slowerThanControl({ delta: 40, beyondNoise: true }, { delta: 35, beyondNoise: true })).toBe(true);
  });

  test('a difference that does not repeat, is within noise or is faster does not count', () => {
    expect(slowerThanControl({ delta: 40, beyondNoise: true }, { delta: 10, beyondNoise: false })).toBe(
      false,
    );
    expect(slowerThanControl({ delta: 40, beyondNoise: true }, null)).toBe(false);
    expect(slowerThanControl({ delta: 12, beyondNoise: false }, { delta: 12, beyondNoise: false })).toBe(
      false,
    );
    expect(slowerThanControl({ delta: -40, beyondNoise: true }, { delta: -40, beyondNoise: true })).toBe(
      false,
    );
  });
});

describe('first paint held back by the extension', () => {
  test('one way of painting in each arm: the median of the differences within pairs, and their spread as noise', () => {
    // Both arms get slower over the run; the pairs take that drift out.
    const h = heldBack([30, 33, 36, 39, 42], [20, 23, 26, 29, 32]);
    expect(h.basis).toBe('pairs');
    expect(h.delta).toBe(10);
    expect(h.noise).toBe(0);
    expect(h.with.groups).toHaveLength(1);
    expect(Math.max(h.with.iqr, h.alone.iqr)).toBe(6);
  });

  test('a failed load leaves its pair out; with fewer than three pairs the medians are compared', () => {
    expect(heldBack([30, null, 32, 33], [20, 21, null, 23]).basis).toBe('medians');
    const h = heldBack([30, null, 32, 33, 34], [20, 21, 22, 23, 24]);
    expect(h.basis).toBe('pairs');
    expect(h.delta).toBe(10);
  });

  test('loads more than a frame apart form groups; a lone outlier is reported but does not split the arm', () => {
    expect(groupsOf([50, 52, 100, 101, 98]).map((g) => g.n)).toEqual([2, 3]);
    const lone = armOf([20, 21, 22, 23, 24, 25, 26, 90]);
    expect(lone.groups).toHaveLength(2);
    expect(splitOf(lone)).toBeNull();
    expect(heldBack([30, 31, 32, 33, 34, 35, 36, 37], [20, 21, 22, 23, 24, 25, 26, 90]).basis).toBe('pairs');
    // Two loads of eight slowed by the machine are not a second way of painting: the pairs take them out.
    const h = heldBack([30, 31, 85, 33, 34, 84, 36, 37], [20, 21, 22, 23, 24, 25, 26, 27]);
    expect(h.basis).toBe('pairs');
    expect(h.delta).toBe(10);
  });

  test('the page alone paints in two ways: the extension is judged against each, the fast one counts', () => {
    // As on the stress page: the page alone sometimes merges two parse chunks into one late update.
    const alone = [47, 50, 55, 63, 95, 100, 104, 110, 118];
    const h = heldBack([60, 61, 62, 63, 64], alone);
    expect(h.alone.groups.map((g) => g.n)).toEqual([4, 5]);
    expect(h.delta).toBe(9.5);
    expect(h.basis).toContain('group of 4 loads');
    // The median across both groups would have hidden it: the extension looks faster than the page alone.
    expect(h.with.median - h.alone.median).toBeLessThan(0);
  });

  test('both arms paint in two ways: groups of the same rank are compared, and the worse pair counts', () => {
    const h = heldBack([40, 42, 44, 90, 92, 94], [30, 31, 32, 85, 86, 87]);
    expect(h.delta).toBe(11);
    expect(h.noise).toBeGreaterThan(0);
    expect(h.noise).toBeLessThan(5);
  });

  test('only the extension paints in two ways: its slow group counts', () => {
    const h = heldBack([20, 21, 22, 60, 61, 62], [18, 19, 20, 21]);
    expect(h.delta).toBe(41.5);
  });
});

describe('a fixed limit measured again in a quick run', () => {
  const fit = fitness({ calibrateMs: 30, cores: 8 }, ref);

  test('within the judged limit the first time: passes, nothing measured again', () => {
    const j = judgeRepeated('held back', 12, null, 16.7, fit);
    expect(j.verdict).toBe('pass');
    expect(j.notRepeated).toBe(false);
    expect(j.second).toBeNull();
  });

  test('over the judged limit twice: fails, with both figures', () => {
    const j = judgeRepeated('held back', 18.3, 17.9, 16.7, fit);
    expect(j.verdict).toBe('fail');
    expect(j.value).toBe(18.3);
    expect(j.second).toBe(17.9);
  });

  test('over once and not again: passes, marked as not repeated, with both figures', () => {
    const j = judgeRepeated('held back', 17.8, 12.4, 16.7, fit);
    expect(j.verdict).toBe('pass');
    expect(j.raw).toBe('fail');
    expect(j.notRepeated).toBe(true);
    expect(j.second).toBe(12.4);
  });

  test('the second figure is judged against the scaled limit too', () => {
    const slower = fitness({ calibrateMs: 36, cores: 8 }, ref);
    expect(judgeRepeated('held back', 21, 19.5, 16.7, slower).verdict).toBe('pass');
    expect(judgeRepeated('held back', 21, 20.5, 16.7, slower).verdict).toBe('fail');
  });

  test('a machine not fit to judge neither fails nor measures again', () => {
    const unfit = fitness({ calibrateMs: 30, cores: 2 }, ref);
    const j = judgeRepeated('held back', 40, null, 16.7, unfit);
    expect(j.verdict).toBe('not judged');
    expect(j.notRepeated).toBe(false);
  });
});

describe('how often a long task occurs, with the extension against without', () => {
  const c = (long: number, loads: number) => ({ long, loads });

  test('the chance of a difference as large as the one seen, were long tasks as common in both arms', () => {
    // Six of six against one of six: about 8 in a thousand.
    expect(moreOftenP(c(6, 6), c(1, 6))).toBeCloseTo(6 / 792, 6);
    expect(moreOftenP(c(3, 20), c(3, 20))).toBeGreaterThan(0.5);
    expect(moreOftenP(c(0, 20), c(5, 20))).toBe(1);
    expect(moreOftenP(c(20, 20), c(5, 20))).toBeLessThan(1e-6);
  });

  test('four long loads of six with the extension against one of six without is within chance', () => {
    // As in a full run that judged three loads against three: it cannot tell.
    expect(moreOftenP(c(4, 6), c(1, 6))).toBeCloseTo(96 / 792, 6);
    expect(moreOften({ ext: c(4, 6), plain: c(1, 6), control: c(1, 6) })).toBe(false);
  });

  test('more often than the page alone but not than any extension does not count', () => {
    expect(moreOften({ ext: c(15, 20), plain: c(3, 20), control: c(12, 20) })).toBe(false);
    expect(moreOften({ ext: c(15, 20), plain: c(3, 20), control: c(3, 20) })).toBe(true);
  });

  test('the do-nothing extension is the baseline, not the page alone, which a loaded machine makes long often', () => {
    // A 40 ms busy loop in the extension's first script, on a loaded machine: every load long.
    expect(moreOften({ ext: c(10, 10), plain: c(7, 10), control: c(2, 10) })).toBe(true);
  });

  test('more often counts only when a second measure from scratch shows it too', () => {
    const real = { ext: c(18, 20), plain: c(4, 20), control: c(5, 20) };
    const none = { ext: c(6, 20), plain: c(5, 20), control: c(5, 20) };
    expect(judgeOften(none, null)).toBe('pass');
    expect(judgeOften(real, real)).toBe('fail');
    expect(judgeOften(real, none)).toBe('not repeated');
    expect(judgeOften(real, null)).toBe('not repeated');
  });

  test('how often is a count over a fixed time: a machine not fit to judge reports it only', () => {
    // GitHub's 4-core Linux runner: the page alone ran its first update in 37 to 47 ms, and ink
    // drawn in the same frame put 4 of 6 loads over 50 ms, twice.
    const runner = { ext: c(4, 6), plain: c(0, 6), control: c(0, 6) };
    expect(moreOften(runner)).toBe(true);
    expect(judgeOften(runner, runner)).toBe('fail');
    expect(judgeOften(runner, runner, false)).toBe('not judged');
    expect(judgeOften(runner, null, false)).toBe('not judged');
  });
});
