import type { Page } from '@playwright/test';
import { expect, layerInfo, ring, shotPath, stroke, test } from './fixtures';

/** Contrast ratio between the ink on the ring and the page background, from screenshot pixels. */
async function inkContrast(
  ext: Page,
  png: Buffer,
  pts: { x: number; y: number }[],
  bg: { x: number; y: number },
) {
  return ext.evaluate(
    async ([b64, points, b]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const px = (x: number, y: number) =>
        [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
      const lum = ([r, gg, bb]: number[]) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r!) + 0.7152 * f(gg!) + 0.0722 * f(bb!);
      };
      const ratio = (a: number, z: number) => (Math.max(a, z) + 0.05) / (Math.min(a, z) + 0.05);
      const back = lum(px(b.x, b.y));
      const found: number[] = [];
      for (const p of points) {
        let best = 1;
        // The stroke may sit a pixel or two off the sampled path.
        for (let dx = -2; dx <= 2; dx++)
          for (let dy = -2; dy <= 2; dy++) best = Math.max(best, ratio(lum(px(p.x + dx, p.y + dy)), back));
        found.push(best);
      }
      found.sort((x, y) => x - y);
      return { median: found[Math.floor(found.length / 2)]!, bg: px(b.x, b.y) };
    },
    [png.toString('base64'), pts, bg] as const,
  );
}

for (const [name, file, theme] of [
  ['dark', 'dark.html', 'dark'],
  ['light', 'article.html', 'light'],
] as const) {
  test(`${name} page: stroke colours map to the theme and stay readable`, async ({
    context,
    origin,
    ext,
  }) => {
    const page = await context.newPage();
    await page.goto(`${origin.a}/${file}`);
    const b = (await page.locator('#blank').boundingBox())!;
    await page.evaluate((y) => scrollTo(0, y - 100), b.y);
    const box = (await page.locator('#blank').boundingBox())!;
    const c = { x: box.x + 300, y: box.y + 150 };
    const pts = ring(c, 90, 60, 36);
    await stroke(page, pts);
    await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
    expect((await layerInfo(page))!.theme).toBe(theme);
    // Once the bar has hidden, only page and ink are in the picture.
    await expect.poll(async () => (await layerInfo(page))?.bar?.hidden).toBe(true);
    const png = await page.screenshot({ path: shotPath(`theme-${name}`) });
    const r = await inkContrast(ext, png, pts.slice(1, -1), { x: c.x, y: c.y });
    console.log(
      `${name} page: ink contrast ${r.median.toFixed(1)} against background rgb(${r.bg.join(',')})`,
    );
    expect(r.median).toBeGreaterThan(4.5);
  });
}
