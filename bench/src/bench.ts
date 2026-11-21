// Speed budgets of DESIGN 11, measured in Playwright Chromium.
//
//   corepack pnpm --filter pageink-bench run bench [--ext dummy|real|<dir>] [--pages id,id] [--loads 10]
//     [--har replay|record|off] [--anchor baseline|core|<path>] [--quick] [--gate] [--headed]
//     [--skip-overhead] [--skip-ink] [--skip-pen] [--seeded id,id|none] [--cold-loads 5] [--traces <dir>]
//
// Overhead: every page loads N times with and without the extension, interleaved, after one
// discarded load per arm. Public pages are replayed from a recording so both arms get the same
// bytes. A paint difference counts only when it is beyond the noise and repeats in a second run.
// Latency, scroll and stress: records are seeded into extension storage. A probe extension records
// when each note's ink enters the layer. Pen: pen-down to first pixel on a page with no ink.
// Writes results/latest.json and results/latest.md.
// Exit 0 when the run completes, 1 with --gate when a budget is missed, 2 when the harness fails.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { availableParallelism, cpus, platform, release, totalmem } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { type BrowserContext, type CDPSession, chromium, type Page, type Worker } from 'playwright';
import { anchorEntry, bundleHarness } from '../../testset/src/bundle.ts';
import { placeholderSvg } from '../../testset/src/freeze.ts';
import { EXPLAIN_LOADS, EXPLAIN_MAX_BYTES, type Explained, explain, explainRows } from './explain.ts';
import {
  type Count,
  type Fitness,
  fitness,
  type HeldBack,
  heldBack,
  type Judged,
  judgeLimit,
  judgeOften,
  judgeRepeated,
  type MachineMeasure,
  moreOften,
  moreOftenP,
  OFTEN_ALPHA,
  type Often,
  slowerThanControl,
} from './judge.ts';
import { clearStorage, identityOf, recordFrom, registered, seed, storageItems, writeNotes } from './seed.ts';
import { type Compare, compare, median, quantile } from './stats.ts';
import {
  type Attribution,
  attribute,
  longestRendererTask,
  type Owner,
  ownerOf,
  startTrace,
} from './trace.ts';
import { type Arm, type InkTask, LIMITS, verdict } from './verdict.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const CACHE = join(ROOT, 'cache');
const HAR_DIR = join(CACHE, 'har');
const RESULTS = join(ROOT, 'results');
const FIXTURES = join(REPO, 'testset', 'fixtures');
const CACHE_FIXTURES = join(REPO, 'testset', 'cache', 'fixtures');
const PROBE = join(ROOT, 'probe-ext');
/** An extension of PageInk's shape that does nothing: what any extension costs a page. */
const CONTROL = join(ROOT, 'control-ext');
/** The bench build: the release code plus the performance marks the bench reads. */
const BUILT = join(REPO, 'packages', 'extension', '.output', 'chrome-mv3-bench');

interface PageDef {
  id: string;
  type: string;
  url: string;
  /** Measure live, with this reason, even when a recording exists. */
  live?: string;
  note?: string;
}
interface SeedDef {
  id: string;
  url: string;
  /** Page the notes are written on, when it differs from the page that is loaded (late content). */
  write?: string;
  notes: number;
}
interface PagesFile {
  pages: PageDef[];
  /** Offline pages used by quick mode, so CI does not depend on the network. */
  offline: PageDef[];
  quick: string[];
  /** Pages with no ink where the mouse moves and the page scrolls, for the cost of the pointer listeners. */
  pointer: string[];
  seeded: SeedDef[];
  stress: SeedDef;
  /** Page with no ink where pen-down to first pixel is timed. Default lesson. */
  pen?: string;
}
interface HarInfo {
  replay: boolean;
  reason: string;
  recorded: string;
  requests: number;
  unmatched: number;
}
type Mode = 'replay' | 'live' | 'local';

/** visibleFrameMs: ink within one frame of its content's first paint, in every case. */
/**
 * inkLongTaskMs: no task over it caused by ink (it would be within it without its ink part, or the
 * ink part alone is over it). inkTaskFrameMs: the ink part of any one task, in every load.
 */
const BUDGET = {
  stubMs: 5,
  visibleMs: 50,
  visibleFrameMs: 16.7,
  heldBackMs: 16.7,
  inkLongTaskMs: LIMITS.longMs,
  inkTaskFrameMs: LIMITS.frameMs,
};

const INIT = `
window.__benchLong = []; window.__benchLcp = null;
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__benchLcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__benchLong.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
window.__name = (f) => f;
`;

const COLLECT = `(() => {
  const p = performance;
  const paint = Object.fromEntries(p.getEntriesByType('paint').map((e) => [e.name, e.startTime]));
  return {
    fp: paint['first-paint'] ?? null,
    fcp: paint['first-contentful-paint'] ?? null,
    lcp: window.__benchLcp,
    longTasks: window.__benchLong || [],
    ink: p.getEntries().filter((e) => e.name.startsWith('ink:')).map((e) => ({ name: e.name, type: e.entryType, start: e.startTime, dur: e.duration })),
  };
})()`;

const PROBE_DUMP = `new Promise((r) => {
  const h = (e) => { if (e.data && e.data.benchProbeData) { removeEventListener('message', h); r(e.data.benchProbeData); } };
  addEventListener('message', h);
  postMessage({ benchProbe: 'dump' }, '*');
  setTimeout(() => r(null), 2000);
})`;

type InkEntry = { name: string; type: string; start: number; dur: number };
interface LoadSample {
  ok: boolean;
  error?: string;
  fp: number | null;
  fcp: number | null;
  lcp: number | null;
  taskMs: number;
  longTasks: number[];
  stubMs: number | null;
  ink: InkEntry[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : Number.NaN);

/** The stub measures its own time cumulatively. The last ink:stub measure holds the total. */
function stubOf(ink: InkEntry[]): number | null {
  const m = ink.filter((e) => e.name === 'ink:stub' && e.type === 'measure').map((e) => e.dur);
  return m.length ? Math.max(...m) : null;
}

/** Local pages and testset fixtures, served over plain http so the browser cache behaves normally. */
function startServer(): Promise<{ server: Server; base: string }> {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const [root, rest] = path.startsWith('/fixtures/')
      ? [FIXTURES, path.slice(10)]
      : path.startsWith('/cache/')
        ? [CACHE_FIXTURES, path.slice(7)]
        : [join(ROOT, 'pages'), path.slice(1)];
    const file = normalize(join(root, rest));
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'max-age=3600',
    });
    res.end(readFileSync(file));
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }),
    ),
  );
}

function resolveUrl(u: string, base: string): string {
  if (u.startsWith('local:')) return `${base}/${u.slice(6)}`;
  if (u.startsWith('fixture:')) return `${base}/fixtures/${u.slice(8)}`;
  return u;
}

/** Image addresses a fixture uses, answered offline with blank pictures of the recorded size. */
function fixtureImages(u: string): Map<string, [number, number]> {
  const m = new Map<string, [number, number]>();
  if (!u.startsWith('fixture:')) return m;
  const f = join(FIXTURES, dirname(u.slice(8)), 'images.json');
  if (existsSync(f))
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(f, 'utf8')))) m.set(k, v as [number, number]);
  return m;
}

async function offlineFixture(
  page: Page,
  base: string,
  images: Map<string, [number, number]>,
): Promise<void> {
  await page.route('**/*', (route) => {
    const href = route.request().url();
    const size = images.get(href);
    if (size)
      return route.fulfill({
        body: placeholderSvg(href, size[0], size[1]),
        headers: { 'content-type': 'image/svg+xml' },
      });
    if (href.startsWith(base) || /^(data|blob|chrome-extension):/.test(href)) return route.continue();
    return route.abort();
  });
}

/**
 * The machine, measured in the browser the bench drives: the library's calibration work
 * (packages/core/src/testkit.ts calibrate()) in a page with no extension, median of five, and the
 * cores the browser may use.
 */
async function measureMachine(headed: boolean): Promise<MachineMeasure> {
  const dir = join(CACHE, 'profile-calibrate');
  const ctx = await launch(dir, [], headed);
  const page = await ctx.newPage();
  if (cpuThrottle > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
  }
  await page.setContent('<body></body>');
  const runs: number[] = [];
  for (let k = 0; k < 5; k++)
    runs.push(
      (await page.evaluate(`(() => {
        const times = [];
        for (let i = 0; i < 7; i++) {
          const box = document.createElement('div');
          box.style.cssText = 'position:absolute;left:-10000px;top:0;width:400px';
          document.body.append(box);
          const t0 = performance.now();
          let h = 0;
          for (let j = 0; j < 600; j++) {
            const p = document.createElement('p');
            p.textContent = 'Calibration line ' + j + ' ' + 'word '.repeat(j % 17);
            box.append(p);
            h += p.getBoundingClientRect().height;
          }
          box.style.width = '300px';
          for (const p of box.children) h += p.getBoundingClientRect().height;
          times.push(performance.now() - t0);
          box.remove();
        }
        times.sort((a, b) => a - b);
        return times[3];
      })()`)) as number,
    );
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
  return { calibrateMs: r1(median(runs)), cores: availableParallelism() };
}

/** The machine measurement stored with the published results, the reference for quick runs. */
function referenceMachine(): (MachineMeasure & { cpu?: string }) | null {
  try {
    const m = JSON.parse(readFileSync(join(RESULTS, 'latest.json'), 'utf8')).meta;
    const c = m?.calibrate as MachineMeasure | undefined;
    return c && c.calibrateMs > 0 ? { ...c, cpu: m.machine?.cpu } : null;
  } catch {
    return null;
  }
}

/** --cpu-throttle: every page's main thread slowed this many times, to study a slow machine. */
let cpuThrottle = 0;

async function launch(dir: string, exts: string[], headed: boolean, keep = false): Promise<BrowserContext> {
  if (!keep) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const list = exts.join(',');
  const args = exts.length
    ? [`--disable-extensions-except=${list}`, `--load-extension=${list}`]
    : ['--disable-extensions'];
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    args,
  });
  await ctx.addInitScript(INIT);
  if (cpuThrottle > 1) {
    const slow = async (p: Page) => {
      const cdp = await ctx.newCDPSession(p).catch(() => null);
      await cdp?.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle }).catch(() => {});
    };
    ctx.on('page', (p) => void slow(p));
  }
  return ctx;
}

/** The service worker of the measured extension. The probe has none. */
async function workerOf(ctx: BrowserContext): Promise<Worker> {
  const [sw] = ctx.serviceWorkers();
  return sw ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
}

interface Target {
  url: string;
  mode: Mode;
  har?: string;
  images?: Map<string, [number, number]>;
}

async function route(page: Page, t: Target, base: string): Promise<void> {
  if (t.mode === 'replay' && t.har) await page.routeFromHAR(t.har, { notFound: 'abort' });
  else if (t.url.startsWith(`${base}/fixtures/`)) await offlineFixture(page, base, t.images ?? new Map());
}

async function loadOnce(
  ctx: BrowserContext,
  t: Target,
  base: string,
  o: { settle: number; trace?: boolean; owner?: Owner },
): Promise<LoadSample & { trace?: Attribution }> {
  const page = await ctx.newPage();
  try {
    await route(page, t, base);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metric = async () =>
      (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0;
    const before = await metric();
    const stop = o.trace ? await startTrace(cdp) : null;
    await page.goto(t.url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(o.settle);
    const m = (await page.evaluate(COLLECT)) as Omit<LoadSample, 'ok' | 'taskMs' | 'stubMs'>;
    const after = await metric();
    const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
    const trace = stop ? attribute(await stop(), o.owner, { mainFrame: tree.frameTree.frame.id }) : undefined;
    return {
      ok: true,
      ...m,
      taskMs: Math.round((after - before) * 10000) / 10,
      stubMs: stubOf(m.ink),
      trace,
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e).split('\n')[0],
      fp: null,
      fcp: null,
      lcp: null,
      taskMs: Number.NaN,
      longTasks: [],
      stubMs: null,
      ink: [],
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

interface Visit {
  requests: number;
  failed: number;
  fcp: number | null;
  text: number;
  serviceWorker: boolean;
  status: number;
}

async function visit(ctx: BrowserContext, url: string, setup?: (p: Page) => Promise<void>): Promise<Visit> {
  const page = await ctx.newPage();
  let requests = 0;
  let failed = 0;
  page.on('request', () => requests++);
  page.on('requestfailed', () => failed++);
  try {
    if (setup) await setup(page);
    const res = await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3000);
    const info = (await page.evaluate(`(async () => ({
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      text: document.body ? document.body.innerText.length : 0,
      sw: !!(navigator.serviceWorker && (navigator.serviceWorker.controller || (await navigator.serviceWorker.getRegistrations()).length)),
    }))()`)) as { fcp: number | null; text: number; sw: boolean };
    return {
      requests,
      failed,
      fcp: info.fcp,
      text: info.text,
      serviceWorker: info.sw,
      status: res?.status() ?? 0,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Records each public page into cache/har/<id>.har, then replays it once and compares with the live
 * load. A page is replayed in the bench only when the replay is faithful: no service worker, at most
 * 5% of requests missing from the recording, a first paint whenever the live page had one, and at
 * least 80% of the live page's text. The verdict goes to cache/har/index.json.
 */
async function recordHar(pages: PageDef[], headed: boolean): Promise<void> {
  mkdirSync(HAR_DIR, { recursive: true });
  const indexFile = join(HAR_DIR, 'index.json');
  const index: Record<string, HarInfo> = existsSync(indexFile)
    ? JSON.parse(readFileSync(indexFile, 'utf8'))
    : {};
  for (const p of pages) {
    if (/^(local|fixture):/.test(p.url)) continue;
    const har = join(HAR_DIR, `${p.id}.har`);
    rmSync(har, { force: true });
    let live: Visit;
    try {
      const rec = await launch(join(CACHE, 'profile-har'), [], headed);
      live = await visit(rec, p.url, (pg) =>
        pg.routeFromHAR(har, { update: true, updateContent: 'embed', updateMode: 'full' }),
      );
      await rec.close();
    } catch (e) {
      console.log(`record failed ${p.id}: ${String(e).split('\n')[0]}`);
      continue;
    }
    const rep = await launch(join(CACHE, 'profile-har'), [], headed);
    let replay: Visit | null = null;
    try {
      replay = await visit(rep, p.url, (pg) => pg.routeFromHAR(har, { notFound: 'abort' }));
    } catch (e) {
      console.log(`replay failed ${p.id}: ${String(e).split('\n')[0]}`);
    }
    await rep.close();
    const why: string[] = [];
    if (live.serviceWorker) why.push('registers a service worker');
    if (!replay) why.push('replay did not load');
    else {
      if (replay.failed > Math.max(1, 0.05 * replay.requests))
        why.push(`${replay.failed} of ${replay.requests} requests not in the recording`);
      if (live.fcp !== null && replay.fcp === null) why.push('no first paint on replay');
      if (replay.text < 0.8 * live.text) why.push(`replay shows ${replay.text} of ${live.text} characters`);
    }
    if (live.status >= 400) why.push(`live status ${live.status} (anti-bot answer)`);
    index[p.id] = {
      replay: why.length === 0,
      reason: why.join('; ') || 'faithful',
      recorded: new Date().toISOString(),
      requests: live.requests,
      unmatched: replay?.failed ?? -1,
    };
    console.log(`recorded ${p.id}: ${index[p.id]!.replay ? 'replay' : 'live'} (${index[p.id]!.reason})`);
    writeFileSync(indexFile, `${JSON.stringify(index, null, 1)}\n`);
  }
}

// ---------------------------------------------------------------------------

function digest(dir: string, files: string[]): string {
  const h = createHash('sha256');
  for (const f of files) if (existsSync(join(dir, f))) h.update(readFileSync(join(dir, f)));
  return h.digest('hex').slice(0, 12);
}

/** Minified bytes of the code that runs in pages: the stub, the viewer and the tools. */
function sizesOf(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, f] of [
    ['stub', 'stub.js'],
    ['boot', 'content/boot.js'],
    ['viewer', 'content/loader.js'],
    ['tools', 'content/tools.js'],
  ] as const)
    if (existsSync(join(dir, f))) out[k] = readFileSync(join(dir, f)).length;
  return out;
}

/** The browser's version, from a short-lived page of an open context. */
/** Leaves the context with one blank tab open, so every arm loads its pages beside the same tabs. */
async function oneBlankTab(ctx: BrowserContext): Promise<void> {
  const keep = ctx.pages()[0] ?? (await ctx.newPage());
  for (const pg of ctx.pages()) if (pg !== keep) await pg.close();
  if (keep.url() !== 'about:blank') await keep.goto('about:blank');
}

async function browserOf(ctx: BrowserContext): Promise<string> {
  const page = await ctx.newPage();
  try {
    const cdp = await ctx.newCDPSession(page);
    return ((await cdp.send('Browser.getVersion')) as { product: string }).product;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      ext: { type: 'string', default: 'dummy' },
      pages: { type: 'string' },
      loads: { type: 'string', default: '10' },
      'live-loads': { type: 'string' },
      har: { type: 'string', default: 'replay' },
      settle: { type: 'string', default: '1500' },
      anchor: { type: 'string', default: 'baseline' },
      'skip-overhead': { type: 'boolean', default: false },
      'skip-ink': { type: 'boolean', default: false },
      'skip-pen': { type: 'boolean', default: false },
      'cpu-throttle': { type: 'string', default: '0' },
      seeded: { type: 'string' },
      'cold-loads': { type: 'string', default: '5' },
      'warm-loads': { type: 'string' },
      'long-loads': { type: 'string' },
      'compare-ext': { type: 'string' },
      explain: { type: 'string' },
      traces: { type: 'string' },
      profile: { type: 'boolean', default: false },
      quick: { type: 'boolean', default: false },
      gate: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
      out: { type: 'string', default: join(RESULTS, 'latest') },
    },
  });
  const cwd = process.env.INIT_CWD ?? process.cwd();
  let ext: string;
  if (values.ext === 'dummy') ext = join(ROOT, 'dummy-ext');
  else if (values.ext === 'real') {
    // The bench build keeps the performance marks that release builds leave out. Build it
    // here, then measure a copy, so a build running at the same time cannot change files under the bench.
    execFileSync('corepack', ['pnpm', '--filter', 'pageink-extension', 'run', 'build:bench'], {
      cwd: REPO,
      stdio: 'ignore',
    });
    ext = join(CACHE, 'ext-real');
    if (!existsSync(join(BUILT, 'manifest.json'))) throw new Error(`no build in ${BUILT}`);
    rmSync(ext, { recursive: true, force: true });
    cpSync(BUILT, ext, { recursive: true });
  } else ext = resolve(cwd, values.ext!);
  values.out = resolve(cwd, values.out!);
  if (!existsSync(join(ext, 'manifest.json'))) throw new Error(`no manifest.json in ${ext}`);
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
  // The latency and stub numbers come from the bench build's marks. A release build has none,
  // and every row would read n/a, so refuse it.
  const benchBuild =
    existsSync(join(ext, 'stub.js')) && readFileSync(join(ext, 'stub.js'), 'utf8').includes('ink:stub');
  if (values.ext === 'real' && !benchBuild)
    throw new Error(`${BUILT} is not a bench build: no ink:stub mark`);
  const def = JSON.parse(readFileSync(join(ROOT, 'pages.json'), 'utf8')) as PagesFile;
  const quick = !!values.quick;
  cpuThrottle = Number(values['cpu-throttle']);
  const all = [...def.pages, ...(def.offline ?? [])];
  let pages = def.pages;
  if (values.pages) {
    const ids = new Set(values.pages.split(','));
    pages = all.filter((p) => ids.has(p.id));
  } else if (quick) {
    pages = all.filter((p) => def.quick.includes(p.id));
  }
  const loads = quick ? Math.min(5, Number(values.loads)) : Number(values.loads);
  const liveLoads = Number(values['live-loads'] ?? Math.max(20, 2 * loads));
  const settle = Number(values.settle);
  const { server, base } = await startServer();
  const t0 = Date.now();

  if (values.har === 'record') await recordHar(pages, !!values.headed);
  const harIndex: Record<string, HarInfo> = existsSync(join(HAR_DIR, 'index.json'))
    ? JSON.parse(readFileSync(join(HAR_DIR, 'index.json'), 'utf8'))
    : {};
  const modeOf = (p: PageDef): { mode: Mode; why: string } => {
    if (/^(local|fixture):/.test(p.url)) return { mode: 'local', why: 'served by the bench' };
    if (p.live) return { mode: 'live', why: p.live };
    if (values.har === 'off') return { mode: 'live', why: 'replay turned off' };
    const info = harIndex[p.id];
    if (!info || !existsSync(join(HAR_DIR, `${p.id}.har`))) return { mode: 'live', why: 'no recording' };
    return info.replay ? { mode: 'replay', why: info.reason } : { mode: 'live', why: info.reason };
  };
  const targetOf = (p: PageDef): Target => {
    const { mode } = modeOf(p);
    return {
      url: resolveUrl(p.url, base),
      mode,
      har: mode === 'replay' ? join(HAR_DIR, `${p.id}.har`) : undefined,
      images: fixtureImages(p.url),
    };
  };

  const machine = {
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: `${platform()} ${release()}`,
  };
  const report: Record<string, unknown> = {
    meta: {
      ext: ext.startsWith(REPO) ? ext.slice(REPO.length + 1) : ext,
      product: values.ext !== 'dummy' && !/dummy/.test(ext),
      extName: manifest.name,
      extVersion: manifest.version,
      extDigest: digest(ext, [
        'manifest.json',
        'stub.js',
        'content/boot.js',
        'content/loader.js',
        'content/tools.js',
        'background.js',
      ]),
      benchBuild,
      sizes: sizesOf(ext),
      loads,
      liveLoads,
      har: values.har,
      settle,
      started: new Date(t0).toISOString(),
      quick,
      budgets: BUDGET,
      machine,
      ...(cpuThrottle > 1 ? { cpuThrottle } : {}),
    },
  };
  const fails: string[] = [];
  const notes: string[] = [];

  // The machine, against the one the published results were measured on. A quick run judges
  // fixed time limits only on a machine fit to judge them (src/judge.ts).
  const here = await measureMachine(!!values.headed);
  const reference = referenceMachine();
  const fit: Fitness = fitness(here, reference);
  (report.meta as Record<string, unknown>).calibrate = here;
  const judged: Judged[] = [];
  console.log(
    `machine: calibration ${here.calibrateMs} ms, ${here.cores} cores; reference ${reference ? `${reference.calibrateMs} ms, ${reference.cores} cores` : 'none'}${quick ? `; fixed limits ${fit.fit ? `judged at ${fit.scale} times` : `not judged: ${fit.reason}`}` : ''}`,
  );
  /**
   * A fixed time limit. A full run judges it as published. A quick run judges it only on a fit
   * machine, scaled by the machine's measured ratio; elsewhere it is reported as not judged.
   */
  const fixed = (
    rule: string,
    value: number,
    limit: number,
    line: string,
    over: (v: number, l: number) => boolean = (v, l) => v > l,
  ) => {
    if (!quick) {
      if (over(value, limit)) fails.push(line);
      return;
    }
    const j = judgeLimit(rule, value, limit, fit, over);
    judged.push(j);
    if (j.verdict === 'fail') fails.push(`${line}, judged against ${j.judgedLimit} ms on this machine`);
    else if (j.verdict === 'not judged' && j.raw === 'fail')
      notes.push(`not judged on this machine: ${line} (${j.reason})`);
  };

  // -------------------------------------------------------------------------
  // Overhead on pages with no ink
  // -------------------------------------------------------------------------
  if (!values['skip-overhead']) {
    const withCtx = await launch(join(CACHE, 'profile-with'), [ext], !!values.headed);
    const withoutCtx = await launch(join(CACHE, 'profile-without'), [], !!values.headed);
    // Quick runs load the pages a third time, with the control extension, so the gate can compare
    // PageInk with any extension on the same machine in the same run.
    const controlCtx = quick
      ? await launch(join(CACHE, 'profile-control'), [CONTROL], !!values.headed)
      : null;
    const sw0 = await workerOf(withCtx);
    // Only this extension counts. Chrome's own PDF viewer is an extension too.
    const owner = ownerOf(sw0.url());
    await sw0.evaluate('chrome.storage.local.clear()');
    (report.meta as Record<string, unknown>).browser = await browserOf(withCtx);
    // Every arm keeps one blank tab open, and nothing else. A browser with no tab open paints a new
    // page later (30 to 60 ms on a slow 2-core machine), so a tab closed in one arm only made that arm
    // look slower than the others.
    for (const ctx of [withCtx, withoutCtx, controlCtx]) if (ctx) await oneBlankTab(ctx);

    type Arms = { with: LoadSample[]; without: LoadSample[]; control: LoadSample[] };
    /** Interleaved loads of one set of pages, after one discarded load per arm. */
    const measure = async (list: PageDef[], n: (p: PageDef) => number): Promise<Map<string, Arms>> => {
      const out = new Map<string, Arms>();
      for (const p of list) {
        out.set(p.id, { with: [], without: [], control: [] });
        await loadOnce(withCtx, targetOf(p), base, { settle: 300 });
        await loadOnce(withoutCtx, targetOf(p), base, { settle: 300 });
        if (controlCtx) await loadOnce(controlCtx, targetOf(p), base, { settle: 300 });
      }
      const rounds = Math.max(...list.map(n));
      for (let i = 0; i < rounds; i++) {
        for (const p of list) {
          if (i >= n(p)) continue;
          const s = out.get(p.id)!;
          // Alternate which arm goes first so drift hits both equally.
          const arms: ['with' | 'without' | 'control', BrowserContext][] = [
            ['with', withCtx],
            ['without', withoutCtx],
          ];
          if (controlCtx) arms.push(['control', controlCtx]);
          if (i % 2) arms.reverse();
          for (const [name, ctx] of arms) s[name].push(await loadOnce(ctx, targetOf(p), base, { settle }));
        }
        console.log(`overhead: round ${i + 1} of ${rounds}`);
      }
      return out;
    };
    const nLoads = (p: PageDef) => (modeOf(p).mode === 'live' ? liveLoads : loads);
    const samples = await measure(pages, nLoads);

    const num = (xs: LoadSample[], f: (x: LoadSample) => number | null) =>
      xs.map(f).filter((x): x is number => x !== null && Number.isFinite(x));
    const paints = (s: Arms, other: 'without' | 'control' = 'without') => {
      const w = s.with.filter((x) => x.ok);
      const o = s[other].filter((x) => x.ok);
      return {
        fcp: compare(
          num(w, (x) => x.fcp),
          num(o, (x) => x.fcp),
        ),
        lcp: compare(
          num(w, (x) => x.lcp),
          num(o, (x) => x.lcp),
        ),
      };
    };
    const slower = (c: Compare) => c.beyondNoise && c.delta > 0;

    // A slower paint is measured again from scratch. It counts only when it repeats.
    const suspects = pages.filter((p) => {
      const c = paints(samples.get(p.id)!);
      const k = controlCtx ? paints(samples.get(p.id)!, 'control') : null;
      return slower(c.fcp) || slower(c.lcp) || (!!k && (slower(k.fcp) || slower(k.lcp)));
    });
    const confirm = suspects.length ? await measure(suspects, nLoads) : new Map<string, Arms>();

    // Traced loads with the extension attribute main-thread time to its scripts and injection.
    const traces = new Map<string, Attribution[]>();
    for (const p of pages) {
      const list: Attribution[] = [];
      for (let i = 0; i < (quick ? 2 : 3); i++) {
        const r = await loadOnce(withCtx, targetOf(p), base, { settle, trace: true, owner });
        if (r.trace) list.push(r.trace);
      }
      traces.set(p.id, list);
    }

    // Cost of the stub's pointer listeners: move the mouse and scroll on pages with no ink.
    // Untraced in both arms, interleaved: script time over the activity, with minus without.
    // Then traced with the extension, for the time attributed to its own scripts.
    const activity = async (ctx: BrowserContext, p: PageDef, trace: boolean) => {
      const page = await ctx.newPage();
      try {
        await route(page, targetOf(p), base);
        await page.goto(targetOf(p).url, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(settle);
        await page.evaluate(
          `window.__benchPtr = 0; addEventListener('pointermove', () => window.__benchPtr++, { capture: true, passive: true });`,
        );
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Performance.enable');
        const metric = async (n: string) =>
          (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === n)?.value ?? 0;
        const s0 = await metric('ScriptDuration');
        const stop = trace ? await startTrace(cdp) : null;
        for (let k = 0; k < 400; k++) await page.mouse.move(100 + ((k * 37) % 1000), 100 + ((k * 53) % 700));
        for (let k = 0; k < 20; k++) {
          await page.mouse.wheel(0, 400);
          await page.waitForTimeout(40);
        }
        await page.waitForTimeout(200);
        const a = stop ? attribute(await stop(), owner) : null;
        const scriptMs = ((await metric('ScriptDuration')) - s0) * 1000;
        const events = (await page.evaluate('window.__benchPtr')) as number;
        return { events, scriptMs: r2(scriptMs), extMs: a?.inkMs ?? null, extEvents: a?.inkEvents ?? null };
      } finally {
        await page.close().catch(() => {});
      }
    };
    const pointer: Record<string, unknown> = {};
    for (const id of quick ? def.pointer.slice(0, 1) : def.pointer) {
      const p = all.find((x) => x.id === id);
      if (!p) continue;
      try {
        await activity(withCtx, p, false);
        await activity(withoutCtx, p, false);
        const w: number[] = [];
        const o: number[] = [];
        for (let i = 0; i < (quick ? 3 : 7); i++) {
          w.push((await activity(withCtx, p, false)).scriptMs);
          o.push((await activity(withoutCtx, p, false)).scriptMs);
        }
        const traced = [];
        for (let i = 0; i < 3; i++) traced.push(await activity(withCtx, p, true));
        const ms = median(traced.map((r) => r.extMs ?? Number.NaN));
        const ev = median(traced.map((r) => r.events));
        const diff = compare(w, o);
        pointer[id] = {
          mode: modeOf(p).mode,
          pointerEvents: ev,
          wheels: 20,
          extMs: r2(ms),
          usPerEvent: r2((ms * 1000) / Math.max(1, ev)),
          scriptMs: diff,
          traced,
        };
        console.log(
          `pointer ${id}: ${r2(ms)} ms of extension script for ${ev} pointer moves and 20 wheel scrolls (traced); untraced script time ${diff.without.median} / ${diff.with.median} ms`,
        );
      } catch (e) {
        notes.push(`pointer ${id}: ${String(e).split('\n')[0]}`);
      }
    }
    report.pointer = pointer;

    await withCtx.close();
    await withoutCtx.close();
    await controlCtx?.close();

    const perPage: Record<string, unknown> = {};
    for (const p of pages) {
      const s = samples.get(p.id)!;
      const okW = s.with.filter((x) => x.ok);
      const okO = s.without.filter((x) => x.ok);
      const tr = traces.get(p.id) ?? [];
      const { mode, why } = modeOf(p);
      const first = paints(s);
      const again = confirm.get(p.id);
      const second = again ? paints(again) : null;
      const real = {
        fcp: slower(first.fcp) && !!second && slower(second.fcp),
        lcp: slower(first.lcp) && !!second && slower(second.lcp),
      };
      // Quick runs: PageInk against the control extension, which does nothing, on this machine.
      const kFirst = controlCtx ? paints(s, 'control') : null;
      const kSecond = controlCtx && again ? paints(again, 'control') : null;
      const vsControl = kFirst
        ? {
            fcp: kFirst.fcp,
            lcp: kFirst.lcp,
            confirm: kSecond,
            real: {
              fcp: slowerThanControl(kFirst.fcp, kSecond?.fcp ?? null),
              lcp: slowerThanControl(kFirst.lcp, kSecond?.lcp ?? null),
            },
          }
        : undefined;
      // The budget is the page's own main thread. Frames in other processes are reported beside it.
      // When the top frame's thread is not found the total is used, which can only be larger.
      const extMs = tr.map((t) => (Number.isFinite(t.pageMs) ? t.pageMs : t.inkMs));
      const allMs = tr.map((t) => t.inkMs);
      const row = {
        type: p.type,
        url: p.url,
        mode,
        modeReason: why,
        failed: {
          with: s.with.length - okW.length,
          without: s.without.length - okO.length,
          errors: [...new Set([...s.with, ...s.without].map((x) => x.error).filter(Boolean))],
        },
        fp: compare(
          num(okW, (x) => x.fp),
          num(okO, (x) => x.fp),
        ),
        fcp: first.fcp,
        lcp: first.lcp,
        confirm: second,
        real,
        vsControl,
        taskMs: compare(
          num(okW, (x) => x.taskMs),
          num(okO, (x) => x.taskMs),
        ),
        longTaskMs: compare(
          okW.map((x) => x.longTasks.reduce((a, b) => a + b, 0)),
          okO.map((x) => x.longTasks.reduce((a, b) => a + b, 0)),
        ),
        stubMs: {
          median: r2(median(num(okW, (x) => x.stubMs))),
          max: r2(maxOf(num(okW, (x) => x.stubMs))),
        },
        extMs: {
          median: r2(median(extMs)),
          max: r2(maxOf(extMs)),
          loads: extMs,
          allFrames: r2(median(allMs)),
          allFramesMax: r2(maxOf(allMs)),
          otherFrames: median(tr.map((t) => t.otherFrames)),
          longestTask: r1(maxOf(tr.map((t) => t.longestInkTask))),
          byName: tr.at(-1)?.byName ?? {},
          byUrl: tr.at(-1)?.byUrl ?? {},
        },
      };
      perPage[p.id] = row;
      const atOrOver = (v: number, l: number) => !(v < l);
      if (okW.length)
        fixed(
          `stub, ${p.id}`,
          row.stubMs.median,
          BUDGET.stubMs,
          `${p.id}: stub ${row.stubMs.median} ms`,
          atOrOver,
        );
      fixed(
        `extension main-thread time, no ink, ${p.id}`,
        row.extMs.median,
        BUDGET.stubMs,
        `${p.id}: extension ${row.extMs.median} ms on the page's main thread, no ink`,
        atOrOver,
      );
      if (row.extMs.otherFrames > 0)
        notes.push(
          `${p.id}: the stub was also injected into ${row.extMs.otherFrames} ${row.extMs.otherFrames === 1 ? 'frame' : 'frames'} in other processes; ${row.extMs.allFrames} ms over all renderer main threads`,
        );
      for (const k of ['fcp', 'lcp'] as const) {
        if (vsControl?.real[k])
          fails.push(
            `${p.id}: ${k} +${vsControl[k].delta} ms over the control extension beyond noise ${vsControl[k].noise} ms, repeated (+${vsControl.confirm![k].delta} ms)`,
          );
        // In a quick run the comparison with no extension at all is reported: much of it is what
        // any extension costs on the machine, which the control comparison takes out.
        if (quick) {
          if (real[k])
            notes.push(
              `${p.id}: ${k} +${row[k].delta} ms over no extension, repeated (+${second![k].delta} ms); over the control extension ${vsControl ? `${vsControl[k].delta > 0 ? '+' : ''}${vsControl[k].delta} ms` : 'n/a'}`,
            );
          continue;
        }
        if (real[k])
          fails.push(
            `${p.id}: ${k} +${row[k].delta} ms beyond noise ${row[k].noise} ms, repeated (+${second![k].delta} ms)`,
          );
        else if (slower(row[k]))
          notes.push(
            `${p.id}: ${k} +${row[k].delta} ms in the first run did not repeat (second run ${second ? `${second[k].delta > 0 ? '+' : ''}${second[k].delta} ms, noise ${second[k].noise} ms` : 'missing'})`,
          );
      }
      if (row.failed.with + row.failed.without)
        notes.push(`${p.id}: failed loads ${row.failed.errors.join('; ')}`);
    }
    report.overhead = perPage;

    // A page that painted later with PageInk than with the control extension, beyond the noise and
    // again in a second run, is loaded once more per arm with a trace of the whole browser, so the
    // report says where the time went in every process. This changes no verdict.
    // --explain id,id: explain these pages whatever the verdict, to study a machine.
    const forced = new Set((values.explain ?? '').split(',').filter(Boolean));
    const toExplain = pages.filter((p) => {
      const k = (perPage[p.id] as { vsControl?: { real: { fcp: boolean; lcp: boolean } } }).vsControl;
      return forced.has(p.id) || (!!k && (k.real.fcp || k.real.lcp));
    });
    if (toExplain.length && (quick || forced.size)) {
      const explained: Record<string, Record<string, Explained[]>> = {};
      const arms: [string, string[]][] = [
        ['pageink', [ext]],
        ['control', [CONTROL]],
        ['none', []],
      ];
      const ctxs = new Map<string, BrowserContext>();
      for (const [name, exts] of arms) {
        const ctx = await launch(join(CACHE, `profile-explain-${name}`), exts, !!values.headed);
        await oneBlankTab(ctx);
        ctxs.set(name, ctx);
      }
      let written = 0;
      const loadTraced = async (ctx: BrowserContext, p: PageDef, file: string | null) => {
        const page = await ctx.newPage();
        try {
          await route(page, targetOf(p), base);
          const cdp = await ctx.newCDPSession(page);
          const stop = await startTrace(cdp, 'explain');
          await page.goto(targetOf(p).url, { waitUntil: 'load', timeout: 60000 });
          await page.waitForTimeout(settle);
          const events = await stop();
          if (file) {
            mkdirSync(dirname(file), { recursive: true });
            const gz = gzipSync(JSON.stringify({ traceEvents: events }));
            // Raw traces are kept while they stay small, so CI can upload them with the report.
            if (written + gz.length < EXPLAIN_MAX_BYTES) {
              writeFileSync(file, gz);
              written += gz.length;
            }
          }
          return explain(events);
        } finally {
          await page.close().catch(() => {});
        }
      };
      // A failure here is noted and changes no verdict.
      try {
        for (const p of toExplain) {
          explained[p.id] = {};
          for (const [name] of arms) {
            explained[p.id]![name] = [];
            await loadTraced(ctxs.get(name)!, p, null);
          }
          for (let i = 0; i < EXPLAIN_LOADS; i++)
            for (const [name] of i % 2 ? [...arms].reverse() : arms)
              explained[p.id]![name]!.push(
                await loadTraced(ctxs.get(name)!, p, `${values.out}.explain-${p.id}-${name}-${i}.json.gz`),
              );
        }
      } catch (e) {
        notes.push(`explaining a slower paint: ${String(e).split('\n')[0]}`);
      }
      for (const ctx of ctxs.values()) await ctx.close().catch(() => {});
      report.explain = explained;
    }
  }

  // -------------------------------------------------------------------------
  // Ink visible latency, scroll trace and stress
  // -------------------------------------------------------------------------
  if (!values['skip-ink']) {
    const bundle = await bundleHarness(anchorEntry(values.anchor!));
    const writer = await launch(join(CACHE, 'profile-writer'), [], !!values.headed);
    // --seeded id,id: only these seeded pages; `none` keeps only the stress page.
    const pick = values.seeded ? new Set(values.seeded.split(',')) : null;
    const seeded = pick
      ? def.seeded.filter((s) => pick.has(s.id))
      : quick
        ? def.seeded.slice(0, 2)
        : def.seeded;

    interface Prepared {
      url: string;
      images: Map<string, [number, number]>;
      items: Record<string, unknown>;
      noteCss: Record<string, string>;
      count: number;
    }
    const prepare = async (sd: SeedDef): Promise<Prepared> => {
      const url = resolveUrl(sd.url, base);
      const images = fixtureImages(sd.url);
      const wp = await writer.newPage();
      await offlineFixture(wp, base, images);
      await wp.goto(resolveUrl(sd.write ?? sd.url, base), { waitUntil: 'load' });
      const { notes: written, size, title } = await writeNotes(wp, bundle, sd.id, sd.notes);
      await wp.close();
      const id = await identityOf(url);
      const rec = recordFrom(id, title, written, size);
      const noteCss: Record<string, string> = {};
      for (const n of rec.notes) if (n.anchor.path?.css) noteCss[n.id] = n.anchor.path.css;
      return { url, images, items: storageItems(id, rec), noteCss, count: rec.notes.length };
    };

    /**
     * Open a seeded page. The page itself records when each anchor element first exists, and
     * marks it for element timing, which reports when the browser first painted it.
     */
    const openSeeded = async (ctx: BrowserContext, pr: Prepared, traceName?: string) => {
      const page = await ctx.newPage();
      await offlineFixture(page, base, pr.images);
      // --traces <dir>: a trace of the load, from before navigation to the end of the settle time.
      // --profile adds sampled script stacks and frames, which slow the page.
      const cdp = values.traces && traceName ? await ctx.newCDPSession(page) : null;
      const stop = cdp ? await startTrace(cdp, values.profile ? 'profile' : 'timeline') : null;
      // With --profile, a CPU profile sampled every 25 µs as well, for short tasks.
      if (cdp && values.profile) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 25 });
        await cdp.send('Profiler.start');
      }
      const sels = [...new Set(Object.values(pr.noteCss))];
      await page.addInitScript(`(() => {
        const sels = ${JSON.stringify(sels)};
        const seen = {};
        const painted = {};
        window.__benchAnchors = seen;
        window.__benchPainted = painted;
        try {
          new PerformanceObserver((l) => {
            for (const e of l.getEntries()) {
              const i = /^ink-anchor-(\\d+)$/.exec(e.identifier || '');
              // paintTime is when the frame that first showed the element was painted. renderTime is
              // when it was presented, later, so ink added in between would wrongly count as in time.
              if (i && painted[sels[+i[1]]] === undefined) painted[sels[+i[1]]] = e.paintTime || e.renderTime || e.loadTime;
            }
          }).observe({ type: 'element', buffered: true });
        } catch {}
        const check = () => {
          for (let i = 0; i < sels.length; i++) {
            const s = sels[i];
            if (seen[s] !== undefined) continue;
            try {
              const el = document.querySelector(s);
              if (!el) continue;
              seen[s] = performance.now();
              if (!el.hasAttribute('elementtiming')) el.setAttribute('elementtiming', 'ink-anchor-' + i);
            } catch { seen[s] = -1; }
          }
        };
        new MutationObserver(check).observe(document, { childList: true, subtree: true });
      })()`);
      await page.goto(pr.url, { waitUntil: 'load' });
      await page.waitForTimeout(settle);
      if (stop) {
        const dir = resolve(cwd, values.traces!);
        mkdirSync(dir, { recursive: true });
        if (values.profile) {
          const { profile } = (await cdp!.send('Profiler.stop')) as { profile: unknown };
          writeFileSync(join(dir, `${traceName}.cpuprofile`), JSON.stringify(profile));
        }
        writeFileSync(join(dir, `${traceName}.json`), JSON.stringify({ traceEvents: await stop() }));
      }
      return page;
    };

    interface LatencyRun {
      /** Worst lag over notes whose anchor is in the first screen: ink inserted minus anchor inserted. */
      worstNear: number | null;
      /** Same, to the start of the first frame after the ink was inserted. */
      worstNearFrame: number | null;
      /** Worst lag counted from the anchor content's first paint, by element timing. Negative: ink came first. */
      worstNearPaint: number | null;
      /** Worst wait of a first-screen anchor for its own first paint, after its insert. */
      worstContentPaint: number | null;
      /**
       * What a reader sees: 0 when every first-screen note's ink was in the page before its
       * content's first paint, so both appear in the same frame; else the worst lag after that paint.
       */
      worstSeen: number | null;
      /** First-screen notes whose ink was in the same frame as its content's first paint. */
      sameFrame: number;
      /** First-screen anchors whose first paint came from element timing, not the fallback. */
      elementTimed: number;
      /** The registered viewer ran: its first read (boot.js) marked ink:boot. */
      boot: boolean;
      fcp: number | null;
      /** Same over every note that was drawn, including those far below the first screen. */
      worstAll: number | null;
      near: number;
      nearDrawn: number;
      drawn: number;
      firstInkMark: number | null;
      placedMark: number | null;
      lastAnchor: number | null;
      stubStart: number | null;
      viewStart: number | null;
    }
    const measureLatency = async (page: Page, pr: Prepared): Promise<LatencyRun> => {
      const got = (await page.evaluate(`(async () => {
        const css = ${JSON.stringify(pr.noteCss)};
        const near = {};
        for (const [id, s] of Object.entries(css)) {
          let el = null; try { el = document.querySelector(s); } catch {}
          const r = el && el.getBoundingClientRect();
          near[id] = !!r && r.bottom > 0 && r.top < innerHeight;
        }
        return { m: ${COLLECT}, a: window.__benchAnchors || {}, p: window.__benchPainted || {}, near, probe: await ${PROBE_DUMP} };
      })()`)) as {
        m: { ink: InkEntry[]; fcp: number | null };
        a: Record<string, number>;
        p: Record<string, number>;
        near: Record<string, boolean>;
        probe: { drawn: Record<string, number>; visible: Record<string, number> } | null;
      };
      const mark = (n: string) => got.m.ink.find((e) => e.name === n && e.type === 'mark')?.start ?? null;
      const lagsNear: number[] = [];
      const lagsFrame: number[] = [];
      const lagsPaint: number[] = [];
      const waitsPaint: number[] = [];
      const fcp = got.m.fcp;
      const lagsAll: number[] = [];
      let near = 0;
      let nearDrawn = 0;
      let drawn = 0;
      let sameFrame = 0;
      let elementTimed = 0;
      for (const [id, s] of Object.entries(pr.noteCss)) {
        const a = got.a[s];
        if (got.near[id]) near++;
        const d = got.probe?.drawn[id];
        if (d === undefined || a === undefined || a < 0) continue;
        const f = got.probe?.visible[id] ?? d;
        drawn++;
        lagsAll.push(d - a);
        if (got.near[id]) {
          nearDrawn++;
          lagsNear.push(d - a);
          lagsFrame.push(f - a);
          // The content's first paint: from element timing, else the later of its insert and the
          // first contentful paint, which is no later than it.
          // The fallback is no later than the real paint, so it can only make the lag look longer.
          const painted = got.p[s] ?? Math.max(a, fcp ?? a);
          if (got.p[s] !== undefined) elementTimed++;
          lagsPaint.push(d - painted);
          waitsPaint.push(painted - a);
          // Ink inserted before that paint was in the DOM when the frame was painted.
          if (d <= painted) sameFrame++;
        }
      }
      const anchors = Object.values(got.a).filter((t) => t >= 0);
      const stub = got.m.ink.filter((e) => e.name === 'ink:stub' && e.type === 'measure');
      const view = mark('ink:view-start');
      return {
        worstNear: lagsNear.length ? r1(Math.max(...lagsNear)) : null,
        worstNearFrame: lagsFrame.length ? r1(Math.max(...lagsFrame)) : null,
        worstNearPaint: lagsPaint.length ? r1(Math.max(...lagsPaint)) : null,
        worstContentPaint: waitsPaint.length ? r1(Math.max(...waitsPaint)) : null,
        worstSeen: lagsPaint.length ? r1(Math.max(0, ...lagsPaint)) : null,
        sameFrame,
        elementTimed,
        boot: mark('ink:boot') !== null,
        fcp: fcp === null ? null : r1(fcp),
        worstAll: lagsAll.length ? r1(Math.max(...lagsAll)) : null,
        near,
        nearDrawn,
        drawn,
        firstInkMark: mark('ink:first-ink') === null ? null : r1(mark('ink:first-ink')!),
        placedMark: mark('ink:placed') === null ? null : r1(mark('ink:placed')!),
        lastAnchor: anchors.length ? r1(Math.max(...anchors)) : null,
        // Where the time goes: stub start and the viewer starting.
        stubStart: stub.length ? r1(stub[0]!.start) : null,
        viewStart: view === null ? null : r1(view),
      };
    };
    const summary = (runs: LatencyRun[]) => {
      const xs = runs.map((r) => r.worstNear).filter((x): x is number => x !== null);
      const fs = runs.map((r) => r.worstNearFrame).filter((x): x is number => x !== null);
      const pick = (f: (r: LatencyRun) => number | null) =>
        r1(median(runs.map(f).filter((x): x is number => x !== null)));
      return {
        median: r1(median(xs)),
        max: r1(maxOf(xs)),
        n: xs.length,
        /** Notes whose anchor is in the first screen, per load. */
        near: median(runs.map((r) => r.near)),
        /** Worst lag over every drawn note, including those far below the first screen. */
        allMedian: pick((r) => r.worstAll),
        frameMedian: r1(median(fs)),
        paintMedian: pick((r) => r.worstNearPaint),
        paintMax: r1(maxOf(runs.map((r) => r.worstNearPaint).filter((x): x is number => x !== null))),
        contentPaintMedian: pick((r) => r.worstContentPaint),
        contentPaintMax: r1(
          maxOf(runs.map((r) => r.worstContentPaint).filter((x): x is number => x !== null)),
        ),
        seenMedian: pick((r) => r.worstSeen),
        seenMax: r1(maxOf(runs.map((r) => r.worstSeen).filter((x): x is number => x !== null))),
        /** Loads where every first-screen note's ink was in the same frame as its content's first paint. */
        sameFrameLoads: runs.filter((r) => r.nearDrawn > 0 && r.sameFrame === r.nearDrawn).length,
        /** First-screen anchors timed by element timing, over all loads, and all first-screen anchors drawn. */
        elementTimed: runs.reduce((n, r) => n + r.elementTimed, 0),
        nearDrawn: runs.reduce((n, r) => n + r.nearDrawn, 0),
        /** Loads where the registered viewer ran. */
        booted: runs.filter((r) => r.boot).length,
        loads: runs.length,
        timeline: {
          lastAnchor: pick((r) => r.lastAnchor),
          fcp: pick((r) => r.fcp),
          stubStart: pick((r) => r.stubStart),
          viewStart: pick((r) => r.viewStart),
          firstInk: pick((r) => r.firstInkMark),
        },
      };
    };

    const prepared = new Map<string, Prepared>();
    for (const sd of [...seeded, def.stress]) prepared.set(sd.id, await prepare(sd));
    await writer.close();

    const latency: Record<string, unknown> = {};
    // The stress page is timed too: a Wikipedia page whose first screen holds notes.
    const timed = quick ? seeded : [...seeded, def.stress];
    // Five cold loads in quick mode too: the gate is on the median, and a median of two is their mean,
    // which one late load decides.
    const nCold = Number(values['cold-loads']);
    const nWarm = quick ? 3 : Number(values['warm-loads'] ?? 8);
    // Cold: a returning reader who opens the browser and goes to a page with ink. Per load, a
    // fresh profile gets the record and the extension registers its viewer for the host; that
    // browser closes without loading any page, and a new browser starts on the same profile, with
    // the registration in place before the load. No page has run the extension's scripts in it, so
    // nothing of them is compiled or cached, and the background has just started.
    const cold = new Map<string, LatencyRun[]>();
    const coldDir = join(CACHE, 'profile-cold');
    for (const sd of timed) {
      const pr = prepared.get(sd.id)!;
      const runs: LatencyRun[] = [];
      for (let i = 0; i < nCold; i++) {
        const setup = await launch(coldDir, [ext, PROBE], !!values.headed);
        await seed(await workerOf(setup), pr.items);
        await setup.close();
        const ctx = await launch(coldDir, [ext, PROBE], !!values.headed, true);
        // See registered(): with an unpacked extension the registration comes back just after start.
        await registered(await workerOf(ctx), pr.items);
        const page = await openSeeded(ctx, pr, `latency-${sd.id}-cold-${i}`);
        runs.push(await measureLatency(page, pr));
        await ctx.close();
      }
      cold.set(sd.id, runs);
    }
    rmSync(coldDir, { recursive: true, force: true });
    // Warm: one browser, the first load of each page discarded.
    const warmCtx = await launch(join(CACHE, 'profile-ink'), [ext, PROBE], !!values.headed);
    const warmSw = await workerOf(warmCtx);
    (report.meta as Record<string, unknown>).browser ??= await browserOf(warmCtx);
    for (const sd of timed) {
      const pr = prepared.get(sd.id)!;
      await seed(warmSw, pr.items);
      await (await openSeeded(warmCtx, pr)).close();
      const runs: LatencyRun[] = [];
      for (let i = 0; i < nWarm; i++) {
        const page = await openSeeded(warmCtx, pr, `latency-${sd.id}-warm-${i}`);
        runs.push(await measureLatency(page, pr));
        await page.close();
      }
      const c = cold.get(sd.id)!;
      latency[sd.id] = {
        url: sd.url,
        notes: pr.count,
        cold: { ...summary(c), runs: c },
        warm: { ...summary(runs), runs },
      };
    }
    await warmCtx.close();

    // The first paint of the content under ink, with the extension and with no extension at all,
    // cold and warm, the loads of the two arms interleaved so drift on the machine hits both alike.
    // The probe is left out of both arms: only PageInk differs. The first-screen anchors that
    // element timing reports are counted, the same anchors in both arms. Two figures per load:
    // when the last of them was first painted, counted from navigation (what a reader waits for,
    // which includes the extension's work while the page parses), and the longest wait of one of
    // them from its insert to its paint. The page alone also gives the 50 ms rule its context.
    interface PaintRun {
      /** Last first-screen anchor's first paint, ms from navigation. */
      at: number | null;
      /** Longest wait of a first-screen anchor from its insert to its first paint, ms. */
      wait: number | null;
      /** First-screen anchors element timing reported, and all first-screen anchors. */
      timed: number;
      near: number;
    }
    const contentPaint = async (page: Page, pr: Prepared): Promise<PaintRun> => {
      const got = (await page.evaluate(`(() => {
        const css = ${JSON.stringify(pr.noteCss)};
        const near = [];
        for (const s of Object.values(css)) {
          let el = null; try { el = document.querySelector(s); } catch {}
          const r = el && el.getBoundingClientRect();
          if (r && r.bottom > 0 && r.top < innerHeight) near.push(s);
        }
        return { near, a: window.__benchAnchors || {}, p: window.__benchPainted || {} };
      })()`)) as { near: string[]; a: Record<string, number>; p: Record<string, number> };
      const near = [...new Set(got.near)];
      const ok = near.filter((s) => got.a[s] !== undefined && got.a[s] >= 0 && got.p[s] !== undefined);
      return {
        at: ok.length ? r1(Math.max(...ok.map((s) => got.p[s]!))) : null,
        wait: ok.length ? r1(Math.max(...ok.map((s) => got.p[s]! - got.a[s]!))) : null,
        timed: ok.length,
        near: near.length,
      };
    };
    const plainSide = (xs: PaintRun[]) => {
      const v = xs.map((x) => x.wait).filter((x): x is number => x !== null);
      return {
        contentPaintMedian: v.length ? r1(median(v)) : null,
        n: v.length,
        runs: xs.map((x) => x.wait),
      };
    };
    const nums = (xs: PaintRun[], k: 'at' | 'wait') => xs.map((x) => x[k]);
    const inkColdDir = join(CACHE, 'profile-held-cold');
    const aloneColdDir = join(CACHE, 'profile-plain-cold');
    const inkWarm = await launch(join(CACHE, 'profile-held'), [ext], !!values.headed);
    const inkWarmSw = await workerOf(inkWarm);
    const aloneWarm = await launch(join(CACHE, 'profile-plain'), [], !!values.headed);
    for (const sd of timed) {
      const pr = prepared.get(sd.id)!;
      const runs = {
        cold: { ink: [] as PaintRun[], alone: [] as PaintRun[] },
        warm: { ink: [] as PaintRun[], alone: [] as PaintRun[] },
      };
      type Pairs = { ink: PaintRun[]; alone: PaintRun[] };
      const inkCold = async (out: Pairs, name: string) => {
        const setup = await launch(inkColdDir, [ext], !!values.headed);
        await seed(await workerOf(setup), pr.items);
        await setup.close();
        const ctx = await launch(inkColdDir, [ext], !!values.headed, true);
        await registered(await workerOf(ctx), pr.items);
        out.ink.push(await contentPaint(await openSeeded(ctx, pr, `held-${name}`), pr));
        await ctx.close();
      };
      const aloneCold = async (out: Pairs, name: string) => {
        await (await launch(aloneColdDir, [], !!values.headed)).close();
        const ctx = await launch(aloneColdDir, [], !!values.headed, true);
        out.alone.push(await contentPaint(await openSeeded(ctx, pr, `plain-${name}`), pr));
        await ctx.close();
      };
      let warmed = false;
      /** One arm's pairs, cold or warm, each pair taken back to back. */
      const measurePairs = async (k: 'cold' | 'warm', out: Pairs, tag = '') => {
        if (k === 'cold') {
          // Alternate which arm goes first so drift hits both equally.
          for (let i = 0; i < nCold; i++)
            for (const f of i % 2 ? [aloneCold, inkCold] : [inkCold, aloneCold])
              await f(out, `${sd.id}-cold${tag}-${i}`);
          return;
        }
        if (!warmed) {
          await seed(inkWarmSw, pr.items);
          await (await openSeeded(inkWarm, pr)).close();
          await (await openSeeded(aloneWarm, pr)).close();
          warmed = true;
        }
        for (let i = 0; i < nWarm; i++) {
          const arms: [BrowserContext, PaintRun[], string][] = [
            [inkWarm, out.ink, `held-${sd.id}-warm${tag}-${i}`],
            [aloneWarm, out.alone, `plain-${sd.id}-warm${tag}-${i}`],
          ];
          if (i % 2) arms.reverse();
          for (const [ctx, list, name] of arms) {
            const page = await openSeeded(ctx, pr, name);
            list.push(await contentPaint(page, pr));
            await page.close();
          }
        }
      };
      for (const k of ['cold', 'warm'] as const) await measurePairs(k, runs[k]);
      const row = latency[sd.id] as Record<string, unknown>;
      row.plain = { cold: plainSide(runs.cold.alone), warm: plainSide(runs.warm.alone) };
      const side = (k: 'cold' | 'warm') => ({
        ...heldBack(nums(runs[k].ink, 'at'), nums(runs[k].alone, 'at')),
        wait: heldBack(nums(runs[k].ink, 'wait'), nums(runs[k].alone, 'wait')),
        timed: runs[k].ink.reduce((n, r) => n + r.timed, 0),
        near: runs[k].ink.reduce((n, r) => n + r.near, 0),
      });
      const held: Record<'cold' | 'warm', ReturnType<typeof side> & { again?: HeldBack }> = {
        cold: side('cold'),
        warm: side('warm'),
      };
      // A quick run on a fit machine measures a figure over its judged limit again from scratch:
      // the same page and arm, pairs again (src/judge.ts judgeRepeated). The stress page is reported.
      if (quick && fit.fit && sd.id !== def.stress.id)
        for (const k of ['cold', 'warm'] as const) {
          if (judgeLimit('', held[k].delta, BUDGET.heldBackMs, fit).verdict !== 'fail') continue;
          const again: Pairs = { ink: [], alone: [] };
          await measurePairs(k, again, '-again');
          held[k].again = heldBack(nums(again.ink, 'at'), nums(again.alone, 'at'));
        }
      row.heldBack = held;
    }
    await inkWarm.close();
    await aloneWarm.close();
    rmSync(inkColdDir, { recursive: true, force: true });
    rmSync(aloneColdDir, { recursive: true, force: true });

    // Scroll and stress without the probe, so only the measured extension is in the page.
    const inkCtx = await launch(join(CACHE, 'profile-scroll'), [ext], !!values.headed);
    const sw = await workerOf(inkCtx);
    const owner = ownerOf(sw.url());
    const scrollTrace = async (pr: Prepared) => {
      const page = await openSeeded(inkCtx, pr);
      const cdp = await inkCtx.newCDPSession(page);
      const stop = await startTrace(cdp);
      for (let k = 0; k < 20; k++) {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(200);
      const a = attribute(await stop(), owner);
      await page.close();
      return { inkEvents: a.inkEvents, inkMs: a.inkMs, byName: a.byName };
    };
    const plainOf = (row: Record<string, unknown>, k: 'cold' | 'warm') =>
      (row.plain as Record<string, { contentPaintMedian: number | null }> | undefined)?.[k]
        ?.contentPaintMedian ?? 'n/a';
    for (const sd of timed) {
      const pr = prepared.get(sd.id)!;
      type Side = {
        median: number;
        n: number;
        near: number;
        allMedian: number;
        paintMedian: number;
        contentPaintMedian: number;
        booted: number;
        loads: number;
      };
      const row = latency[sd.id] as Record<string, unknown> & { cold: Side; warm: Side };
      let sc = { inkEvents: 0, inkMs: 0, byName: {} as Record<string, number> };
      if (sd.id !== def.stress.id) {
        await seed(sw, pr.items);
        await (await openSeeded(inkCtx, pr)).close();
        sc = await scrollTrace(pr);
        row.scroll = sc;
      }
      for (const k of ['cold', 'warm'] as const) {
        // Every timed load must have gone through the registered viewer, or it measured another path.
        if (benchBuild && row[k].booted < row[k].loads)
          throw new Error(
            `${sd.id}: the registered viewer ran in ${row[k].booted} of ${row[k].loads} ${k} loads`,
          );
        if (!row[k].near)
          notes.push(
            `${sd.id}: no note has its anchor in the first screen, so the budget has nothing to time (${k}). Worst lag over all notes, drawn in idle time below the screen: ${row[k].allMedian} ms (median)`,
          );
        else if (!row[k].n) fails.push(`${sd.id}: no ink drawn for notes in the first screen (${k})`);
        else {
          // In every case: within one frame of the content's own first paint.
          fixed(
            `ink after its content's first paint, ${sd.id} ${k}`,
            row[k].paintMedian,
            BUDGET.visibleFrameMs,
            `${sd.id}: ink ${row[k].paintMedian} ms after its content's first paint (${k}, median), more than one frame`,
          );
          // Within 50 ms of the insert, unless the page alone, with no extension, painted that
          // content later than that allows. The paint with the extension stands in only when the
          // page alone was not measured.
          const scale = quick && fit.fit ? fit.scale : 1;
          const alone = plainOf(row, k);
          const pagePaint = typeof alone === 'number' ? alone : row[k].contentPaintMedian;
          const layoutAllows = pagePaint <= (BUDGET.visibleMs - BUDGET.visibleFrameMs) * scale;
          if (layoutAllows)
            fixed(
              `ink visible after its anchor content, ${sd.id} ${k}`,
              row[k].median,
              BUDGET.visibleMs,
              `${sd.id}: ink visible ${row[k].median} ms after its anchor content (${k}, median)`,
            );
        }
      }
      // The first paint of the content under ink, against the page alone. Judged on the seeded
      // pages. The stress page is reported: its parse is long, and the page alone paints its first
      // screen in two ways from load to load, so both groups are shown beside the figure.
      const hb = row.heldBack as Record<'cold' | 'warm', HeldBack> | undefined;
      for (const k of ['cold', 'warm'] as const) {
        const h = hb?.[k];
        if (!h || !Number.isFinite(h.delta)) continue;
        const line = `${sd.id}: first paint of the content under ink held back ${h.delta} ms by the extension (${k}, ${h.basis}, noise ${h.noise} ms)`;
        const rule = `first paint of content under ink held back, ${sd.id} ${k}`;
        if (sd.id === def.stress.id) notes.push(`${line}; reported, not judged`);
        else if (!quick) fixed(rule, h.delta, BUDGET.heldBackMs, line);
        else {
          // Few pairs in a quick run: over the judged limit fails only when a second measure is too.
          const again = (h as HeldBack & { again?: HeldBack }).again;
          const j = judgeRepeated(rule, h.delta, again ? again.delta : null, BUDGET.heldBackMs, fit);
          judged.push(j);
          if (j.verdict === 'fail')
            fails.push(
              `${line}, and ${j.second} ms when measured again, judged against ${j.judgedLimit} ms on this machine`,
            );
          else if (j.notRepeated)
            notes.push(
              `${line} was over ${j.judgedLimit} ms, judged on this machine; it did not repeat when measured again (${j.second ?? 'n/a'} ms)`,
            );
          else if (j.verdict === 'not judged' && j.raw === 'fail')
            notes.push(`not judged on this machine: ${line} (${j.reason})`);
        }
      }
      if (sc.inkEvents > 0) fails.push(`${sd.id}: ${sc.inkEvents} ink script events during scroll`);
      console.log(
        `latency ${sd.id}: cold ${row.cold.median} ms, warm ${row.warm.median} ms after the anchor; ${row.cold.paintMedian} / ${row.warm.paintMedian} ms after its first paint; content waits ${row.cold.contentPaintMedian} / ${row.warm.contentPaintMedian} ms, ${plainOf(row, 'cold')} / ${plainOf(row, 'warm')} ms without the extension; first paint held back ${hb ? `${hb.cold.delta} / ${hb.warm.delta} ms (noise ${hb.cold.noise} / ${hb.warm.noise})` : 'n/a'}; scroll ink events ${sc.inkEvents}`,
      );
    }
    report.latency = latency;

    // Stress: a 200-note record on a long page, traced from navigation, then scrolled. The same
    // page is also loaded without the extension, the same number of times, cold and warm, so the
    // page's own long tasks are seen apart from the ink's.
    const st = def.stress;
    const pr = prepared.get(st.id)!;
    const nStress = quick ? 1 : 3;
    interface StressLoad {
      inkMs: number;
      /** Longest task of any kind on the page's main thread. */
      longestTask: number;
      longestInkTask: number;
      longestInkTaskInk: number;
      inkLongTasks: number[];
      longTasks: number[];
      /** Tasks that ran ink script and are long or hold more than 1 ms of ink: length and ink part. */
      inkTasks: InkTask[];
    }
    const traceStress = async (
      ctx: BrowserContext,
      own: Owner | string,
      name: string,
    ): Promise<StressLoad> => {
      const page = await ctx.newPage();
      await offlineFixture(page, base, pr.images);
      const cdp = await ctx.newCDPSession(page);
      const stop = await startTrace(cdp, !!values.traces);
      await page.goto(pr.url, { waitUntil: 'load' });
      await page.waitForTimeout(settle);
      const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
      const events = await stop();
      const a = attribute(events, own, { mainFrame: tree.frameTree.frame.id });
      // --traces <dir>: keep the raw trace of each stress load, with the stack of each forced layout, to find what a long task ran. The stacks slow the page, so those numbers are not for publishing.
      if (values.traces) {
        mkdirSync(resolve(cwd, values.traces), { recursive: true });
        writeFileSync(
          join(resolve(cwd, values.traces), `stress-${name}.json`),
          JSON.stringify({ owner: own, events }),
        );
      }
      await page.close();
      return {
        inkMs: a.inkMs,
        longestTask: a.longestTask,
        longestInkTask: a.longestInkTask,
        longestInkTaskInk: a.longestInkTaskInk,
        inkLongTasks: a.inkLongTasks,
        longTasks: a.longTasks,
        inkTasks: a.inkTasks.filter((t) => t.ms > 16.7 || t.inkMs > 1),
      };
    };
    // Warm: one browser each, after one discarded load of the page, as for latency.
    await seed(sw, pr.items);
    await traceStress(inkCtx, owner, 'warm-discarded');
    const warmInk: StressLoad[] = [];
    for (let i = 0; i < nStress; i++) warmInk.push(await traceStress(inkCtx, owner, `warm-${i}`));
    const stressScroll = await scrollTrace(pr);
    await inkCtx.close();
    const plainCtx = await launch(join(CACHE, 'profile-stress-plain'), [], !!values.headed);
    await traceStress(plainCtx, owner, 'plain-warm-discarded');
    const warmPlain: StressLoad[] = [];
    for (let i = 0; i < nStress; i++) warmPlain.push(await traceStress(plainCtx, owner, `plain-warm-${i}`));
    await plainCtx.close();
    // Cold: a new browser on a profile that has the record (or, without the extension, a profile
    // that has been opened once), started again for the load.
    const coldInk: StressLoad[] = [];
    const coldPlain: StressLoad[] = [];
    const inkDir = join(CACHE, 'profile-stress-cold');
    const plainDir = join(CACHE, 'profile-stress-plain-cold');
    for (let i = 0; i < nStress; i++) {
      const setup = await launch(inkDir, [ext], !!values.headed);
      await seed(await workerOf(setup), pr.items);
      await setup.close();
      const ctx = await launch(inkDir, [ext], !!values.headed, true);
      await registered(await workerOf(ctx), pr.items);
      coldInk.push(await traceStress(ctx, owner, `cold-${i}`));
      await ctx.close();
      await (await launch(plainDir, [], !!values.headed)).close();
      const plain = await launch(plainDir, [], !!values.headed, true);
      coldPlain.push(await traceStress(plain, owner, `plain-cold-${i}`));
      await plain.close();
    }
    rmSync(inkDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
    const stress = [...coldInk, ...warmInk];
    const worst = Math.max(...stress.map((s) => s.longestInkTask));
    const arms: Arm[] = [
      {
        ink: coldInk.map((s) => s.inkTasks),
        plain: coldPlain.map((s) => s.longestTask),
      },
      {
        ink: warmInk.map((s) => s.inkTasks),
        plain: warmPlain.map((s) => s.longestTask),
      },
    ];
    const v = verdict(arms);
    // The limits the gate judges with. Both are fixed times: 50 ms for a long task and one frame
    // for the ink part of a task. A machine three times slower turns a 20 ms task into a long one,
    // so a quick run judges both scaled on a fit machine and not at all elsewhere. How often a
    // long task occurs against the control extension, below, is judged on every machine.
    const scaled = (ms: number) => (!quick ? ms : fit.fit ? r2(ms * fit.scale) : Number.POSITIVE_INFINITY);
    const frameJ = scaled(LIMITS.frameMs);
    const longJ = scaled(LIMITS.longMs);
    const limJ = { longMs: longJ, frameMs: frameJ };
    const vj = verdict(arms, limJ);
    const side = (ink: StressLoad[], plain: StressLoad[]) => ({
      runs: ink,
      plain: plain.map((s) => s.longestTask),
      longestTask: Math.max(...ink.map((s) => s.longestTask)),
      plainLongestTask: Math.max(...plain.map((s) => s.longestTask)),
      plainLongTasks: plain.reduce((n, s) => n + s.longTasks.length, 0),
    });
    report.stress = {
      page: st.url,
      notes: pr.count,
      loads: nStress,
      cold: side(coldInk, coldPlain),
      warm: side(warmInk, warmPlain),
      /** Warm loads, as published before the cold and no-extension arms. */
      runs: warmInk,
      longestInkTask: worst,
      /** Extension time inside the longest of those tasks. */
      longestInkTaskInk: stress.find((x) => x.longestInkTask === worst)?.longestInkTaskInk ?? null,
      inkLongTasks: stress.reduce((n, s) => n + s.inkLongTasks.length, 0),
      /** The budget: long tasks ink caused, the largest ink part of one task, and long tasks seen only with ink. */
      verdict: {
        caused: v.caused,
        maxInkMs: v.maxInkMs,
        overFrame: v.overFrame,
        long: v.long,
        onlyWithInk: v.onlyWithInk,
        pass: v.pass,
      },
      scroll: stressScroll,
    };
    // Quick mode has one load per arm, and on a shared machine one task can be stretched by the
    // machine itself (another process, a garbage collection), not by ink. So in quick mode a
    // task the rules below flag counts only when it repeats: the extension's side is loaded once
    // more, cold and warm, and a finding counts when the same rule flags a task there too, as a
    // slower paint counts only when it repeats. A full run judges every task of its loads.
    let again: ReturnType<typeof verdict> | null = null;
    if (quick && (vj.caused.length || vj.overFrame.length)) {
      const dir = join(CACHE, 'profile-stress-again');
      const setup = await launch(dir, [ext], !!values.headed);
      await seed(await workerOf(setup), pr.items);
      await setup.close();
      const cold = await launch(dir, [ext], !!values.headed, true);
      await registered(await workerOf(cold), pr.items);
      const c = await traceStress(cold, owner, 'again-cold');
      await cold.close();
      const warm = await launch(dir, [ext], !!values.headed, true);
      await registered(await workerOf(warm), pr.items);
      await traceStress(warm, owner, 'again-warm-discarded');
      const w = await traceStress(warm, owner, 'again-warm');
      await warm.close();
      rmSync(dir, { recursive: true, force: true });
      again = verdict([{ ink: [c.inkTasks, w.inkTasks], plain: [c.longestTask, w.longestTask] }], limJ);
      (report.stress as Record<string, unknown>).again = {
        runs: [c, w],
        caused: again.caused,
        overFrame: again.overFrame,
        maxInkMs: again.maxInkMs,
      };
    }
    let frameFails = 0;
    const judge = (line: string, second: InkTask[] | undefined): boolean => {
      if (!again || second?.length) {
        fails.push(line);
        return true;
      }
      notes.push(`${line}; it did not repeat when the extension's loads were measured again`);
      return false;
    };
    for (const t of vj.caused)
      judge(
        `stress: a ${t.ms} ms task caused by ink (${t.inkMs} ms of it ink)${longJ !== LIMITS.longMs ? `, judged against ${longJ} ms on this machine` : ''}`,
        again?.caused,
      );
    for (const t of vj.overFrame)
      if (
        judge(
          `stress: ${t.inkMs} ms of ink in one task, more than ${frameJ} ms${frameJ !== LIMITS.frameMs ? ` (one frame, ${LIMITS.frameMs} ms, on this machine)` : ' (one frame)'}`,
          again?.overFrame,
        )
      )
        frameFails++;
    if (quick) {
      const worstInk = v.maxInkMs;
      // A finding on a fit machine counts only when it repeats, so the verdict is the gate's.
      const j = judgeLimit('ink part of one task, stress', worstInk, LIMITS.frameMs, fit);
      if (fit.fit) j.verdict = frameFails ? 'fail' : 'pass';
      judged.push(j);
      if (!fit.fit && v.overFrame.length)
        notes.push(
          `not judged on this machine: stress: ${worstInk} ms of ink in one task, more than one frame (${LIMITS.frameMs} ms) (${fit.reason})`,
        );
      if (!fit.fit)
        for (const t of v.caused)
          notes.push(
            `not judged on this machine: stress: a ${t.ms} ms task caused by ink (${t.inkMs} ms of it ink) (${fit.reason})`,
          );
    }
    // The traced loads are few: whether the page itself merged two parse chunks into one long
    // first update in them is chance on either side (docs/RESULTS.md). A long task with ink script
    // in an arm where the page alone had none is reported here, and judged below by how often it
    // occurs over many loads.
    for (const ms of v.onlyWithInk)
      notes.push(
        `stress: a ${ms} ms task with the extension, and none over ${LIMITS.longMs} ms without it in ${nStress} traced ${nStress === 1 ? 'load' : 'loads'} (judged by how often, below)`,
      );

    // How often a load of the stress page has a long task, with the extension, with the control
    // extension and with none, cold and warm, the arms interleaved. The page itself runs its first
    // update as one long task in some loads and as two shorter ones in others, so a few traced
    // loads cannot tell whether the extension makes the long form more common. Here every load is
    // traced with tasks only, which barely slows it. --compare-ext <dir> adds another build
    // as a fourth arm, for study; it is not judged.
    const nOften = Number(values['long-loads'] ?? (quick ? 6 : 20));
    const compareExt = values['compare-ext'] ? resolve(cwd, values['compare-ext']) : null;
    type OftenArm = 'ext' | 'plain' | 'control' | 'compare';
    const oftenArms: [OftenArm, string[], boolean][] = [
      ['ext', [ext], true],
      ['plain', [], false],
      ['control', [CONTROL], false],
      ...(compareExt ? ([['compare', [compareExt], true]] as [OftenArm, string[], boolean][]) : []),
    ];
    /**
     * One load, traced with tasks only, which barely slows the page: its longest main-thread task,
     * ms. The page's long task entries are not used: they leave out tasks that run content scripts.
     */
    const longOf = async (ctx: BrowserContext): Promise<number[]> => {
      const page = await ctx.newPage();
      await offlineFixture(page, base, pr.images);
      const stop = await startTrace(await ctx.newCDPSession(page), 'tasks');
      await page.goto(pr.url, { waitUntil: 'load' });
      await page.waitForTimeout(settle);
      const longest = longestRendererTask(await stop());
      await page.close();
      return [longest];
    };
    const measureOften = async (tag: string) => {
      const loads: Record<string, { cold: number[][]; warm: number[][] }> = {};
      for (const [name] of oftenArms) loads[name] = { cold: [], warm: [] };
      for (let i = 0; i < nOften; i++) {
        const order = i % 2 ? [...oftenArms].reverse() : oftenArms;
        for (const [name, exts, ink] of order) {
          const dir = join(CACHE, `profile-often-${name}`);
          const setup = await launch(dir, exts, !!values.headed);
          if (ink) await seed(await workerOf(setup), pr.items);
          await setup.close();
          const ctx = await launch(dir, exts, !!values.headed, true);
          if (ink) await registered(await workerOf(ctx), pr.items);
          loads[name]!.cold.push(await longOf(ctx));
          await ctx.close();
          rmSync(dir, { recursive: true, force: true });
        }
      }
      const warm: [OftenArm, BrowserContext][] = [];
      for (const [name, exts, ink] of oftenArms) {
        const ctx = await launch(join(CACHE, `profile-often-warm-${name}`), exts, !!values.headed);
        if (ink) {
          const w = await workerOf(ctx);
          await seed(w, pr.items);
          await registered(w, pr.items);
        }
        await longOf(ctx);
        warm.push([name, ctx]);
      }
      for (let i = 0; i < nOften; i++)
        for (const [name, ctx] of i % 2 ? [...warm].reverse() : warm)
          loads[name]!.warm.push(await longOf(ctx));
      for (const [, ctx] of warm) await ctx.close();
      const count = (xs: number[][]): Count => ({
        long: xs.filter((l) => l.some((ms) => ms > LIMITS.longMs)).length,
        loads: xs.length,
      });
      const side = (k: 'cold' | 'warm'): Often => ({
        ext: count(loads.ext![k]),
        plain: count(loads.plain![k]),
        control: count(loads.control![k]),
      });
      console.log(
        `stress, how often a long task (${tag}): ${oftenArms
          .map(
            ([n]) =>
              `${n} cold ${count(loads[n]!.cold).long}/${nOften}, warm ${count(loads[n]!.warm).long}/${nOften}`,
          )
          .join('; ')}`,
      );
      return {
        loads,
        cold: side('cold'),
        warm: side('warm'),
        compare: compareExt
          ? { cold: count(loads.compare!.cold), warm: count(loads.compare!.warm) }
          : undefined,
      };
    };
    const often = await measureOften('first');
    const flagged = moreOften(often.cold) || moreOften(often.warm);
    // A difference beyond chance counts only when a second measure from scratch shows it too.
    const oftenAgain = flagged ? await measureOften('again') : null;
    const oftenVerdict = {
      cold: judgeOften(often.cold, oftenAgain?.cold ?? null),
      warm: judgeOften(often.warm, oftenAgain?.warm ?? null),
    };
    (report.stress as Record<string, unknown>).often = {
      loads: nOften,
      alpha: OFTEN_ALPHA,
      cold: often.cold,
      warm: often.warm,
      compare: often.compare,
      p: {
        cold: {
          plain: moreOftenP(often.cold.ext, often.cold.plain),
          control: moreOftenP(often.cold.ext, often.cold.control),
        },
        warm: {
          plain: moreOftenP(often.warm.ext, often.warm.plain),
          control: moreOftenP(often.warm.ext, often.warm.control),
        },
      },
      again: oftenAgain ? { cold: oftenAgain.cold, warm: oftenAgain.warm } : null,
      verdict: oftenVerdict,
      runs: often.loads,
    };
    // The few traced loads report a long task seen only with the extension; how often decides it.
    const sv = (report.stress as { verdict: { pass: boolean } }).verdict;
    sv.pass =
      v.caused.length === 0 &&
      v.overFrame.length === 0 &&
      oftenVerdict.cold !== 'fail' &&
      oftenVerdict.warm !== 'fail';
    for (const k of ['cold', 'warm'] as const) {
      const o = often[k];
      const line = `stress: loads with a task over ${LIMITS.longMs} ms, ${k}: ${o.ext.long} of ${o.ext.loads} with the extension, ${o.plain.long} of ${o.plain.loads} for the page alone, ${o.control.long} of ${o.control.loads} with the control extension`;
      if (oftenVerdict[k] === 'fail')
        fails.push(
          `${line}: more often beyond chance, and again when measured a second time (${oftenAgain![k].ext.long}, ${oftenAgain![k].plain.long}, ${oftenAgain![k].control.long} of ${nOften})`,
        );
      else if (oftenVerdict[k] === 'not repeated')
        notes.push(`${line}: more often beyond chance once, not when measured a second time`);
    }
    if (stressScroll.inkEvents > 0)
      fails.push(`stress: ${stressScroll.inkEvents} ink script events during scroll`);
    console.log(
      `stress: ${pr.count} notes, longest task with ink script ${worst} ms; longest page task cold ${Math.max(...coldInk.map((s) => s.longestTask))} / ${Math.max(...coldPlain.map((s) => s.longestTask))} ms, warm ${Math.max(...warmInk.map((s) => s.longestTask))} / ${Math.max(...warmPlain.map((s) => s.longestTask))} ms with / without the extension; ink part at most ${v.maxInkMs} ms; long tasks caused by ink ${v.caused.length}`,
    );
  }

  // -------------------------------------------------------------------------
  // Pen-down to first pixel, on a page with no ink
  // -------------------------------------------------------------------------
  // A harness failure in this last part is recorded, and the parts already measured are still written.
  let harnessError = '';
  if (!values['skip-pen'] && benchBuild)
    try {
      const target = all.find((p) => p.id === (def.pen ?? 'lesson'));
      if (!target) throw new Error(`pen page ${def.pen} is not in pages.json`);
      const tg = targetOf(target);
      const n = quick ? 3 : 10;
      const dir = join(CACHE, 'profile-pen');
      /** A pen stroke through CDP: a ring of 30 points, 8 ms apart, as a 120 Hz pen reports them. */
      const penStroke = async (cdp: CDPSession, cx: number, cy: number) => {
        const base = { button: 'left', clickCount: 1, pointerType: 'pen', force: 0.5 };
        const pts = Array.from({ length: 31 }, (_, i) => {
          const a = (i / 30) * Math.PI * 2;
          return { x: cx + Math.cos(a) * 60, y: cy + Math.sin(a) * 20 };
        });
        const send = (type: string, p: { x: number; y: number }, buttons: number) =>
          cdp.send('Input.dispatchMouseEvent', { ...base, type, x: p.x, y: p.y, buttons } as never);
        await send('mouseMoved', pts[0]!, 0);
        await send('mousePressed', pts[0]!, 1);
        for (const p of pts.slice(1)) {
          await send('mouseMoved', p, 1);
          await new Promise((r) => setTimeout(r, 8));
        }
        await send('mouseReleased', pts.at(-1)!, 0);
      };
      /** Durations of the bench build's pen-down to first pixel measure, once `count` exist. */
      const firstPixels = async (page: Page, count: number): Promise<number[]> => {
        for (let i = 0; i < 100; i++) {
          const xs = (await page.evaluate(
            `performance.getEntriesByName('ink:pen-first-pixel').map((e) => e.duration)`,
          )) as number[];
          if (xs.length >= count) return xs;
          await page.waitForTimeout(50);
        }
        throw new Error(`no pen-down to first pixel measure for stroke ${count}`);
      };
      const injectMs = async (page: Page): Promise<number | null> =>
        (await page.evaluate(
          `(performance.getEntriesByName('ink:inject')[0] || { duration: null }).duration`,
        )) as number | null;
      const workersRunning = async (cdp: CDPSession, id: string): Promise<number> => {
        const { targetInfos } = (await cdp.send('Target.getTargets')) as {
          targetInfos: { type: string; url: string }[];
        };
        return targetInfos.filter((t) => t.type === 'service_worker' && t.url.includes(id)).length;
      };
      const open = async (ctx: BrowserContext) => {
        const page = await ctx.newPage();
        await route(page, tg, base);
        await page.goto(tg.url, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(settle);
        return { page, cdp: await ctx.newCDPSession(page) };
      };
      const cold: number[] = [];
      const warm: number[] = [];
      const later: number[] = [];
      const inject = { cold: [] as number[], warm: [] as number[] };
      for (let i = 0; i <= n; i++) {
        // Cold: a fresh browser and profile, the page loaded, then the extension's background
        // stopped, so the first pen-down has to wake it before the tools can be injected.
        const ctx = await launch(dir, [ext], !!values.headed);
        const id = ownerOf((await workerOf(ctx)).url()).id!;
        const a = await open(ctx);
        await a.cdp.send('ServiceWorker.enable');
        await a.cdp.send('ServiceWorker.stopAllWorkers');
        for (let k = 0; k < 100 && (await workersRunning(a.cdp, id)) > 0; k++)
          await a.page.waitForTimeout(20);
        if ((await workersRunning(a.cdp, id)) > 0) throw new Error('the background did not stop');
        await penStroke(a.cdp, 420, 300);
        await firstPixels(a.page, 1);
        // The pen-down had to start the background again.
        if (!(await workersRunning(a.cdp, id)))
          throw new Error('the first pen stroke did not wake the background');
        // Later strokes on the same page: the tools are in.
        await a.page.waitForTimeout(400);
        await penStroke(a.cdp, 420, 420);
        await a.page.waitForTimeout(400);
        await penStroke(a.cdp, 420, 540);
        const c = await firstPixels(a.page, 3);
        const ci = await injectMs(a.page);
        await a.page.close();
        // Warm: the same browser, its background running, a new load of the page with no ink.
        await clearStorage(await workerOf(ctx));
        const b = await open(ctx);
        const running = await workersRunning(b.cdp, id);
        await penStroke(b.cdp, 420, 300);
        const w = await firstPixels(b.page, 1);
        const wi = await injectMs(b.page);
        await ctx.close();
        if (i === 0) continue; // The first of each arm is discarded.
        if (!running) notes.push('pen: the background had stopped before a warm stroke');
        cold.push(r1(c[0]!));
        later.push(...c.slice(1).map(r1));
        warm.push(r1(w[0]!));
        if (ci !== null) inject.cold.push(r1(ci));
        if (wi !== null) inject.warm.push(r1(wi));
        console.log(
          `pen ${i} of ${n}: first stroke ${r1(c[0]!)} ms cold, ${r1(w[0]!)} ms warm; later ${c.slice(1).map(r1).join(', ')} ms`,
        );
      }
      rmSync(dir, { recursive: true, force: true });
      const side = (xs: number[]) => ({
        median: r1(median(xs)),
        iqr: r1(quantile(xs, 0.75) - quantile(xs, 0.25)),
        max: r1(maxOf(xs)),
        n: xs.length,
        runs: xs,
      });
      report.pen = {
        page: target.url,
        mode: modeOf(target).mode,
        cold: side(cold),
        warm: side(warm),
        later: side(later),
        injectCold: side(inject.cold),
        injectWarm: side(inject.warm),
      };
      console.log(
        `pen: first stroke ${r1(median(cold))} ms cold, ${r1(median(warm))} ms warm, later strokes ${r1(median(later))} ms (medians)`,
      );
    } catch (e) {
      harnessError = `pen: ${String(e).split('\n')[0]}`;
      notes.push(`harness error, ${harnessError}`);
    }

  server.close();
  (report.meta as Record<string, unknown>).seconds = Math.round((Date.now() - t0) / 1000);
  if (quick)
    report.gate = {
      machine: here,
      reference,
      fit: fit.fit,
      scale: fit.scale,
      ratio: fit.ratio,
      reason: fit.reason,
      judged,
      notJudged: judged.filter((j) => j.verdict === 'not judged').length,
    };
  report.pass = fails.length === 0;
  report.fails = fails;
  report.notes = notes;
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(`${values.out}.json`, `${JSON.stringify(report, null, 1)}\n`);
  writeFileSync(`${values.out}.md`, markdown(report));
  console.log(
    `\n${fails.length ? `FAIL (${fails.length})` : 'PASS'}  wrote ${values.out}.json and ${values.out}.md`,
  );
  for (const f of fails) console.log(`  ${f}`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (harnessError) {
    console.error(harnessError);
    return 2;
  }
  return values.gate && fails.length ? 1 : 0;
}

interface OftenReport {
  loads: number;
  cold: Often;
  warm: Often;
  compare?: { cold: Count; warm: Count };
  p: Record<'cold' | 'warm', { plain: number; control: number }>;
  again: { cold: Often; warm: Often } | null;
  verdict: Record<'cold' | 'warm', string>;
}

/** The stress page's long tasks counted over many loads per arm (src/judge.ts judgeOften). */
function oftenLines(o: OftenReport | undefined): string[] {
  if (!o) return [];
  const p = (x: number) => (x < 0.001 ? '<0.001' : x.toFixed(3));
  return [
    `How often a load had a task over ${LIMITS.longMs} ms, ${o.loads} loads per arm traced with tasks only, interleaved. The page runs its first update as one long task in some loads and as two shorter ones in others, so the rule asks whether loads with the extension have a long task more often than loads with a do-nothing extension, beyond chance (one-sided Fisher test, under 0.05), in a first measure and again in a second one. The page alone is counted beside them.`,
    '',
    '| arm | with the extension | page alone | control extension | chance, against alone / control | verdict |',
    '| --- | ---: | ---: | ---: | --- | --- |',
    ...(['cold', 'warm'] as const).map(
      (k) =>
        `| ${k} | ${o[k].ext.long} of ${o[k].ext.loads} | ${o[k].plain.long} of ${o[k].plain.loads} | ${o[k].control.long} of ${o[k].control.loads} | ${p(o.p[k].plain)} / ${p(o.p[k].control)} | ${o.verdict[k]} |`,
    ),
    ...(o.compare
      ? [
          '',
          `Another build, for comparison: cold ${o.compare.cold.long} of ${o.compare.cold.loads}, warm ${o.compare.warm.long} of ${o.compare.warm.loads}.`,
        ]
      : []),
    '',
  ];
}

function markdown(r: Record<string, unknown>): string {
  const meta = r.meta as Record<string, unknown> & { machine: Record<string, unknown> };
  const m = meta.machine;
  const out = [
    '# Bench results',
    '',
    `Extension: \`${meta.ext}\` (${meta.extName} ${meta.extVersion}, files ${meta.extDigest}). Browser: ${meta.browser ?? 'n/a'}, headless. Machine: ${m.cpu}, ${m.cores} cores, ${m.memoryGb} GB, ${m.os}.`,
    '',
    `${meta.loads} loads per arm on replayed and local pages, ${meta.liveLoads} on live pages, after one discarded load per arm. Settle ${meta.settle} ms. Started ${meta.started}, took ${meta.seconds} s${meta.quick ? ', quick mode' : ''}.`,
    '',
    `**${r.pass ? 'PASS' : 'FAIL'}**${(r.fails as string[]).length ? `: ${(r.fails as string[]).join('; ')}` : ''}`,
    '',
  ];
  const g = r.gate as
    | {
        machine: { calibrateMs: number; cores: number };
        reference: { calibrateMs: number; cores: number; cpu?: string } | null;
        fit: boolean;
        scale: number;
        ratio: number | null;
        reason: string;
        judged: Judged[];
        notJudged: number;
      }
    | undefined;
  if (g) {
    out.push(
      '## Quick gate: the machine and the fixed limits',
      '',
      `This machine ran the calibration work in ${g.machine.calibrateMs} ms with ${g.machine.cores} cores. The reference machine of the published results: ${g.reference ? `${g.reference.calibrateMs} ms, ${g.reference.cores} cores${g.reference.cpu ? `, ${g.reference.cpu}` : ''}` : 'no measurement stored'}. ${g.fit ? `Fit to judge fixed limits: each is judged at ${g.scale} times its published value (measured ratio ${g.ratio}).` : `Not fit to judge fixed limits (${g.reason}). The rules below are measured and shown, and not judged: this run says nothing about the published budgets.`} Rules that do not depend on the machine's speed are judged in every run.`,
      '',
      '| rule | measured, ms | published limit, ms | judged limit, ms | at the published limit | verdict |',
      '| --- | ---: | ---: | ---: | --- | --- |',
      ...g.judged.map(
        (j) =>
          `| ${j.rule} | ${j.value} | ${j.limit} | ${j.verdict === 'not judged' ? 'n/a' : j.judgedLimit} | ${j.raw} | ${j.verdict} |`,
      ),
      '',
    );
  }
  const ov = r.overhead as Record<string, Record<string, unknown>> | undefined;
  if (ov) {
    const c = (x: Compare) =>
      `${x.without.median} / ${x.with.median} (${x.delta >= 0 ? '+' : ''}${x.delta}, noise ${x.noise})${x.beyondNoise ? ' *' : ''}`;
    out.push(
      '## Overhead on pages with no ink',
      '',
      'Medians in ms, without / with the extension (difference, noise as the larger interquartile range of the two arms). A star marks a difference larger than the noise and than one frame (16.7 ms). A slower star is measured again; it counts only when it repeats. "Extension ms" is time in the extension on the page\'s own main thread from traced loads: injecting the stub (world setup included) and every task that ran its code. The budget applies to it. "All frames" adds the main threads of frames from other sites, which run in their own processes beside the page, and how many such frames got the stub.',
      '',
      '| page | type | mode | FCP | LCP | stub ms | extension ms, page thread | all frames, other processes | failed loads |',
      '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
    );
    for (const [id, row] of Object.entries(ov)) {
      const f = row.failed as { with: number; without: number };
      const stub = row.stubMs as { median: number };
      const ext = row.extMs as { median: number; max: number; allFrames: number; otherFrames: number };
      out.push(
        `| ${id} | ${row.type} | ${row.mode} | ${c(row.fcp as Compare)} | ${c(row.lcp as Compare)} | ${Number.isFinite(stub.median) ? stub.median.toFixed(2) : 'n/a'} | ${Number.isFinite(ext.median) ? `${ext.median.toFixed(2)} (max ${ext.max.toFixed(2)})` : 'n/a'} | ${ext.allFrames.toFixed(2)}, ${ext.otherFrames} | ${f.with + f.without} |`,
      );
    }
    const ex = r.explain as Record<string, Record<string, Explained[]>> | undefined;
    if (ex)
      out.push(
        '',
        '## Where the time went before the first paint',
        '',
        `Each page that painted later with PageInk than with the control extension, loaded ${EXPLAIN_LOADS} more times per arm with a trace of the whole browser (the raw traces, gzip, sit beside this report while they stay under ${EXPLAIN_MAX_BYTES / 2 ** 20} MB). Medians in ms, from navigation start up to the first contentful paint: time each thread spent running tasks, frames the page produced before it, and when the first extension call left the page. This explains a verdict and changes none.`,
        '',
        ...explainRows(ex),
      );
    out.push('', 'Live pages and why:', '');
    for (const [id, row] of Object.entries(ov))
      if (row.mode === 'live') out.push(`- ${id}: ${row.modeReason}`);
    out.push('');
  }
  const ptr = r.pointer as Record<string, Record<string, unknown>> | undefined;
  if (ptr && Object.keys(ptr).length) {
    out.push(
      '## Pointer listeners',
      '',
      'The stub listens for pointerdown, pointermove, pointerup, pointercancel and click on window in the capture phase. Each run moves the mouse 400 times and scrolls 20 times on a page with no ink. "Extension ms" is main-thread time in the extension\'s scripts over the whole activity, from a trace (median of 3 runs; tracing itself makes each call slower, so this is an upper bound). "Script ms" is all script time on the page over the same activity without tracing, without / with the extension (medians, difference, noise).',
      '',
      '| page | mode | pointer events | extension ms (traced) | µs per event | script ms, without / with |',
      '| --- | --- | ---: | ---: | ---: | --- |',
    );
    for (const [id, row] of Object.entries(ptr)) {
      const c = row.scriptMs as Compare;
      out.push(
        `| ${id} | ${row.mode} | ${row.pointerEvents} | ${row.extMs} | ${row.usPerEvent} | ${c.without.median} / ${c.with.median} (${c.delta >= 0 ? '+' : ''}${c.delta}, noise ${c.noise}) |`,
      );
    }
    out.push('');
  }
  const lat = r.latency as Record<string, Record<string, unknown>> | undefined;
  if (lat) {
    out.push(
      '## Ink visible and scroll',
      '',
      'Per load, the worst lag over notes whose anchor is in the first screen: when the note\'s ink was inserted into the layer, minus when its anchor element was inserted into the page (DESIGN 11). Medians over loads in ms (max in brackets). "After first paint" counts from the content\'s first paint, which the page reports through element timing (else the later of the insert and the first contentful paint, which is no later than the real paint); below zero, the ink was in the page before that paint, so both appear in the same frame. It must be within one frame (16.7 ms) in every case. "Seen" is what a reader sees: 0 when the ink was in the same frame as its content\'s first paint, else how much later. The first measure must be within 50 ms when the page painted that content soon enough to allow it ("content waits" is how long the page itself took to first paint the content after inserting it). "Next frame" is the same lag to the start of the first frame after the insert. Cold is a returning reader: a new browser on a profile where the viewer\'s registration for the host is already stored. Warm is the same browser after one discarded load. The timeline is the warm median, ms from navigation: last anchor inserted, first contentful paint, stub start, viewer start (after the storage read), the product\'s ink:first-ink mark.',
      '',
      '| page | notes | cold | warm | cold, after first paint | warm, after first paint | seen, cold / warm | same frame, loads | content waits, cold / warm | warm, next frame | first screen drawn | warm timeline | ink script events during scroll |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
    );
    for (const [id, row] of Object.entries(lat)) {
      type Side = {
        median: number;
        max: number;
        frameMedian: number;
        paintMedian: number;
        paintMax: number;
        contentPaintMedian: number;
        seenMedian: number;
        sameFrameLoads: number;
        loads: number;
        timeline: Record<string, number>;
        allMedian: number;
        runs: { near: number; nearDrawn: number }[];
      };
      const cold = row.cold as Side;
      const warm = row.warm as Side;
      const sc = row.scroll as { inkEvents: number } | undefined;
      const w0 = warm.runs[0];
      const tl = warm.timeline;
      const lag = (x: Side) =>
        Number.isFinite(x.median)
          ? `${x.median} (${x.max})`
          : `none in first screen; all notes ${x.allMedian}`;
      out.push(
        `| ${id} | ${row.notes} | ${lag(cold)} | ${lag(warm)} | ${cold.paintMedian} (${cold.paintMax}) | ${warm.paintMedian} (${warm.paintMax}) | ${cold.seenMedian} / ${warm.seenMedian} | ${cold.sameFrameLoads + warm.sameFrameLoads} of ${cold.loads + warm.loads} | ${cold.contentPaintMedian} / ${warm.contentPaintMedian} | ${warm.frameMedian} | ${w0 ? `${w0.nearDrawn} of ${w0.near}` : 'n/a'} | ${tl.lastAnchor}, ${tl.fcp}, ${tl.stubStart}, ${tl.viewStart}, ${tl.firstInk} | ${sc ? sc.inkEvents : 'see stress'} |`,
      );
    }
    out.push('');
    const held = Object.entries(lat).filter(([, row]) => row.heldBack);
    if (held.length) {
      const groups = (a: HeldBack['with']) =>
        a.groups.length > 1 ? a.groups.map((g) => `${g.n} at ${g.median}`).join(', ') : `${a.n} loads`;
      out.push(
        '## First paint of content under ink',
        '',
        `How long the extension held back the first paint of the content that has ink on it. Loads with the extension (no probe) and with no extension at all, interleaved, cold and warm as above. Per load: when the last first-screen anchor that element timing reports was first painted, ms from navigation; the same anchors in both arms. "Held back" is the median of the differences within pairs of loads taken back to back, one per arm, with the interquartile range of those differences as noise; this takes out drift of the machine over the run. An arm whose loads fall into groups more than a frame apart, each with at least a third of the loads and three, is compared group by group and the largest difference counts (src/judge.ts); every group is listed. "Insert to paint" is the longest wait of one of those anchors from its insert to its first paint, without / with the extension. Budget on the seeded pages: at most ${BUDGET.heldBackMs} ms (one frame). The stress page is reported.`,
        '',
        '| page | arm | without, ms (groups) | with, ms (groups) | held back, ms | noise, ms | compared | insert to paint, without / with | anchors timed |',
        '| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |',
      );
      for (const [id, row] of held) {
        const hb = row.heldBack as Record<
          'cold' | 'warm',
          HeldBack & { wait: HeldBack; timed: number; near: number; again?: HeldBack }
        >;
        for (const k of ['cold', 'warm'] as const) {
          const h = hb[k];
          out.push(
            `| ${id} | ${k} | ${h.alone.median} (${groups(h.alone)}) | ${h.with.median} (${groups(h.with)}) | ${h.delta}${h.again ? `, measured again ${h.again.delta}` : ''} | ${h.noise} | ${h.basis} | ${h.wait.alone.median} / ${h.wait.with.median} | ${h.timed} of ${h.near} |`,
          );
        }
      }
      out.push('');
    }
  }
  const st = r.stress as Record<string, unknown> | undefined;
  if (st) {
    const sc = st.scroll as { inkEvents: number };
    const v = st.verdict as { caused: unknown[]; maxInkMs: number; onlyWithInk: unknown[]; pass: boolean };
    out.push(
      '## Stress',
      '',
      `${st.notes} notes on \`${st.page}\`, ${st.loads} traced loads per arm: cold (a new browser on a stored profile) and warm (one browser, after one discarded load), each with and without the extension. A task counts against the budget when it is over ${BUDGET.inkLongTaskMs} ms and would have been within it without its ink part (time inside ink calls, layout they forced included), or when the ink part alone is over ${BUDGET.inkLongTaskMs} ms. The ink part of any one task must also be at most one frame (${BUDGET.inkTaskFrameMs} ms). A long task that ran ink script, in an arm where the page without the extension never had a long task, counts too.`,
      '',
      `Long tasks caused by ink: ${v.caused.length}. Largest ink part of one task: ${v.maxInkMs} ms. Long tasks seen only with the extension in the traced loads: ${v.onlyWithInk.length}. Verdict: ${v.pass ? 'pass' : 'fail'}.`,
      '',
      ...oftenLines(st.often as OftenReport | undefined),
      '| arm | longest task, with / without the extension | tasks over 50 ms, with / without | longest task that ran ink script (its ink part) |',
      '| --- | --- | --- | --- |',
      ...(['cold', 'warm'] as const).map((k) => {
        const a = st[k] as {
          runs: {
            longestTask: number;
            longTasks: number[];
            longestInkTask: number;
            longestInkTaskInk: number;
          }[];
          plain: number[];
          plainLongTasks: number;
        };
        const top = a.runs.reduce((m, x) => (x.longestInkTask > m.longestInkTask ? x : m), a.runs[0]!);
        return `| ${k} | ${a.runs.map((x) => x.longestTask).join(', ')} / ${a.plain.join(', ')} ms | ${a.runs.reduce((n, x) => n + x.longTasks.length, 0)} / ${a.plainLongTasks} | ${top.longestInkTask} ms (${top.longestInkTaskInk} ms) |`;
      }),
      '',
      `Longest main-thread task that ran ink script, over all loads: ${st.longestInkTask} ms, of which ${st.longestInkTaskInk ?? 'n/a'} ms was inside ink calls and the rest the page's own work. Tasks over 50 ms with ink script: ${st.inkLongTasks}. Ink script events during a scroll of the page: ${sc.inkEvents}.`,
      '',
    );
  }
  const pen = r.pen as Record<string, { median: number; iqr: number; max: number; n: number }> | undefined;
  if (pen) {
    const row = (name: string, x: { median: number; iqr: number; max: number; n: number }) =>
      `| ${name} | ${x.median} | ${x.iqr} | ${x.max} | ${x.n} |`;
    out.push(
      '## Pen-down to first pixel',
      '',
      `A pen stroke on \`${(r.pen as { page: string }).page}\`, a page with no ink. Time from the pen-down event to the call that paints the stroke's first pixel (the bench build's ink:pen-first-pixel measure); the pixel reaches the screen with the next frame. Cold: a fresh browser, the extension's background stopped, so the first pen-down wakes it, which then injects the viewer and the tools. Warm: the same browser, background running, a new load of the page. Later: the second and third strokes on the cold page. Medians in ms, interquartile range, max, loads; the first of each arm is discarded.`,
      '',
      '| stroke | median | IQR | max | n |',
      '| --- | ---: | ---: | ---: | ---: |',
      row('first, cold background', pen.cold!),
      row('first, warm background', pen.warm!),
      row('later strokes', pen.later!),
      row('injecting viewer and tools, cold', pen.injectCold!),
      row('injecting viewer and tools, warm', pen.injectWarm!),
      '',
    );
  }
  const nt = r.notes as string[];
  if (nt?.length) out.push('## Notes', '', ...nt.map((n) => `- ${n}`), '');
  return out.join('\n');
}

// A page that navigates on its own (a silent sign-in redirect, for one) can reject inside Playwright
// after the load is over. That says nothing about the extension, so it is logged, not fatal.
process.on('unhandledRejection', (e) =>
  console.log(`ignored: ${(String(e).split('\n')[0] ?? '').slice(0, 160)}`),
);

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
