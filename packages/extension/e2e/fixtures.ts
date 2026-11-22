/**
 * Playwright fixtures: two local static servers on two ports, and Chromium
 * with the real Chrome build of the extension loaded (.output/chrome-mv3).
 * The layer lives in a closed shadow root, so tests read it through CDP.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import {
  type BrowserContext,
  test as base,
  type CDPSession,
  chromium,
  type Frame,
  type Page,
  type Worker,
} from '@playwright/test';
import { forbidden, record, unpackedId } from './netlog';

export { extensionRequests } from './netlog';

/** INK_TARGET=edge runs the same tests against the Edge build, which Chromium loads too. */
export const extDir = resolve(import.meta.dirname, `../.output/${process.env.INK_TARGET ?? 'chrome'}-mv3`);
/**
 * The bench build (`wxt build --mode bench`): the same code and loading path, plus the
 * performance marks that the timing tests read. Release builds have none.
 */
export const benchDir = `${extDir}-bench`;
const pagesDir = resolve(import.meta.dirname, 'pages');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
};
/** Pages whose name starts with csp get a strict policy, like many real sites. */
export const STRICT_CSP = "default-src 'self'; style-src 'self'; script-src 'self'";

/** Words for the streamed page, picked by a fixed sequence so every load is the same. */
const WORDS = 'river stone harbor lantern meadow copper willow signal orchard canvas ember quarry'.split(' ');

/** One chunk of the streamed page: a section of paragraphs. */
function streamChunk(i: number, per: number): string {
  let out = `<section id="s${i}"><h2>Part ${i + 1}</h2>`;
  for (let k = 0; k < per; k++) {
    const w: string[] = [];
    for (let j = 0; j < 40; j++) w.push(WORDS[(i * 7 + k * 5 + j * 3) % WORDS.length]!);
    out += `<p id="p${i}-${k}">Part ${i + 1}, line ${k + 1}: ${w.join(' ')}.</p>`;
  }
  return `${out}</section>`;
}

/**
 * A long article sent in pieces with a pause between them, as a slow network feeds the
 * parser: /stream.html?parts=12&per=30&gap=60.
 */
function stream(u: URL, res: ServerResponse): void {
  const parts = Number(u.searchParams.get('parts') ?? 12);
  const per = Number(u.searchParams.get('per') ?? 30);
  const gap = Number(u.searchParams.get('gap') ?? 60);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.write(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Streamed</title>' +
      '<style>body{margin:0;font:17px/1.6 Georgia,serif}main{max-width:640px;margin:24px auto}</style></head>' +
      `<body><main><h1>A long streamed article</h1>${' '.repeat(2048)}`,
  );
  let i = 0;
  const next = () => {
    if (i >= parts) {
      res.end('</main></body></html>');
      return;
    }
    res.write(streamChunk(i++, per));
    setTimeout(next, gap);
  };
  next();
}

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/stream.html') return stream(u, res);
    const path = normalize(decodeURIComponent(u.pathname));
    // Single page app routes all serve the same file.
    const name = path.startsWith('/app/') ? '/spa.html' : path === '/' ? '/plain.html' : path;
    const file = join(pagesDir, name);
    if (!file.startsWith(pagesDir) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    const headers: Record<string, string> = { 'content-type': TYPES[extname(file)] ?? 'text/plain' };
    if (/^\/csp[^/]*\.html$/.test(name)) headers['content-security-policy'] = STRICT_CSP;
    res.writeHead(200, headers).end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/**
 * The test build, which talks to the local fake clouds (INK_CLOUD_FAKE=1 wxt build). Only the
 * cloud tests load it; every other test loads the release build above.
 */
export const testExtDir = resolve(
  import.meta.dirname,
  `../.output/test-${process.env.INK_TARGET ?? 'chrome'}-mv3`,
);

/**
 * A fresh profile folder for one browser. Each test gets its own, so tests share no storage.
 * They sit in the run's folder (e2e/profiles.ts), which goes when the run ends, so a test that
 * fails or times out before its own clean-up leaves nothing behind.
 */
export const newProfile = (): string =>
  mkdtempSync(join(process.env.INK_E2E_PROFILES ?? tmpdir(), 'ink-e2e-'));

/** Remove a profile folder once its browser has closed. */
export const dropProfile = (profile: string): void =>
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

/** The first-run guide's address ends with this (src/background/first-run.ts). */
const GUIDE = '/options.html#welcome';

/**
 * A profile that never ran the extension gets the first-run guide: a tab of its own, in front,
 * a moment after the extension loads. A page a test opened before that moment would lose the
 * front to it, and only the tab in front gets a picture of itself. So a launch into an unused
 * profile ends when the guide's tab is there. Every page a test opens comes after it and is in
 * front until the test itself opens another.
 */
async function guideOpened(ctx: BrowserContext): Promise<void> {
  const there = () => ctx.pages().some((p) => p.url().endsWith(GUIDE));
  const end = Date.now() + 60_000;
  while (!there()) {
    if (Date.now() > end) throw new Error('the first-run guide did not open in an unused profile');
    await new Promise<void>((done) => {
      const t = setTimeout(done, 100);
      ctx.once('page', () => {
        clearTimeout(t);
        done();
      });
    });
  }
}

/**
 * Chromium with the extension loaded, in a fresh profile unless one is given. A fresh profile
 * is removed when the context closes. A given one is the caller's to remove. On a profile that
 * was never used the first-run guide is open when this returns.
 */
export async function launch(given?: string, more: string[] = [], dir = extDir): Promise<BrowserContext> {
  if (!existsSync(join(dir, 'manifest.json'))) {
    const how =
      dir === benchDir
        ? 'wxt build --mode bench'
        : dir === testExtDir
          ? 'INK_CLOUD_FAKE=1 wxt build'
          : 'wxt build';
    throw new Error(`Run ${how} first`);
  }
  const list = [dir, ...more].join(',');
  const profile = given ?? newProfile();
  const unused = readdirSync(profile).length === 0;
  let ctx: BrowserContext;
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1000, height: 800 },
      args: [`--disable-extensions-except=${list}`, `--load-extension=${list}`],
    });
  } catch (e) {
    if (!given) dropProfile(profile);
    throw e;
  }
  // Every request the extension starts is recorded. Closing fails if one breaks the rule.
  record(ctx);
  if (unused) {
    try {
      await guideOpened(ctx);
    } catch (e) {
      await ctx.close().catch(() => {});
      if (!given) dropProfile(profile);
      throw e;
    }
  }
  // INK_CPU_THROTTLE=4 slows every page's CPU four times, as a slow machine would.
  const rate = Number(process.env.INK_CPU_THROTTLE ?? 0);
  if (rate > 1) {
    const slow = async (p: Page) => {
      const cdp = await ctx.newCDPSession(p).catch(() => null);
      await cdp?.send('Emulation.setCPUThrottlingRate', { rate }).catch(() => {});
    };
    ctx.on('page', (p) => void slow(p));
    for (const p of ctx.pages()) await slow(p);
  }
  const others = more.map(unpackedId);
  const close = ctx.close.bind(ctx);
  ctx.close = async (o) => {
    const bad = forbidden(ctx, others);
    try {
      await close(o);
    } finally {
      if (!given) dropProfile(profile);
    }
    if (bad.length) {
      throw new Error(
        `the extension made network requests:\n${bad.map((r) => `${r.from} -> ${r.url}`).join('\n')}`,
      );
    }
  };
  return ctx;
}

/**
 * The bench's probe extension. It records when each note's ink enters the layer's closed
 * shadow root, without writing to the page. Asked with postMessage({ benchProbe: 'dump' }).
 */
export const probeDir = resolve(import.meta.dirname, '../../../bench/probe-ext');

export async function workerOf(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

type Fixtures = {
  /** Which build the context loads. Timing tests use the bench build for its marks. */
  build: 'release' | 'bench';
  context: BrowserContext;
  extId: string;
  sw: Worker;
  /** Page on the extension origin, for storage and messages. */
  ext: Page;
};

export const test = base.extend<Fixtures, { origin: { a: string; b: string } }>({
  origin: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture needs from this pattern.
    async ({}, use) => {
      const s1 = await serve();
      const s2 = await serve();
      const p1 = (s1.address() as AddressInfo).port;
      const p2 = (s2.address() as AddressInfo).port;
      // Two ports and two host names: different origins and different sites.
      await use({ a: `http://localhost:${p1}`, b: `http://127.0.0.1:${p2}` });
      s1.close();
      s2.close();
    },
    { scope: 'worker' },
  ],
  build: ['release', { option: true }],
  context: async ({ build }, use) => {
    const profile = newProfile();
    const context = await launch(profile, [], build === 'bench' ? benchDir : extDir);
    try {
      await use(context);
      await context.close();
    } finally {
      dropProfile(profile);
    }
  },
  sw: async ({ context }, use) => {
    await use(await workerOf(context));
  },
  extId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
  ext: async ({ context, extId }, use) => {
    const p = await context.newPage();
    await p.goto(`chrome-extension://${extId}/pdf.html`);
    await use(p);
  },
});

export { expect } from '@playwright/test';

/** Write items into extension storage.local. */
export const seedStorage = (ext: Page, items: Record<string, unknown>) =>
  ext.evaluate((i) => chrome.storage.local.set(i), items);

export const readStorage = (ext: Page, keys: string[] | null = null) =>
  ext.evaluate((k) => chrome.storage.local.get(k), keys) as Promise<Record<string, unknown>>;

export const clearStorage = (ext: Page) => ext.evaluate(() => chrome.storage.local.clear());

/** What the stub in one frame of a tab answers: viewer loaded, site off, draw mode, notes. */
export type InkState = { loaded: boolean; off: boolean; draw: boolean; notes: number };

/**
 * Ask the stub of a tab's frame for its state. The answer waits for a viewer the stub has
 * started, so it is a barrier: a load already begun is finished first. Null while no stub listens.
 */
export const inkState = (ext: Page, tab: number, frameId = 0): Promise<InkState | null> =>
  ext.evaluate(
    ([t, f]) =>
      chrome.tabs.sendMessage(t, { ink: 'state' }, { frameId: f }).then(
        (r) => (r ?? null) as InkState | null,
        () => null,
      ),
    [tab, frameId] as const,
  );

/** Tab id of the first tab whose address matches the pattern. */
export async function tabId(ext: Page, pattern: string): Promise<number> {
  const [tab] = await ext.evaluate((u) => chrome.tabs.query({ url: u }), pattern);
  if (!tab?.id) throw new Error(`no tab for ${pattern}`);
  return tab.id;
}

// ---------------------------------------------------------------------------
// Input through CDP. Coordinates are viewport (client) pixels of the page.

export type Pt = { x: number; y: number };
type Kind = 'pen' | 'mouse';

async function session(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/**
 * The input clock. The page reads the timing of a gesture from the times of its events: a pen
 * that lifts within 300 ms without moving is a tap, a second finger within 300 ms makes two
 * fingers, strokes within 1.5 s of each other are one note. Left alone, an event's time is the
 * moment the browser got it, so on a busy machine the gaps between events grow and a tap turns
 * into a stroke. So every event made here carries its time:
 * - events of one gesture are at most STEP_MS apart;
 * - a gesture starts at the real time, or `after` ms after the last event when the test says so;
 * - no event is ever stamped ahead of the real clock, so input that Playwright makes itself
 *   (page.mouse) still comes after it.
 * A pause between gestures is a real wait: the real clock only makes it longer.
 */
const STEP_MS = 4;
let lastInput = 0;

/** The time of the next event, in seconds since 1970 as CDP takes it: `gap` ms after the last one, or now if that is sooner. */
function stamp(gap = Number.POSITIVE_INFINITY): number {
  const now = Date.now();
  lastInput = lastInput ? Math.min(now, lastInput + gap) : now;
  return lastInput / 1000;
}

/** Points on a line from a to b, every `step` px. */
export function line(a: Pt, b: Pt, step = 4): Pt[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
  return Array.from({ length: n + 1 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / n,
    y: a.y + ((b.y - a.y) * i) / n,
  }));
}

/** Points on an ellipse around a box. */
export function ring(c: Pt, rx: number, ry: number, n = 28): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: c.x + Math.cos(a) * rx, y: c.y + Math.sin(a) * ry };
  });
}

/**
 * One stroke with a pen (default) or mouse, pressed along the points. `after` starts it that
 * many ms after the last input event on the input clock, for strokes that must count as written
 * close together. Without it the stroke starts at the real time.
 */
export async function stroke(
  page: Page,
  pts: Pt[],
  o: { kind?: Kind; modifiers?: number; after?: number } = {},
): Promise<void> {
  const cdp = await session(page);
  const pointerType = o.kind ?? 'pen';
  const base = { button: 'left', clickCount: 1, pointerType, force: 0.5, modifiers: o.modifiers ?? 0 };
  const send = (type: string, p: Pt, buttons: number, timestamp: number) =>
    cdp.send('Input.dispatchMouseEvent', { ...base, type, x: p.x, y: p.y, buttons, timestamp } as never);
  const first = pts[0]!;
  await send('mouseMoved', first, 0, stamp(o.after));
  await send('mousePressed', first, 1, stamp(STEP_MS));
  for (const p of pts.slice(1)) await send('mouseMoved', p, 1, stamp(STEP_MS));
  await send('mouseReleased', pts[pts.length - 1]!, 0, stamp(STEP_MS));
  await cdp.detach();
}

/** A pen or mouse tap that does not move. */
export async function tap(page: Page, p: Pt, kind: Kind = 'pen'): Promise<void> {
  const cdp = await session(page);
  const base = { button: 'left', clickCount: 1, pointerType: kind, force: 0.5, x: p.x, y: p.y };
  const send = (type: string, buttons: number, timestamp: number) =>
    cdp.send('Input.dispatchMouseEvent', { ...base, type, buttons, timestamp } as never);
  await send('mouseMoved', 0, stamp());
  await send('mousePressed', 1, stamp(STEP_MS));
  await send('mouseReleased', 0, stamp(STEP_MS));
  await cdp.detach();
}

/** How long fingers rest before they lift. The browser takes a finger still for 80 ms as stopped. */
const REST_MS = 120;

/** A finger this far from where it landed has left the browser's slop: the gesture is a move, not a press. */
const HEAD_PX = 24;

/**
 * Fingers moving together. Each path is one finger; all paths have the same length. The moves
 * are `stepMs` apart on the input clock, and the fingers rest before they lift, so the page
 * does not coast on: a page that scrolled is where it stays when this returns.
 *
 * The browser reads a touch gesture from real time too: a finger that lands and waits half a
 * second is a long press, and a long press scrolls nothing. So the touch and its moves up to
 * the first one HEAD_PX from where a finger landed go to the browser at once, dated back from
 * now, and no round trip falls between them. The moves after that go one by one. Once the
 * fingers move, a wait between two moves changes nothing: a slow machine only makes the
 * gesture slower.
 */
export async function touch(page: Page, paths: Pt[][], stepMs = 16): Promise<void> {
  const cdp = await session(page);
  const n = paths[0]!.length;
  const at = (i: number) =>
    paths.map((p, id) => ({ x: p[i]!.x, y: p[i]!.y, id, radiusX: 4, radiusY: 4, force: 1 }));
  const far = (i: number) => paths.some((p) => Math.hypot(p[i]!.x - p[0]!.x, p[i]!.y - p[0]!.y) >= HEAD_PX);
  let head = 1;
  while (head < n && !far(head - 1)) head++;
  const send = (type: string, touchPoints: object[], t: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints, timestamp: t / 1000 } as never);
  // The head ends now, so it starts a little in the past, but after the last event made.
  const span = (head - 1) * stepMs;
  const short = lastInput + 1 - (Date.now() - span);
  if (short > 0) await new Promise((r) => setTimeout(r, short));
  let t = Date.now() - span;
  const first = [send('touchStart', at(0), t)];
  for (let i = 1; i < head; i++) {
    t += stepMs;
    first.push(send('touchMove', at(i), t));
  }
  lastInput = t;
  await Promise.all(first);
  for (let i = head; i < n; i++) {
    // The real wait keeps the input clock from running ahead of the real one.
    await new Promise((r) => setTimeout(r, stepMs));
    await send('touchMove', at(i), stamp(stepMs) * 1000);
  }
  await new Promise((r) => setTimeout(r, REST_MS));
  await send('touchEnd', [], stamp(REST_MS) * 1000);
  await cdp.detach();
}

// ---------------------------------------------------------------------------
// The closed shadow root, through CDP.

/**
 * Run fn(shadowRoot, arg) inside the closed shadow root of the frame's
 * <ink-layer> and return its result. Null when there is no layer. Same-origin
 * frames share the page's session; cross-origin frames get their own.
 */
export async function inLayer<A, R>(
  target: Page | Frame,
  fn: (root: ShadowRoot, arg: A) => R,
  arg?: A,
): Promise<R | null> {
  const page = 'page' in target ? target.page() : target;
  let cdp: CDPSession;
  try {
    cdp = await page.context().newCDPSession(target);
  } catch {
    cdp = await page.context().newCDPSession(page);
  }
  try {
    const frameUrl = 'page' in target ? target.url() : null;
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: DomNode;
    };
    const host = findLayer(root, frameUrl);
    const sr = host?.shadowRoots?.[0];
    if (!sr) return null;
    const { object } = (await cdp.send('DOM.resolveNode', { backendNodeId: sr.backendNodeId })) as {
      object: { objectId: string };
    };
    const r = (await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(a){ return (${fn.toString()})(this, a); }`,
      arguments: [{ value: arg ?? null }],
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: R }; exceptionDetails?: { exception?: { description?: string } } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'layer call failed');
    return r.result.value;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

type DomNode = {
  nodeName: string;
  backendNodeId: number;
  documentURL?: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
};

function findLayer(n: DomNode, url: string | null, docUrl: string | null = null): DomNode | null {
  const here = n.nodeName === '#document' ? (n.documentURL ?? null) : docUrl;
  if (n.nodeName === 'INK-LAYER' && (url === null || here === url) && n.shadowRoots?.length) return n;
  // Only the top document when no frame is named.
  if (n.contentDocument && url === null) return null;
  for (const c of [
    ...(n.children ?? []),
    ...(n.shadowRoots ?? []),
    ...(n.contentDocument ? [n.contentDocument] : []),
  ]) {
    const f = findLayer(c, url, here);
    if (f) return f;
  }
  return null;
}

export type Box = { x: number; y: number; w: number; h: number };
export type LayerInfo = {
  theme: string;
  /** Client-space boxes of drawn ink notes. */
  notes: { id: string; box: Box; strokes: number }[];
  /** Client-space boxes of text marks. */
  marks: { id: string; box: Box; parts: number }[];
  badge: { hidden: boolean; text: string } | null;
  bar: null | {
    hidden: boolean;
    draw: boolean;
    tray: string;
    trayHidden: boolean;
    tool: string;
  };
};

/** What the layer shows right now. */
export function layerInfo(target: Page | Frame): Promise<LayerInfo | null> {
  return inLayer(target, (root) => {
    const notes: LayerInfo['notes'] = [];
    const seen = new Map<string, DOMRect[]>();
    for (const g of root.querySelectorAll<SVGGElement>('g[data-note]')) {
      if (!g.querySelector('path[data-stroke]')) continue;
      const id = g.dataset.note ?? '';
      const list = seen.get(id) ?? [];
      list.push(g.getBoundingClientRect());
      seen.set(id, list);
    }
    for (const [id, rs] of seen) {
      const x0 = Math.min(...rs.map((r) => r.left));
      const y0 = Math.min(...rs.map((r) => r.top));
      const x1 = Math.max(...rs.map((r) => r.right));
      const y1 = Math.max(...rs.map((r) => r.bottom));
      const n = root.querySelectorAll(`g[data-note="${id}"] path[data-stroke]`).length;
      notes.push({ id, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, strokes: n });
    }
    const marks: LayerInfo['marks'] = [];
    const mk = new Map<string, DOMRect[]>();
    for (const p of root.querySelectorAll<SVGElement>('[data-mark]')) {
      const id = (p.closest('[data-note]') as SVGElement | null)?.dataset.note ?? '';
      const list = mk.get(id) ?? [];
      list.push(p.getBoundingClientRect());
      mk.set(id, list);
    }
    for (const [id, rs] of mk) {
      const x0 = Math.min(...rs.map((r) => r.left));
      const y0 = Math.min(...rs.map((r) => r.top));
      const x1 = Math.max(...rs.map((r) => r.right));
      const y1 = Math.max(...rs.map((r) => r.bottom));
      marks.push({ id, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, parts: rs.length });
    }
    const b = root.querySelector<HTMLButtonElement>('.badge');
    const iu = root.querySelector<HTMLElement>('.iu');
    const draw = iu?.querySelector('button.draw');
    const trayB = iu?.querySelector<HTMLButtonElement>('[aria-controls="iu-tray"]');
    const pressed = [...(iu?.querySelectorAll('.bar > button[aria-pressed="true"]') ?? [])]
      .map((x) => x.getAttribute('aria-label'))
      .filter((x) => x !== 'Draw');
    return {
      theme: (root.host as HTMLElement).dataset.theme ?? '',
      notes,
      marks,
      badge: b
        ? { hidden: b.hidden === true || getComputedStyle(b).display === 'none', text: b.textContent ?? '' }
        : null,
      bar: iu
        ? {
            hidden: iu.classList.contains('hid'),
            draw: draw?.getAttribute('aria-pressed') === 'true',
            tray: trayB?.querySelector('.cnt')?.textContent ?? '',
            trayHidden: !!trayB?.hidden,
            tool: pressed[0] ?? '',
          }
        : null,
    };
  });
}

/** Client centre of the first element in the layer that matches the selector. */
export async function layerPoint(target: Page | Frame, selector: string): Promise<Pt | null> {
  return inLayer(
    target,
    (root, sel) => {
      const el = [...root.querySelectorAll<HTMLElement>(sel)].find((e) => e.getClientRects().length > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    selector,
  ).then((p) => p ?? null);
}

/** Client rect of the first occurrence of a text in an element of the page (or frame). */
export function textBox(target: Page | Frame, text: string, within = 'body'): Promise<Box | null> {
  return target.evaluate(
    ([t, sel]) => {
      const roots: Node[] = [document.querySelector(sel) ?? document.body];
      // Test pages hand over their closed shadow root this way.
      const closed = (window as unknown as { __closed?: ShadowRoot }).__closed;
      if (closed) roots.push(closed);
      while (roots.length) {
        const r = roots.shift()!;
        const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          if (n.nodeType === 1) {
            const sr = (n as Element).shadowRoot;
            if (sr) roots.push(sr);
            continue;
          }
          const tag = n.parentElement?.localName;
          if (tag === 'script' || tag === 'style') continue;
          const i = (n.textContent ?? '').indexOf(t);
          if (i < 0) continue;
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + t.length);
          const b = range.getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        }
      }
      return null;
    },
    [text, within] as const,
  );
}

export const centre = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Records in storage, by storage key. */
export async function records(ext: Page): Promise<Record<string, { key: string; notes: InkNote[] }>> {
  const all = await readStorage(ext);
  const out: Record<string, { key: string; notes: InkNote[] }> = {};
  for (const [k, v] of Object.entries(all))
    if (k.startsWith('p:')) out[k] = v as { key: string; notes: InkNote[] };
  return out;
}

export type InkNote = {
  id: string;
  kind: string;
  anchor: { type: string; quote: { exact: string }; frame?: { url: string } };
  strokes: { id: string }[];
  thumb?: string;
  mark?: { style: string };
};

/** All notes in storage across pages. */
export async function allNotes(ext: Page): Promise<InkNote[]> {
  return Object.values(await records(ext)).flatMap((r) => r.notes);
}

/**
 * Decode a PNG in a page and return the centroid of pixels that pass a colour test, within a client box.
 * For a coloured ink, a grey pixel never counts, however near its value: the page's text is grey, and
 * the edges of its letters come close to a dark ink. Which letters sit inside the box depends on the
 * font, so counting them would move the centroid by a different amount on every system.
 */
export async function inkCentroid(
  decoder: Page,
  png: Buffer,
  area: Box,
  test: 'dark' | 'light' | { r: number; g: number; b: number; tol: number },
  dpr = 1,
): Promise<{ x: number; y: number; n: number } | null> {
  return decoder.evaluate(
    async ([b64, a, t, k]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const x0 = Math.max(0, Math.floor(a.x * k));
      const y0 = Math.max(0, Math.floor(a.y * k));
      const w = Math.min(bmp.width - x0, Math.ceil(a.w * k));
      const h = Math.min(bmp.height - y0, Math.ceil(a.h * k));
      if (w <= 0 || h <= 0) return null;
      const d = g.getImageData(x0, y0, w, h).data;
      // Spread between the largest and smallest channel: 0 for grey.
      const chroma = (r: number, gg: number, bb: number) => Math.max(r, gg, bb) - Math.min(r, gg, bb);
      const GREY = 12;
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = d[i]!;
          const gg = d[i + 1]!;
          const bb = d[i + 2]!;
          const ok =
            t === 'dark'
              ? r + gg + bb < 200
              : t === 'light'
                ? r + gg + bb > 640
                : Math.abs(r - t.r) + Math.abs(gg - t.g) + Math.abs(bb - t.b) < t.tol &&
                  (chroma(t.r, t.g, t.b) < GREY * 2 || chroma(r, gg, bb) >= GREY);
          if (!ok) continue;
          sx += x;
          sy += y;
          n++;
        }
      }
      return n ? { x: (x0 + sx / n) / k, y: (y0 + sy / n) / k, n } : null;
    },
    [png.toString('base64'), area, test, dpr] as const,
  );
}

/** Running service workers of this extension, from the browser's target list. */
export async function runningWorkers(page: Page, extId: string): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  const { targetInfos } = (await cdp.send('Target.getTargets')) as {
    targetInfos: { type: string; url: string }[];
  };
  await cdp.detach();
  return targetInfos.filter((t) => t.type === 'service_worker' && t.url.includes(extId)).length;
}

/** Notes in the extension's storage, read through its service worker. */
export async function storedNotes(context: BrowserContext): Promise<number> {
  const sw = await workerOf(context);
  return sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    let n = 0;
    for (const [k, v] of Object.entries(all))
      if (k.startsWith('p:')) n += ((v as { notes?: unknown[] }).notes ?? []).length;
    return n;
  });
}

/** calibrate() of pageink-core's testkit in this Chromium on a laptop, in ms. */
const CALIBRATE_REF_MS = 30;

/**
 * How much slower than a laptop this browser runs a fixed piece of script and layout work right
 * now: the median of five runs over CALIBRATE_REF_MS, never below 1. Budget gates are scaled by
 * it, so a busy or slow machine does not fail them, while code that got slower still does.
 */
export async function slowdown(page: Page): Promise<number> {
  const ms = await page.evaluate(() => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:-10000px;top:0;width:400px';
      document.body.append(box);
      const t0 = performance.now();
      for (let j = 0; j < 600; j++) {
        const p = document.createElement('p');
        p.textContent = `Calibration line ${j} ${'word '.repeat(j % 17)}`;
        box.append(p);
        p.getBoundingClientRect();
      }
      box.style.width = '300px';
      for (const p of box.children) p.getBoundingClientRect();
      times.push(performance.now() - t0);
      box.remove();
    }
    times.sort((a, b) => a - b);
    return times[2]!;
  });
  return Math.max(1, ms / CALIBRATE_REF_MS);
}

/** Wait until the stub has timed itself on this page. */
export const stubDone = (page: Page | Frame) =>
  page.waitForFunction(() => performance.getEntriesByName('ink:stub').length > 0);

/** Click a bar button by its label with the mouse. Wakes the bar first when it has hidden. */
export async function barClick(page: Page, label: string): Promise<void> {
  const sel = `.iu button[aria-label="${label}"]`;
  const hidden = await inLayer(page, (root) => !!root.querySelector('.iu.hid'));
  if (hidden) {
    const h = await layerPoint(page, '.iu button.hdl');
    if (h) await page.mouse.click(h.x, h.y);
  }
  const p = await layerPoint(page, sel);
  if (!p) throw new Error(`no bar button ${label}`);
  await page.mouse.click(p.x, p.y);
}

/** Where screenshots for review go, when asked for. */
export const shotPath = (name: string): string | undefined =>
  process.env.INK_SHOTS ? `${process.env.INK_SHOTS}/${name}.png` : undefined;
