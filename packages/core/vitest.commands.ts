// Browser commands for the Vitest browser tests, shared with the embed package.
// They run on the test server and drive the page through Playwright, which works
// in every engine, unlike CDP.
import type { BrowserCommand } from 'vitest/node';

/** prefers-reduced-motion, set for the whole page. */
const reducedMotion: BrowserCommand<[on: boolean]> = async (ctx, on) => {
  await ctx.page.emulateMedia({ reducedMotion: on ? 'reduce' : 'no-preference' });
};

type MouseStep = 'mousePressed' | 'mouseMoved' | 'mouseReleased';
const KEYS: [number, string][] = [
  [1, 'Alt'],
  [2, 'Control'],
  [4, 'Meta'],
  [8, 'Shift'],
];

/**
 * One trusted mouse event at a client point of the test frame. Playwright takes page
 * coordinates, so the frame's offset is added. Modifier bits are CDP's: 1 Alt, 2 Control,
 * 4 Meta, 8 Shift.
 */
const realMouse: BrowserCommand<[type: MouseStep, x: number, y: number, modifiers: number]> = async (
  ctx,
  type,
  x,
  y,
  modifiers,
) => {
  const frame = await ctx.frame();
  const box = await (await frame.frameElement()).boundingBox();
  const px = x + (box?.x ?? 0);
  const py = y + (box?.y ?? 0);
  const { mouse, keyboard } = ctx.page;
  const keys = KEYS.filter(([bit]) => modifiers & bit).map(([, k]) => k);
  for (const k of keys) await keyboard.down(k);
  try {
    if (type === 'mousePressed') {
      await mouse.move(px, py);
      await mouse.down();
    } else if (type === 'mouseMoved') await mouse.move(px, py);
    else {
      await mouse.move(px, py);
      await mouse.up();
    }
  } finally {
    for (const k of keys.reverse()) await keyboard.up(k);
  }
};

/**
 * Slow the page's CPU by `rate` through CDP, as a slow machine would. Chromium only: elsewhere
 * it does nothing and returns false. Set VITE_INK_CPU_THROTTLE to run a suite this way.
 */
const throttle: BrowserCommand<[rate: number]> = async (ctx, rate) => {
  try {
    const cdp = await ctx.page.context().newCDPSession(ctx.page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    return true;
  } catch {
    return false;
  }
};

export const commands = { reducedMotion, realMouse, throttle };
