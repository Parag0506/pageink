import { afterEach, expect, test } from 'vitest';
import { installCompat } from './compat';

type Bag = Record<string, unknown>;
const P = Promise as unknown as Bag;
const S = AbortSignal as unknown as Bag;
const B = ArrayBuffer.prototype as unknown as Bag;
const saved = { w: P.withResolvers, a: S.any, t: B.transferToFixedLength };

afterEach(() => {
  P.withResolvers = saved.w;
  S.any = saved.a;
  B.transferToFixedLength = saved.t;
});

test('adds nothing where the browser has everything', () => {
  expect(installCompat()).toEqual([]);
  expect(P.withResolvers).toBe(saved.w);
});

test('fills in what Safari 17.0 to 17.3 lacks, and each stand-in works', async () => {
  delete P.withResolvers;
  delete S.any;
  delete B.transferToFixedLength;
  expect(installCompat()).toEqual([
    'Promise.withResolvers',
    'AbortSignal.any',
    'ArrayBuffer.prototype.transferToFixedLength',
  ]);

  const r = (P.withResolvers as () => { promise: Promise<number>; resolve: (v: number) => void })();
  r.resolve(3);
  expect(await r.promise).toBe(3);

  const a = new AbortController();
  const b = new AbortController();
  const any = AbortSignal.any([a.signal, b.signal]);
  expect(any.aborted).toBe(false);
  b.abort('stop');
  expect(any.aborted).toBe(true);
  expect(any.reason).toBe('stop');
  const done = new AbortController();
  done.abort('early');
  expect(AbortSignal.any([done.signal]).reason).toBe('early');

  const buf = new Uint8Array([1, 2, 3, 4]).buffer;
  const cut = (n?: number) => (B.transferToFixedLength as (n?: number) => ArrayBuffer).call(buf, n);
  expect([...new Uint8Array(cut(2))]).toEqual([1, 2]);
  expect([...new Uint8Array(cut(6))]).toEqual([1, 2, 3, 4, 0, 0]);
  expect(cut().byteLength).toBe(4);
});
