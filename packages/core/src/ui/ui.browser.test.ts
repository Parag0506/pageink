import { afterEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { quiet, until } from '../testkit';
import type { Front, InkState, Ui } from '../types';
import { type FakeHost, fakeHost } from './fake';
import { createUi, resetUiSession } from './index';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  resetUiSession();
});

function setup(opts: { barHideMs?: number; state?: Partial<InkState>; strict?: boolean } = {}) {
  const mount = document.createElement('div');
  document.body.append(mount);
  const host = fakeHost(mount, opts);
  const ui = createUi(host);
  cleanup.push(() => {
    ui.destroy();
    mount.remove();
  });
  const q = <T extends Element = HTMLButtonElement>(sel: string) => mount.querySelector(sel) as T;
  const b = (label: string) => q(`button[aria-label="${label}"]`);
  return { mount, host, ui, q, b, root: q<HTMLElement>('.iu') };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true, ...init }),
  );
const tap = (el: Element, pointerType = 'pen') => {
  const o = { bubbles: true, composed: true, pointerType, pointerId: 7, isPrimary: true };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  // The browser follows with a click; it must not act a second time.
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, detail: 1 }));
};

describe('styles under a strict style-src', () => {
  test('the bar adopts one sheet on its shadow root and removes it on destroy', () => {
    const hostEl = document.createElement('div');
    document.body.append(hostEl);
    const shadow = hostEl.attachShadow({ mode: 'closed' });
    const mount = document.createElement('div');
    shadow.append(mount);
    const ui = createUi(fakeHost(mount));
    try {
      expect(shadow.querySelectorAll('style').length).toBe(0);
      expect(shadow.adoptedStyleSheets.length).toBe(1);
      const bar = mount.querySelector<HTMLElement>('.bar')!;
      // The sheet applies: the bar is a fixed flex box.
      expect(getComputedStyle(bar).position).toBe('fixed');
      expect(getComputedStyle(bar).display).toBe('flex');
      ui.destroy();
      expect(shadow.adoptedStyleSheets.length).toBe(0);
    } finally {
      ui.destroy();
      hostEl.remove();
    }
  });
});

describe('pages that stop events at the window', () => {
  test('a click on the bar still acts once, through the front', () => {
    const hostEl = document.createElement('div');
    document.body.append(hostEl);
    const shadow = hostEl.attachShadow({ mode: 'closed' });
    const mount = document.createElement('div');
    shadow.append(mount);
    const subs = new Map<string, ((e: Event) => void)[]>();
    const relay = (e: Event) => {
      for (const f of subs.get(e.type) ?? []) f(e);
    };
    const stop = (e: Event) => e.stopImmediatePropagation();
    window.addEventListener('click', relay, true);
    window.addEventListener('click', stop, true);
    const host = {
      ...fakeHost(mount, { state: { canUndo: true } }),
      front: {
        on(type: string, fn: (e: Event) => void) {
          subs.set(type, [...(subs.get(type) ?? []), fn]);
          return () =>
            subs.set(
              type,
              (subs.get(type) ?? []).filter((x) => x !== fn),
            );
        },
      } as Front,
    };
    const ui = createUi(host);
    try {
      const undo = mount.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')!;
      const r = undo.getBoundingClientRect();
      const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, detail: 1 };
      undo.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, ...at }));
      expect(host.cmd.undo).toHaveBeenCalledTimes(1);
      // Without the page in the way, the bar's own listener sees it too, and it still acts once.
      window.removeEventListener('click', stop, true);
      undo.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, ...at }));
      expect(host.cmd.undo).toHaveBeenCalledTimes(2);
      ui.destroy();
      expect([...subs.values()].every((l) => l.length === 0)).toBe(true);
    } finally {
      window.removeEventListener('click', relay, true);
      window.removeEventListener('click', stop, true);
      ui.destroy();
      hostEl.remove();
    }
  });
});

describe('bar theme', () => {
  test('follows the ink theme by default, and a host theme when one is given', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    const inkLight = fakeHost(a, { state: { theme: 'light' } });
    const own = { ...fakeHost(b, { state: { theme: 'light' } }), uiTheme: 'dark' as const };
    const u1 = createUi(inkLight);
    const u2 = createUi(own);
    try {
      expect(a.querySelector('.iu')?.getAttribute('data-theme')).toBe('light');
      // Dark chrome around white paper: the bar is dark, the ink keeps its light colours.
      expect(b.querySelector('.iu')?.getAttribute('data-theme')).toBe('dark');
      own.set({ theme: 'light' });
      expect(b.querySelector('.iu')?.getAttribute('data-theme')).toBe('dark');
    } finally {
      u1.destroy();
      u2.destroy();
      a.remove();
      b.remove();
    }
  });

  test('auto follows the reader colour scheme', () => {
    const a = document.createElement('div');
    document.body.append(a);
    const host = { ...fakeHost(a), uiTheme: 'auto' as const };
    const u = createUi(host);
    try {
      const want = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      expect(a.querySelector('.iu')?.getAttribute('data-theme')).toBe(want);
    } finally {
      u.destroy();
      a.remove();
    }
  });
});

describe('bar', () => {
  test('is a labelled toolbar and every control is a button with a label and a title', () => {
    const { mount, q } = setup({ state: { tray: 2 } });
    const bar = q<HTMLElement>('.bar');
    expect(bar.getAttribute('role')).toBe('toolbar');
    expect(bar.getAttribute('aria-label')).toBe('PageInk tools');
    const all = [...mount.querySelectorAll('button')];
    expect(all.length).toBeGreaterThan(15);
    for (const el of all) {
      expect(el.getAttribute('type')).toBe('button');
      expect(el.getAttribute('aria-label'), el.outerHTML).toBeTruthy();
      expect(el.title, el.outerHTML).toBeTruthy();
    }
    for (const t of mount.querySelectorAll('.iu *'))
      expect(t.textContent ?? '').not.toContain(String.fromCharCode(0x2014));
  });

  test('each bar button calls the right command', () => {
    const { host, b, q } = setup({ state: { canUndo: true, canRedo: true } });
    q('.draw').click();
    expect(host.cmd.setDraw).toHaveBeenLastCalledWith(true);
    q('.draw').click();
    expect(host.cmd.setDraw).toHaveBeenLastCalledWith(false);
    b('Pen, second colour').click();
    expect(host.cmd.setTool).toHaveBeenLastCalledWith('pen');
    expect(host.cmd.setColor).toHaveBeenLastCalledWith('ink-2');
    b('Pen, first colour').click();
    expect(host.cmd.setColor).toHaveBeenLastCalledWith('ink-1');
    b('Highlighter').click();
    expect(host.cmd.setTool).toHaveBeenLastCalledWith('hi');
    expect(host.cmd.setColor).toHaveBeenLastCalledWith('hi-1');
    b('Eraser').click();
    expect(host.cmd.setTool).toHaveBeenLastCalledWith('eraser');
    b('Lasso').click();
    expect(host.cmd.setTool).toHaveBeenLastCalledWith('lasso');
    b('Undo').click();
    b('Redo').click();
    expect(host.cmd.undo).toHaveBeenCalledOnce();
    expect(host.cmd.redo).toHaveBeenCalledOnce();
  });

  test('state changes update the bar in place', () => {
    const { host, b, q } = setup({ state: { tray: 0 } });
    const draw = q('.draw');
    const undo = b('Undo');
    expect(draw.getAttribute('aria-pressed')).toBe('false');
    expect(undo.getAttribute('aria-disabled')).toBe('true');
    expect(b('Redo').getAttribute('aria-disabled')).toBe('true');
    expect(b('Pen, first colour').getAttribute('aria-pressed')).toBe('true');
    const tray = q('button[aria-haspopup=dialog]');
    expect(tray.hidden).toBe(true);

    host.set({ draw: true, canUndo: true, tool: 'eraser', tray: 3 });
    expect(q('.draw')).toBe(draw);
    expect(b('Undo')).toBe(undo);
    expect(draw.getAttribute('aria-pressed')).toBe('true');
    expect(undo.getAttribute('aria-disabled')).toBe('false');
    expect(b('Eraser').getAttribute('aria-pressed')).toBe('true');
    expect(b('Pen, first colour').getAttribute('aria-pressed')).toBe('false');
    expect(tray.hidden).toBe(false);
    expect(tray.getAttribute('aria-label')).toBe('Moved notes, 3');
    expect(tray.querySelector('.cnt')?.textContent).toBe('3');
  });

  test('disabled undo and redo do nothing', () => {
    const { host, b } = setup();
    b('Undo').click();
    b('Redo').click();
    expect(host.cmd.undo).not.toHaveBeenCalled();
    expect(host.cmd.redo).not.toHaveBeenCalled();
  });

  test('swatches use host colours and follow the theme', () => {
    const { host, q } = setup();
    const sw = q<HTMLElement>('.sw');
    expect(getComputedStyle(sw).backgroundColor).toBe('rgb(20, 20, 20)');
    host.set({ theme: 'dark' });
    expect(getComputedStyle(sw).backgroundColor).toBe('rgb(240, 240, 240)');
    expect(q('.iu').getAttribute('data-theme')).toBe('dark');
    expect(getComputedStyle(q<HTMLElement>('.hib')).backgroundColor).toBe('rgb(150, 130, 0)');
  });

  test('a pen tap acts on pointerup and the click after it is ignored', () => {
    const { host, b } = setup();
    tap(b('Eraser'), 'pen');
    expect(host.cmd.setTool).toHaveBeenCalledTimes(1);
    expect(host.cmd.setTool).toHaveBeenLastCalledWith('eraser');
    tap(b('Lasso'), 'touch');
    expect(host.cmd.setTool).toHaveBeenCalledTimes(2);
  });

  test('a finger that moves before lifting does not act', () => {
    const { host, b } = setup();
    const o = { bubbles: true, composed: true, pointerType: 'touch', pointerId: 9 };
    b('Eraser').dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 10, clientY: 10 }));
    b('Eraser').dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 10, clientY: 60 }));
    expect(host.cmd.setTool).not.toHaveBeenCalled();
  });

  test('pressing a button never takes focus from the page', async () => {
    const input = document.createElement('input');
    document.body.append(input);
    cleanup.push(() => input.remove());
    input.focus();
    const { host, ui, b } = setup();
    ui.wake();
    expect(document.activeElement).toBe(input);
    await userEvent.click(b('Eraser'));
    expect(host.cmd.setTool).toHaveBeenLastCalledWith('eraser');
    expect(document.activeElement).toBe(input);
    // Park the mouse away from the bar so later tests start without hover.
    await userEvent.hover(input);
  });

  test('dragging the grip moves the bar to the nearest edge and the session remembers it', async () => {
    const { q, root } = setup();
    const start = root.getAttribute('data-edge');
    expect(['right', 'bottom']).toContain(start);
    const grip = q('.grip');
    const o = { bubbles: true, pointerId: 3, pointerType: 'mouse', button: 0 };
    grip.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: 300, clientY: 300 }));
    grip.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: 200, clientY: 200 }));
    expect(q('.bar').classList.contains('drag')).toBe(true);
    grip.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: 5, clientY: 200 }));
    grip.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(root.getAttribute('data-edge')).toBe('left');
    expect(q('.bar').getAttribute('aria-orientation')).toBe('vertical');
    expect(getComputedStyle(q('.bar')).flexDirection).toBe('column');
    cleanup.shift()?.();
    const again = setup();
    expect(again.root.getAttribute('data-edge')).toBe('left');
  });

  test('the grip moves the bar to the next edge from the keyboard', () => {
    const { q, root } = setup();
    const before = root.getAttribute('data-edge');
    q('.grip').click();
    expect(root.getAttribute('data-edge')).not.toBe(before);
  });
});

describe('only real input counts', () => {
  test('clicks, taps and keys a page script makes press nothing, real ones still work', async () => {
    const { host, b, q } = setup({ strict: true, state: { draw: true, canUndo: true, canRedo: true } });
    for (const label of ['Undo', 'Redo', 'Eraser', 'Draw', 'More']) {
      b(label).click();
      tap(b(label));
      tap(b(label), 'mouse');
    }
    // The clear step, reached only through a fake menu.
    (q('[role=menu]') as HTMLElement).hidden = false;
    for (const el of q<HTMLElement>('[role=menu]').querySelectorAll('button')) {
      (el as HTMLElement).hidden = false;
      (el as HTMLButtonElement).click();
    }
    key(document.body, 'z', { ctrlKey: true });
    key(document.body, 'z', { metaKey: true, shiftKey: true });
    key(document.body, 'e');
    key(document.body, 'Escape');
    key(b('Undo'), 'Escape');
    for (const [name, fn] of Object.entries(host.cmd)) {
      expect(fn, name).not.toHaveBeenCalled();
    }
    expect(host.state().draw).toBe(true);
    await userEvent.click(b('Undo'));
    expect(host.cmd.undo).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(host.cmd.undo).toHaveBeenCalledTimes(2);
    await userEvent.keyboard('{Escape}');
    expect(host.cmd.setDraw).toHaveBeenLastCalledWith(false);
    await userEvent.hover(document.body, { position: { x: 1, y: 1 } });
  });
});

describe('menu', () => {
  test('menu items call the right commands', async () => {
    const { host, b, q } = setup();
    const more = b('More');
    const menu = q<HTMLElement>('[role=menu]');
    expect(menu.hidden).toBe(true);
    const cases: [string, keyof FakeHost['cmd'], unknown[]][] = [
      ['Save as image', 'exportImage', []],
      ['Save notes as Markdown', 'exportMarkdown', []],
      ['Copy for chat', 'copyForChat', []],
      ['Print', 'print', []],
      ['Turn ink off for this site', 'setSiteOff', [true]],
    ];
    for (const [label, name, args] of cases) {
      more.click();
      expect(menu.hidden).toBe(false);
      expect(more.getAttribute('aria-expanded')).toBe('true');
      b(label).click();
      expect(menu.hidden).toBe(true);
      await wait(0);
      expect(host.cmd[name]).toHaveBeenCalledWith(...args);
    }
    expect(b('Turn ink on for this site')).toBeTruthy();
  });

  test('clear page needs the confirm step', async () => {
    const { host, b, q } = setup();
    b('More').click();
    b('Clear page').click();
    expect(host.cmd.clearPage).not.toHaveBeenCalled();
    expect(q('.warn').textContent).toBe('Remove all ink on this page? This cannot be undone.');
    expect(b('Clear page').hidden).toBe(true);
    b('Cancel').click();
    expect(b('Clear page').hidden).toBe(false);
    expect(host.cmd.clearPage).not.toHaveBeenCalled();
    b('Clear page').click();
    b('Remove').click();
    await wait(0);
    expect(host.cmd.clearPage).toHaveBeenCalledOnce();
    expect(q<HTMLElement>('[role=menu]').hidden).toBe(true);
  });

  test('keyboard opens the menu, arrows move, Escape closes and returns focus', () => {
    const { b, q } = setup();
    const more = b('More');
    more.focus();
    more.click(); // keyboard activation has detail 0
    expect(document.activeElement).toBe(b('Save as image'));
    key(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement).toBe(b('Save notes as Markdown'));
    key(document.activeElement as Element, 'ArrowUp');
    key(document.activeElement as Element, 'ArrowUp');
    expect(document.activeElement).toBe(b('Turn ink off for this site'));
    key(document.activeElement as Element, 'Escape');
    expect(q<HTMLElement>('[role=menu]').hidden).toBe(true);
    expect(document.activeElement).toBe(more);
  });
});

describe('keyboard', () => {
  test('arrow keys move through the toolbar with one tab stop', () => {
    const { q, b } = setup();
    const bar = q('.bar');
    const stops = [...bar.querySelectorAll(':scope > button')].filter(
      (x) => (x as HTMLElement).tabIndex === 0,
    );
    expect(stops).toEqual([q('.draw')]);
    q('.draw').focus();
    key(q('.draw'), 'ArrowRight');
    expect(document.activeElement).toBe(b('Pen, first colour'));
    expect(b('Pen, first colour').tabIndex).toBe(0);
    expect(q('.draw').tabIndex).toBe(-1);
    key(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement).toBe(b('Pen, second colour'));
    key(document.activeElement as Element, 'End');
    expect(document.activeElement).toBe(b('More'));
    key(document.activeElement as Element, 'ArrowRight');
    expect(document.activeElement).toBe(q('.grip'));
    key(document.activeElement as Element, 'ArrowLeft');
    expect(document.activeElement).toBe(b('More'));
  });

  test('shortcuts work while draw is on', () => {
    const { host } = setup({ state: { draw: true, canUndo: true, canRedo: true } });
    key(document.body, 'h');
    expect(host.cmd.setTool).toHaveBeenLastCalledWith('hi');
    key(document.body, 'E');
    expect(host.cmd.setTool).toHaveBeenLastCalledWith('eraser');
    key(document.body, 'l');
    expect(host.cmd.setTool).toHaveBeenLastCalledWith('lasso');
    key(document.body, 'p');
    expect(host.cmd.setTool).toHaveBeenLastCalledWith('pen');
    expect(host.cmd.setColor).toHaveBeenLastCalledWith('ink-1');
    key(document.body, 'z', { ctrlKey: true });
    expect(host.cmd.undo).toHaveBeenCalledOnce();
    key(document.body, 'z', { metaKey: true, shiftKey: true });
    expect(host.cmd.redo).toHaveBeenCalledOnce();
    key(document.body, 'Escape');
    expect(host.cmd.setDraw).toHaveBeenLastCalledWith(false);
  });

  test('shortcuts do nothing while draw is off', () => {
    const { host } = setup({ state: { canUndo: true } });
    key(document.body, 'h');
    key(document.body, 'z', { ctrlKey: true });
    expect(host.cmd.setTool).not.toHaveBeenCalled();
    expect(host.cmd.undo).not.toHaveBeenCalled();
  });

  test('shortcuts are ignored while the page focus is in a field', () => {
    const { host } = setup({ state: { draw: true, canUndo: true } });
    const fields = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      document.createElement('div'),
    ];
    (fields[3] as HTMLElement).contentEditable = 'true';
    for (const f of fields) {
      document.body.append(f);
      f.focus();
      key(f, 'h');
      key(f, 'z', { ctrlKey: true });
      key(f, 'Escape');
      f.remove();
    }
    expect(host.cmd.setTool).not.toHaveBeenCalled();
    expect(host.cmd.undo).not.toHaveBeenCalled();
    expect(host.cmd.setDraw).not.toHaveBeenCalled();
  });

  test('a field inside an open shadow root counts as a field', () => {
    const { host } = setup({ state: { draw: true } });
    const h = document.createElement('div');
    const sr = h.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    sr.append(input);
    document.body.append(h);
    input.focus();
    key(input, 'h');
    h.remove();
    expect(host.cmd.setTool).not.toHaveBeenCalled();
  });
});

describe('selection', () => {
  test('selection row shows with a selection and calls the commands', () => {
    const { host, b, q } = setup();
    const row = q<HTMLElement>('.sel');
    expect(row.hidden).toBe(true);
    host.set({ selected: ['n1', 'n2'] });
    expect(row.hidden).toBe(false);
    expect(row.getAttribute('role')).toBe('toolbar');
    b('Join').click();
    expect(host.cmd.joinSelected).toHaveBeenCalledOnce();
    b('Split').click();
    expect(host.cmd.splitSelected).toHaveBeenCalledOnce();
    b('Delete').click();
    expect(host.cmd.deleteNotes).toHaveBeenCalledWith(['n1', 'n2']);
    b('Done').click();
    expect(host.cmd.clearSelection).toHaveBeenCalledOnce();
    expect(row.hidden).toBe(true);
  });
});

describe('auto hide', () => {
  // The hide timers here are short, so quiet() waits for them: a hide that is due has
  // happened, and one that is not scheduled cannot come later.
  const hidden = (root: HTMLElement) => root.classList.contains('hid');

  test('the bar hides after barHideMs and wake brings it back', async () => {
    const { ui, root, q } = setup({ barHideMs: 40 });
    expect(hidden(root)).toBe(false);
    await quiet();
    expect(hidden(root)).toBe(true);
    // The bar fades out, then turns hidden.
    await until(() => getComputedStyle(q('.bar')).visibility === 'hidden', 'bar hidden');
    expect(getComputedStyle(q('.hdl')).visibility).toBe('visible');
    ui.wake();
    expect(hidden(root)).toBe(false);
    expect(getComputedStyle(q('.bar')).visibility).toBe('visible');
  });

  test('a tap or hover on the handle brings the bar back', async () => {
    const { root, q } = setup({ barHideMs: 30 });
    await quiet();
    expect(hidden(root)).toBe(true);
    tap(q('.hdl'), 'touch');
    expect(hidden(root)).toBe(false);
    await quiet();
    expect(hidden(root)).toBe(true);
    q('.hdl').dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'pen' }));
    expect(hidden(root)).toBe(false);
  });

  test('never hides while draw is on, a menu is open, or something is selected', async () => {
    const { host, root, b } = setup({ barHideMs: 30, state: { draw: true } });
    await quiet();
    expect(hidden(root)).toBe(false);
    host.set({ draw: false });
    b('More').click();
    await quiet();
    expect(hidden(root)).toBe(false);
    key(root, 'Escape');
    (document.activeElement as HTMLElement)?.blur();
    host.set({ selected: ['a'] });
    await quiet();
    expect(hidden(root)).toBe(false);
    host.set({ selected: [] });
    await quiet();
    expect(hidden(root)).toBe(true);
  });

  test('turning draw on shows a hidden bar', async () => {
    const { host, root } = setup({ barHideMs: 30 });
    await quiet();
    expect(hidden(root)).toBe(true);
    host.set({ draw: true });
    expect(hidden(root)).toBe(false);
  });

  test('waking never moves focus', async () => {
    const input = document.createElement('input');
    document.body.append(input);
    cleanup.push(() => input.remove());
    const { ui, host } = setup({ barHideMs: 30 });
    input.focus();
    await quiet();
    ui.wake();
    host.set({ draw: true });
    expect(document.activeElement).toBe(input);
  });
});

describe('destroy', () => {
  test('removes every node and every listener', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const rem = vi.spyOn(document, 'removeEventListener');
    const mount = document.createElement('div');
    document.body.append(mount);
    const host = fakeHost(mount, { barHideMs: 20, state: { draw: true } });
    const ui: Ui = createUi(host);
    expect(mount.childElementCount).toBe(1);
    expect(host.subs.size).toBe(1);
    ui.destroy();
    expect(mount.childNodes.length).toBe(0);
    expect(host.subs.size).toBe(0);
    for (const call of add.mock.calls) {
      expect(rem.mock.calls.some((r) => r[0] === call[0] && r[1] === call[1])).toBe(true);
    }
    key(document.body, 'h');
    expect(host.cmd.setTool).not.toHaveBeenCalled();
    ui.wake();
    ui.openTray();
    expect(mount.childNodes.length).toBe(0);
    add.mockRestore();
    rem.mockRestore();
    mount.remove();
  });
});
