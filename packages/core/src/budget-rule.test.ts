import { describe, expect, it } from 'vitest';
import { freeCores, isBusy, isSteady, judge, minFreeCores, STEADY, scaleOf, type Try } from './budget-rule';

const REF = 30;
const BUDGET = { work: 50 };
const tryOf = (work: number, before = REF, after = REF): Try => ({ values: { work }, before, after });
/** A try on an 11-core machine with this many cores free before and after. */
const withFree = (t: Try, before: number, after = before): Try => ({
  ...t,
  free: { before, after, cores: 11 },
});

describe('a time budget', () => {
  it('passes a measure within the budget on a machine like the reference', () => {
    const j = judge([tryOf(40)], BUDGET, REF);
    expect(j.verdict).toBe('pass');
    expect(j.scale).toBe(1);
    expect(j.note).toContain('work 40 ms of 50');
  });

  it('fails a measure at or over the budget', () => {
    expect(judge([tryOf(50)], BUDGET, REF).verdict).toBe('fail');
    expect(judge([tryOf(80)], BUDGET, REF).verdict).toBe('fail');
  });

  it('never makes the limit smaller on a machine faster than the reference', () => {
    expect(scaleOf(tryOf(0, 10, 10), REF)).toBe(1);
    expect(judge([tryOf(49, 10, 10)], BUDGET, REF).verdict).toBe('pass');
    expect(judge([tryOf(51, 10, 10)], BUDGET, REF).verdict).toBe('fail');
  });

  it('judges a machine that is slow for the whole run against a larger limit', () => {
    // Three times slower before and after: the limit is 150.
    expect(judge([tryOf(140, 90, 90)], BUDGET, REF)).toMatchObject({ verdict: 'pass', scale: 3 });
    expect(judge([tryOf(160, 90, 90)], BUDGET, REF).verdict).toBe('fail');
  });

  it('takes the slower of the two calibrations for the limit', () => {
    expect(scaleOf(tryOf(0, 30, 42), REF)).toBeCloseTo(1.4);
    expect(scaleOf(tryOf(0, 42, 30), REF)).toBeCloseTo(1.4);
  });

  it('does not judge a measure taken while the machine changed pace', () => {
    expect(isSteady(tryOf(0, 30, 30 * STEADY))).toBe(true);
    expect(isSteady(tryOf(0, 30, 30 * STEADY + 1))).toBe(false);
    expect(isSteady(tryOf(0, 100, 30))).toBe(false);
    // Far over the budget, but load came during the measure: it says nothing about the code.
    const j = judge([tryOf(500, 30, 200)], BUDGET, REF);
    expect(j.verdict).toBe('not judged');
    expect(j.note).toContain('calibration 30 then 200 ms');
  });

  it('does not judge a measure taken while other work had the cores', () => {
    expect(minFreeCores(11)).toBe(4);
    expect(minFreeCores(4)).toBe(2);
    expect(minFreeCores(2)).toBe(1);
    expect(isBusy(tryOf(0))).toBe(false);
    expect(isBusy(withFree(tryOf(0), 9.5))).toBe(false);
    expect(isBusy(withFree(tryOf(0), 4))).toBe(false);
    expect(isBusy(withFree(tryOf(0), 9, 3.9))).toBe(true);
    expect(isBusy(withFree(tryOf(0), 0.3, 10))).toBe(true);
    // The calibration is steady and close to the reference, as it is on a busy machine, and the
    // measure is far over: only the free cores tell that it was the machine.
    const j = judge([withFree(tryOf(140, 33, 35), 0.4)], BUDGET, REF);
    expect(j.verdict).toBe('not judged');
    expect(j.note).toContain('other work was running: 0.4 of 11 cores free');
    // The same measure on a free machine is the code's own and fails.
    expect(judge([withFree(tryOf(140, 33, 35), 9)], BUDGET, REF).verdict).toBe('fail');
  });

  it('passes when one measure that may be judged is within the budget, whatever the others say', () => {
    const tries = [tryOf(500, 30, 200), tryOf(90), withFree(tryOf(300), 1), tryOf(40)];
    expect(judge(tries, BUDGET, REF).verdict).toBe('pass');
    // The order does not matter.
    expect(judge([...tries].reverse(), BUDGET, REF).verdict).toBe('pass');
  });

  it('fails slower code: over the budget every time the machine was steady and free', () => {
    const j = judge([tryOf(90), tryOf(500, 30, 200), withFree(tryOf(70), 9)], BUDGET, REF);
    expect(j.verdict).toBe('fail');
    // It reports the best measure judged.
    expect(j.note).toContain('best of 2 measures judged');
    expect(j.note).toContain('work 70 ms of 50');
  });

  it('judges nothing when no measure may be judged, and says why for each', () => {
    const j = judge([tryOf(500, 30, 200), withFree(tryOf(40), 2), tryOf(40, 0, 30)], BUDGET, REF);
    expect(j.verdict).toBe('not judged');
    expect(j.note).toContain('any of 3 measures');
    expect(j.note).toContain('calibration 30 then 200 ms');
    expect(j.note).toContain('2 of 11 cores free');
  });

  it('needs every named time within its own limit', () => {
    const budgets = { build: 60, resolve: 32 };
    const t = (build: number, resolve: number): Try => ({
      values: { build, resolve },
      before: REF,
      after: REF,
    });
    expect(judge([t(10, 5)], budgets, REF).verdict).toBe('pass');
    expect(judge([t(10, 40)], budgets, REF).verdict).toBe('fail');
    expect(judge([t(70, 5)], budgets, REF).verdict).toBe('fail');
    // One try good in one time and one good in the other do not add up to a pass.
    expect(judge([t(10, 40), t(70, 5)], budgets, REF).verdict).toBe('fail');
  });

  it('counts a time that was not measured as over its limit', () => {
    const j = judge([{ values: {}, before: REF, after: REF }], BUDGET, REF);
    expect(j.verdict).toBe('fail');
  });
});

describe('free cores', () => {
  const at = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });

  it('are the idle share of the time the cores spent between two readings', () => {
    // Four cores over one second: two fully busy, one half busy, one idle.
    const before = [at(0, 0), at(0, 0), at(0, 0), at(0, 0)];
    const after = [at(1000, 0), at(1000, 0), at(500, 500), at(0, 1000)];
    expect(freeCores(before, after)).toBeCloseTo(1.5);
  });

  it('are all the cores when the counters did not move', () => {
    const now = [at(5, 5), at(7, 3)];
    expect(freeCores(now, now)).toBe(2);
  });
});
