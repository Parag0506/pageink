// The PDF viewer frame fills the window at every device scale, and ink stays on its PDF point.
// The scale is set the way a real high density screen sets it. Playwright's deviceScaleFactor
// emulation is not used: it lays out every cross-origin frame, on any page, at the window size
// divided by the scale, so it cannot show how a real screen lays out the viewer frame.
import { chromium, expect, test } from '@playwright/test';
import { centre, dropProfile, extDir, newProfile, ring, stroke } from './fixtures';
import { inkCount, notePoint, pdfServer, ready, showPage, viewerOf, wordBox, wordPoint } from './pdf-kit';

let srv: Awaited<ReturnType<typeof pdfServer>>;
test.beforeAll(async () => {
  srv = await pdfServer();
});
test.afterAll(() => srv.close());

for (const scale of [1, 2, 3, 4]) {
  test(`at device scale ${scale}, the viewer fills the window and ink stays on its point`, async () => {
    const profile = newProfile();
    const ctx = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: null,
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        '--window-size=1000,800',
        `--force-device-scale-factor=${scale}`,
      ],
    });
    try {
      const page = await ctx.newPage();
      await page.goto(`${srv.url}/doc.pdf`);
      const v = await viewerOf(page);
      await ready(v);
      const top = await page.evaluate(() => {
        const r = document.querySelector('iframe')!.getBoundingClientRect();
        return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, fw: r.width, fh: r.height };
      });
      expect(top.dpr).toBe(scale);
      expect(top.fw).toBe(top.w);
      expect(top.fh).toBe(top.h);
      const inner = await v.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
      expect(inner).toEqual({ w: top.w, h: top.h, dpr: scale });
      // The page fills the view's width, and its canvas has more pixels than CSS pixels on a dense screen.
      const c = await v.evaluate(() => {
        const cv = document.querySelector('.page canvas') as HTMLCanvasElement;
        return { px: cv.width, css: cv.getBoundingClientRect().width };
      });
      expect(c.css).toBeGreaterThan(top.w * 0.8);
      if (scale > 1) expect(c.px / c.css).toBeGreaterThan(1.5);

      await showPage(v, 2);
      const w = await wordBox(v, 2, 'quokka2');
      await stroke(page, ring(centre(w), w.w / 2 + 10, w.h / 2 + 8));
      await expect.poll(async () => (await inkCount(v)).notes).toBe(1);
      const at = async (f: typeof v) => {
        const n = await notePoint(f, 2);
        const t = await wordPoint(f, 2, 'quokka2');
        return n && { dx: n.x - t.x, dy: n.y - t.y };
      };
      const first = (await at(v))!;
      expect(first).not.toBeNull();

      await page.reload();
      const v2 = await viewerOf(page);
      await ready(v2);
      await showPage(v2, 2);
      await expect.poll(async () => (await inkCount(v2)).notes).toBe(1);
      await v2.locator('#zoom-in').click();
      await showPage(v2, 2);
      await expect
        .poll(async () => {
          const a = await at(v2);
          return a ? Math.abs(a.dx - first.dx) + Math.abs(a.dy - first.dy) : 1;
        })
        .toBeLessThan(0.006);
    } finally {
      await ctx.close().finally(() => dropProfile(profile));
    }
  });
}
