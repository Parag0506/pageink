/**
 * DESIGN 11 budgets, measured inside the real extension. The bench measures
 * them on real sites; these runs keep them from regressing.
 */
import type { Page } from '@playwright/test';
import {
  benchDir,
  centre,
  dropProfile,
  expect,
  launch,
  layerInfo,
  newProfile,
  probeDir,
  ring,
  runningWorkers,
  slowdown,
  storedNotes,
  stroke,
  stubDone,
  test,
  textBox,
  withinBudget,
} from './fixtures';

// These tests read the performance marks, which only the bench build has.
test.use({ build: 'bench' });

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Time from DOMContentLoaded to the first ink on screen, once the page has drawn it. */
async function firstInk(page: Page): Promise<number> {
  await page.waitForFunction(() => performance.getEntriesByName('ink:first-ink').length > 0);
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const ink = performance.getEntriesByName('ink:first-ink', 'mark')[0]!;
    return ink.startTime - nav.domContentLoadedEventStart;
  });
}

/** Write three rings on the article so the page has ink. */
async function writeThree(page: Page): Promise<void> {
  for (const w of ['pomegranate', 'Borrowdale', 'centuries']) {
    const b = (await textBox(page, w))!;
    await stroke(page, ring(centre(b), b.w / 2 + 8, b.h / 2 + 6));
    // Past the grouping gap of 1.5 s, so the next ring starts a note of its own.
    await page.waitForTimeout(1700);
  }
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(3);
  await expect.poll(() => storedNotes(page.context())).toBe(3);
}

const show = (xs: number[]) => xs.map((g) => g.toFixed(1)).join(', ');

/**
 * Gates for first ink, in ms. Measured medians: about 20 warm and 25 cold on a laptop.
 * Local gates add a margin; CI machines are slower and get more. Every gate is judged by
 * withinBudget (fixtures.ts): against work timed in the same browser right before and after
 * the measure, and again from scratch when it is over, so a busy machine does not fail it.
 */
const WARM_MS = 30;
const COLD_MS = 45;
const CI_WARM_MS = 80;
const CI_COLD_MS = 120;

/** Event listener types on window, from every world, through CDP. */
async function windowListeners(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  const { result } = (await cdp.send('Runtime.evaluate', { expression: 'window' })) as {
    result: { objectId: string };
  };
  const { listeners } = (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })) as {
    listeners: { type: string }[];
  };
  await cdp.detach();
  return listeners.map((l) => l.type);
}

test('a page without ink: no DOM change, no extension load, no worker, stub under 5 ms', async ({
  context,
  origin,
  extId,
  ext,
}) => {
  const page = await context.newPage();
  const loaded: string[] = [];
  page.on('request', (r) => loaded.push(r.url()));
  await page.goto(`${origin.a}/article.html`);
  await withinBudget(
    () => page,
    { stub: 5 },
    async () => {
      const times: number[] = [];
      for (let i = 0; i < 7; i++) {
        await page.goto(`${origin.a}/article.html?run=${i}`);
        await stubDone(page);
        times.push(await page.evaluate(() => performance.getEntriesByName('ink:stub').at(-1)!.duration));
      }
      console.log(`stub time, page without ink: ${times.map((t) => t.toFixed(2)).join(', ')} ms`);
      return { stub: median(times) };
    },
  );

  const same = await page.evaluate(async () => {
    const raw = await (await fetch(location.href)).text();
    const fresh = new DOMParser().parseFromString(raw, 'text/html');
    // The page's own script adds nothing to the DOM, so the trees must match.
    return fresh.documentElement.outerHTML === document.documentElement.outerHTML;
  });
  expect(same).toBe(true);
  expect(await page.locator('ink-layer').count()).toBe(0);
  expect(loaded.filter((u) => u.startsWith('chrome-extension://'))).toEqual([]);
  // The probe sees the stub's own listener, so it would see a scroll listener too.
  const types = await windowListeners(page);
  expect(types).toContain('pointerdown');
  expect(types).not.toContain('scroll');

  // The worker stays asleep while pages without ink load and get clicked.
  // The browser reports every change of a worker's state on this session, in order.
  const cdp = await context.newCDPSession(ext);
  const states: string[] = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (e: { versions: { runningStatus: string }[] }) => {
    for (const v of e.versions) states.push(v.runningStatus);
  });
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect.poll(() => runningWorkers(ext, extId)).toBe(0);
  states.length = 0;
  await page.goto(`${origin.a}/plain.html`);
  await stubDone(page);
  await page.goto(`${origin.b}/article.html`);
  await stubDone(page);
  await page.mouse.click(300, 300);
  await page.mouse.wheel(0, 400);
  // A message from the stub would reach the browser before the input above is done, and the
  // browser starts the worker for it at once. A round trip on the session that reports worker
  // states comes after that report.
  await cdp.send('ServiceWorker.enable');
  expect(states).toEqual([]);
  expect(await runningWorkers(ext, extId)).toBe(0);
});

test('a page with ink: ink is visible within 50 ms of its content, and nothing runs on scroll', async ({
  context,
  origin,
}) => {
  const url = `${origin.a}/article.html`;
  const page = await context.newPage();
  await page.goto(url);
  await writeThree(page);

  const loaded: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith('chrome-extension://')) loaded.push(new URL(r.url()).pathname);
  });
  // 50 ms is the budget (DESIGN 11). The gate is tighter, to catch a slower view path.
  await withinBudget(
    () => page,
    { 'first ink': process.env.CI ? CI_WARM_MS : WARM_MS },
    async () => {
      const gaps: number[] = [];
      for (let i = 0; i < 9; i++) {
        loaded.length = 0;
        await page.reload();
        gaps.push(await firstInk(page));
        // The view code is a registered content script: the page loads nothing from the
        // extension. The tools wait for a pen or the draw toggle.
        expect(loaded).toEqual([]);
      }
      console.log(`warm first ink after DOMContentLoaded: ${show(gaps)} ms`);
      return { 'first ink': median(gaps) };
    },
  );
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(3);
  // The overlay scrolls with the page. No scroll listener on the window.
  expect(await windowListeners(page)).not.toContain('scroll');
});

test('a page with ink in a browser that just started: ink is visible within the budget', async ({
  origin,
}) => {
  test.slow();
  const profile = newProfile();
  try {
    const url = `${origin.a}/article.html`;
    const first = await launch(profile, [], benchDir);
    const page = await first.newPage();
    await page.goto(url);
    await writeThree(page);
    await first.close();

    // A browser that just started is busy with its own start, so each load is set against the
    // slowdown measured in that same browser right after it. The machine as a whole is timed in
    // a browser of its own that stays open, before and after each batch of starts.
    const steady = await launch(undefined, [], benchDir);
    try {
      const probe = await steady.newPage();
      await probe.goto(`${origin.a}/blank.html`);
      await withinBudget(
        () => probe,
        { 'first ink': process.env.CI ? CI_COLD_MS : COLD_MS },
        async () => {
          const gaps: number[] = [];
          const scaled: number[] = [];
          for (let i = 0; i < 5; i++) {
            const ctx = await launch(profile, [], benchDir);
            try {
              const p = await ctx.newPage();
              await p.goto(url);
              const gap = await firstInk(p);
              gaps.push(gap);
              scaled.push(gap / (await slowdown(p)));
              await expect.poll(async () => (await layerInfo(p))?.notes.length).toBe(3);
            } finally {
              await ctx.close();
            }
          }
          console.log(`cold first ink after DOMContentLoaded: ${show(gaps)} ms, scaled ${show(scaled)}`);
          return { 'first ink': median(scaled) };
        },
        { scaled: true },
      );
    } finally {
      await steady.close();
    }
  } finally {
    dropProfile(profile);
  }
});

/** Per note: when its anchor paragraph entered the page and when its ink entered the layer. */
async function lags(page: Page, ids: Record<string, string>): Promise<{ near: number[]; all: number }> {
  return page.evaluate(async (ids) => {
    const probe = await new Promise<{ drawn: Record<string, number> } | null>((r) => {
      const h = (e: MessageEvent) => {
        if (e.data?.benchProbeData) {
          removeEventListener('message', h);
          r(e.data.benchProbeData);
        }
      };
      addEventListener('message', h);
      postMessage({ benchProbe: 'dump' }, '*');
      setTimeout(() => r(null), 2000);
    });
    const seen = (window as unknown as { __anchors: Record<string, number> }).__anchors;
    const near: number[] = [];
    let all = 0;
    for (const [note, el] of Object.entries(ids)) {
      const d = probe?.drawn[note];
      const a = seen[el];
      if (d === undefined || a === undefined) continue;
      all++;
      const r = document.getElementById(el)!.getBoundingClientRect();
      if (r.top < innerHeight) near.push(d - a);
    }
    return { near, all };
  }, ids);
}

test('a large page that streams in: ink is drawn within 50 ms of its content', async ({ origin }) => {
  test.slow();
  const url = `${origin.a}/stream.html?parts=12&per=30&gap=60`;
  const targets = ['p0-1', 'p0-4', 'p0-7', 'p3-2', 'p8-5'];
  // One browser with the probe beside Ink. Write a note on each target paragraph, once the whole page is in.
  const ctx = await launch(undefined, [probeDir], benchDir);
  try {
    const w = await ctx.newPage();
    await w.goto(url, { waitUntil: 'load' });
    const ids: Record<string, string> = {};
    for (const id of targets) {
      await w.evaluate((id) => document.getElementById(id)!.scrollIntoView({ block: 'center' }), id);
      const b = (await w.evaluate((id) => {
        const r = document.getElementById(id)!.getBoundingClientRect();
        return { x: r.left, y: r.top, w: 120, h: 20 };
      }, id))!;
      const before = new Set(((await layerInfo(w))?.notes ?? []).map((n) => n.id));
      await stroke(w, ring(centre(b), 40, 9));
      await expect
        .poll(async () => ((await layerInfo(w))?.notes ?? []).some((n) => !before.has(n.id)))
        .toBe(true);
      const made = ((await layerInfo(w))?.notes ?? []).find((n) => !before.has(n.id))!;
      ids[made.id] = id;
      // Past the grouping gap of 1.5 s, so the next ring starts a note of its own.
      await w.waitForTimeout(1700);
    }
    await expect.poll(() => storedNotes(ctx)).toBe(targets.length);
    await w.close();

    await ctx.addInitScript(`(() => {
    const want = ${JSON.stringify(targets)};
    const seen = {};
    window.__anchors = seen;
    new MutationObserver(() => {
      for (const id of want) if (seen[id] === undefined && document.getElementById(id)) seen[id] = performance.now();
    }).observe(document, { childList: true, subtree: true });
  })()`);
    // The calibration runs in a page of its own, which stays open and idle during the loads.
    const still = await ctx.newPage();
    await still.goto(`${origin.a}/blank.html`);
    await withinBudget(
      () => still,
      { 'ink after its content': process.env.CI ? CI_WARM_MS : 50 },
      async () => {
        const worst: number[] = [];
        for (let i = 0; i < 6; i++) {
          const p = await ctx.newPage();
          await p.goto(url, { waitUntil: 'load' });
          let got = await lags(p, ids);
          await expect
            .poll(async () => {
              got = await lags(p, ids);
              return got.all;
            })
            .toBe(targets.length);
          expect(got.near.length).toBeGreaterThan(0);
          // The first load of the browser is discarded, as in the bench.
          if (i > 0) worst.push(Math.max(...got.near));
          await p.close();
        }
        console.log(`streamed page, ink after its content: ${show(worst)} ms`);
        return { 'ink after its content': median(worst) };
      },
    );
  } finally {
    await ctx.close();
  }
});
