// Screenshots of the example page with some pen ink, wide and narrow, light and dark.
// Usage: node scripts/shots.mjs [out dir]   (build first)
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const out = process.argv[2] ?? join(tmpdir(), 'pageink-embed-shots');
mkdirSync(out, { recursive: true });
const port = 5191;
const server = await serve(port);
const browser = await chromium.launch();

async function pen(page, pts) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, x, y, extra = {}) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, pointerType: 'pen', modifiers: 0, ...extra });
  const [x0, y0] = pts[0];
  await send('mouseMoved', x0, y0);
  await send('mousePressed', x0, y0, { button: 'left', clickCount: 1, force: 0.5 });
  for (const [x, y] of pts.slice(1))
    await send('mouseMoved', x, y, { button: 'left', buttons: 1, force: 0.6 });
  const [x1, y1] = pts[pts.length - 1];
  await send('mouseReleased', x1, y1, { button: 'left', clickCount: 1 });
}

const circle = (r, pad = 6) => {
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2.15 - 0.4;
    pts.push([
      r.x + r.width / 2 + (r.width / 2 + pad) * Math.cos(a),
      r.y + r.height / 2 + (r.height / 2 + pad) * Math.sin(a),
    ]);
  }
  return pts;
};

async function shot(name, { width, height, dark }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: dark ? 'dark' : 'light',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}/example/`);
  await page.evaluate(() => window.PageInk.auto.ready);
  await page.screenshot({ path: join(out, `${name}-top.png`) });
  await page.evaluate(() => {
    document.querySelectorAll('h2')[0].scrollIntoView({ block: 'start' });
    window.scrollBy(0, -30);
  });
  // Circle a phrase and underline-scribble in the margin.
  const r = await page.evaluate(() => {
    const p = [...document.querySelectorAll('main p')].find((e) =>
      e.textContent.includes('pulled a little harder'),
    );
    const t = p.firstChild;
    const i = t.data.indexOf('pulled a little harder');
    const range = document.createRange();
    range.setStart(t, i);
    range.setEnd(t, i + 'pulled a little harder'.length);
    const b = range.getClientRects()[0];
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  await pen(page, circle(r));
  const m = await page.evaluate(() => {
    const p = [...document.querySelectorAll('main p')].find((e) =>
      e.textContent.startsWith('The ocean on the far'),
    );
    const b = p.getBoundingClientRect();
    return { x: b.right, y: b.top };
  });
  if (width > 900) {
    const pts = [];
    for (let i = 0; i <= 30; i++) pts.push([m.x + 30 + i * 3, m.y + 20 + Math.sin(i / 2.5) * 8]);
    await pen(page, pts);
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}.png`) });
  const notes = await page.evaluate(() => window.PageInk.auto.state().notes);
  await ctx.close();
  console.log(`${name}: notes ${notes}${errors.length ? `, errors: ${errors.join(' | ')}` : ''}`);
}

await shot('wide-light', { width: 1280, height: 900 });
await shot('wide-dark', { width: 1280, height: 900, dark: true });
await shot('narrow-light', { width: 390, height: 844 });
await browser.close();
server.close();
console.log(`Screenshots in ${out}`);
