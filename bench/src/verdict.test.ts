import { describe, expect, test } from 'vitest';
import { causedByInk, verdict } from './verdict.ts';

describe('the long task budget', () => {
  test("a long task made long by the page's own work passes", () => {
    const t = { ms: 69.4, inkMs: 7.4 };
    expect(causedByInk(t)).toBe(false);
    const v = verdict([{ ink: [[t, { ms: 30, inkMs: 4 }]], plain: [72.5] }]);
    expect(v.caused).toEqual([]);
    expect(v.long).toEqual([t]);
    expect(v.pass).toBe(true);
  });

  test('ink that pushes a task over 50 ms fails', () => {
    const t = { ms: 58, inkMs: 12 };
    expect(causedByInk(t)).toBe(true);
    expect(verdict([{ ink: [[t]], plain: [60] }]).pass).toBe(false);
    // Ink alone over 50 ms is caused by ink, whatever the page did.
    expect(causedByInk({ ms: 120, inkMs: 55 })).toBe(true);
  });

  test("an ink part over one frame fails, even inside the page's own long task", () => {
    const t = { ms: 90, inkMs: 17 };
    expect(causedByInk(t)).toBe(false);
    const v = verdict([{ ink: [[t]], plain: [80] }]);
    expect(v.overFrame).toEqual([t]);
    expect(v.maxInkMs).toBe(17);
    expect(v.pass).toBe(false);
  });

  test('long tasks only with the extension fail: then the ink made them', () => {
    const t = { ms: 66, inkMs: 7 };
    const v = verdict([{ ink: [[t]], plain: [44, 41, 48] }]);
    expect(v.caused).toEqual([]);
    expect(v.onlyWithInk).toEqual([66]);
    expect(v.pass).toBe(false);

    // Each arm is judged on its own page loads.
    expect(
      verdict([
        { ink: [[t]], plain: [70] },
        { ink: [[{ ms: 40, inkMs: 4 }]], plain: [40] },
      ]).pass,
    ).toBe(true);
  });
});

describe('limits a quick run judges with', () => {
  // The two tasks a 2-core runner about three times slower than the reference machine reported.
  const slow = [
    { ms: 59.4, inkMs: 56.1 },
    { ms: 53.8, inkMs: 6.4 },
  ];

  test('at the published limits both tasks count', () => {
    expect(verdict([{ ink: [slow], plain: [92.5] }]).caused).toEqual(slow);
  });

  test('a machine not fit to judge fixed times judges neither limit', () => {
    const none = { longMs: Number.POSITIVE_INFINITY, frameMs: Number.POSITIVE_INFINITY };
    const v = verdict([{ ink: [slow], plain: [92.5] }], none);
    expect(v.caused).toEqual([]);
    expect(v.overFrame).toEqual([]);
  });

  test('a fit machine judges both at the scaled limits', () => {
    // At 1.2 times: a long task is over 60 ms, a frame of ink is over 20 ms.
    const made = { ms: 75, inkMs: 30 };
    const v = verdict([{ ink: [slow, [made, { ms: 58, inkMs: 12 }]], plain: [40] }], {
      longMs: 60,
      frameMs: 20,
    });
    expect(v.caused).toEqual([made]);
    expect(v.overFrame).toEqual([slow[0], made]);
  });
});
