/**
 * Firefox smoke test: load the Firefox build as a temporary add-on in a real
 * Firefox, write with the mouse and the modifier key, reload, and check that
 * the ink comes back. Run after `wxt build -b firefox`.
 *
 * Firefox lets Playwright drive pages but not install add-ons, so the add-on
 * goes in through Firefox's own remote debugging protocol, as web-ext does.
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { firefox } from '@playwright/test';

// web-ext does not export its remote client, so it is loaded by file.
const webExt = resolve(import.meta.dirname, '../node_modules/web-ext');
const { connectWithMaxRetries, findFreeTcpPort } = await import(
  pathToFileURL(resolve(webExt, 'lib/firefox/remote.js')).href
);

const dir = resolve(import.meta.dirname, '../.output/firefox-mv3');
const page = `<!doctype html><meta charset="utf-8"><title>Firefox smoke</title>
<body style="font:18px/1.6 Georgia,serif;margin:40px;background:#fff;color:#222">
<p id="p">Iron gall ink was the standard writing ink in Europe for a thousand years.</p></body>`;

const server = createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(page));
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://localhost:${server.address().port}/smoke.html`;
const port = await findFreeTcpPort();
const browser = await firefox.launch({
  headless: true,
  args: ['--start-debugger-server', String(port)],
  firefoxUserPrefs: {
    'devtools.debugger.remote-enabled': true,
    'devtools.debugger.prompt-connection': false,
    'devtools.chrome.enabled': true,
    'xpinstall.signatures.required': false,
  },
});
let failed = '';
try {
  const remote = await connectWithMaxRetries({ port });
  const added = await remote.installTemporaryAddon(dir);
  console.log(`installed ${added.addon.id}`);
  const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const tab = await ctx.newPage();
  // Content script errors reach the page console in Firefox.
  tab.on('console', (m) => {
    if (m.type() === 'error') console.log(`console: ${m.text()}`);
  });
  await tab.goto(url);
  // Release builds leave no mark; the stub runs at document start, long before load ends.
  await tab.waitForLoadState('load');
  const word = await tab.evaluate(() => {
    const t = document.getElementById('p').firstChild;
    const i = t.textContent.indexOf('Europe');
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + 6);
    const b = r.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  /** Dark ink pixels in the ring around the word, from a screenshot. */
  const inkPixels = async () => {
    const png = await tab.screenshot({
      clip: { x: word.x - 16, y: word.y - 14, width: word.w + 32, height: word.h + 28 },
    });
    return tab.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let n = 0;
      // Ink colour #1f2a44 in the light theme. Text is #222, so blue decides.
      for (let i = 0; i < d.length; i += 4) if (d[i + 2] - d[i] > 25 && d[i] < 90) n++;
      return n;
    }, png.toString('base64'));
  };
  const until = async (fn, what, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  if ((await inkPixels()) > 5) throw new Error('ink colour on the page before writing');
  // Mouse with Alt held: the default draw modifier.
  const cx = word.x + word.w / 2;
  const cy = word.y + word.h / 2;
  const pts = Array.from({ length: 29 }, (_, i) => {
    const a = (i / 28) * Math.PI * 2;
    return { x: cx + Math.cos(a) * (word.w / 2 + 10), y: cy + Math.sin(a) * (word.h / 2 + 8) };
  });
  await tab.keyboard.down('Alt');
  await tab.mouse.move(pts[0].x, pts[0].y);
  await tab.mouse.down();
  for (const p of pts.slice(1)) await tab.mouse.move(p.x, p.y);
  await tab.mouse.up();
  await tab.keyboard.up('Alt');

  await until(async () => (await inkPixels()) > 40, 'ink after writing');
  const before = await inkPixels();
  await tab.waitForTimeout(300);
  await tab.reload();
  await until(async () => (await inkPixels()) > before * 0.8, 'ink after reload');
  console.log(`ink pixels: ${before} written, ${await inkPixels()} after reload`);
  // The layer is in place again after the reload.
  if ((await tab.locator('ink-layer').count()) !== 1) throw new Error('no layer after reload');

  await remote.disconnect?.();
} catch (e) {
  failed = String(e?.stack ?? e);
} finally {
  await browser.close();
  server.close();
}
if (failed) {
  console.error(`Firefox smoke test failed: ${failed}`);
  process.exit(1);
}
console.log('Firefox smoke test passed: write, reload, ink returns.');
