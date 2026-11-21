import { expect, test } from 'vitest';
import { missingBuiltins, NEEDED, TOO_OLD } from './guard';

const fn = () => undefined;

/** A global object with every needed built-in, as a current browser has. */
function full(): Record<string, unknown> {
  const g: Record<string, unknown> = {};
  for (const path of NEEDED) {
    const parts = path.split('.');
    let o = g;
    for (const k of parts.slice(0, -1)) {
      o[k] ??= {};
      o = o[k] as Record<string, unknown>;
    }
    o[parts.at(-1)!] = fn;
  }
  return g;
}

test('nothing is missing on a current browser', () => {
  expect(missingBuiltins(full())).toEqual([]);
});

test('names each built-in an old browser lacks', () => {
  const g = full();
  delete (g.Math as Record<string, unknown>).sumPrecise;
  delete g.Iterator;
  (g.Promise as Record<string, unknown>).try = 'not a function';
  expect(missingBuiltins(g)).toEqual([
    'Promise.try',
    'Math.sumPrecise',
    'Iterator.prototype.map',
    'Iterator.prototype.toArray',
  ]);
  expect(missingBuiltins({})).toEqual([...NEEDED]);
});

test('the message is short and plain', () => {
  expect(TOO_OLD).toMatch(
    /^This browser is too old to open PDFs with \S+\. Update the browser, or open the file in its own viewer\.$/,
  );
});
