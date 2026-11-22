import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { quiet, until } from '../testkit';
import type { Capture, CaptureHost, Front, Gesture, StrokeProbe, Tool } from '../types';
import { TAP_MS } from './capture';
import { createCapture, createProbe } from './index';
import {
  ALT,
  engine,
  fromTest,
  isChromium,
  mouseInput,
  REST_MS,
  STEP_MS,
  session,
  synthMouse,
  type TouchPoint,
  type TouchStep,
  touchEmulation,
  touchEventOf,
  touchGesture,
  touchInput,
} from './testkit';

// Real input through CDP in Chromium, and the same events built by hand in the other
// engines (see testkit). The test page is the top frame of the runner, so the
// coordinates are client coordinates here.
/** Runs in Chromium only, for the reason in NEEDS_CDP. */
const chromiumTest = test.runIf(isChromium);
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/**
 * Wait until the page has taken a scroll the compositor made. No gesture here ends with a
 * fling (the fingers rest before they lift), so nothing coasts into the next test.
 */
async function settle(): Promise<void> {
  let last = -1;
  let still = 0;
  for (let i = 0; i < 120 && still < 4; i++) {
    await frame();
    still = window.scrollY === last ? still + 1 : 0;
    last = window.scrollY;
  }
}

async function pointer(
  type: 'mousePressed' | 'mouseMoved' | 'mouseReleased',
  x: number,
  y: number,
  o: { pen?: boolean; down?: boolean; force?: number; modifiers?: number; gap?: number } = {},
): Promise<void> {
  await mouseInput(type, x, y, o.pen ? 'pen' : 'mouse', o);
}

/** A pen or mouse stroke along a straight line in steps, its events STEP_MS apart on the input clock. */
async function drag(
  from: [number, number],
  to: [number, number],
  o: { pen?: boolean; modifiers?: number; steps?: number; noHover?: boolean } = {},
): Promise<void> {
  const steps = o.steps ?? 8;
  if (!o.noHover) await pointer('mouseMoved', from[0], from[1], o);
  await pointer('mousePressed', from[0], from[1], {
    ...o,
    force: 0.5,
    ...(o.noHover ? {} : { gap: STEP_MS }),
  });
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    await pointer('mouseMoved', from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, {
      ...o,
      down: true,
      force: 0.4 + 0.4 * f,
      gap: STEP_MS,
    });
  }
  await pointer('mouseReleased', to[0], to[1], { ...o, gap: STEP_MS });
}

/**
 * A pen tap: a hover, a press and a lift at one point, the lift STEP_MS after the press on the
 * input clock, however long the machine takes between the two.
 */
async function penTap(x: number, y: number): Promise<void> {
  await pointer('mouseMoved', x, y, { pen: true });
  await pointer('mousePressed', x, y, { pen: true, force: 0.5, gap: STEP_MS });
  await pointer('mouseReleased', x, y, { pen: true, gap: STEP_MS });
}

type TP = TouchPoint;
const touch = touchInput;

/**
 * One or two fingers moving up the screen by dy in steps, as one gesture on the input clock:
 * the second finger 30 ms after the first, which is within TWO_FINGER_MS, moves 16 ms apart,
 * and a rest before the lift, so the page does not coast.
 */
async function swipe(fingers: number, dy: number, at = { x: 200, y: 700 }): Promise<void> {
  const pts = (d: number): TP[] =>
    Array.from({ length: fingers }, (_, i) => ({ x: at.x + i * 60, y: at.y - d, id: i + 1 }));
  const steps: TouchStep[] = [{ type: 'touchStart', points: pts(0).slice(0, 1) }];
  if (fingers > 1) steps.push({ type: 'touchStart', points: pts(0), gap: 30 });
  const n = 12;
  for (let i = 1; i <= n; i++) steps.push({ type: 'touchMove', points: pts((dy * i) / n), gap: 16 });
  steps.push({ type: 'touchEnd', points: [], gap: REST_MS });
  await touchGesture(steps);
  await settle();
}

interface Rig {
  host: CaptureHost;
  cap: Capture;
  /** fake: events the test makes count too, through the test seam. False: only real input counts. */
  state: { draw: boolean; enabled: boolean; tool: Tool; fake: boolean };
  starts: unknown[];
  moves: Gesture[];
  ends: Gesture[];
  cancels: number;
  near: number;
  layer: HTMLElement;
  mount: ShadowRoot;
  ui: HTMLElement;
}

let rig: Rig;
let link: HTMLAnchorElement;
let clicks: string[];

function makeRig(): Rig {
  const layer = document.createElement('ink-layer');
  layer.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
  document.documentElement.append(layer);
  const mount = layer.attachShadow({ mode: 'closed' });
  const ui = document.createElement('div');
  ui.style.cssText =
    'position:fixed;right:0;top:0;width:60px;height:60px;pointer-events:auto;background:#eee';
  mount.append(ui);
  const r: Rig = {
    state: { draw: false, enabled: true, tool: 'pen', fake: true },
    starts: [],
    moves: [],
    ends: [],
    cancels: 0,
    near: 0,
    layer,
    mount,
    ui,
  } as unknown as Rig;
  r.host = {
    doc: document,
    mount,
    enabled: () => r.state.enabled,
    draw: () => r.state.draw,
    tool: () => r.state.tool,
    liveStyle: () => ({ tool: 'pen', color: '#c00', w: 4 }),
    modifier: 'Alt',
    isUi: (t) => t === layer,
    onStart: (g) => r.starts.push(g),
    onMove: (g) => r.moves.push(g),
    onEnd: (g) => r.ends.push(g),
    onCancel: () => {
      r.cancels++;
    },
    onPenNear: () => {
      r.near++;
    },
    real: (e) => r.state.fake || fromTest(e),
  };
  r.cap = createCapture(r.host);
  return r;
}

/** Count of painted pixels on the live canvas. */
function inked(r: Rig): number {
  const c = r.mount.querySelector('canvas');
  if (!c) return 0;
  const ctx = c.getContext('2d');
  if (!ctx) return 0;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) n++;
  return n;
}

beforeAll(async () => {
  await touchEmulation(true);
});

// Emulated touch makes the pointer coarse for every later file in this browser.
afterAll(async () => {
  await touchEmulation(false);
});

beforeEach(async () => {
  document.body.style.margin = '0';
  document.body.innerHTML = `
    <p id="text" style="position:absolute;left:20px;top:100px;width:360px;font:16px sans-serif">
      Plain words that a pen may write over. Plain words that a pen may write over.
    </p>
    <a id="link" href="#tapped" style="position:absolute;left:50px;top:300px;display:block;width:150px;height:40px;background:#def">a link</a>
    <div style="height:4000px"></div>`;
  link = document.getElementById('link') as HTMLAnchorElement;
  clicks = [];
  link.addEventListener('click', (e) => {
    e.preventDefault();
    clicks.push('link');
  });
  window.scrollTo(0, 0);
  rig = makeRig();
  await frame();
});

afterEach(async () => {
  rig.cap.destroy();
  rig.layer.remove();
  document.adoptedStyleSheets = [];
  await settle();
  // A page with nothing to scroll: the browser itself puts the scroll offset at 0. After a
  // finger scrolled the page, scrollTo(0, 0) alone is not enough. Chromium's compositor can
  // hold a fraction of a pixel that the page never saw, keeps it through scrollTo, and hands
  // it over later as scrollY 1, in the middle of another test.
  document.body.innerHTML = '';
  await until(() => document.documentElement.scrollHeight <= window.innerHeight, 'an empty page');
  await frame();
  await frame();
  expect(window.scrollY).toBe(0);
});

describe('pen', () => {
  test('draws with the toggle off, in document space, and paints the live canvas', async () => {
    window.scrollTo(0, 100);
    await frame();
    await drag([60, 500], [200, 560], { pen: true });
    expect(rig.starts).toHaveLength(1);
    expect(rig.ends).toHaveLength(1);
    const g = rig.ends[0] as Gesture;
    expect(g.pointerType).toBe('pen');
    expect(g.tool).toBe('pen');
    expect(g.samples.length).toBeGreaterThanOrEqual(9);
    expect(g.samples[0]?.x).toBeCloseTo(60, 0);
    expect(g.samples[0]?.y).toBeCloseTo(600, 0);
    expect(g.samples[g.samples.length - 1]?.y).toBeCloseTo(660, 0);
    expect(g.t1).toBeGreaterThanOrEqual(g.t0);
    expect(g.samples.some((s) => s.p !== 0.5)).toBe(true);
    expect(inked(rig)).toBeGreaterThan(50);
    const c = rig.mount.querySelector('canvas') as HTMLCanvasElement;
    expect(c.width).toBe(Math.round(innerWidth * devicePixelRatio));
    expect(getComputedStyle(c).position).toBe('fixed');
    expect(getComputedStyle(c).pointerEvents).toBe('none');
    // Firefox does not know the desynchronized hint and reports false.
    if (engine !== 'firefox') expect(c.getContext('2d')?.getContextAttributes().desynchronized).toBe(true);
    rig.cap.clearLive();
    expect(inked(rig)).toBe(0);
  });

  test('a tap on a link still clicks it and makes no ink', async () => {
    await penTap(100, 320);
    await quiet();
    expect(clicks).toEqual(['link']);
    expect(rig.starts).toHaveLength(0);
    expect(rig.ends).toHaveLength(0);
  });

  test('a stroke across a link makes ink and does not click it', async () => {
    await drag([60, 310], [190, 330], { pen: true });
    await quiet();
    expect(rig.ends).toHaveLength(1);
    expect(clicks).toEqual([]);
    // Starting on plain page and ending on the link.
    await drag([60, 500], [100, 320], { pen: true });
    await quiet();
    expect(rig.ends).toHaveLength(2);
    expect(clicks).toEqual([]);
  });

  test('a tap on plain text is a dot and the page still gets the click', async () => {
    const seen: string[] = [];
    document.body.addEventListener('click', () => seen.push('click'));
    await penTap(100, 500);
    await quiet();
    expect(rig.ends).toHaveLength(1);
    expect(seen).toEqual(['click']);
  });

  // The input clock of the test kit: a tap is told by the times of its events, so a machine that
  // stalls between the press and the lift does not turn a test's tap into a stroke.
  test('a press and a lift close together on the input clock are a tap, however late the lift arrives', async () => {
    const seen: string[] = [];
    document.body.addEventListener('click', () => seen.push('click'));
    await pointer('mouseMoved', 100, 500, { pen: true });
    await pointer('mousePressed', 100, 500, { pen: true, force: 0.5 });
    // Longer than a tap may last. With the lift at the real time, the click would be swallowed.
    await new Promise((r) => setTimeout(r, TAP_MS + 100));
    await pointer('mouseReleased', 100, 500, { pen: true, gap: STEP_MS });
    await quiet();
    expect(rig.ends).toHaveLength(1);
    expect(rig.ends[0]!.t1 - rig.ends[0]!.t0).toBeLessThanOrEqual(STEP_MS);
    expect(seen).toEqual(['click']);
  });

  test('a lift that comes late on the real clock is no tap: the click after the dot is swallowed', async () => {
    const seen: string[] = [];
    document.body.addEventListener('click', () => seen.push('click'));
    await pointer('mouseMoved', 100, 500, { pen: true });
    await pointer('mousePressed', 100, 500, { pen: true, force: 0.5 });
    await new Promise((r) => setTimeout(r, TAP_MS + 100));
    await pointer('mouseReleased', 100, 500, { pen: true });
    await quiet();
    expect(rig.ends).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  test('page handlers do not see a stroke, and no text gets selected', async () => {
    const seen: string[] = [];
    await pointer('mouseMoved', 30, 110, { pen: true });
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      document.addEventListener(t, () => seen.push(t));
    }
    await drag([30, 110], [300, 130], { pen: true, noHover: true });
    expect(rig.ends).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(String(window.getSelection())).toBe('');
  });

  test('palm touches are ignored while the pen is down', async () => {
    const seen: string[] = [];
    document.addEventListener('pointerdown', (e) => seen.push(e.pointerType));
    await pointer('mouseMoved', 60, 500, { pen: true });
    await pointer('mousePressed', 60, 500, { pen: true, force: 0.5 });
    await touch('touchStart', [{ x: 300, y: 700, id: 1 }]);
    for (let i = 1; i <= 8; i++) {
      await touch('touchMove', [{ x: 300, y: 700 - i * 30, id: 1 }]);
      await pointer('mouseMoved', 60 + i * 10, 500, { pen: true, down: true, force: 0.5 });
    }
    await pointer('mouseReleased', 140, 500, { pen: true });
    await touch('touchEnd', []);
    await quiet();
    expect(rig.ends).toHaveLength(1);
    expect(rig.ends[0]?.pointerType).toBe('pen');
    expect(rig.cancels).toBe(0);
    expect(seen).toEqual([]);
    expect(window.scrollY).toBe(0);
  });

  test('hover arms the pan guard and tells the host; a mouse disarms it', async () => {
    await pointer('mouseMoved', 100, 500, { pen: true });
    await pointer('mouseMoved', 110, 500, { pen: true });
    expect(rig.near).toBe(1);
    expect(getComputedStyle(document.getElementById('text') as HTMLElement).touchAction).toBe('none');
    await pointer('mouseMoved', 120, 500);
    expect(getComputedStyle(document.getElementById('text') as HTMLElement).touchAction).toBe('auto');
  });

  test('the first finger after the pen still scrolls the page', async () => {
    await pointer('mouseMoved', 100, 500, { pen: true });
    expect(getComputedStyle(document.body).touchAction).toBe('none');
    await swipe(1, 300);
    expect(getComputedStyle(document.body).touchAction).toBe('auto');
    expect(window.scrollY).toBeGreaterThan(150);
    expect(rig.ends).toHaveLength(0);
  });

  test('iPad stylus touches are held back except on links, and turn the guard off', () => {
    const fire = (el: Element, type: string) => {
      const e = touchEventOf(type, [
        { identifier: 3, target: el, clientX: 10, clientY: 10, touchType: 'stylus' },
      ]);
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    window.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'pen' }));
    expect(document.adoptedStyleSheets.length).toBe(1);
    expect(fire(document.getElementById('text') as Element, 'touchstart')).toBe(true);
    expect(document.adoptedStyleSheets.length).toBe(0);
    expect(fire(link, 'touchstart')).toBe(false);
    // Once a stylus touch is seen, the touch trick is enough and the guard stays off.
    window.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'pen' }));
    expect(document.adoptedStyleSheets.length).toBe(0);
  });

  test('the eraser end of a pen erases', async () => {
    await pointer('mouseMoved', 60, 500, { pen: true });
    // CDP has no eraser button, so the down event is built by hand.
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerType: 'pen',
        pointerId: 77,
        button: 5,
        buttons: 32,
        clientX: 60,
        clientY: 500,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
    document.body.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerType: 'pen',
        pointerId: 77,
        clientX: 60,
        clientY: 500,
        bubbles: true,
      }),
    );
    expect(rig.ends[0]?.tool).toBe('eraser');
  });
});

describe('drags the page means for itself', () => {
  const zone = (html: string) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;left:20px;top:420px;width:400px';
    d.innerHTML = html;
    document.body.append(d);
    return d;
  };
  const mid = (el: Element): [number, number] => {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };

  test('a pen drag on a slider, a draggable item, a separator, media controls or a kept part goes to the page', async () => {
    const d = zone(`
      <input id="rng" type="range" min="0" max="100" value="10" style="display:block;width:300px;height:30px">
      <div draggable="true" style="height:40px;background:#eee">drag me</div>
      <div role="slider" aria-valuenow="1" tabindex="0" style="height:30px;background:#ddd">slider</div>
      <div role="separator" aria-valuenow="50" tabindex="0" style="height:16px;background:#ccc"></div>
      <div role="scrollbar" aria-valuenow="0" style="height:16px;background:#bbb"></div>
      <audio controls style="display:block;width:300px"></audio>
      <div data-ink-off><p style="height:30px;margin:0">kept for the page</p></div>`);
    for (const el of [...d.children]) {
      const [x, y] = mid(el);
      await drag([x - 40, y], [x + 40, y], { pen: true });
    }
    expect(rig.starts).toHaveLength(0);
    expect(rig.ends).toHaveLength(0);
    // The slider moved under the pen. Only trusted input moves a slider. NEEDS_CDP.
    if (isChromium)
      expect(Number((document.getElementById('rng') as HTMLInputElement).value)).toBeGreaterThan(10);
  });

  test('a pen drag on a scrollbar or on selection handles in editable text goes to the page', async () => {
    const d = zone(`
      <div id="sc" style="height:100px;width:300px;overflow-y:scroll;border:0">${'<p>row</p>'.repeat(40)}</div>
      <div id="ed" contenteditable="true" style="font:16px sans-serif;width:300px">Some words to select here.</div>`);
    const sc = document.getElementById('sc')!;
    const r = sc.getBoundingClientRect();
    const barX = r.left + sc.clientWidth + (r.width - sc.clientWidth) / 2;
    // Headless runs hide scrollbars. The extension tests drive a real one in a browser that shows them.
    if (r.width - sc.clientWidth > 2) {
      await drag([barX, r.top + 8], [barX, r.top + 80], { pen: true });
      expect(rig.ends).toHaveLength(0);
      expect(sc.scrollTop).toBeGreaterThan(0);
    }
    const ed = document.getElementById('ed')!;
    const text = ed.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 5);
    range.setEnd(text, 10);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const end = range.getClientRects()[0]!;
    await drag([end.right, end.bottom - 2], [end.right + 60, end.bottom - 2], { pen: true });
    expect(rig.ends).toHaveLength(0);
    getSelection()!.removeAllRanges();
    d.remove();
  });

  test('pen drags on plain content, pictures and canvases still write', async () => {
    const d = zone(`
      <p style="margin:0;height:30px">plain words</p>
      <img alt="" width="200" height="40" style="display:block;background:#9cf" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <canvas width="200" height="40" style="display:block;background:#fc9"></canvas>`);
    let n = 0;
    for (const el of [...d.children]) {
      const [x, y] = mid(el);
      await drag([x - 40, y], [x + 40, y], { pen: true });
      n++;
      expect(rig.ends).toHaveLength(n);
    }
  });
});

describe('only real input counts', () => {
  const fake = (type: string, init: PointerEventInit) =>
    document
      .getElementById('text')!
      .dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  const fakeStroke = (init: PointerEventInit) => {
    fake('pointerover', init);
    fake('pointerdown', { ...init, clientX: 60, clientY: 120, buttons: init.buttons ?? 1 });
    for (let i = 1; i <= 6; i++)
      fake('pointermove', { ...init, clientX: 60 + i * 20, clientY: 120, buttons: 1 });
    fake('pointerup', { ...init, clientX: 180, clientY: 120, buttons: 0 });
  };

  test('a page script that makes pen, eraser, touch and mouse strokes writes and erases nothing', async () => {
    rig.state.fake = false;
    fakeStroke({ pointerType: 'pen', pointerId: 41, button: 0 });
    fakeStroke({ pointerType: 'pen', pointerId: 42, button: 5, buttons: 32 });
    rig.state.draw = true;
    fakeStroke({ pointerType: 'touch', pointerId: 43, button: 0 });
    fakeStroke({ pointerType: 'mouse', pointerId: 1, button: 0, altKey: true });
    rig.cap.adopt([
      new PointerEvent('pointerdown', { pointerType: 'pen', pointerId: 44, clientX: 60, clientY: 120 }),
      new PointerEvent('pointerup', { pointerType: 'pen', pointerId: 44, clientX: 160, clientY: 120 }),
    ]);
    expect(rig.starts).toHaveLength(0);
    expect(rig.ends).toHaveLength(0);
    expect(document.adoptedStyleSheets.length).toBe(0);
    // Real input still writes.
    rig.state.draw = false;
    await drag([60, 500], [200, 560], { pen: true });
    expect(rig.ends).toHaveLength(1);
  });

  test('a fake stylus touch is not held back', () => {
    rig.state.fake = false;
    // Built the way a page script can in any engine: an event with the touch lists set on it.
    const t = { identifier: 3, target: link, clientX: 10, clientY: 10, touchType: 'stylus' };
    const e = new Event('touchstart', { bubbles: true, cancelable: true });
    for (const k of ['changedTouches', 'touches', 'targetTouches'])
      Object.defineProperty(e, k, { value: [t] });
    document.getElementById('text')!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('touch', () => {
  test('a finger does not draw with the toggle off and the page scrolls', async () => {
    await swipe(1, 300);
    expect(rig.starts).toHaveLength(0);
    expect(rig.ends).toHaveLength(0);
    // Only trusted touches scroll natively. NEEDS_CDP.
    if (isChromium) expect(window.scrollY).toBeGreaterThan(150);
  });

  test('a finger draws with the toggle on and the page stays put', async () => {
    rig.state.draw = true;
    await swipe(1, 300);
    expect(rig.ends).toHaveLength(1);
    expect(rig.ends[0]?.pointerType).toBe('touch');
    expect(window.scrollY).toBe(0);
  });

  test('two fingers scroll natively with the toggle on and cancel the stroke', async () => {
    rig.state.draw = true;
    await swipe(2, 300);
    expect(rig.ends).toHaveLength(0);
    expect(rig.cancels).toBe(1);
    // Only trusted touches scroll natively. NEEDS_CDP.
    if (isChromium) expect(window.scrollY).toBeGreaterThan(150);
    expect(inked(rig)).toBe(0);
  });

  test('a second finger long after the first is a palm and the stroke goes on', async () => {
    rig.state.draw = true;
    // One gesture on the input clock: the second finger lands TWO_FINGER_WAIT after the first.
    const steps: TouchStep[] = [{ type: 'touchStart', points: [{ x: 100, y: 600, id: 1 }] }];
    for (let i = 1; i <= 4; i++)
      steps.push({ type: 'touchMove', points: [{ x: 100 + i * 10, y: 600, id: 1 }], gap: 16 });
    steps.push({
      type: 'touchStart',
      points: [
        { x: 140, y: 600, id: 1 },
        { x: 300, y: 700, id: 2 },
      ],
      gap: TWO_FINGER_WAIT,
    });
    for (let i = 1; i <= 4; i++) {
      steps.push({
        type: 'touchMove',
        points: [
          { x: 140 + i * 10, y: 600, id: 1 },
          { x: 300, y: 700 - i * 20, id: 2 },
        ],
        gap: 16,
      });
    }
    steps.push({ type: 'touchEnd', points: [], gap: REST_MS });
    await touchGesture(steps);
    await quiet();
    expect(rig.ends).toHaveLength(1);
    expect(rig.cancels).toBe(0);
  });
});

const TWO_FINGER_WAIT = 350;

describe('mouse', () => {
  test('draws only with the toggle or the modifier', async () => {
    await drag([60, 500], [200, 560]);
    expect(rig.ends).toHaveLength(0);
    await drag([60, 500], [200, 560], { modifiers: ALT });
    expect(rig.ends).toHaveLength(1);
    rig.state.draw = true;
    await drag([60, 500], [200, 560]);
    expect(rig.ends).toHaveLength(2);
    expect(rig.ends[1]?.pointerType).toBe('mouse');
  });

  test('a drag that starts on a link is ink, not a link drag or a click', async () => {
    rig.state.draw = true;
    const seen: string[] = [];
    for (const t of ['dragstart', 'selectstart', 'mouseup', 'click'])
      document.addEventListener(t, () => seen.push(t));
    await drag([70, 320], [190, 330]);
    await quiet();
    expect(rig.ends).toHaveLength(1);
    expect(clicks).toEqual([]);
    expect(seen).toEqual([]);
  });

  test('events on our own UI are never ink', async () => {
    rig.state.draw = true;
    const r = rig.ui.getBoundingClientRect();
    await drag([r.left + 10, r.top + 10], [r.left + 40, r.top + 40], { pen: true });
    expect(rig.ends).toHaveLength(0);
  });

  test('nothing is ink when ink is off for the site', async () => {
    rig.state.enabled = false;
    rig.state.draw = true;
    await drag([60, 500], [200, 560], { pen: true });
    await drag([60, 500], [200, 560]);
    expect(rig.starts).toHaveLength(0);
    expect(rig.ends).toHaveLength(0);
  });
});

describe('host options', () => {
  test('a page that stops events at the window: the front still hands them to capture', async () => {
    const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click'] as const;
    const subs = new Map<string, ((e: Event) => void)[]>();
    const relay = (e: Event) => {
      for (const f of subs.get(e.type) ?? []) f(e);
    };
    // The host's listeners come first, then the page's, which stop everything.
    for (const t of types) window.addEventListener(t, relay, true);
    const stop = (e: Event) => e.stopImmediatePropagation();
    for (const t of types) window.addEventListener(t, stop, true);
    try {
      rig.cap.destroy();
      const front: Front = {
        on(type, fn) {
          subs.set(type, [...(subs.get(type) ?? []), fn]);
          return () =>
            subs.set(
              type,
              (subs.get(type) ?? []).filter((x) => x !== fn),
            );
        },
      };
      rig.cap = createCapture({ ...rig.host, front });
      await drag([60, 500], [200, 540], { pen: true });
      expect(rig.ends.length).toBe(1);
      expect(rig.ends[0]!.samples.length).toBeGreaterThan(5);
      // Without the front, a page like this hides the pen.
      rig.cap.destroy();
      expect([...subs.values()].every((l) => l.length === 0)).toBe(true);
      rig.cap = createCapture(rig.host);
      await drag([60, 600], [200, 640], { pen: true });
      expect(rig.ends.length).toBe(1);
    } finally {
      for (const t of types) {
        window.removeEventListener(t, relay, true);
        window.removeEventListener(t, stop, true);
      }
    }
  });

  test('the front and the window listener do not handle one event twice', async () => {
    const subs = new Map<string, ((e: Event) => void)[]>();
    const relay = (e: Event) => {
      for (const f of subs.get(e.type) ?? []) f(e);
    };
    const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click'] as const;
    for (const t of types) window.addEventListener(t, relay, true);
    try {
      rig.cap.destroy();
      rig.cap = createCapture({
        ...rig.host,
        front: {
          on(type, fn) {
            subs.set(type, [...(subs.get(type) ?? []), fn]);
            return () => {};
          },
        },
      });
      await drag([60, 500], [200, 540], { pen: true });
      expect(rig.ends.length).toBe(1);
      expect(rig.starts.length).toBe(1);
    } finally {
      for (const t of types) window.removeEventListener(t, relay, true);
    }
  });

  test('a gesture that starts on an ignored element is never ink and reaches the page', async () => {
    rig.host.ignore = (el) => !!el.closest('#text');
    const seen: string[] = [];
    const text = document.getElementById('text') as HTMLElement;
    for (const t of ['pointerdown', 'pointermove', 'pointerup']) text.addEventListener(t, () => seen.push(t));
    await drag([60, 128], [200, 132], { pen: true });
    expect(rig.starts).toHaveLength(0);
    expect(rig.ends).toHaveLength(0);
    expect(seen).toContain('pointerdown');
    expect(seen).toContain('pointerup');
    // A pen over an ignored element does not hold the page still.
    expect(getComputedStyle(text).touchAction).toBe('auto');
    // A stroke that starts elsewhere is still ink.
    await drag([60, 500], [200, 560], { pen: true });
    expect(rig.ends).toHaveLength(1);
    rig.state.draw = true;
    await drag([60, 128], [200, 132]);
    expect(rig.ends).toHaveLength(1);
  });

  test('penNeedsToggle: a pen behaves like a mouse until the toggle is on', async () => {
    rig.host.penNeedsToggle = true;
    await drag([60, 500], [200, 560], { pen: true });
    expect(rig.ends).toHaveLength(0);
    // No pan guard either: the pen may scroll the page like a finger.
    expect(document.adoptedStyleSheets.length).toBe(0);
    expect(getComputedStyle(document.body).touchAction).toBe('auto');
    rig.state.draw = true;
    await drag([60, 500], [200, 560], { pen: true });
    expect(rig.ends).toHaveLength(1);
    expect(rig.ends[0]?.pointerType).toBe('pen');
  });
});

describe('samples', () => {
  test('coalesced samples are used and predicted ones are not reported', () => {
    const at = (x: number, y: number) =>
      new PointerEvent('pointermove', {
        pointerType: 'pen',
        pointerId: 5,
        clientX: x,
        clientY: y,
        pressure: 0.6,
      });
    const down = new PointerEvent('pointerdown', {
      pointerType: 'pen',
      pointerId: 5,
      button: 0,
      buttons: 1,
      clientX: 50,
      clientY: 500,
      pressure: 0.5,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(down);
    const mv = new PointerEvent('pointermove', {
      pointerType: 'pen',
      pointerId: 5,
      buttons: 1,
      clientX: 80,
      clientY: 500,
      pressure: 0.6,
      bubbles: true,
      cancelable: true,
      coalescedEvents: [at(60, 500), at(70, 500), at(80, 500)],
      predictedEvents: [at(90, 500), at(100, 500)],
    } as PointerEventInit);
    document.body.dispatchEvent(mv);
    expect(inked(rig)).toBeGreaterThan(0);
    document.body.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerType: 'pen',
        pointerId: 5,
        clientX: 80,
        clientY: 500,
        bubbles: true,
      }),
    );
    const xs = rig.ends[0]?.samples.map((s) => s.x);
    expect(xs).toEqual([50, 60, 70, 80]);
  });

  // Coalescing is the browser's own work on trusted input. NEEDS_CDP.
  chromiumTest('real moves sent faster than a frame arrive coalesced', async () => {
    let events = 0;
    const count = () => {
      events++;
    };
    window.addEventListener('pointermove', count, true);
    rig.cap.destroy();
    rig = makeRig();
    window.removeEventListener('pointermove', count, true);
    window.addEventListener('pointermove', count, true);
    const s = session();
    await pointer('mouseMoved', 50, 500, { pen: true });
    await pointer('mousePressed', 50, 500, { pen: true, force: 0.5 });
    events = 0;
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        s.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: 51 + i * 4,
          y: 500 + (i % 5),
          button: 'left',
          buttons: 1,
          pointerType: 'pen',
          force: 0.5,
        }),
      ),
    );
    await pointer('mouseReleased', 211, 504, { pen: true });
    window.removeEventListener('pointermove', count, true);
    const g = rig.ends[0] as Gesture;
    expect(g.samples.length).toBeGreaterThanOrEqual(30);
    // Fewer events than samples means coalesced samples were read.
    expect(events).toBeLessThanOrEqual(g.samples.length);
  });

  test('onMove runs at most once per frame', async () => {
    rig.state.draw = true;
    // Ten moves in one task, so they all land in one frame in every engine.
    synthMouse('mousePressed', 50, 500, 'mouse', {});
    for (let i = 1; i <= 10; i++) synthMouse('mouseMoved', 50 + i * 5, 500, 'mouse', { down: true });
    await frame();
    await frame();
    expect(rig.moves).toHaveLength(1);
    expect(rig.moves[0]!.samples.at(-1)!.x).toBe(100);
    synthMouse('mouseReleased', 100, 500, 'mouse', {});
    expect(rig.ends).toHaveLength(1);
  });
});

describe('lifecycle', () => {
  test('adopt replays events buffered before capture loaded', async () => {
    const mk = (type: string, x: number) =>
      new PointerEvent(type, {
        pointerType: 'pen',
        pointerId: 1,
        button: type === 'pointerdown' ? 0 : -1,
        buttons: 1,
        clientX: x,
        clientY: 500,
        pressure: 0.5,
      });
    // The stub saw these before the tools loaded.
    const buffered = [mk('pointerdown', 40), mk('pointermove', 50), mk('pointermove', 60)];
    rig.cap.adopt(buffered);
    expect(rig.starts).toHaveLength(1);
    // The pen is still down; live events continue the same stroke.
    await pointer('mousePressed', 70, 500, { pen: true, force: 0.5 });
    expect(rig.ends).toHaveLength(0);
    const mv = new PointerEvent('pointermove', {
      pointerType: 'pen',
      pointerId: 1,
      buttons: 1,
      clientX: 80,
      clientY: 500,
      pressure: 0.5,
      bubbles: true,
    });
    document.body.dispatchEvent(mv);
    document.body.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerType: 'pen',
        pointerId: 1,
        clientX: 80,
        clientY: 500,
        bubbles: true,
      }),
    );
    await pointer('mouseReleased', 70, 500, { pen: true });
    expect(rig.ends).toHaveLength(1);
    expect(rig.ends[0]?.samples.map((q) => q.x)).toEqual([40, 50, 60, 80]);
  });

  /** A real pen stroke the page sees before capture exists, buffered the way the stub does. */
  async function bufferedStroke(from: [number, number], to: [number, number]): Promise<PointerEvent[]> {
    rig.cap.destroy();
    const buf: PointerEvent[] = [];
    const keep = (e: Event) => buf.push(e as PointerEvent);
    const types = ['pointerdown', 'pointermove', 'pointerup'];
    for (const t of types) window.addEventListener(t, keep, true);
    await drag(from, to, { pen: true, steps: 10, noHover: true });
    for (const t of types) window.removeEventListener(t, keep, true);
    rig.cap = createCapture(rig.host);
    return buf;
  }

  // The page's own selection comes from trusted mouse events. NEEDS_CDP.
  chromiumTest('a buffered pen stroke over text leaves no selection once adopted as ink', async () => {
    const buf = await bufferedStroke([40, 130], [300, 136]);
    // The page made a selection from the mouse events it saw.
    expect(document.getSelection()?.toString().length).toBeGreaterThan(5);
    rig.cap.adopt(buf);
    expect(rig.ends).toHaveLength(1);
    expect(document.getSelection()?.toString()).toBe('');
  });

  test('a selection the reader made before the pen went down is kept', async () => {
    const pad = document.createElement('div');
    pad.style.cssText = 'position:absolute;left:20px;top:600px;width:360px;height:80px;user-select:none';
    document.body.append(pad);
    const text = document.getElementById('text')!.firstChild!;
    const sel = document.getSelection()!;
    sel.setBaseAndExtent(text, 10, text, 30);
    const before = sel.toString();
    expect(before.length).toBe(20);
    const buf = await bufferedStroke([40, 620], [300, 660]);
    rig.cap.adopt(buf);
    expect(rig.ends).toHaveLength(1);
    expect(document.getSelection()?.toString()).toBe(before);
  });

  test('adopt skips pointerrawupdate, whose coordinates are wrong in same-process frames', () => {
    const mk = (type: string, x: number, y = 500) =>
      new PointerEvent(type, {
        pointerType: 'pen',
        pointerId: 1,
        button: type === 'pointerdown' ? 0 : -1,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
        pressure: 0.5,
      });
    rig.cap.adopt([
      mk('pointerdown', 40),
      mk('pointerrawupdate', 400, 900),
      mk('pointermove', 50),
      mk('pointerrawupdate', 410, 900),
      mk('pointermove', 60),
      mk('pointerup', 60),
    ]);
    expect(rig.ends).toHaveLength(1);
    expect(rig.ends[0]?.samples.every((q) => q.x <= 60)).toBe(true);
  });

  test('a whole buffered stroke is replayed into one gesture', () => {
    const mk = (type: string, x: number) =>
      new PointerEvent(type, {
        pointerType: 'pen',
        pointerId: 9,
        button: 0,
        buttons: 1,
        clientX: x,
        clientY: 520,
        pressure: 0.5,
      });
    rig.cap.adopt([mk('pointerdown', 40), mk('pointermove', 60), mk('pointermove', 90), mk('pointerup', 90)]);
    expect(rig.ends).toHaveLength(1);
    expect(rig.ends[0]?.samples).toHaveLength(3);
  });

  test('destroy removes every listener and element', async () => {
    await pointer('mouseMoved', 100, 500, { pen: true });
    await drag([60, 500], [200, 560], { pen: true });
    expect(rig.mount.querySelector('canvas')).not.toBeNull();
    expect(document.adoptedStyleSheets.length).toBe(1);
    rig.cap.destroy();
    expect(rig.mount.querySelector('canvas')).toBeNull();
    expect(document.adoptedStyleSheets.length).toBe(0);
    const before = rig.ends.length;
    await drag([60, 500], [200, 560], { pen: true });
    await swipe(1, 200);
    expect(rig.ends.length).toBe(before);
    expect(document.adoptedStyleSheets.length).toBe(0);
  });
});

describe('probe', () => {
  let probes: StrokeProbe[];
  beforeEach(() => {
    probes = [];
    rig.cap.destroy();
    rig.cap = createCapture({ ...rig.host, probe: createProbe(window, (p) => probes.push(p)) });
  });

  test('a pen stroke reports what capture saw, with the palm that landed meanwhile', async () => {
    const stylus = touchEventOf('touchstart', [
      {
        identifier: 3,
        target: document.getElementById('text') as Element,
        clientX: 60,
        clientY: 130,
        touchType: 'stylus',
      },
    ]);
    document.getElementById('text')?.dispatchEvent(stylus);
    await pointer('mouseMoved', 60, 500, { pen: true });
    await pointer('mousePressed', 60, 500, { pen: true, force: 0.5 });
    await touch('touchStart', [{ x: 300, y: 700, id: 1 }]);
    for (let i = 1; i <= 8; i++) {
      await pointer('mouseMoved', 60 + i * 10, 500, { pen: true, down: true, force: 0.3 + i * 0.05 });
    }
    await pointer('mouseReleased', 140, 500, { pen: true });
    await touch('touchEnd', []);
    await frame();
    await frame();
    expect(probes).toHaveLength(1);
    const p = probes[0] as StrokeProbe;
    expect(p).toMatchObject({
      pointerType: 'pen',
      tool: 'pen',
      outcome: 'ink',
      draw: false,
      replayed: false,
    });
    expect(p.samples).toBeGreaterThan(4);
    expect(p.moves).toBeGreaterThan(4);
    expect(p.coalesced).toBeGreaterThanOrEqual(p.moves);
    expect(p.pressure.min).toBeGreaterThan(0);
    expect(p.pressure.max).toBeLessThanOrEqual(1);
    expect(p.stylusTouches).toBe(1);
    expect(p.stylusCancelled).toBe(1);
    expect(p.fingersWhilePen).toBe(1);
    expect(p.fingersBlocked).toBe(1);
    expect(p.scroll1).toEqual(p.scroll0);
    expect(p.firstPaintMs).not.toBeNull();
    expect(p.firstFrameMs).not.toBeNull();
    expect(p.t1).toBeGreaterThanOrEqual(p.t0);
  });

  test('a replayed stroke says so, a tap on a link is a tap, and a pen-down with ink off is a skip', async () => {
    const mk = (type: string, x: number) =>
      new PointerEvent(type, {
        pointerType: 'pen',
        pointerId: 1,
        button: type === 'pointerdown' ? 0 : -1,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: 500,
        pressure: 0.5,
      });
    rig.cap.adopt([mk('pointerdown', 40), mk('pointermove', 60), mk('pointermove', 80), mk('pointerup', 80)]);
    await frame();
    expect(probes.at(-1)).toMatchObject({ outcome: 'ink', replayed: true, samples: 3 });

    await penTap(60, 320);
    expect(probes.at(-1)).toMatchObject({ outcome: 'tap', replayed: false });

    rig.state.enabled = false;
    await pointer('mousePressed', 60, 500, { pen: true, force: 0.5 });
    await pointer('mouseReleased', 60, 500, { pen: true });
    expect(probes.at(-1)).toMatchObject({ outcome: 'skip', reason: 'off', samples: 0 });
    expect(probes).toHaveLength(3);
  });
});

describe('pen guard fallback', () => {
  const guardStyles = () =>
    [...document.querySelectorAll('style')].filter((s) => s.textContent?.includes('touch-action:none'));

  async function withAdopted(desc: PropertyDescriptor, run: () => Promise<void>): Promise<void> {
    const proto = Document.prototype;
    const orig = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets')!;
    Object.defineProperty(document, 'adoptedStyleSheets', { ...desc, configurable: true });
    try {
      await run();
    } finally {
      delete (document as unknown as Record<string, unknown>).adoptedStyleSheets;
      Object.defineProperty(proto, 'adoptedStyleSheets', orig);
    }
  }

  test('uses a style element when adopting throws, and removes it on pen lift away', async () => {
    await withAdopted(
      {
        get: () => [],
        set: () => {
          throw new Error('not in this world');
        },
      },
      async () => {
        window.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'pen' }));
        expect(guardStyles()).toHaveLength(1);
        await drag([60, 500], [200, 560], { pen: true });
        expect(rig.ends).toHaveLength(1);
        // A mouse means the pen is gone: the guard comes down.
        window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', button: 2 }));
        expect(guardStyles()).toHaveLength(0);
      },
    );
  });

  test('uses a style element when adoptedStyleSheets is missing', async () => {
    await withAdopted({ get: () => undefined, set: () => {} }, async () => {
      window.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'pen' }));
      expect(guardStyles()).toHaveLength(1);
      rig.cap.destroy();
      expect(guardStyles()).toHaveLength(0);
    });
  });

  test('uses a style element when the write is silently dropped', async () => {
    await withAdopted({ get: () => [], set: () => {} }, async () => {
      window.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'pen' }));
      expect(guardStyles()).toHaveLength(1);
      rig.cap.destroy();
      expect(guardStyles()).toHaveLength(0);
    });
  });
});
