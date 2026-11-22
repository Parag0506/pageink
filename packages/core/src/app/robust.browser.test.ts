// The controller under hard conditions: storage that fails or holds what it cannot read, pages that
// come back from the back-forward cache, rich text editors, and very long pages with many notes.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { describe as describeBox } from '../anchor/describe';
import { pageIdentity } from '../anchor/identity';
import { newId, pageKeyOf } from '../hash';
import { memoryKV } from '../store/memory';
import { emptyRecord } from '../store/patch';
import { createStore } from '../store/store';
import { makeStroke } from '../strokes/stroke';
import { frame, quiet, withinBudget } from '../testkit';
import type { InkWarning, KV, Note, PageRecord } from '../types';
import {
  articleHtml,
  closeAll,
  filler,
  loop,
  openViewer,
  setPage,
  settle,
  stroke,
  textRect,
  until,
  wait,
} from './testkit';
import { FULL_WARN, RECORD_WARN } from './view';

beforeAll(async () => {
  await page.viewport(900, 800);
});
afterAll(async () => {
  await page.viewport(414, 896);
});
afterEach(() => {
  closeAll();
  document.body.innerHTML = '';
  document.body.removeAttribute('contenteditable');
  document.designMode = 'off';
});

const el = (id: string) => document.getElementById(id)!;
const ctx = () => ({ doc: document, isOurs: (e: Element) => e.localName === 'ink-layer' });

/** A KV whose writes can be made to fail, like a full disk, and which can go deaf to changes. */
function flakyKV(): KV & { fail: boolean; writes: number } {
  const inner = memoryKV();
  const kv = {
    fail: false,
    writes: 0,
    get: (keys: string[]) => inner.get(keys),
    async set(items: Record<string, unknown>) {
      kv.writes++;
      if (kv.fail) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return inner.set(items);
    },
    remove: (keys: string[]) => inner.remove(keys),
    keys: (p: string) => inner.keys(p),
  };
  return kv;
}

function noteOn(target: Element): Note {
  const r = target.getBoundingClientRect();
  const box = {
    x: r.left + scrollX,
    y: r.top + scrollY,
    w: Math.min(r.width, 80),
    h: Math.min(r.height, 20),
  };
  const d = describeBox(ctx(), box);
  const s = makeStroke(
    [
      { x: box.x, y: box.y, p: 0.5, t: 0 },
      { x: box.x + box.w, y: box.y + box.h, p: 0.5, t: 10 },
    ],
    d.origin,
    { tool: 'pen', color: 'ink-1', w: 2 },
  );
  return {
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    device: 't',
    kind: 'ink',
    anchor: d.anchor,
    frame: d.frame,
    strokes: [s],
  };
}

async function writeOn(word: string, id: string): Promise<void> {
  await stroke(loop(textRect(el(id), word)));
}

describe('storage failures', () => {
  test('a full disk: a quiet warning, nothing lost in memory, saved on the next change', async () => {
    setPage(articleHtml());
    const kv = flakyKV();
    const warns: InkWarning[] = [];
    const rig = await openViewer(kv, { hooks: { onWarn: (w) => warns.push(w) } });
    await rig.cmd();
    kv.fail = true;
    await writeOn('Paragraph 1', 'p1');
    await until(() => rig.viewer.state().warn === FULL_WARN, 'warning');
    const wn = rig.v!.layer.root.querySelector<HTMLElement>('.wn')!;
    expect(wn.hidden).toBe(false);
    expect(wn.getAttribute('aria-label')).toBe(FULL_WARN);
    // The bar says it in words, with what to do.
    const msg = rig.v!.layer.root.querySelector<HTMLElement>('.note .msg')!;
    expect(msg.hidden).toBe(false);
    expect(msg.textContent).toBe(FULL_WARN);
    await wait(1700);
    await writeOn('Paragraph 3', 'p3');
    await until(() => rig.notes().length === 2, 'second note kept in memory');
    await quiet();
    // No retry loop while nothing changes, and the host hears about it once. A missed retry
    // can only make this pass wrongly, never fail wrongly.
    const writes = kv.writes;
    await wait(500);
    expect(kv.writes).toBe(writes);
    expect(warns.filter((w) => w.kind === 'save')).toHaveLength(1);

    kv.fail = false;
    await wait(1700);
    await writeOn('Paragraph 5', 'p5');
    await until(() => rig.viewer.state().warn === undefined, 'warning cleared');
    expect(wn.hidden).toBe(true);
    const saved = await createStore(kv).load(pageIdentity(location.href, document));
    expect(saved?.notes).toHaveLength(3);
  });

  test('a record from a newer version is ignored, never overwritten, and reported once', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const id = pageIdentity(location.href, document);
    const sk = pageKeyOf(id.key);
    const future = { v: 2, key: id.key, notes: [{ id: 'x', shape: 'new' }], extra: true };
    await kv.set({ [sk]: future });
    const warns: InkWarning[] = [];
    const rig = await openViewer(kv, { hooks: { onWarn: (w) => warns.push(w) } });
    await rig.viewer.ready;
    expect(rig.viewer.state().notes).toBe(0);
    expect(warns).toEqual([expect.objectContaining({ kind: 'record', key: sk })]);
    await rig.cmd();
    await writeOn('Paragraph 1', 'p1');
    await until(() => rig.viewer.state().warn === RECORD_WARN, 'warning');
    expect(rig.notes()).toHaveLength(1);
    await writeOn('Paragraph 3', 'p3');
    await until(() => rig.notes().length === 2, 'second note');
    await quiet();
    expect((await kv.get([sk]))[sk]).toEqual(future);
    expect(warns).toHaveLength(1);
  });

  test('a damaged record is ignored and left as it is', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const sk = pageKeyOf(pageIdentity(location.href, document).key);
    await kv.set({ [sk]: 'not json at all' });
    const rig = await openViewer(kv);
    await rig.cmd();
    await writeOn('Paragraph 1', 'p1');
    await until(() => rig.viewer.state().warn === RECORD_WARN, 'warning');
    expect((await kv.get([sk]))[sk]).toBe('not json at all');
  });
});

describe('coming back', () => {
  /** A KV that tells nobody about changes, like a page frozen in the back-forward cache. */
  function deafKV(): KV {
    const inner = memoryKV();
    return {
      get: (k) => inner.get(k),
      set: (i) => inner.set(i),
      remove: (k) => inner.remove(k),
      keys: (p) => inner.keys(p),
    };
  }

  test('a back-forward cache restore reads the record again and shows ink written meanwhile', async () => {
    setPage(articleHtml());
    const kv = deafKV();
    const rig = await openViewer(kv);
    await rig.viewer.ready;
    expect(rig.viewer.state().notes).toBe(0);
    // Another tab writes while this page is frozen.
    const id = pageIdentity(location.href, document);
    const rec: PageRecord = { ...emptyRecord(id, 't'), notes: [noteOn(el('w-target'))], updatedAt: 1 };
    await createStore(kv).save(rec, id);
    await quiet();
    expect(rig.viewer.state().notes).toBe(0);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await until(() => rig.viewer.state().notes === 1, 'note after restore');
    await until(() => !!document.querySelector('ink-layer'), 'drawn');
  });

  test('a tab that becomes visible again picks up changes it missed, and a hidden tab saves', async () => {
    setPage(articleHtml());
    const kv = deafKV();
    const rig = await openViewer(kv);
    await rig.cmd();
    const id = pageIdentity(location.href, document);
    await createStore(kv).save({ ...emptyRecord(id, 't'), notes: [noteOn(el('p3'))], updatedAt: 1 }, id);
    document.dispatchEvent(new Event('visibilitychange'));
    await until(() => rig.viewer.state().notes === 1, 'note on return');
    await settle();
    expect(rig.placed(rig.notes()[0]!.id)).toBeDefined();
  });
});

describe('editors', () => {
  for (const mode of ['contenteditable', 'designMode'] as const) {
    test(`${mode}: ink never touches the editor content and anchors to its text`, async () => {
      setPage(articleHtml());
      if (mode === 'designMode') document.designMode = 'on';
      else document.body.setAttribute('contenteditable', 'true');
      const before = document.body.innerHTML;
      let inputs = 0;
      document.addEventListener('input', () => inputs++);
      const rig = await openViewer(memoryKV());
      await rig.cmd();
      await writeOn('pomegranate', 'p2');
      await until(() => rig.notes().length === 1, 'note');
      await settle();
      expect(document.body.innerHTML).toBe(before);
      expect(inputs).toBe(0);
      expect(document.querySelector('body ink-layer')).toBeNull();
      const n = rig.notes()[0]!;
      expect(n.anchor.type).toBe('text');
      expect(n.anchor.quote.exact).toContain('pomegranate');
      expect(rig.placed(n.id)).toBeDefined();
    });
  }
});

describe('big pages', () => {
  // A budget test, with the limit scaled by work measured in the same run. Two measures: long
  // tasks, which only Chromium reports, and the gaps between animation frames, which every
  // engine has. A task that blocks the page for longer than the limit holds back the next frame.
  test('budget: a page 100,000 px long with 1,000 notes loads with no long task', async () => {
    const paras = Array.from(
      { length: 1300 },
      (_, i) => `<p id="b${i}">Block ${i} starts. ${filler(i + 3, 24)}.</p>`,
    ).join('');
    setPage(`<style>p{margin:0 0 20px;font:18px/1.6 serif;width:600px}</style><main>${paras}</main>`);
    expect(document.documentElement.scrollHeight).toBeGreaterThan(100_000);
    const notes: Note[] = [];
    for (let i = 0; i < 1000; i++) notes.push(noteOn(el(`b${Math.floor(i * 1.3)}`)));
    const kv = memoryKV();
    const id = pageIdentity(location.href, document);
    await createStore(kv).save({ ...emptyRecord(id, 't'), notes, updatedAt: 1 }, id);
    const longTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
    let rig: Awaited<ReturnType<typeof openViewer>> | null = null;
    // A frame gap holds one frame of the browser's own work besides ours, so it gets twice the time.
    await withinBudget({ 'long task': 50, 'frame gap': 100 }, async (scale) => {
      rig?.viewer.destroy();
      const limit = 50 * scale;
      await quiet();
      const long: number[] = [];
      const po = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) long.push(e.duration);
      });
      if (longTasks) po.observe({ type: 'longtask', buffered: false });
      // Frame gaps, read with frames the test kit does not count, so quiet() still ends.
      const gaps: number[] = [];
      let watching = true;
      const watch = (async () => {
        let last = performance.now();
        while (watching) {
          await frame();
          const t = performance.now();
          gaps.push(t - last);
          last = t;
        }
      })();
      try {
        // Prove both measures see a task as long as the limit before trusting them.
        await frame();
        const t1 = performance.now();
        while (performance.now() - t1 < limit + 20) {}
        await frame();
        await frame();
        expect(Math.max(...gaps)).toBeGreaterThan(limit);
        if (longTasks) await until(() => long.some((d) => d > limit), 'the probe task seen');
        gaps.length = 0;
        long.length = 0;

        let placedAll = -1;
        const t0 = performance.now();
        rig = await openViewer(kv, {
          hooks: {
            onTiming: (name) => {
              if (name === 'view.placed') placedAll = performance.now() - t0;
            },
          },
        });
        await rig.viewer.ready;
        // Placing all of them takes many idle slices: the bound grows with the machine's slowdown.
        await until(() => placedAll >= 0, 'all placed', 30_000 * scale);
        await quiet();
      } finally {
        watching = false;
        await watch;
        po.disconnect();
      }
      return { 'long task': Math.max(0, ...long), 'frame gap': Math.max(...gaps) };
    });
    expect(rig!.viewer.state().notes).toBe(1000);
  }, 300_000);
});
