/** Each store has its own limit for the manifest description. An upload over it is refused. */
import { expect, test } from 'vitest';
import { manifestFor } from '../build/targets';

const LIMIT = { chrome: 132, edge: 132, firefox: 132, safari: 112 } as const;

test('the manifest description fits each store', () => {
  for (const [t, max] of Object.entries(LIMIT)) {
    const d = manifestFor(t as keyof typeof LIMIT).description as string;
    expect(d.length, t).toBeGreaterThan(0);
    expect(d.length, t).toBeLessThanOrEqual(max);
  }
});
