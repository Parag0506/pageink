import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { describe as describeBox } from '../anchor/describe';
import { pageIdentity } from '../anchor/identity';
import { CFG_KEY, newId } from '../hash';
import { memoryKV } from '../store/memory';
import { emptyRecord, erasePatch } from '../store/patch';
import { createStore } from '../store/store';
import { makeStroke } from '../strokes/stroke';
import { budget, quiet } from '../testkit';
import type { KV, Note, PageRecord } from '../types';
import {
  articleHtml,
  centreIn,
  closeAll,
  drawnOn,
  filler,
  frame,
  loop,
  mouseInput,
  openViewer,
  setPage,
  settle,
  stroke,
  tap,
  tapUntil,
  textRect,
  toDocRect,
  until,
  wait,
} from './testkit';
import { QUIET_MS } from './view';

beforeAll(async () => {
  await page.viewport(900, 800);
});
afterAll(async () => {
  await page.viewport(414, 896);
});
afterEach(() => {
  closeAll();
  document.body.innerHTML = '';
});

const el = (id: string) => document.getElementById(id)!;
const ctx = () => ({ doc: document, isOurs: (e: Element) => e.localName === 'ink-layer' });

/** A note written by script over a box, as describe would on the real page. */
function noteAt(box: { x: number; y: number; w: number; h: number }, frame?: Note['anchor']['frame']): Note {
  const d = describeBox(ctx(), box);
  const s = makeStroke(
    [
      { x: box.x, y: box.y, p: 0.5, t: 0 },
      { x: box.x + box.w, y: box.y + box.h, p: 0.5, t: 10 },
    ],
    d.origin,
    { tool: 'pen', color: 'ink-1', w: 2 },
  );
  const anchor = frame ? { ...d.anchor, frame } : d.anchor;
  return {
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    device: 't',
    kind: 'ink',
    anchor,
    frame: d.frame,
    strokes: [s],
  };
}

async function seed(notes: Note[], url = location.href): Promise<ReturnType<typeof memoryKV>> {
  const kv = memoryKV();
  const id = pageIdentity(url, document);
  const rec: PageRecord = { ...emptyRecord(id, 'seed'), notes, updatedAt: 1 };
  await createStore(kv).save(rec, id);
  return kv;
}

describe('quiet pages', () => {
  test('no DOM change and no listeners on a page without notes', async () => {
    setPage(articleHtml());
    const changes: MutationRecord[] = [];
    const mo = new MutationObserver((l) => changes.push(...l));
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const add = vi.spyOn(window, 'addEventListener');
    const rig = await openViewer();
    await rig.viewer.ready;
    await settle();
    mo.disconnect();
    expect(changes).toHaveLength(0);
    expect(document.querySelector('ink-layer')).toBeNull();
    expect(add.mock.calls.map((c) => c[0]).filter((t) => t !== 'pagehide' && t !== 'pageshow')).toEqual([]);
    add.mockRestore();
    expect(rig.viewer.state().notes).toBe(0);
  });

  test('a note the merge left with no strokes is not placed, counted or listed in the tray', async () => {
    setPage(articleHtml());
    const shown = noteAt(toDocRect(el('w-target').getBoundingClientRect()));
    const empty = { ...noteAt(toDocRect(textRect(el('p1'), 'Paragraph 1'))), id: 'n~5', strokes: [] };
    const kv = await seed([shown, empty]);
    const rig = await openViewer(kv);
    await rig.viewer.ready;
    await settle();
    expect(rig.viewer.state()).toMatchObject({ notes: 1, tray: 0 });
    await rig.cmd();
    expect(rig.v!.placer.all().map((p) => p.id)).toEqual([shown.id]);
    expect(rig.v!.tray().map((t) => t.note.id)).not.toContain(empty.id);
  });

  test('nothing listens to window scroll on a normal page, with ink and tools loaded', async () => {
    setPage(articleHtml());
    const kv = await seed([noteAt(toDocRect(el('w-target').getBoundingClientRect()))]);
    const add = vi.spyOn(window, 'addEventListener');
    const addDoc = vi.spyOn(document, 'addEventListener');
    const rig = await openViewer(kv);
    await rig.viewer.ready;
    await rig.cmd();
    await stroke(loop(textRect(el('p1'), 'Paragraph 1')));
    await until(() => rig.notes().length === 2, 'write');
    window.scrollTo(0, 200);
    await settle();
    const types = [...add.mock.calls, ...addDoc.mock.calls].map((c) => c[0]);
    expect(types).not.toContain('scroll');
    add.mockRestore();
    addDoc.mockRestore();
  });

  test('a reader whose device id is not stored yet sees the ink without waiting for that write', async () => {
    setPage(articleHtml());
    const shown = noteAt(toDocRect(el('w-target').getBoundingClientRect()));
    const base = await seed([shown]);
    expect((await base.get([CFG_KEY]))[CFG_KEY]).toBeUndefined();
    // Every write waits until the test lets it through, like a disk that is slow on a cold start.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const kv: KV = {
      ...base,
      async set(items) {
        await held;
        return base.set(items);
      },
    };
    const rig = await openViewer(kv);
    await rig.viewer.ready;
    expect(rig.viewer.state().notes).toBe(1);
    expect(document.querySelector('ink-layer')).not.toBeNull();
    await rig.cmd();
    expect(rig.v!.placer.all().map((p) => p.id)).toEqual([shown.id]);
    expect((await base.get([CFG_KEY]))[CFG_KEY]).toBeUndefined();
    release();
    await settle();
    const cfg = (await base.get([CFG_KEY]))[CFG_KEY] as { device?: string };
    expect(cfg.device).toBe(rig.v!.config.device);
  });

  // A budget test: the median of a batch, against a limit scaled by work measured in the same run.
  test('budget: first ink is on screen within 50 ms on a page with 50 notes', async () => {
    const paras: string[] = [];
    for (let i = 0; i < 50; i++) paras.push(`<p id="q${i}">Note ${i} sits on ${filler(i + 3, 18)}.</p>`);
    setPage(
      `<style>body{margin:0;font:16px/1.5 sans-serif}main{width:600px;margin:20px}</style><main>${paras.join('')}</main>`,
    );
    const notes = paras.map((_, i) => noteAt(toDocRect(textRect(el(`q${i}`), `Note ${i} sits`))));
    window.scrollTo(0, 0);
    const kv = await seed(notes);
    const runs: number[] = [];
    let last: Awaited<ReturnType<typeof openViewer>> | null = null;
    for (let i = 0; i < 5; i++) {
      last?.viewer.destroy();
      const timings: Record<string, number> = {};
      const rig = await openViewer(kv, {
        hooks: { onTiming: (n, ms) => Object.assign(timings, { [n]: ms }) },
      });
      await rig.viewer.ready;
      await until(() => timings['view.first-ink'] !== undefined, 'first ink timing');
      await until(() => timings['view.placed'] !== undefined, 'placed timing');
      runs.push(timings['view.first-ink']!);
      last = rig;
    }
    runs.sort((a, b) => a - b);
    const ms = runs[2]!;
    const limit = budget(50);
    console.info(
      `first ink: median ${ms.toFixed(1)} ms of ${runs.map((r) => r.toFixed(1)).join(', ')}, limit ${limit.toFixed(0)}`,
    );
    expect(ms).toBeLessThan(limit);
    await last!.cmd();
    expect(last!.v!.placer.all()).toHaveLength(50);
  });
});

describe('sync', () => {
  test('a second viewer on the same storage sees the first one strokes', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const a = await openViewer(kv);
    const b = await openViewer(kv);
    expect(b.viewer.state().notes).toBe(0);
    await a.cmd();
    await stroke(loop(el('w-target').getBoundingClientRect()));
    await until(() => b.viewer.state().notes === 1, 'b sees it');
    // b paints it too, in its own layer.
    expect(document.querySelectorAll('ink-layer')).toHaveLength(2);
    await b.cmd();
    const id = a.notes()[0]!.id;
    await until(() => !!b.placed(id), 'b placed');
    expect(centreIn(b.placed(id)!.bbox, toDocRect(el('w-target').getBoundingClientRect()))).toBe(true);
  });

  test('a stroke in progress is not disturbed by a change from elsewhere', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const a = await openViewer(kv);
    const b = await openViewer(kv);
    await a.cmd();
    await b.cmd();
    const r = textRect(el('p1'), 'Paragraph 1');
    // a writes slowly while b writes a note elsewhere.
    const pts = loop(r);
    const [x0, y0] = pts[0]!;
    await mouseInput('mouseMoved', x0, y0, 'pen');
    await mouseInput('mousePressed', x0, y0, 'pen', { force: 0.5 });
    for (const [x, y] of pts.slice(1, 12))
      await mouseInput('mouseMoved', x, y, 'pen', { down: true, force: 0.5 });
    b.v!.commit({ add: [noteAt(toDocRect(el('w-target').getBoundingClientRect()))] });
    await until(() => a.viewer.state().notes === 1, 'a merged b');
    for (const [x, y] of pts.slice(12))
      await mouseInput('mouseMoved', x, y, 'pen', { down: true, force: 0.5 });
    const [lx, ly] = pts[pts.length - 1]!;
    await mouseInput('mouseReleased', lx, ly, 'pen');
    await until(() => a.notes().length === 2, 'a wrote');
    const mine = a.notes().find((n) => n.anchor.quote.exact.includes('Paragraph 1'))!;
    // Two of these viewers share the page, so each one stroke may be grouped by the other only by storage.
    expect(mine.strokes.length).toBeGreaterThanOrEqual(1);
    await until(() => b.viewer.state().notes === 2, 'b sees both');
  });
});

describe('navigation and frames', () => {
  test('in-page navigation swaps records', async () => {
    setPage(articleHtml());
    const start = location.href;
    const kv = memoryKV();
    const rig = await openViewer(kv);
    await rig.cmd();
    await stroke(loop(el('w-target').getBoundingClientRect()));
    await until(() => rig.notes().length === 1, 'first page note');
    const firstKey = rig.v!.record().key;
    try {
      history.pushState(null, '', `${location.pathname}?route=two`);
      await rig.viewer.reload();
      expect(rig.v!.record().key).not.toBe(firstKey);
      expect(rig.viewer.state().notes).toBe(0);
      expect(rig.v!.placer.all()).toHaveLength(0);
      expect(rig.viewer.state().canUndo).toBe(false);
      await stroke(loop(textRect(el('p1'), 'Paragraph 1')));
      await until(() => rig.notes().length === 1, 'second page note');
      history.pushState(null, '', start);
      await rig.viewer.reload();
      expect(rig.v!.record().key).toBe(firstKey);
      expect(rig.viewer.state().notes).toBe(1);
      expect(rig.notes()[0]!.anchor.quote.exact).toContain('pomegranate');
    } finally {
      history.replaceState(null, '', start);
    }
    // Both records were saved.
    const store = createStore(kv);
    expect((await store.list()).map((p) => p.notes)).toEqual([1, 1]);
  });

  test('the frame option shows only that frame notes and writes with the frame', async () => {
    setPage(articleHtml());
    const f = { url: 'https://frame.example/doc', path: { css: 'iframe', xpath: '/html/body/iframe' } };
    const top = noteAt(toDocRect(el('w-target').getBoundingClientRect()));
    const inFrame = noteAt(toDocRect(textRect(el('p1'), 'Paragraph 1')), f);
    const other = noteAt(toDocRect(textRect(el('p3'), 'Paragraph 3')), {
      ...f,
      url: 'https://other.example/',
    });
    const kv = await seed([top, inFrame, other]);
    const framed = await openViewer(kv, { frame: f });
    await framed.viewer.ready;
    expect(framed.viewer.state().notes).toBe(1);
    await framed.cmd();
    expect(framed.v!.placer.all().map((p) => p.id)).toEqual([inFrame.id]);
    await stroke(loop(textRect(el('p5'), 'Paragraph 5')));
    await until(() => framed.viewer.state().notes === 2, 'frame note');
    const mine = framed.notes().find((n) => ![top.id, inFrame.id, other.id].includes(n.id))!;
    expect(mine.anchor.frame).toEqual(f);
    // Clear page in a frame clears only that frame's ink, through the store's own erase.
    const want = erasePatch(framed.v!.record(), (n) => n.anchor.frame?.url === f.url).del ?? [];
    expect(want).toEqual(expect.arrayContaining([inFrame.id, mine.id]));
    (await framed.cmd()).clearPage();
    const after = framed.v!.record();
    expect(after.notes.map((n) => n.id).sort()).toEqual([top.id, other.id].sort());
    const dead = new Set(after.deleted.map((d) => d.id));
    for (const id of want) expect(dead.has(id), id).toBe(true);
    expect(dead.has(top.id) || dead.has(other.id)).toBe(false);
    framed.viewer.destroy();

    const topView = await openViewer(kv);
    await topView.viewer.ready;
    expect(topView.viewer.state().notes).toBe(1);
  });
});

describe('site off', () => {
  test('a host in config.off gets nothing at all', async () => {
    setPage(articleHtml());
    const kv = await seed([noteAt(toDocRect(el('w-target').getBoundingClientRect()))]);
    const cfg = await createStore(kv).config();
    await kv.set({ [CFG_KEY]: { ...cfg, off: [pageIdentity(location.href).host] } });
    const rig = await openViewer(kv);
    await rig.viewer.ready;
    await settle();
    expect(document.querySelector('ink-layer')).toBeNull();
    expect(rig.viewer.state().off).toBe(true);
    const cmd = await rig.viewer.tools();
    cmd.setSiteOff(false);
    expect(rig.viewer.state().off).toBe(false);
    // Turning it back on brings the ink back in place, without a reload.
    await until(() => !!document.querySelector('ink-layer'), 'layer back');
    expect((await createStore(kv).config()).off).toEqual([]);
    await until(() => rig.viewer.state().notes === 1, 'notes back');
    // The revived viewer takes the tools and pen input from here.
    const live = await rig.viewer.tools();
    expect(live).not.toBe(cmd);
    live.setDraw(true);
    expect(rig.viewer.state().draw).toBe(true);
  });

  test('turning the site off persists and tears the viewer down', async () => {
    setPage(articleHtml());
    const kv = await seed([noteAt(toDocRect(el('w-target').getBoundingClientRect()))]);
    const rig = await openViewer(kv);
    await rig.viewer.ready;
    const cmd = await rig.cmd();
    expect(document.querySelector('ink-layer')).not.toBeNull();
    cmd.setSiteOff(true);
    expect(document.querySelector('ink-layer')).toBeNull();
    await vi.waitFor(
      async () => expect((await createStore(kv).config()).off).toEqual([pageIdentity(location.href).host]),
      { timeout: 15_000 },
    );
    // Notes are kept.
    const again = await openViewer(kv);
    expect(again.viewer.state().off).toBe(true);
  });
});

describe('harder pages', () => {
  test('a page with an inner scroller: ink follows the scroller and comes back after reload', async () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `<p id="c${i}">Line ${i} of code ${filler(i, 6)}</p>`,
    ).join('');
    setPage(
      `<style>body{margin:0;font:16px/1.5 sans-serif}#pane{position:absolute;left:40px;top:60px;width:500px;height:300px;overflow:auto;border:1px solid #ccc}#pane p{margin:0 0 6px}</style><div id="pane">${lines}</div>`,
    );
    const pane = el('pane');
    pane.scrollTop = 120;
    const kv = memoryKV();
    const a = await openViewer(kv);
    await a.cmd();
    await stroke(loop(textRect(el('c10'), 'Line 10')));
    await until(() => a.notes().length === 1, 'note');
    const n = a.notes()[0]!;
    expect(n.anchor.scroller).toBeDefined();
    await settle();
    const before = a.placed(n.id)!.bbox;
    pane.scrollTop = 40;
    await until(() => Math.abs(a.placed(n.id)!.bbox.y - (before.y + 80)) < 1.5, 'follow the scroller');
    expect(centreIn(a.placed(n.id)!.bbox, toDocRect(textRect(el('c10'), 'Line 10')))).toBe(true);
    // What is drawn follows too, not only the numbers.
    await until(() => drawnOn(a, n.id, textRect(el('c10'), 'Line 10')), 'drawn on its line');
    a.viewer.destroy();

    pane.scrollTop = 200;
    const b = await openViewer(kv);
    await b.viewer.ready;
    await b.cmd();
    await settle();
    expect(centreIn(b.placed(n.id)!.bbox, toDocRect(textRect(el('c10'), 'Line 10')))).toBe(true);
    expect(drawnOn(b, n.id, textRect(el('c10'), 'Line 10'))).toBe(true);
    pane.scrollTop = 150;
    await until(() => drawnOn(b, n.id, textRect(el('c10'), 'Line 10')), 'drawn after scroll');
  });

  test('a page whose content arrives late: the note waits, then attaches', async () => {
    setPage(articleHtml());
    const note = noteAt(toDocRect(el('w-target').getBoundingClientRect()));
    const kv = await seed([note]);
    const html = el('main').innerHTML;
    el('main').innerHTML = '<p>Loading…</p>';
    const rig = await openViewer(kv);
    await rig.viewer.ready;
    expect(rig.viewer.state().tray).toBe(1);
    await rig.cmd();
    expect(rig.v!.tray()[0]!.state).toBe('waiting');
    await wait(200);
    el('main').innerHTML = html;
    await until(() => rig.viewer.state().tray === 0, 'attached');
    await settle();
    expect(centreIn(rig.placed(note.id)!.bbox, toDocRect(el('w-target').getBoundingClientRect()), 6)).toBe(
      true,
    );
  });

  test('the badge shows once the page settles, and opens the tray', async () => {
    setPage(articleHtml());
    const note = noteAt(toDocRect(el('w-target').getBoundingClientRect()));
    const kv = await seed([note]);
    el('p2').remove();
    const rig = await openViewer(kv);
    await rig.viewer.ready;
    await until(() => rig.viewer.state().tray === 1, 'tray');
    expect(rig.v).toBeNull();
    // The badge sits in the closed layer, bottom right, and shows once the page settles.
    // A real click reaches it.
    await wait(QUIET_MS);
    await tapUntil(
      () => [innerWidth - 16 - 14, innerHeight - 16 - 14],
      () => rig.v !== null,
      'the badge',
    );
    expect(rig.v!.tray()[0]!.state).toBe('missing');
    // The bar now shows the count, so the badge goes away.
    const badge = rig.v!.layer.root.querySelector<HTMLElement>('.badge')!;
    await until(() => badge.hidden === true, 'badge hidden');
    expect(rig.v!.layer.root.querySelector('.iu .cnt')?.textContent).toBe('1');
  });
});

describe('page edge markers for moved notes', () => {
  test('a moved note gets a marker at its height, which scrolls with the page and opens the tray on it', async () => {
    setPage(articleHtml(24));
    const note = noteAt(toDocRect(el('w-target').getBoundingClientRect()));
    note.anchor = { ...note.anchor, frac: { x: 0.5, y: 0.6 } };
    const kv = await seed([note]);
    el('p2').remove();
    const rig = await openViewer(kv);
    await rig.viewer.ready;
    await until(() => rig.viewer.state().tray === 1, 'tray');
    await wait(QUIET_MS);
    const html = document.documentElement;
    const y = 0.6 * html.scrollHeight;
    scrollTo(0, y - innerHeight / 2);
    await settle();
    // The marker is in the closed layer, at the right edge, once the page settles. A real click
    // reaches it. WebKit drops a click that comes within about half a second of a scroll, so
    // the tap is repeated until the tools load.
    await tapUntil(
      () => [html.clientWidth - 8, y - scrollY],
      () => rig.v !== null,
      'the marker',
    );
    const root = rig.v!.layer.root;
    await until(() => root.querySelector<HTMLElement>('.iu .tray')?.hidden === false, 'tray open');
    const on = root.querySelectorAll('.iu li[data-on]');
    expect(on.length).toBe(1);
    expect(on[0]!.textContent).toContain(note.anchor.quote.exact);

    const mk = root.querySelector<HTMLButtonElement>('.mks .mk')!;
    expect(mk.title).toContain(note.anchor.quote.exact);
    const r = mk.getBoundingClientRect();
    expect(Math.abs(r.top + r.height / 2 + scrollY - y)).toBeLessThan(2);
    expect(Math.abs(r.right - (html.clientWidth - 2))).toBeLessThan(1);
    // Small and at the edge: it never reaches into the reading column.
    expect(r.width).toBeLessThanOrEqual(12);
    expect(getComputedStyle(root.querySelector('.mks')!).pointerEvents).toBe('none');
    scrollBy(0, 100);
    await frame();
    expect(mk.getBoundingClientRect().top).toBeCloseTo(r.top - 100, 0);
  });

  test('markers wait for the page to settle and leave when the tray is empty', async () => {
    setPage(articleHtml());
    const note = noteAt(toDocRect(el('w-target').getBoundingClientRect()));
    const kv = await seed([note]);
    const p2 = el('p2');
    const parent = p2.parentElement!;
    const next = p2.nextSibling;
    p2.remove();
    const rig = await openViewer(kv);
    await rig.viewer.ready;
    await rig.cmd();
    const root = rig.v!.layer.root;
    const marks = root.querySelector<HTMLElement>('.mks')!;
    expect(marks.hidden).toBe(true);
    await until(() => !marks.hidden && marks.children.length === 1, 'marker shown');
    parent.insertBefore(p2, next);
    await until(() => rig.viewer.state().tray === 0, 'attached');
    await settle();
    expect(marks.hidden).toBe(true);
    expect(marks.children.length).toBe(0);
  });
});

describe('saving', () => {
  test('a stroke is saved at once, so a tab closed right after keeps it', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const rig = await openViewer(kv);
    await rig.cmd();
    await stroke(loop(el('w-target').getBoundingClientRect()));
    await until(() => rig.notes().length === 1, 'note');
    // Frames, idle callbacks and timers up to 300 ms have run. A save behind a longer debounce
    // would still be waiting.
    await quiet();
    expect((await createStore(kv).list())[0]?.notes ?? 0).toBe(1);
  });
});

describe('host options', () => {
  test('hideSiteOff: config.off is ignored, the menu has no site entry and the command does nothing', async () => {
    setPage(articleHtml());
    const kv = await seed([noteAt(toDocRect(el('w-target').getBoundingClientRect()))]);
    const store = createStore(kv);
    const cfg = await store.config();
    const host = pageIdentity(location.href).host;
    await kv.set({ [CFG_KEY]: { ...cfg, off: [host] } });
    const rig = await openViewer(kv, { hideSiteOff: true });
    await rig.viewer.ready;
    expect(rig.viewer.state().off).toBe(false);
    expect(rig.viewer.state().notes).toBe(1);
    const cmd = await rig.cmd();
    const labels = [...rig.v!.layer.root.querySelectorAll('.menu button')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toContain('Print');
    expect(labels.some((l) => /this site/.test(l ?? ''))).toBe(false);
    cmd.setSiteOff(true);
    await quiet();
    expect(rig.viewer.state().off).toBe(false);
    expect(document.querySelector('ink-layer')).not.toBeNull();
    expect((await store.config()).off).toEqual([host]);
  });

  test('config overrides apply in memory and are never saved', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const rig = await openViewer(kv, { config: { penW: 6, barHideMs: 0, theme: 'dark', modifier: 'none' } });
    await rig.cmd();
    expect(rig.v!.config.penW).toBe(6);
    expect(rig.v!.layer.theme()).toBe('dark');
    await stroke(loop(el('w-target').getBoundingClientRect()));
    await until(() => rig.notes().length === 1, 'note');
    expect(rig.notes()[0]!.strokes[0]!.w).toBe(6);
    // A change to settings from the tools writes only what it changes.
    (await rig.cmd()).setSiteOff(false);
    await vi.waitFor(async () => expect((await kv.get([CFG_KEY]))[CFG_KEY]).toBeDefined(), {
      timeout: 15_000,
    });
    await quiet();
    // Neither the overrides nor the defaults reach storage.
    const stored = (await kv.get([CFG_KEY]))[CFG_KEY] as Record<string, unknown>;
    expect(stored.penW).toBeUndefined();
    expect(stored.theme).toBeUndefined();
    expect(stored.barHideMs).toBeUndefined();
    expect(stored.modifier).toBeUndefined();
  });
});

describe('quiet handle', () => {
  test('off by default: a page without notes gets no layer', async () => {
    setPage(articleHtml());
    const rig = await openViewer(memoryKV());
    await rig.viewer.ready;
    // The handle would come from an idle callback, and quiet() waits for those.
    await quiet();
    expect(document.querySelector('ink-layer')).toBeNull();
  });

  test('showHandle: a handle shows once the page is idle, and the tools load only when it is used', async () => {
    setPage(articleHtml());
    const rig = await openViewer(memoryKV(), { showHandle: true });
    await rig.viewer.ready;
    await until(() => !!document.querySelector('ink-layer'), 'layer with the handle');
    await quiet();
    expect(rig.v).toBeNull();
    // Fine pointer: the handle sits on the right edge, half way down.
    await tap(document.documentElement.clientWidth - 4 - 22, innerHeight / 2);
    await until(() => rig.v !== null, 'tools loaded by the handle');
    // The bar has its own handle, so the quiet one goes.
    expect(rig.v!.layer.root.querySelector('.ui > .hdl')).toBeNull();
    expect(rig.v!.layer.root.querySelector('.iu')).not.toBeNull();
  });
});
