// What the reader sees and keeps: draw mode remembered per site, private windows, pictures
// of blank areas, the one-time hint and the pen that needs the toggle.
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { memoryKV } from '../store/memory';
import type { InkConfig, KV } from '../types';
import {
  articleHtml,
  closeAll,
  frame,
  loop,
  openViewer,
  quiet,
  type Rig,
  setPage,
  stroke,
  tap,
  textRect,
  until,
  wait,
} from './testkit';
import { FIRST_HINT } from './tools';
import { DRAW_TIP } from './view';

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
const cfgOf = async (kv: KV): Promise<Partial<InkConfig>> =>
  ((await kv.get(['cfg'])).cfg ?? {}) as Partial<InkConfig>;
const host = location.hostname;
const q = (rig: Rig, sel: string) => rig.v!.layer.root.querySelector<HTMLElement>(sel)!;
const records = async (kv: KV) => kv.keys('p:');

async function waitFor(f: () => Promise<boolean>, label: string): Promise<void> {
  const end = performance.now() + 15_000;
  while (!(await f())) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${label}`);
    await frame();
  }
}

describe('draw mode remembered per site', () => {
  test('on at a site is kept, comes back on with the bar saying so, and Esc turns it off for good', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const rig = await openViewer(kv);
    const cmd = await rig.cmd();
    cmd.setDraw(true);
    await waitFor(async () => !!(await cfgOf(kv)).drawOn?.includes(host), 'drawOn saved');
    closeAll();

    const again = await openViewer(kv);
    await until(() => again.viewer.state().draw, 'draw back on');
    expect(again.viewer.state().tip).toBe(DRAW_TIP);
    expect(q(again, '.iu').classList.contains('hid')).toBe(false);
    expect(q(again, 'button.draw').getAttribute('aria-pressed')).toBe('true');
    expect(q(again, '.note .msg').textContent).toBe(DRAW_TIP);
    // Never trapped: Esc turns it off, and the site is forgotten.
    await userEvent.keyboard('{Escape}');
    expect(again.viewer.state().draw).toBe(false);
    await waitFor(async () => !(await cfgOf(kv)).drawOn?.includes(host), 'drawOn cleared');
    closeAll();
    const third = await openViewer(kv);
    await third.viewer.ready;
    await quiet();
    expect(third.viewer.state().draw).toBe(false);
  });

  test('with remembering off nothing is stored and nothing comes back', async () => {
    setPage(articleHtml());
    const kv = memoryKV({ cfg: { v: 1, device: 'd', rememberDraw: false, drawOn: [host] } });
    const rig = await openViewer(kv);
    await rig.viewer.ready;
    await quiet();
    expect(rig.viewer.state().draw).toBe(false);
    const cmd = await rig.cmd();
    cmd.setDraw(true);
    cmd.setDraw(false);
    cmd.setDraw(true);
    await quiet();
    expect((await cfgOf(kv)).drawOn).toEqual([host]);
  });

  test('a link still works with a plain click while draw mode is on', async () => {
    setPage(`${articleHtml()}<a id="go" href="#went" style="display:block;margin:20px 60px">Go there</a>`);
    const rig = await openViewer();
    const cmd = await rig.cmd();
    cmd.setDraw(true);
    const clicked = vi.fn((e: Event) => e.preventDefault());
    el('go').addEventListener('click', clicked);
    await userEvent.click(el('go'));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(rig.notes()).toHaveLength(0);
  });
});

describe('private windows', () => {
  test('ink works but nothing is saved, and the bar says so', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const set = vi.spyOn(kv, 'set');
    const rig = await openViewer(kv, { private: true });
    const cmd = await rig.cmd();
    expect(rig.viewer.state().memoryOnly).toBe(true);
    await stroke(loop(textRect(el('p1'), 'Paragraph 1')));
    await until(() => rig.notes().length === 1, 'note in memory');
    cmd.setDraw(true);
    cmd.setDraw(false);
    await quiet();
    expect(await records(kv)).toEqual([]);
    expect(set).not.toHaveBeenCalled();
    const pv = q(rig, '.note .pv');
    expect(pv.hidden).toBe(false);
    expect(pv.textContent).toBe('Not saved in private windows');
  });

  test('kept when the reader chose to keep private ink', async () => {
    setPage(articleHtml());
    const kv = memoryKV({ cfg: { v: 1, device: 'd', privateKeep: true } });
    const rig = await openViewer(kv, { private: true });
    await rig.cmd();
    expect(rig.viewer.state().memoryOnly).toBeUndefined();
    await stroke(loop(textRect(el('p1'), 'Paragraph 1')));
    await waitFor(async () => (await records(kv)).length === 1, 'saved');
  });
});

describe('device id', () => {
  test('a viewer that made an id writes with the one another tab stored', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const rig = await openViewer(kv);
    await rig.cmd();
    await quiet();
    // Another tab made its own id at the same moment, and its write landed last.
    await kv.set({ cfg: { v: 1, device: 'other-tab' } });
    await quiet();
    await stroke(loop(textRect(el('p1'), 'Paragraph 1')));
    await until(() => rig.notes().length === 1, 'note');
    expect(rig.notes()[0]?.device).toBe('other-tab');
  });
});

describe('pictures of blank areas', () => {
  const blank = '<div id="blank" style="height:2400px"></div>';
  const shot = (): string => {
    const c = document.createElement('canvas');
    c.width = 900;
    c.height = 800;
    const g = c.getContext('2d')!;
    g.fillStyle = '#c33';
    g.fillRect(0, 0, 900, 800);
    return c.toDataURL('image/png');
  };

  async function blankNote(cfg: Partial<InkConfig>, answers: (string | undefined)[] = []) {
    setPage(blank);
    const kv = memoryKV({ cfg: { v: 1, device: 'd', ...cfg } });
    let asked = 0;
    // Each call takes the next answer. After the listed ones, a picture.
    const captureVisible = vi.fn(async () => (asked < answers.length ? answers[asked++] : shot()));
    const rig = await openViewer(kv, { hooks: { captureVisible } });
    await rig.cmd();
    await stroke(loop({ left: 300, top: 300, width: 80, height: 40 }));
    await until(() => rig.notes().length === 1, 'note');
    expect(rig.notes()[0]!.anchor.type).toBe('viewport');
    return { rig, captureVisible };
  }

  test('a note on a blank area gets a small picture by default', async () => {
    const { rig } = await blankNote({});
    await until(() => !!rig.notes()[0]!.thumb, 'thumb');
  });

  test('a picture the browser refuses at first is asked for again', async () => {
    const { rig, captureVisible } = await blankNote({}, [undefined, undefined]);
    await until(() => !!rig.notes()[0]!.thumb, 'thumb', 6000);
    expect(captureVisible).toHaveBeenCalledTimes(3);
  });

  test('after three refusals it stops asking and the note has no picture', async () => {
    const { rig, captureVisible } = await blankNote({}, [undefined, undefined, undefined, undefined]);
    await until(() => captureVisible.mock.calls.length === 3, 'three asks', 6000);
    await wait(2000);
    expect(captureVisible).toHaveBeenCalledTimes(3);
    expect(rig.notes()[0]!.thumb).toBeUndefined();
  });

  test('with pictures off none is taken or stored', async () => {
    const { rig, captureVisible } = await blankNote({ thumbs: false });
    await quiet();
    expect(captureVisible).not.toHaveBeenCalled();
    expect(rig.notes()[0]!.thumb).toBeUndefined();
  });
});

describe('the first ink', () => {
  test('a one-line hint shows once, goes with the next action and never comes back', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const rig = await openViewer(kv);
    await rig.cmd();
    await stroke(loop(textRect(el('p1'), 'Paragraph 1')));
    await until(() => rig.viewer.state().tip === FIRST_HINT, 'hint');
    expect(q(rig, '.note .msg').textContent).toBe(FIRST_HINT);
    expect(q(rig, '.note').hidden).toBe(false);
    await waitFor(async () => (await cfgOf(kv)).hinted === true, 'hinted saved');
    await wait(1600);
    await stroke(loop(textRect(el('p3'), 'Paragraph 3')));
    await until(() => rig.notes().length === 2, 'second');
    expect(rig.viewer.state().tip).toBeUndefined();
    expect(q(rig, '.note').hidden).toBe(true);
    closeAll();
    const again = await openViewer(kv);
    await again.cmd();
    await stroke(loop(textRect(el('p5'), 'Paragraph 5')));
    await until(() => again.notes().length === 3, 'third');
    await quiet();
    expect(again.viewer.state().tip).toBeUndefined();
  });
});

describe('a pen that needs the toggle', () => {
  test('the setting holds: no ink until draw mode is on', async () => {
    setPage(articleHtml());
    const kv = memoryKV({ cfg: { v: 1, device: 'd', penNeedsToggle: true } });
    const rig = await openViewer(kv);
    const cmd = await rig.cmd();
    await stroke(loop(textRect(el('p1'), 'Paragraph 1')));
    await quiet();
    expect(rig.notes()).toHaveLength(0);
    cmd.setDraw(true);
    await stroke(loop(textRect(el('p1'), 'Paragraph 1')));
    await until(() => rig.notes().length === 1, 'note');
  });
});

async function openTrayOf(rig: Rig): Promise<void> {
  const b = rig.v!.layer.root.querySelector<HTMLButtonElement>('button[aria-controls="iu-tray"]')!;
  expect(b.hidden).toBe(false);
  const r = b.getBoundingClientRect();
  await tap(r.left + r.width / 2, r.top + r.height / 2, 'mouse');
}

describe('translated pages', () => {
  /** Swap every paragraph's words, as a browser translation does, and mark <html> its way. */
  function translate(mark: (html: HTMLElement) => void): () => void {
    const html = document.documentElement;
    const before = new Map<Element, string>();
    for (const p of document.querySelectorAll('main p')) {
      before.set(p, p.innerHTML);
      p.textContent = `Absatz ${p.id} übersetzt, ganz andere Wörter stehen jetzt hier.`;
    }
    const cls = html.className;
    const lang = html.getAttribute('lang');
    mark(html);
    return () => {
      for (const [p, h] of before) p.innerHTML = h;
      html.className = cls;
      if (lang === null) html.removeAttribute('lang');
      else html.setAttribute('lang', lang);
    };
  }

  for (const [name, mark] of [
    ['Chromium', (h: HTMLElement) => h.classList.add('translated-ltr')],
    ['Firefox and Safari', (h: HTMLElement) => h.setAttribute('lang', 'de')],
  ] as const) {
    test(`${name}: notes are held, listed apart in the tray, and return with the original`, async () => {
      document.documentElement.setAttribute('lang', 'en');
      setPage(articleHtml());
      const rig = await openViewer(memoryKV());
      await rig.cmd();
      await stroke(loop(textRect(el('p1'), 'Paragraph 1')));
      await until(() => rig.notes().length === 1, 'note');
      const id = rig.notes()[0]!.id;
      await until(() => !!rig.placed(id), 'placed');
      const undo = translate(mark);
      try {
        await until(() => (rig.viewer.state().held ?? 0) === 1, 'held');
        expect(rig.viewer.state().tray).toBe(0);
        expect(rig.v!.tray().map((t) => t.state)).toEqual(['translated']);
        // The tray button shows for held notes, and a real click opens it.
        await openTrayOf(rig);
        const sub = q(rig, '.tray .sub');
        expect(sub.hidden).toBe(false);
        expect(sub.textContent).toBe('Hidden while the page is translated');
        expect(q(rig, '.tray ul.held').children).toHaveLength(1);
        // No page edge markers and no badge: the note is not missing.
        expect(rig.v!.layer.root.querySelectorAll('.mks .mk')).toHaveLength(0);
      } finally {
        undo();
      }
      await until(() => !!rig.placed(id) && !rig.viewer.state().held, 'back');
      expect(rig.viewer.state().tray).toBe(0);
      document.documentElement.removeAttribute('lang');
    });
  }
});
