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

/**
 * What the browser puts on the screen: one frame of the page's screencast as a JPEG, with the
 * place of the test frame in it. A screenshot paints the page again in one pass, so it cannot
 * show a fault in how the browser puts its layers together. A screencast frame can.
 */
const shown: BrowserCommand<[]> = async (ctx) => {
  const frame = await ctx.frame();
  const box = await (await frame.frameElement()).boundingBox();
  const size = ctx.page.viewportSize() ?? { width: 1280, height: 720 };
  let last: { data: Buffer; viewportWidth: number } | undefined;
  let seen = 0;
  await ctx.page.screencast.start({
    size,
    quality: 100,
    onFrame: (f) => {
      last = f;
      seen++;
    },
  });
  try {
    // A browser sends a frame when the page changes. One pixel in the corner changes until
    // two frames have come, so the frame read is from after the screencast began.
    for (let i = 0; i < 100 && seen < 2; i++) {
      await ctx.page.evaluate((n) => {
        const id = 'ink-shown-tick';
        let d = document.getElementById(id);
        if (!d) {
          d = document.createElement('div');
          d.id = id;
          d.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:2147483647';
          document.documentElement.append(d);
        }
        d.style.background = n % 2 ? '#fefefe' : '#fdfdfd';
        return new Promise((r) => requestAnimationFrame(() => r(null)));
      }, i);
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await ctx.page.screencast.stop();
    await ctx.page.evaluate(() => document.getElementById('ink-shown-tick')?.remove());
  }
  if (!last) throw new Error('The browser sent no screencast frame');
  return {
    jpeg: last.data.toString('base64'),
    viewportWidth: last.viewportWidth || size.width,
    x: box?.x ?? 0,
    y: box?.y ?? 0,
    width: box?.width ?? size.width,
  };
};

export const commands = { reducedMotion, realMouse, throttle, shown };
