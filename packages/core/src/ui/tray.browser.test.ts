import { afterEach, describe, expect, test } from 'vitest';
import type { TrayItem } from '../types';
import { fakeHost, note } from './fake';
import { createUi, resetUiSession } from './index';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  resetUiSession();
});

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function setup(items: TrayItem[]) {
  const mount = document.createElement('div');
  document.body.append(mount);
  const host = fakeHost(mount, { state: { tray: items.length } });
  host.items = items;
  const ui = createUi(host);
  cleanup.push(() => {
    ui.destroy();
    mount.remove();
  });
  const q = <T extends Element = HTMLButtonElement>(sel: string) => mount.querySelector(sel) as T;
  return { mount, host, ui, q };
}

const items = (): TrayItem[] => [
  {
    note: note('a', 'M10 20L110 20L110 70Z'),
    state: 'waiting',
    quote: 'the first passage',
    relY: 0.1,
    thumb: PNG,
  },
  { note: note('b'), state: 'missing', quote: 'second words', relY: 0.9, link: 'https://example.org/x' },
];

describe('tray', () => {
  test('openTray with a note id marks that row; by keyboard it also takes focus there', () => {
    const { ui, mount } = setup(items());
    ui.openTray('b');
    const on = () => [...mount.querySelectorAll('li[data-on]')];
    expect(on().length).toBe(1);
    expect(on()[0]!.textContent).toContain('second words');
    // A tap leaves focus where it was.
    expect(mount.contains(document.activeElement)).toBe(false);
    ui.openTray('a', true);
    expect(on()[0]!.textContent).toContain('the first passage');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Place this note');
    ui.openTray();
    expect(on().length).toBe(0);
  });

  test('an open tray shows a waiting note as missing once the page settles', () => {
    const { ui, mount, host } = setup(items());
    ui.openTray();
    const meta = () => mount.querySelector('li .meta')?.textContent;
    expect(meta()).toBe('Waiting for the page, near the top.');
    host.items = host.items.map((it) => ({ ...it, state: 'missing' as const }));
    // Same count, new state: the panel still follows.
    host.set({});
    expect(meta()).toBe('Passage not found, near the top.');
  });

  test('the tray button and openTray show the panel with every item', () => {
    const { q, ui, mount } = setup(items());
    const panel = q<HTMLElement>('[role=dialog]');
    expect(panel.hidden).toBe(true);
    expect(panel.getAttribute('aria-label')).toBe('Moved notes');
    q('button[aria-label="Moved notes, 2"]').click();
    expect(panel.hidden).toBe(false);
    const lis = mount.querySelectorAll('li');
    expect(lis.length).toBe(2);
    expect(lis[0]?.querySelector('.q')?.textContent).toBe('“the first passage”');
    expect(lis[0]?.querySelector('.meta')?.textContent).toBe('Waiting for the page, near the top.');
    expect(lis[1]?.querySelector('.meta')?.textContent).toBe('Passage not found, near the end.');
    q('button[aria-label="Close"]').click();
    expect(panel.hidden).toBe(true);
    ui.openTray();
    expect(panel.hidden).toBe(false);
  });

  test('ink is drawn as an inline SVG fitted to the thumbnail, in host colours', () => {
    const { ui, mount } = setup(items());
    ui.openTray();
    const li = mount.querySelector('li') as HTMLElement;
    const svg = li.querySelector('svg.ink') as SVGSVGElement;
    const path = svg.querySelector('path') as SVGPathElement;
    expect(path.getAttribute('d')).toBe('M10 20L110 20L110 70Z');
    expect(path.getAttribute('fill')).toBe('rgb(20, 20, 20)');
    const vb = svg.viewBox.baseVal;
    expect(vb.x).toBeLessThan(10);
    expect(vb.x + vb.width).toBeGreaterThan(110);
    const r = svg.getBoundingClientRect();
    const box = (li.querySelector('.pic') as HTMLElement).getBoundingClientRect();
    expect(r.width).toBeLessThanOrEqual(box.width + 0.5);
    expect(r.height).toBeLessThanOrEqual(box.height + 0.5);
    expect(path.getBoundingClientRect().width).toBeGreaterThan(30);
  });

  test('thumb images are shown only from inline data', () => {
    const list = items();
    (list[1] as TrayItem).thumb = 'https://example.org/remote.png';
    const { ui, mount } = setup(list);
    ui.openTray();
    const imgs = mount.querySelectorAll('img');
    expect(imgs.length).toBe(1);
    expect(imgs[0]?.getAttribute('src')).toBe(PNG);
  });

  test('links are plain text links that open in a new tab and are never fetched', () => {
    const list = items();
    list.push({ note: note('c'), state: 'missing', quote: '', relY: 0.5, link: 'javascript:alert(1)' });
    const { ui, mount } = setup(list);
    ui.openTray();
    const a = mount.querySelector('a.lnk') as HTMLAnchorElement;
    expect(a.textContent).toBe('https://example.org/x');
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener noreferrer');
    const lis = mount.querySelectorAll('li');
    const bad = lis[2]?.querySelector('.lnk') as HTMLElement;
    expect(bad.tagName).toBe('SPAN');
    expect(bad.textContent).toBe('javascript:alert(1)');
    expect(lis[2]?.querySelector('.q')?.textContent).toBe('No saved words.');
  });

  test('place starts placing, closes the panel, and the banner follows state', () => {
    const { ui, host, q, mount } = setup(items());
    ui.openTray();
    const ban = q<HTMLElement>('.ban');
    expect(ban.hidden).toBe(true);
    (mount.querySelectorAll('button[aria-label="Place this note"]')[1] as HTMLElement).click();
    expect(host.cmd.place).toHaveBeenCalledWith('b');
    expect(q<HTMLElement>('[role=dialog]').hidden).toBe(true);
    expect(ban.hidden).toBe(false);
    expect(ban.getAttribute('role')).toBe('status');
    expect(ban.textContent).toContain('Tap where this note belongs');
    host.set({ placing: undefined });
    expect(ban.hidden).toBe(true);
    host.set({ placing: 'a' });
    (ban.querySelector('button') as HTMLButtonElement).click();
    expect(host.cmd.place).toHaveBeenLastCalledWith(null);
    expect(ban.hidden).toBe(true);
  });

  test('Escape cancels placing', () => {
    const { host } = setup(items());
    host.set({ placing: 'a' });
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(host.cmd.place).toHaveBeenLastCalledWith(null);
  });

  test('delete removes the note and the list follows the host', () => {
    const { ui, host, mount } = setup(items());
    ui.openTray();
    const first = mount.querySelector('li');
    (mount.querySelectorAll('button[aria-label="Delete this note"]')[1] as HTMLElement).click();
    expect(host.cmd.deleteNotes).toHaveBeenCalledWith(['b']);
    host.items = host.items.slice(0, 1);
    host.set({ tray: 1 });
    const lis = mount.querySelectorAll('li');
    expect(lis.length).toBe(1);
    expect(lis[0]).toBe(first);
    host.items = [];
    host.set({ tray: 0 });
    expect(mount.querySelectorAll('li').length).toBe(0);
    expect((mount.querySelector('.empty') as HTMLElement).hidden).toBe(false);
  });

  test('Escape closes the panel and focus returns to the tray button', () => {
    const { q, mount } = setup(items());
    const tb = q('button[aria-label="Moved notes, 2"]');
    tb.focus();
    tb.click();
    expect(document.activeElement).toBe(q('button[aria-label="Close"]'));
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
    );
    expect((mount.querySelector('[role=dialog]') as HTMLElement).hidden).toBe(true);
    expect(document.activeElement).toBe(tb);
  });

  test('text marks get a band in the mark colour', () => {
    const n = note('m');
    n.kind = 'textmark';
    n.strokes = [];
    n.mark = { style: 'highlight', color: 'hi-2' };
    const { ui, mount } = setup([{ note: n, state: 'missing', quote: 'w', relY: 0.4 }]);
    ui.openTray();
    expect(mount.querySelector('svg.ink rect')?.getAttribute('fill')).toBe('rgb(120, 220, 120)');
  });
});
