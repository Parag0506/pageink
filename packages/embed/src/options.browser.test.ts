// Host page options: the pen toggle rule, data-ink-off inside shadow roots, the site switch and the
// quiet draw handle for lazy tools. These run the source, so the test can see when the tools load.
import type { ViewerInternals } from 'pageink-core/types';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { optionsFrom } from './auto';
import { type InkHandle, type MountOptions, mountWith } from './mount';
import { ARTICLE, finger, fromTest, quiet, recordingKV, stroke, until, zigzag } from './testkit';

const handles: InkHandle[] = [];
beforeAll(async () => {
  await page.viewport(900, 800);
});
afterEach(async () => {
  for (const h of handles.splice(0)) await h.destroy();
  document.body.innerHTML = '';
  window.scrollTo(0, 0);
});

function mounted(o: MountOptions): { h: InkHandle; tools: () => ViewerInternals | null } {
  document.body.innerHTML = ARTICLE;
  window.scrollTo(0, 0);
  let v: ViewerInternals | null = null;
  const h = mountWith(o, { onInternals: (x) => (v = x), real: fromTest });
  handles.push(h);
  return { h, tools: () => v };
}

async function writeBeside(id: string): Promise<void> {
  const r = document.getElementById(id)!.getBoundingClientRect();
  await stroke(zigzag(r.right + 20, r.top + 4, 80, 20));
}

describe('options', () => {
  test('the tag reads data-pen-needs-toggle and data-handle', () => {
    const el = document.createElement('script');
    el.setAttribute('data-pen-needs-toggle', '');
    el.setAttribute('data-handle', 'false');
    expect(optionsFrom(el)).toEqual({ penNeedsToggle: true, handle: false });
  });

  test('penNeedsToggle: the pen writes only with the toggle, and its events reach the page', async () => {
    const { h } = mounted({ store: recordingKV(), penNeedsToggle: true });
    await h.ready;
    let downs = 0;
    document.getElementById('p1')!.addEventListener('pointerdown', () => downs++);
    const r = document.getElementById('p1')!.getBoundingClientRect();
    await stroke(zigzag(r.left + 40, r.top + 4, 80, 20));
    await quiet();
    expect(downs).toBe(1);
    expect(h.state().notes).toBe(0);
    await h.draw(true);
    await writeBeside('p1');
    await until(() => h.state().notes === 1, 'pen note with the toggle');
  });

  test('data-ink-off inside a shadow root keeps pen and finger gestures for the page', async () => {
    const { h } = mounted({ store: recordingKV() });
    const box = document.createElement('div');
    box.setAttribute('data-ink-off', '');
    box.style.cssText = 'position:absolute;left:20px;top:420px';
    const sr = box.attachShadow({ mode: 'open' });
    const pad = document.createElement('div');
    pad.style.cssText = 'width:300px;height:120px';
    sr.append(pad);
    document.body.append(box);
    // A surface marked inside a shadow root of an unmarked host.
    const host2 = document.createElement('div');
    host2.style.cssText = 'position:absolute;left:400px;top:420px';
    const sr2 = host2.attachShadow({ mode: 'open' });
    const marked = document.createElement('div');
    marked.setAttribute('data-ink-off', '');
    marked.style.cssText = 'width:300px;height:120px;background:#ddd';
    sr2.append(marked);
    document.body.append(host2);
    await h.ready;
    let downs = 0;
    pad.addEventListener('pointerdown', () => downs++);
    marked.addEventListener('pointerdown', () => downs++);
    await stroke(zigzag(60, 450, 160, 40));
    await stroke(zigzag(440, 450, 160, 40));
    await h.draw(true);
    await finger(zigzag(60, 450, 160, 40));
    await quiet();
    expect(downs).toBe(3);
    expect(h.state().notes).toBe(0);
  });

  test('a host in the stored off list still gets ink: the site owns that choice', async () => {
    const kv = recordingKV();
    await kv.set({ cfg: { v: 1, device: 'd', off: [location.hostname] } });
    const { h } = mounted({ store: kv });
    await h.ready;
    expect(h.state().off).toBe(false);
    await writeBeside('p0');
    await until(() => h.state().notes === 1, 'note');
  });
});

describe('lazy tools and the draw handle', () => {
  test('the handle shows once the page is idle; the tools load only when it is used', async () => {
    const { h, tools } = mounted({ store: recordingKV(), tools: 'lazy' });
    await h.ready;
    await until(() => !!document.querySelector('ink-layer'), 'the handle');
    await quiet();
    expect(tools()).toBeNull();
    // A mouse reader: the handle is on the right edge, half way down.
    const x = document.documentElement.clientWidth - 4 - 22;
    await stroke([[x, innerHeight / 2]], 'mouse');
    await until(() => tools() !== null, 'tools loaded by the handle');
    await h.draw(true);
    await stroke(zigzag(100, 200, 120, 30), 'mouse');
    await until(() => h.state().notes === 1, 'mouse note');
  });

  test('handle: false leaves the page alone until something asks for the tools', async () => {
    const { h, tools } = mounted({ store: recordingKV(), tools: 'lazy', handle: false });
    await h.ready;
    await quiet();
    expect(document.querySelector('ink-layer')).toBeNull();
    expect(tools()).toBeNull();
  });
});
