/**
 * The viewer page with the PDF.js build the Firefox and Safari targets ship,
 * in Gecko and WebKit. The built page is served from a local static server
 * and the extension API is a small stand-in, so no extension loading is
 * needed. A page of a generated PDF must render.
 * The engines are Playwright's current ones, not the oldest supported
 * versions. test/builtins.test.ts covers the versions.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { type BrowserType, expect, firefox, test, webkit } from '@playwright/test';
import { makePdf, paperPages } from './pdfs';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serve(dir: string): Promise<Server> {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    const file = join(dir, path);
    if (!file.startsWith(dir) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res
      .writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      .end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/** What the viewer page asks of the extension API. Storage starts empty. */
function stubApi(): void {
  const store: Record<string, unknown> = {};
  const listeners = { addListener() {}, removeListener() {} };
  (globalThis as unknown as { browser: unknown }).browser = {
    runtime: {
      id: 'engine-test',
      getURL: (p: string) => p,
      sendMessage: async () => undefined,
      onMessage: listeners,
    },
    storage: {
      local: {
        get: async (keys: string[] | null) =>
          Object.fromEntries(Object.entries(store).filter(([k]) => !keys || keys.includes(k))),
        set: async (items: Record<string, unknown>) => void Object.assign(store, items),
        remove: async (keys: string[]) => {
          for (const k of keys) delete store[k];
        },
        getKeys: async () => Object.keys(store),
      },
      onChanged: listeners,
    },
  };
}

const DOC = makePdf({ pages: paperPages(2, 'engine'), title: 'Engine paper' });

const engines: [string, BrowserType, string][] = [
  ['firefox', firefox, 'firefox-mv3'],
  ['webkit', webkit, 'safari-mv3'],
];

for (const [name, type, build] of engines) {
  test(`${name}: the shipped viewer renders a page of a PDF`, async () => {
    const dir = resolve(import.meta.dirname, '../.output', build);
    test.skip(!existsSync(join(dir, 'pdf.html')), `run wxt build for ${build} first`);
    test.skip(!existsSync(type.executablePath()), `Playwright has no ${name} installed`);
    const server = await serve(dir);
    const browser = await type.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(stubApi);
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/pdf.html`);
      await page
        .locator('#file')
        .setInputFiles({ name: 'engine.pdf', mimeType: 'application/pdf', buffer: DOC });
      await page.waitForFunction(
        () =>
          document.documentElement.classList.contains('has-doc') && !!document.querySelector('.page canvas'),
        undefined,
        { timeout: 20_000 },
      );
      await expect(page.locator('#count')).toHaveText('of 2');
      await expect(page.locator('#too-old')).toHaveCount(0);
      // The page was drawn: the canvas holds dark text pixels on white paper.
      const dark = await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('.page canvas')!;
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! < 100 && d[i + 3]! > 0) n++;
        return n;
      });
      expect(dark).toBeGreaterThan(100);
      // The legacy build's polyfills ran in the page.
      expect(await page.evaluate(() => '__core-js_shared__' in globalThis)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      server.close();
    }
  });
}

test('a browser that cannot run PDF.js gets the message, not a blank page', async () => {
  const dir = resolve(import.meta.dirname, '../.output/firefox-mv3');
  test.skip(!existsSync(join(dir, 'pdf.html')), 'run wxt build for firefox-mv3 first');
  test.skip(!existsSync(firefox.executablePath()), 'Playwright has no firefox installed');
  const server = await serve(dir);
  const browser = await firefox.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(stubApi);
    // An engine with no Iterator global that polyfills cannot add one either.
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'Iterator', {
        value: undefined,
        writable: false,
        configurable: false,
      });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/pdf.html`);
    await expect(page.locator('#too-old')).toHaveText(/^This browser is too old to open PDFs with /);
    await expect(page.locator('#empty [data-open]')).toHaveCount(0);
    await expect(page.locator('#bar')).toBeHidden();
  } finally {
    await browser.close();
    server.close();
  }
});
