import { expect, test } from 'vitest';
import { RATE_KEY } from '../rate';
import { RATE_TEXT, type RateDeps, type RateView, showRate } from './rate';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 26, 12);
const URL_ = 'https://store.example/pageink/reviews';

function view(): RateView {
  document.body.innerHTML = `
    <p id="rate" hidden><span id="rate-text"></span>
      <button id="rate-go" type="button">Rate</button><button id="rate-no" type="button">No thanks</button></p>
    <p id="about" hidden><button id="rate-link" type="button">Rate</button></p>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  return {
    line: $('rate'),
    text: $('rate-text'),
    go: $('rate-go'),
    no: $('rate-no'),
    link: $('rate-link'),
    foot: $('about'),
  };
}

function setup(
  o: {
    pages?: number;
    age?: number;
    state?: object;
    url?: string;
    busy?: boolean;
    /** Make the storage read or write reject. */
    fail?: { get?: boolean; set?: boolean };
  } = {},
) {
  const data: Record<string, unknown> = o.state ? { [RATE_KEY]: o.state } : {};
  const opened: string[] = [];
  let closed = 0;
  let listed = 0;
  const deps: RateDeps = {
    area: {
      get: async (k: string) => {
        if (o.fail?.get) throw new Error('storage read failed');
        return k in data ? { [k]: data[k] } : {};
      },
      set: async (x: Record<string, unknown>) => {
        if (o.fail?.set) throw new Error('storage write failed');
        Object.assign(data, x);
      },
    } as unknown as RateDeps['area'],
    url: o.url ?? URL_,
    pages: async () => {
      listed++;
      return Array.from({ length: o.pages ?? 5 }, () => ({ notes: 1, updatedAt: NOW - (o.age ?? 4) * DAY }));
    },
    open: async (u) => void opened.push(u),
    close: () => void closed++,
    busy: () => !!o.busy,
    now: () => NOW,
  };
  return { deps, data, opened, closed: () => closed, listed: () => listed };
}

test('the line shows when the rule is met, with plain words', async () => {
  const v = view();
  const s = setup();
  expect(await showRate(v, s.deps)).toBe(true);
  expect(v.line.hidden).toBe(false);
  // The line holds the link while it shows.
  expect(v.foot.hidden).toBe(true);
  expect(v.text.textContent).toBe(RATE_TEXT);
  expect(RATE_TEXT).toBe('Using PageInk a lot? A rating helps other people find it.');
  expect(RATE_TEXT).not.toMatch(/[!—]/);
});

test('the line stays hidden before the rule is met, and the plain link is still there', async () => {
  for (const o of [{ pages: 4 }, { age: 1 }, { pages: 0 }]) {
    const v = view();
    expect(await showRate(v, setup(o).deps)).toBe(false);
    expect(v.line.hidden).toBe(true);
    expect(v.foot.hidden).toBe(false);
  }
});

test('the first page with ink starts the clock', async () => {
  const s = setup({ pages: 1, age: 0 });
  await showRate(view(), s.deps);
  expect(s.data[RATE_KEY]).toEqual({ first: NOW });
});

test('the line waits while the popup asks something else', async () => {
  const v = view();
  expect(await showRate(v, setup({ busy: true }).deps)).toBe(false);
  expect(v.line.hidden).toBe(true);
});

test('No thanks hides the line for good', async () => {
  const v = view();
  const s = setup();
  await showRate(v, s.deps);
  v.no.click();
  expect(v.line.hidden).toBe(true);
  expect(v.foot.hidden).toBe(false);
  await expect.poll(() => (s.data[RATE_KEY] as { done?: string }).done).toBe('declined');
  expect(s.opened).toEqual([]);
  // The next opening of the popup shows no line, and does not even read the pages.
  const again = view();
  const before = s.listed();
  expect(await showRate(again, s.deps)).toBe(false);
  expect(again.line.hidden).toBe(true);
  expect(again.foot.hidden).toBe(false);
  expect(s.listed()).toBe(before);
});

test('Rate opens the store page in a new tab and hides the line for good', async () => {
  const v = view();
  const s = setup();
  await showRate(v, s.deps);
  v.go.click();
  await expect.poll(() => s.opened).toEqual([URL_]);
  expect((s.data[RATE_KEY] as { done?: string }).done).toBe('rated');
  expect(s.closed()).toBe(1);
  expect(await showRate(view(), s.deps)).toBe(false);
});

test('the plain link opens the store page and settles the line too', async () => {
  const v = view();
  const s = setup({ pages: 1 });
  await showRate(v, s.deps);
  v.link.click();
  await expect.poll(() => s.opened).toEqual([URL_]);
  expect((s.data[RATE_KEY] as { done?: string }).done).toBe('rated');
});

test('a build without a store page shows neither the line nor the link', async () => {
  const v = view();
  const s = setup({ url: '' });
  expect(await showRate(v, s.deps)).toBe(false);
  expect(v.line.hidden).toBe(true);
  expect(v.foot.hidden).toBe(true);
  expect(s.listed()).toBe(0);
  expect(s.data).toEqual({});
});

test('when the stored state cannot be read, the line stays hidden', async () => {
  const v = view();
  const s = setup({ fail: { get: true } });
  expect(await showRate(v, s.deps)).toBe(false);
  expect(v.line.hidden).toBe(true);
  // The plain link is still there, and the pages are not even read.
  expect(v.foot.hidden).toBe(false);
  expect(s.listed()).toBe(0);
});

test('when the stored state cannot be written, nothing throws', async () => {
  const v = view();
  const s = setup({ pages: 5, fail: { set: true } });
  // The first page with ink tries to start the clock, and that write fails.
  await expect(showRate(v, s.deps)).resolves.toBe(true);
  expect(s.data).toEqual({});
  // No thanks still hides the line, and its failed write is swallowed.
  v.no.click();
  expect(v.line.hidden).toBe(true);
  // Rate still opens the store page and closes the popup.
  const again = view();
  await showRate(again, s.deps);
  again.go.click();
  await expect.poll(() => s.opened).toEqual([URL_]);
  expect(s.closed()).toBe(1);
  expect(s.data).toEqual({});
});
