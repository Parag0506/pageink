import { describe, expect, it } from 'vitest';
import { isSteady, judge, STEADY, scaleOf, type Try } from './budget-rule';

const REF = 30;
const BUDGET = { work: 50 };
const tryOf = (work: number, before = REF, after = REF): Try => ({ values: { work }, before, after });

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
    expect(j.note).toContain('30 then 200 ms');
  });

  it('passes when one steady measure is within the budget, whatever the others say', () => {
    const tries = [tryOf(500, 30, 200), tryOf(90), tryOf(40)];
    expect(judge(tries, BUDGET, REF).verdict).toBe('pass');
    // The order does not matter.
    expect(judge([...tries].reverse(), BUDGET, REF).verdict).toBe('pass');
  });

  it('fails slower code: over the budget every time the machine was steady', () => {
    const j = judge([tryOf(90), tryOf(500, 30, 200), tryOf(70)], BUDGET, REF);
    expect(j.verdict).toBe('fail');
    // It reports the best steady measure.
    expect(j.note).toContain('best of 2 steady measures');
    expect(j.note).toContain('work 70 ms of 50');
  });

  it('judges nothing when no measure was steady, and says so', () => {
    const j = judge([tryOf(500, 30, 200), tryOf(40, 200, 30), tryOf(40, 0, 30)], BUDGET, REF);
    expect(j.verdict).toBe('not judged');
    expect(j.note).toContain('each of 3 measures');
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
