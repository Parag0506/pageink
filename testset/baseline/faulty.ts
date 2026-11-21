// Scorer self-test. The baseline with known faults: every third resolved note is moved
// 60 px down and every fifth is sent to the tray. A correct scorer reports these as
// wrong places and misses. Run with --anchor testset/baseline/faulty.ts.
import type { CreateResolver } from 'pageink-core/types';
import { createResolver as base } from './index.ts';

export { describe } from './index.ts';

export const createResolver: CreateResolver = (ctx) => {
  const r = base(ctx);
  let n = 0;
  return {
    invalidate: () => r.invalidate(),
    resolve(anchor, frame) {
      n++;
      const res = r.resolve(anchor, frame);
      if (!res) return res;
      if (n % 5 === 0) return null;
      if (n % 3 === 0) return { ...res, origin: { x: res.origin.x, y: res.origin.y + 60 } };
      return res;
    },
  };
};
