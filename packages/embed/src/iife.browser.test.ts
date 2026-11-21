// The built dist/pageink.js in a page: auto mount, pen input, stores, page keys, input rules, exports.
import { hashKey } from 'pageink-core';
import { FORMER_GLOBALS, GLOBAL } from 'pageink-core/brand';
import type { PageRecord } from 'pageink-core/types';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import source from '../dist/pageink.js?raw';
import type { InkHandle } from './mount';
import {
  ARTICLE,
  clean,
  finger,
  type InkGlobal,
  isChromium,
  loadInk,
  quiet,
  recordingKV,
  touchEmulation,
  until,
  write,
  zigzag,
} from './testkit';

/** Runs in Chromium only, for the reason in NEEDS_TRUSTED_PEN in testkit.ts. */
const penTest = test.runIf(isChromium);

beforeAll(async () => {
  await page.viewport(900, 800);
});
afterAll(async () => {
  await page.viewport(414, 896);
});

const handles: InkHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.destroy();
  await clean();
});

/** A same-origin frame that runs the built script after the given page script. */
function frameWith(before = ''): Window {
  const f = document.createElement('iframe');
  document.body.append(f);
  const d = f.contentDocument!;
  for (const text of [before, source]) {
    if (!text) continue;
    const s = d.createElement('script');
    s.textContent = text;
    d.body.append(s);
  }
  return f.contentWindow!;
}

function setup(attrs: Record<string, string> = {}): InkGlobal {
  document.body.innerHTML = ARTICLE;
  window.scrollTo(0, 0);
  return loadInk(attrs);
}

function mounted(Ink: InkGlobal, o: Parameters<InkGlobal['mount']>[0]): InkHandle {
  const h = Ink.mount(o);
  handles.push(h);
  return h;
}

/** A zigzag in the right margin of a paragraph. */
async function writeBeside(id: string): Promise<void> {
  const r = document.getElementById(id)!.getBoundingClientRect();
  await write(zigzag(r.right + 20, r.top + 4, 80, 20));
}

describe('auto mount from the script tag', () => {
  test('mounts, takes pen ink, and the ink is back after destroy and a new mount', async () => {
    const Ink = setup({ 'data-ink': '', 'data-store': 'local' });
    const h = Ink.auto!;
    expect(h).toBeTruthy();
    await h.ready;
    expect(document.querySelector('ink-layer')).toBeTruthy();
    expect(h.state().notes).toBe(0);

    await writeBeside('p0');
    await until(() => h.state().notes === 1, 'one note');
    await h.destroy();
    expect(document.querySelector('ink-layer')).toBeNull();

    for (const s of document.querySelectorAll('script[data-ink]')) s.remove();
    const Again = loadInk({ 'data-ink': '', 'data-store': 'local' });
    const h2 = Again.auto!;
    await h2.ready;
    await until(() => h2.state().notes === 1, 'the note back');
    expect(document.querySelector('ink-layer')).toBeTruthy();
  });

  test('the default store is IndexedDB and survives a new mount', async () => {
    const Ink = setup({ 'data-ink': '' });
    const h = Ink.auto!;
    await h.ready;
    await writeBeside('p1');
    await until(() => h.state().notes === 1, 'one note');
    await h.destroy();
    expect(Object.keys(localStorage)).toEqual([]);

    for (const s of document.querySelectorAll('script[data-ink]')) s.remove();
    const h2 = loadInk({ 'data-ink': '' }).auto!;
    await h2.ready;
    await until(() => h2.state().notes === 1, 'the note back from IndexedDB');
  });

  test('the global has the product name, and the former name still works', () => {
    const g = setup();
    expect(GLOBAL).toBe('PageInk');
    expect((window as unknown as Record<string, unknown>)[GLOBAL]).toBe(g);
    expect(FORMER_GLOBALS).toContain('Ink');
    // A fresh frame, so no other script has used the old names yet.
    const win = frameWith();
    const w = win as unknown as Record<string, unknown>;
    const said: string[] = [];
    (win as unknown as { console: Console }).console.warn = (...a: unknown[]) => void said.push(a.join(' '));
    const now = w[GLOBAL] as InkGlobal;
    expect(typeof now.mount).toBe('function');
    for (const old of FORMER_GLOBALS) {
      expect(w[old]).toBe(now);
      expect(w[old]).toBe(now);
    }
    expect(said).toHaveLength(FORMER_GLOBALS.length);
    expect(said[0]).toMatch(/deprecated/);
  });

  test('a page that has its own global under a former name keeps it', () => {
    const w = frameWith('var Ink = 42;') as unknown as Record<string, unknown>;
    expect(w.Ink).toBe(42);
    expect(typeof (w[GLOBAL] as InkGlobal).mount).toBe('function');
  });

  test('data attributes become options', () => {
    const Ink = setup();
    expect(Ink.auto).toBeNull();
    const el = document.createElement('script');
    el.setAttribute('data-store', 'local');
    el.setAttribute('data-page', 'lesson-3');
    el.setAttribute('data-pen-only', 'false');
    el.setAttribute('data-theme', 'dark');
    el.setAttribute('data-tools', 'lazy');
    el.setAttribute('data-bar-hide-ms', '2500');
    el.setAttribute('data-modifier', 'Meta');
    expect(Ink.optionsFrom(el)).toEqual({
      store: 'local',
      page: 'lesson-3',
      penOnly: false,
      theme: 'dark',
      tools: 'lazy',
      barHideMs: 2500,
      modifier: 'Meta',
    });
  });

  test('a second mount while one is live is refused', async () => {
    const Ink = setup();
    const h = mounted(Ink, { store: recordingKV() });
    expect(() => Ink.mount({ store: recordingKV() })).toThrow(/already mounted/);
    await h.ready;
  });
});

describe('stores', () => {
  test('a custom KV receives the record, index and settings keys', async () => {
    const Ink = setup();
    const kv = recordingKV();
    const h = mounted(Ink, { store: kv, page: 'lesson-1', theme: 'dark' });
    await h.ready;
    await writeBeside('p0');
    await until(() => kv.data.has(`p:${hashKey('lesson-1')}`), 'record saved');
    const rec = kv.data.get(`p:${hashKey('lesson-1')}`) as PageRecord;
    expect(rec.v).toBe(1);
    expect(rec.key).toBe('lesson-1');
    expect(rec.notes).toHaveLength(1);
    expect(rec.notes[0]!.strokes[0]!.d.length).toBeGreaterThan(10);
    expect(kv.written).toContain('cfg');
    expect(kv.written).toContain(`idx:${hashKey(location.hostname)}`);
    expect([...kv.data.keys()].every((k) => k === 'cfg' || /^(p|idx):[0-9a-z]+$/.test(k))).toBe(true);
    // Options apply without being written into the stored settings.
    expect(h.state().theme).toBe('dark');
    expect((kv.data.get('cfg') as { theme?: string }).theme).toBeUndefined();
  });

  test('draw mode is kept for the site through the embed store, and comes back on', async () => {
    const Ink = setup();
    const kv = recordingKV();
    let h = mounted(Ink, { store: kv, page: 'lesson-d' });
    await h.ready;
    await h.draw(true);
    await until(
      () =>
        ((kv.data.get('cfg') as { drawOn?: string[] } | undefined)?.drawOn ?? []).includes(location.hostname),
      'drawOn saved',
    );
    // Only that setting is written: defaults stay out of the store.
    expect((kv.data.get('cfg') as { theme?: string }).theme).toBeUndefined();
    await h.destroy();
    h = mounted(Ink, { store: kv, page: 'lesson-d' });
    await h.ready;
    await until(() => h.state().draw, 'draw back on');
  });

  test('the page option keeps records apart', async () => {
    const Ink = setup();
    const kv = recordingKV();
    let h = mounted(Ink, { store: kv, page: 'lesson-a' });
    await h.ready;
    await writeBeside('p0');
    await until(() => h.state().notes === 1, 'note on lesson a');
    await h.destroy();

    h = mounted(Ink, { store: kv, page: 'lesson-b' });
    await h.ready;
    await quiet();
    expect(h.state().notes).toBe(0);
    await h.destroy();

    h = mounted(Ink, { store: kv });
    await h.ready;
    await quiet();
    expect(h.state().notes).toBe(0);
    await h.destroy();

    h = mounted(Ink, { store: kv, page: 'lesson-a' });
    await h.ready;
    await until(() => h.state().notes === 1, 'lesson a again');
  });

  test('change events follow this page only', async () => {
    const Ink = setup();
    const kv = recordingKV();
    const h = mounted(Ink, { store: kv, page: 'lesson-c' });
    await h.ready;
    let n = 0;
    h.on('change', () => n++);
    await kv.set({ [`p:${hashKey('elsewhere')}`]: { v: 1 } });
    await quiet();
    expect(n).toBe(0);
    await writeBeside('p0');
    await until(() => n > 0, 'change event');
  });
});

describe('input rules', () => {
  beforeAll(async () => {
    await touchEmulation(true);
  });
  afterAll(async () => {
    await touchEmulation(false);
  });

  const swipe = (id: string): Promise<void> => {
    const r = document.getElementById(id)!.getBoundingClientRect();
    const pts: [number, number][] = [];
    for (let i = 0; i <= 10; i++) pts.push([r.left + 40 + i * 12, r.top + 10 + (i % 2) * 14]);
    return finger(pts);
  };

  penTest('penOnly true: a pen writes without the toggle, a finger does not', async () => {
    const Ink = setup();
    const h = mounted(Ink, { store: recordingKV() });
    await h.ready;
    await swipe('p0');
    await quiet();
    expect(h.state().notes).toBe(0);
    await writeBeside('p1');
    await until(() => h.state().notes === 1, 'pen note');
  });

  penTest('penOnly false: touch and pen draw only with the toggle', async () => {
    const Ink = setup();
    const h = mounted(Ink, { store: recordingKV(), penOnly: false });
    await h.ready;
    await swipe('p0');
    await writeBeside('p1');
    await quiet();
    expect(h.state().notes).toBe(0);

    await h.draw(true);
    expect(h.state().draw).toBe(true);
    await swipe('p0');
    await until(() => h.state().notes === 1, 'touch note');
    await writeBeside('p2');
    await until(() => h.state().notes === 2, 'pen note with the toggle');
  });

  test('gestures that start inside data-ink-off reach the page and leave no ink', async () => {
    const Ink = setup();
    const h = mounted(Ink, { store: recordingKV() });
    await h.ready;
    const code = document.getElementById('code')!;
    let downs = 0;
    code.addEventListener('pointerdown', () => downs++);
    const r = code.getBoundingClientRect();
    await write(zigzag(r.left + 20, r.top + 20, 160, 40));
    await quiet();
    expect(downs).toBe(1);
    expect(h.state().notes).toBe(0);

    // A stroke that starts outside may cross it.
    const p = document.getElementById('p1')!.getBoundingClientRect();
    await write(zigzag(r.left + 300, p.top + 6, 60, r.top + 30 - (p.top + 6)));
    await until(() => h.state().notes === 1, 'ink from outside');
    expect(downs).toBe(1);
  });

  penTest('lazy tools load on the first pen stroke and keep it', async () => {
    const Ink = setup();
    const h = mounted(Ink, { store: recordingKV(), tools: 'lazy' });
    await h.ready;
    expect(document.querySelector('ink-layer')).toBeNull();
    await writeBeside('p0');
    await until(() => h.state().notes === 1, 'first stroke kept');
  });
});

describe('exports and archives', () => {
  test('markdown and png', async () => {
    const Ink = setup();
    document.title = 'Rivers';
    const h = mounted(Ink, { store: recordingKV(), page: 'rivers' });
    await h.ready;
    await writeBeside('p0');
    await until(() => h.state().notes === 1, 'note');
    const md = await h.export.markdown();
    expect(md).toMatch(/^# Notes/);
    expect(md).toContain('## Rivers');
    expect(md).toContain('Handwriting');

    const png = await h.export.png();
    expect(png.type).toBe('image/png');
    const bmp = await createImageBitmap(png);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let inked = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) inked++;
    expect(inked).toBeGreaterThan(20);
  });

  test('archive export and import', async () => {
    const Ink = setup();
    let h = mounted(Ink, { store: recordingKV(), page: 'arch' });
    await h.ready;
    await writeBeside('p0');
    await until(() => h.state().notes === 1, 'note');
    const zip = await h.export.archive();
    expect([zip[0], zip[1]]).toEqual([0x50, 0x4b]);
    await h.destroy();

    h = mounted(Ink, { store: recordingKV(), page: 'arch' });
    await h.ready;
    expect(h.state().notes).toBe(0);
    const r = await h.importArchive(zip.slice().buffer);
    expect(r.errors).toEqual([]);
    await until(() => h.state().notes === 1, 'note from the archive');
  });
});
