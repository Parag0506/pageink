import { describe, expect, test } from 'vitest';
import {
  firstUse,
  markRate,
  noteFirst,
  RATE_DAYS,
  RATE_KEY,
  RATE_PAGES,
  type RateState,
  rateDue,
  readRate,
  usage,
} from './rate';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 26, 12);

/** A storage area in memory, with the two calls the code uses. */
function area(init: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: async (k: string) => (k in data ? { [k]: data[k] } : {}),
    set: async (o: Record<string, unknown>) => void Object.assign(data, o),
  } as unknown as chrome.storage.StorageArea & { data: Record<string, unknown> };
}

describe('rateDue', () => {
  const due = (pages: number, ageDays: number | undefined, st: RateState = {}) =>
    rateDue({ pages, oldest: ageDays === undefined ? undefined : NOW - ageDays * DAY, st, now: NOW });

  test('the rule is five pages and three days', () => {
    expect(RATE_PAGES).toBe(5);
    expect(RATE_DAYS).toBe(3);
  });

  test('shows with ink on five pages and three days of use', () => {
    expect(due(5, 3)).toBe(true);
    expect(due(40, 90)).toBe(true);
  });

  test('waits for the fifth page', () => {
    expect(due(4, 30)).toBe(false);
    expect(due(0, 30)).toBe(false);
  });

  test('waits until three days have passed', () => {
    expect(due(10, 2.99)).toBe(false);
    expect(due(10, 0)).toBe(false);
  });

  test('takes the earlier of the stored first use and the oldest page', () => {
    // Pages all changed today, but this browser saw ink four days ago.
    expect(due(6, 0, { first: NOW - 4 * DAY })).toBe(true);
    // A first use stored today does not hide older pages.
    expect(due(6, 5, { first: NOW })).toBe(true);
  });

  test('never shows again after either answer', () => {
    expect(due(50, 50, { done: 'rated' })).toBe(false);
    expect(due(50, 50, { done: 'declined' })).toBe(false);
  });

  test('does not show without any time to go by, or with a first use in the future', () => {
    expect(due(9, undefined)).toBe(false);
    expect(due(9, -10)).toBe(false);
    expect(due(9, undefined, { first: NOW + DAY })).toBe(false);
  });
});

test('firstUse ignores missing and zero times', () => {
  expect(firstUse({})).toBeUndefined();
  expect(firstUse({}, 0)).toBeUndefined();
  expect(firstUse({ first: 5 }, 9)).toBe(5);
  expect(firstUse({ first: 9 }, 5)).toBe(5);
});

test('usage counts pages with notes and the oldest change among them', () => {
  expect(usage([])).toEqual({ pages: 0 });
  expect(
    usage([
      { notes: 2, updatedAt: 300 },
      { notes: 0, updatedAt: 100 },
      { notes: 1, updatedAt: 200 },
      { notes: 1, updatedAt: 0 },
    ]),
  ).toEqual({ pages: 3, oldest: 200 });
});

describe('storage', () => {
  test('reads nothing as an empty state, and drops bad values', async () => {
    expect(await readRate(area())).toEqual({});
    expect(await readRate(area({ [RATE_KEY]: 'x' }))).toEqual({});
    expect(await readRate(area({ [RATE_KEY]: { first: -1, done: 'maybe' } }))).toEqual({});
  });

  test('the first use is written once', async () => {
    const a = area();
    expect(await noteFirst(a, 1000)).toEqual({ first: 1000 });
    expect(await noteFirst(a, 2000)).toEqual({ first: 1000 });
    expect(a.data[RATE_KEY]).toEqual({ first: 1000 });
  });

  test('an answer is kept with the first use', async () => {
    const a = area({ [RATE_KEY]: { first: 1000 } });
    await markRate(a, 'declined');
    expect(await readRate(a)).toEqual({ first: 1000, done: 'declined' });
    await markRate(a, 'rated');
    expect(await readRate(a)).toEqual({ first: 1000, done: 'rated' });
  });

  test('only the rate key is written', async () => {
    const a = area();
    await noteFirst(a, 1);
    await markRate(a, 'rated');
    expect(Object.keys(a.data)).toEqual([RATE_KEY]);
  });
});
