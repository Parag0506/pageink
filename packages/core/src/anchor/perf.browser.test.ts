import { afterAll, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { withinBudget } from '../testkit';
import type { Described } from '../types';
import { describe, describeRange } from './describe';
import { docRect, mount, reveal, rng, STYLE, sentence, wordRange } from './fixtures';
import { createResolver } from './resolve';
import { dropModel, getModel } from './text';

/**
 * Budgets from CONTRACT 3, with a margin. testkit.withinBudget() judges them against work
 * measured beside them in the same run, so a slow or busy machine does not fail them.
 */
const MARGIN = 2;
const BUILD_MS = 30;
const RESOLVE_MS = 16;

afterAll(() => {
  dropModel(document);
  document.body.innerHTML = '';
});

function bigPage(words: number): string {
  const r = rng(42);
  const sections: string[] = [];
  let count = 0;
  let s = 0;
  while (count < words) {
    const paras: string[] = [`<h2>${sentence(r, 5)}</h2>`];
    for (let i = 0; i < 40 && count < words; i++) {
      const parts: string[] = [];
      for (let j = 0; j < 3; j++) {
        const n = 6 + Math.floor(r() * 6);
        const text = sentence(r, n);
        count += n;
        parts.push(j === 1 ? `<a href="#s${s}-${i}">${text}</a>` : j === 2 ? `<em>${text}</em>` : text);
      }
      paras.push(`<p>\n      ${parts.join('\n      ')}\n    </p>`);
    }
    sections.push(`<section class="sec-${s++}">${paras.join('\n')}</section>`);
  }
  return `${STYLE}<main id="content"><article>${sections.join('\n')}</article></main>`;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

// A budget test. Medians of a few runs, judged by the rule in budget-rule.ts.
test('budget: text model build and resolving 200 notes on a 50,000 word page', {
  timeout: 90_000,
}, async () => {
  await page.viewport(1280, 900);
  const { ctx } = mount(bigPage(50_000));
  // Let the page lay out once, as a real page would before any note is placed.
  void document.body.offsetHeight;

  const model = getModel(ctx);
  expect(model.text.split(' ').length).toBeGreaterThan(50_000);

  // 160 notes on words and 40 margin notes, spread over the page.
  const r = rng(7);
  const ps = [...document.querySelectorAll('article p')];
  const notes: Described[] = [];
  for (let i = 0; i < 160; i++) {
    const p = ps[Math.floor(r() * ps.length)]!;
    const a = Math.floor(r() * 4);
    notes.push(describeRange(ctx, wordRange(p, a, a + 2)));
  }
  for (let i = 0; i < 40; i++) {
    const p = ps[Math.floor(r() * ps.length)]!;
    const b = docRect(p);
    const box = { x: b.x + b.w + 20, y: b.y + 2, w: 60, h: 24 };
    reveal(box);
    notes.push(describe(ctx, box));
  }
  scrollTo(0, 0);
  expect(notes.filter((n) => n.anchor.type === 'block').length).toBeGreaterThanOrEqual(35);

  // One quote edited: the approximate search runs over the whole page.
  const target = notes[0]!;
  const edited = {
    ...target.anchor,
    quote: { ...target.anchor.quote, exact: `${target.anchor.quote.exact}s` },
  };

  await withinBudget(
    { build: BUILD_MS * MARGIN, 'resolve 200': RESOLVE_MS * MARGIN, 'one fuzzy': 50 * MARGIN },
    () => {
      const builds: number[] = [];
      for (let i = 0; i < 5; i++) {
        dropModel(document);
        const t0 = performance.now();
        getModel(ctx);
        builds.push(performance.now() - t0);
      }
      const resolver = createResolver(ctx);
      const passes: number[] = [];
      for (let pass = 0; pass < 5; pass++) {
        const t0 = performance.now();
        let found = 0;
        for (const n of notes) if (resolver.resolve(n.anchor, n.frame)) found++;
        passes.push(performance.now() - t0);
        expect(found).toBe(200);
      }
      const fuzzies: number[] = [];
      for (let i = 0; i < 3; i++) {
        const f0 = performance.now();
        const fz = resolver.resolve(edited, target.frame);
        fuzzies.push(performance.now() - f0);
        expect(fz?.method).toBe('fuzzy');
      }
      // The first pass over the notes is the cold one. The budget is for the passes after it.
      return { build: median(builds), 'resolve 200': median(passes.slice(1)), 'one fuzzy': median(fuzzies) };
    },
  );
});
