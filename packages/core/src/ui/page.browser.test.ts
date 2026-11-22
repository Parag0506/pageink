import { afterEach, describe, expect, test } from 'vitest';
import { commands, page } from 'vitest/browser';
import { isChromium, session } from '../capture/testkit';
import type { InkState } from '../types';
import { fakeHost, note } from './fake';
import { createUi, resetUiSession } from './index';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  resetUiSession();
});

// Mounts like the real layer: a plain element on <html> with a closed shadow root.
function mountInLayer(state: Partial<InkState> = {}) {
  const el = document.createElement('ink-layer');
  el.style.cssText = 'all:initial;position:absolute;top:0;left:0;pointer-events:none';
  const sr = el.attachShadow({ mode: 'closed' });
  const mount = document.createElement('div');
  mount.style.cssText = 'all:initial';
  sr.append(mount);
  document.documentElement.append(el);
  const host = fakeHost(mount, { state });
  const ui = createUi(host);
  cleanup.push(() => {
    ui.destroy();
    el.remove();
  });
  const q = <T extends Element = HTMLElement>(s: string) => mount.querySelector(s) as T;
  return { host, ui, q, mount };
}

const HOSTILE = `
* { all: revert; font-size: 41px !important; line-height: 7 !important; padding: 23px !important;
    box-sizing: content-box !important; letter-spacing: 9px !important; color: lime !important;
    font-family: "Comic Sans MS", cursive !important; text-transform: uppercase !important; }
html { zoom: 1; font-size: 40px; color: red; visibility: visible; writing-mode: horizontal-tb; }
body { line-height: 9; letter-spacing: 12px; word-spacing: 30px; direction: rtl; text-align: right;
       cursor: wait; white-space: pre; font-style: italic; }
button, svg, div, span, ul, li, p { display: block !important; width: 300px !important; margin: 20px !important;
       border: 9px solid red !important; background: hotpink !important; }
ink-layer { font-size: 60px; color: red; letter-spacing: 20px; line-height: 10; }
`;

function hostileStyle() {
  const s = document.createElement('style');
  s.textContent = HOSTILE;
  document.head.append(s);
  cleanup.push(() => s.remove());
}

describe('on a hostile page', () => {
  test('the bar keeps its own sizes, fonts and colours inside a closed shadow root', () => {
    hostileStyle();
    const { q, ui, host } = mountInLayer({ tray: 3, selected: ['a'] });
    host.items = [{ note: note('a'), state: 'missing', quote: 'q', relY: 0.2 }];
    ui.openTray();
    const bar = q('.bar');
    const draw = q('.draw');
    const r = draw.getBoundingClientRect();
    expect(r.width).toBe(32);
    expect(r.height).toBe(32);
    const cs = getComputedStyle(draw);
    expect(cs.paddingTop).toBe('0px');
    expect(cs.borderTopWidth).toBe('0px');
    expect(cs.letterSpacing).toBe('normal');
    const icon = draw.querySelector('svg') as SVGElement;
    expect(icon.getBoundingClientRect().width).toBe(18);
    const br = bar.getBoundingClientRect();
    expect(br.width).toBeLessThan(60);
    expect(br.right).toBeLessThanOrEqual(innerWidth);
    expect(br.top).toBeGreaterThanOrEqual(0);
    expect(br.bottom).toBeLessThanOrEqual(innerHeight);
    const root = getComputedStyle(q('.iu'));
    expect(root.fontSize).toBe('13px');
    expect(root.textTransform).toBe('none');
    expect(root.direction).toBe('ltr');
    expect(root.fontFamily).toMatch(/^system-ui/);
    const h2 = getComputedStyle(q('h2'));
    expect(h2.fontSize).toBe('14px');
    expect(h2.color).not.toBe('rgb(0, 255, 0)');
    const tray = q('.tray').getBoundingClientRect();
    expect(tray.width).toBeLessThanOrEqual(360);
    expect(tray.width).toBeGreaterThan(200);
    expect(getComputedStyle(q('.sel')).display).toBe('flex');
  });

  test('the page cannot see or style the UI and the UI adds nothing outside its mount', () => {
    const before = document.body.innerHTML;
    const { ui } = mountInLayer();
    ui.openTray();
    ui.wake();
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelector('.iu')).toBeNull();
  });
});

describe('media', () => {
  // Only CDP can make the pointer coarse at run time; Playwright sets it per context.
  test.runIf(isChromium)(
    'targets are at least 44 px on a coarse pointer and the bar starts at the bottom',
    async () => {
      const c = session();
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] });
      cleanup.push(async () => {
        await c.send('Emulation.setEmulatedMedia', { features: [] });
        await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      });
      expect(matchMedia('(pointer: coarse)').matches).toBe(true);
      const { q, mount, ui, host } = mountInLayer({ tray: 1, selected: ['x'] });
      host.items = [{ note: note('a'), state: 'waiting', quote: 'q', relY: 0.2 }];
      expect(q('.iu').getAttribute('data-edge')).toBe('bottom');
      host.set({ placing: 'a' });
      ui.openTray();
      host.set({ placing: undefined });
      ui.openTray();
      q<HTMLButtonElement>('button[aria-label=More]').click();
      let n = 0;
      for (const b of mount.querySelectorAll('button')) {
        const r = b.getBoundingClientRect();
        if (r.width === 0) continue; // hidden controls
        n++;
        if (b.classList.contains('grip')) {
          expect(r.height, b.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(44);
          continue;
        }
        expect(r.width, b.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(44);
        expect(r.height, b.getAttribute('aria-label') ?? '').toBeGreaterThanOrEqual(44);
      }
      expect(n).toBeGreaterThan(14);
    },
  );

  test('targets are compact on a fine pointer', () => {
    const { q } = mountInLayer();
    expect(q('.draw').getBoundingClientRect().height).toBe(32);
    expect(q('.iu').getAttribute('data-edge')).toBe('right');
  });

  test('reduced motion turns off the fade', async () => {
    const { q } = mountInLayer();
    expect(getComputedStyle(q('.bar')).transitionDuration).not.toMatch(/^0s(, 0s)*$/);
    await commands.reducedMotion(true);
    cleanup.push(() => commands.reducedMotion(false));
    expect(getComputedStyle(q('.bar')).transitionDuration).toMatch(/^0s(, 0s)*$/);
  });
});

describe('visual check', () => {
  // Mounts the UI in each theme with everything open and takes a screenshot
  // that is kept in memory only. It fails if anything renders off screen or empty.
  for (const theme of ['light', 'dark'] as const) {
    test(`everything is on screen in the ${theme} theme`, async () => {
      document.body.style.background = theme === 'dark' ? '#111' : '#fff';
      cleanup.push(() => {
        document.body.style.background = '';
      });
      const { q, ui, host } = mountInLayer({ theme, tray: 2, selected: ['a'], canUndo: true, draw: true });
      host.items = [
        {
          note: note('a'),
          state: 'waiting',
          quote: 'a passage that moved',
          relY: 0.3,
          link: 'https://example.org',
        },
        { note: note('b'), state: 'missing', quote: 'another one', relY: 0.7 },
      ];
      ui.openTray();
      for (const s of ['.bar', '.sel', '.tray', 'li']) {
        const r = q(s).getBoundingClientRect();
        expect(r.width, s).toBeGreaterThan(0);
        expect(r.left, s).toBeGreaterThanOrEqual(0);
        expect(r.top, s).toBeGreaterThanOrEqual(0);
        expect(r.right, s).toBeLessThanOrEqual(innerWidth);
        expect(r.bottom, s).toBeLessThanOrEqual(innerHeight);
      }
      const bg = getComputedStyle(q('.tray')).backgroundColor;
      expect(bg).toBe(theme === 'dark' ? 'rgb(38, 38, 43)' : 'rgb(255, 255, 255)');
      const shot = await page.screenshot({ save: false });
      expect(shot.length).toBeGreaterThan(1000);
    });
  }
});

describe('rotation and resize', () => {
  // The bar is fixed to an edge by style rules, so it follows the screen with no script.
  const SIZES: [number, number][] = [
    [1366, 1024],
    [1024, 1366],
    [1194, 834],
    [834, 1194],
    [375, 1024],
    [896, 414],
    [414, 896],
    [568, 320],
    [320, 568],
  ];
  const check = async (edge: string, coarse: boolean) => {
    cleanup.push(() => page.viewport(414, 896));
    const { q, mount } = mountInLayer({ draw: true, tray: 1 });
    const grip = q<HTMLButtonElement>('.grip');
    for (let i = 0; i < 4 && q('.iu').getAttribute('data-edge') !== edge; i++) grip.click();
    for (const [w, h] of SIZES) {
      await page.viewport(w, h);
      const at = `${edge} edge at ${w}x${h}`;
      expect(q('.iu').getAttribute('data-edge')).toBe(edge);
      const bar = q('.bar').getBoundingClientRect();
      const btns = [...mount.querySelectorAll('.bar > button')].filter((b) => !(b as HTMLElement).hidden);
      expect(btns.length).toBeGreaterThanOrEqual(11);
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        const label = `${b.getAttribute('aria-label')}, ${at}`;
        expect(r.width, label).toBeGreaterThan(0);
        expect(r.left, label).toBeGreaterThanOrEqual(0);
        expect(r.top, label).toBeGreaterThanOrEqual(0);
        expect(r.right, label).toBeLessThanOrEqual(innerWidth);
        expect(r.bottom, label).toBeLessThanOrEqual(innerHeight);
        // Inside the bar's own box too, so it is drawn on the bar and not loose on the page.
        expect(r.left, label).toBeGreaterThanOrEqual(bar.left);
        expect(r.right, label).toBeLessThanOrEqual(bar.right);
        expect(r.top, label).toBeGreaterThanOrEqual(bar.top);
        expect(r.bottom, label).toBeLessThanOrEqual(bar.bottom);
        if (coarse && !b.classList.contains('grip')) {
          expect(r.width, label).toBeGreaterThanOrEqual(44);
          expect(r.height, label).toBeGreaterThanOrEqual(44);
        }
      }
    }
  };
  for (const edge of ['bottom', 'left', 'top', 'right'] as const) {
    test(`on the ${edge} edge every bar button stays on screen at every size`, () => check(edge, false));
    // Only CDP can make the pointer coarse at run time.
    test.runIf(isChromium)(`the same on the ${edge} edge with touch sizes`, async () => {
      const c = session();
      await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] });
      cleanup.push(async () => {
        await c.send('Emulation.setEmulatedMedia', { features: [] });
        await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      });
      await check(edge, true);
    });
  }
});

describe('narrow screens', () => {
  for (const edge of ['right', 'left', 'bottom', 'top'] as const) {
    test(`the selection row stays on screen with the bar on the ${edge} edge`, async () => {
      await page.viewport(300, 560);
      cleanup.push(() => page.viewport(414, 896));
      const { q, mount } = mountInLayer({ selected: ['a'] });
      // The grip cycles bottom, left, top, right.
      const grip = q<HTMLButtonElement>('.grip');
      for (let i = 0; i < 4 && q('.iu').getAttribute('data-edge') !== edge; i++) grip.click();
      expect(q('.iu').getAttribute('data-edge')).toBe(edge);
      const sel = q('.sel').getBoundingClientRect();
      expect(sel.width).toBeGreaterThan(0);
      expect(sel.left).toBeGreaterThanOrEqual(0);
      expect(sel.top).toBeGreaterThanOrEqual(0);
      expect(sel.right).toBeLessThanOrEqual(innerWidth);
      expect(sel.bottom).toBeLessThanOrEqual(innerHeight);
      for (const b of mount.querySelectorAll('.sel button')) {
        const r = b.getBoundingClientRect();
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.right).toBeLessThanOrEqual(innerWidth);
      }
    });
  }
});
