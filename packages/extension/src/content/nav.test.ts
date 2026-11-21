import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { watchNavigation } from './nav';

class FakeMO {
  static last: FakeMO | undefined;
  observed = false;
  constructor(readonly cb: () => void) {
    FakeMO.last = this;
  }
  observe() {
    this.observed = true;
  }
  disconnect() {
    this.observed = false;
  }
}

function fakeWin(withNavigation: boolean) {
  const t = new EventTarget();
  const nav = withNavigation ? new EventTarget() : undefined;
  const win = Object.assign(t, { location: { href: 'https://a.test/1' }, document: {}, navigation: nav });
  return {
    win: win as unknown as Window,
    nav,
    go: (href: string) => {
      win.location.href = href;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('MutationObserver', FakeMO);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('Navigation API: one call per address change', () => {
  const f = fakeWin(true);
  const cb = vi.fn();
  const stop = watchNavigation(f.win, cb);
  f.nav!.dispatchEvent(new Event('navigatesuccess'));
  expect(cb).not.toHaveBeenCalled();
  f.go('https://a.test/2');
  f.nav!.dispatchEvent(new Event('navigatesuccess'));
  f.win.dispatchEvent(new Event('popstate'));
  expect(cb).toHaveBeenCalledTimes(1);
  f.go('https://a.test/2#x');
  f.win.dispatchEvent(new Event('hashchange'));
  expect(cb).toHaveBeenCalledTimes(2);
  stop();
  f.go('https://a.test/3');
  f.win.dispatchEvent(new Event('popstate'));
  expect(cb).toHaveBeenCalledTimes(2);
});

test('without the Navigation API, pushState is caught after DOM changes', () => {
  const f = fakeWin(false);
  const cb = vi.fn();
  const stop = watchNavigation(f.win, cb, 100);
  const mo = FakeMO.last!;
  expect(mo.observed).toBe(true);
  f.go('https://a.test/route');
  mo.cb();
  mo.cb();
  expect(cb).not.toHaveBeenCalled();
  vi.advanceTimersByTime(120);
  expect(cb).toHaveBeenCalledTimes(1);
  stop();
  expect(mo.observed).toBe(false);
});
