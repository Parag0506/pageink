// Scores an anchor module on the test set.
//
//   corepack pnpm --filter pageink-testset run score [--anchor baseline|core|<path>] [--only id,id]
//     [--kind wikipedia,docs] [--widths 390,820,1280] [--no-layout] [--notes 20] [--quick] [--gate]
//     [--split all|tuning|heldout]
//
// Notes are written on version A at the base condition, then resolved on version B.
// Writes results/latest.json and results/latest.md. Exit 0 when the run completes,
// 1 with --gate when a target is missed, 2 when the harness itself fails.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import type { NoteResult, Written } from '../page/harness.ts';
import { anchorEntry, bundleHarness, REPO } from './bundle.ts';
import { placeholderSvg } from './freeze.ts';
import { buildReport, type Run } from './report.ts';
import {
  CACHE_FIXTURES,
  type Condition,
  FIXTURES,
  hasFixture,
  loadSources,
  type Pair,
  pairDir,
  RESULTS,
  splitOf,
  versionFile,
} from './sources.ts';

const HOSTS: Record<string, string> = {
  'fixtures.ink.test': FIXTURES,
  'cache.ink.test': CACHE_FIXTURES,
};

const DARK_CSS = `html, body { background: #121212 !important; color: #ddd !important; }
body *:not(img):not(svg):not(video) { background-color: transparent !important; color: #ddd !important; border-color: #444 !important; }
a, a * { color: #8ab4f8 !important; }`;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function urlFor(p: Pair, v: 'a' | 'b'): string {
  const file = versionFile(p, v);
  if (file.startsWith(FIXTURES)) return `http://fixtures.ink.test/${file.slice(FIXTURES.length + 1)}`;
  return `http://cache.ink.test/${file.slice(CACHE_FIXTURES.length + 1)}`;
}

/** Serves fixtures from disk and blocks every other request, so a run is offline and repeatable. */
async function serveOffline(ctx: BrowserContext, blocked: { n: number }): Promise<void> {
  await ctx.route('**/*', async (route) => {
    const href = route.request().url();
    const u = new URL(href);
    const root = HOSTS[u.hostname];
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    const size = IMAGES.get(href);
    if (size) {
      return route.fulfill({
        status: 200,
        body: placeholderSvg(href, size[0], size[1]),
        headers: { 'content-type': 'image/svg+xml' },
      });
    }
    if (!root) {
      blocked.n++;
      return route.abort('blockedbyclient');
    }
    const file = normalize(join(root, decodeURIComponent(u.pathname)));
    if (!file.startsWith(root) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({
      status: 200,
      body: readFileSync(file),
      headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' },
    });
  });
}

/** Image address to recorded size, from every fixture's images.json. */
const IMAGES = new Map<string, [number, number]>();

export function loadImages(pairs: Pair[]): void {
  for (const p of pairs) {
    const f = join(pairDir(p), 'images.json');
    if (!existsSync(f)) continue;
    for (const [k, v] of Object.entries(
      JSON.parse(readFileSync(f, 'utf8')) as Record<string, [number, number]>,
    ))
      IMAGES.set(k, v);
  }
}

export class Contexts {
  private byZoom = new Map<number, BrowserContext>();
  constructor(
    private browser: Browser,
    private blocked: { n: number },
  ) {}
  async page(c: Condition): Promise<Page> {
    const zoom = c.zoom ?? 1;
    let ctx = this.byZoom.get(zoom);
    if (!ctx) {
      ctx = await this.browser.newContext({
        deviceScaleFactor: zoom,
        locale: 'en-US',
        reducedMotion: 'reduce',
      });
      await serveOffline(ctx, this.blocked);
      this.byZoom.set(zoom, ctx);
    }
    const page = await ctx.newPage();
    await page.setViewportSize({ width: Math.round(c.w / zoom), height: Math.round((c.h ?? 900) / zoom) });
    await page.emulateMedia({ colorScheme: c.scheme ?? 'light' });
    return page;
  }
  async close(): Promise<void> {
    for (const c of this.byZoom.values()) await c.close();
  }
}

export async function open(
  pages: Contexts,
  url: string,
  c: Condition,
  bundle: string,
  settle: 'load' | 'early',
): Promise<Page> {
  const page = await pages.page(c);
  await page.goto(url, { waitUntil: settle === 'early' ? 'domcontentloaded' : 'load', timeout: 60000 });
  if (settle === 'load') await page.evaluate('document.fonts.ready.then(() => true)');
  if (c.darkCss) await page.addStyleTag({ content: DARK_CSS });
  await page.evaluate(bundle);
  return page;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      anchor: { type: 'string', default: 'baseline' },
      only: { type: 'string' },
      kind: { type: 'string' },
      widths: { type: 'string' },
      'no-layout': { type: 'boolean', default: false },
      notes: { type: 'string', default: '20' },
      quick: { type: 'boolean', default: false },
      gate: { type: 'boolean', default: false },
      out: { type: 'string', default: join(RESULTS, 'latest') },
      headed: { type: 'boolean', default: false },
      split: { type: 'string', default: 'all' },
    },
  });
  // Paths given on the command line are relative to where the command was typed.
  values.out = resolve(process.env.INIT_CWD ?? process.cwd(), values.out!);
  const src = loadSources();
  const base = src.conditions[src.base]!;
  const entry = anchorEntry(values.anchor!);
  const bundle = await bundleHarness(entry);
  const count = Number(values.notes);

  let pairs = src.pairs;
  if (values.only) {
    const ids = new Set(values.only.split(','));
    pairs = pairs.filter((p) => ids.has(p.id));
  }
  if (values.kind) {
    const ks = new Set(values.kind.split(','));
    pairs = pairs.filter((p) => ks.has(p.kind));
  }
  if (values.split !== 'all') pairs = pairs.filter((p) => splitOf(p) === values.split);
  const quickIds = new Set(['wiki-photosynthesis-month', 'py-controlflow-312-313', 'mdn-css-flex-basis']);
  if (values.quick)
    pairs = pairs.filter((p) => p.kind === 'synthetic' || p.kind === 'dynamic' || quickIds.has(p.id));
  const missing = pairs.filter((p) => !hasFixture(p)).map((p) => p.id);
  pairs = pairs.filter((p) => hasFixture(p));
  loadImages(pairs);

  // Content pairs at each requested width. Layout sets reuse version A under other conditions.
  const widths = values.widths ? values.widths.split(',').map(Number) : [base.w];
  type Job = { pair: Pair; cond: string; c: Condition; layout: boolean };
  const jobs: Job[] = [];
  for (const p of pairs) {
    for (const w of widths) {
      const name = w === base.w ? src.base : `w${w}`;
      jobs.push({ pair: p, cond: name, c: src.conditions[name] ?? { ...base, w }, layout: false });
    }
  }
  if (!values['no-layout']) {
    for (const l of src.layouts) {
      const p = pairs.find((x) => x.id === l.fixture);
      if (!p) continue;
      const conds = values.quick ? l.conditions.slice(0, 2) : l.conditions;
      for (const cn of conds) jobs.push({ pair: p, cond: cn, c: src.conditions[cn]!, layout: true });
    }
  }

  const blocked = { n: 0 };
  const browser = await chromium.launch({ headless: !values.headed });
  const pages = new Contexts(browser, blocked);
  const written = new Map<string, Written[]>();
  const runs: Run[] = [];
  const t0 = Date.now();
  let crashed = false;
  for (const job of jobs) {
    const { pair: p } = job;
    try {
      let notes = written.get(p.id);
      if (!notes) {
        const pa = await open(pages, urlFor(p, 'a'), base, bundle, 'load');
        notes = (await pa.evaluate(`window.__inkTest.write(${JSON.stringify(p.id)}, ${count})`)) as Written[];
        await pa.close();
        written.set(p.id, notes);
      }
      const bUrl = job.layout ? urlFor(p, 'a') : urlFor(p, 'b');
      const phases: ('early' | 'settled' | 'load')[] =
        p.kind === 'dynamic' && !job.layout ? ['early', 'settled'] : ['load'];
      const pb = await open(pages, bUrl, job.c, bundle, phases[0] === 'early' ? 'early' : 'load');
      for (const phase of phases) {
        if (phase === 'settled') {
          await pb.evaluate(
            'window.__inkSettle ? window.__inkSettle() : new Promise((r) => { const t = Date.now(); (function w() { if (window.__inkSettled || Date.now() - t > 10000) r(); else setTimeout(w, 50); })(); })',
          );
          await pb.evaluate('document.fonts.ready.then(() => true)');
        }
        const out = (await pb.evaluate(
          `window.__inkTest.score(${JSON.stringify(notes)}, ${phase === 'settled'})`,
        )) as { results: NoteResult[]; firstMs: number; totalMs: number };
        runs.push({
          pair: p.id,
          kind: job.layout ? 'layout' : p.kind,
          change: job.layout ? `layout-${job.cond}` : p.change,
          shape: p.shape,
          cond: job.cond,
          split: splitOf(p),
          phase,
          firstMs: out.firstMs,
          totalMs: out.totalMs,
          results: out.results,
          written: notes.length,
          describeOff: notes.filter((n) => n.aDist !== undefined && n.aDist > 8).length,
        });
      }
      await pb.close();
      const last = runs[runs.length - 1]!;
      const c = (o: string) => last.results.filter((r) => r.outcome === o).length;
      console.log(
        `${p.id.padEnd(46)} ${job.cond.padEnd(10)} notes ${String(last.results.length).padStart(2)}  right ${String(c('right')).padStart(2)}  tray ${String(c('tray-gone') + c('tray-edited')).padStart(2)}  miss ${String(c('miss')).padStart(2)}  wrong ${String(c('wrong')).padStart(2)}  hidden ${String(c('hidden')).padStart(2)}`,
      );
    } catch (e) {
      crashed = true;
      console.log(`ERROR ${p.id} ${job.cond}: ${String(e).split('\n')[0]}`);
      runs.push({
        pair: p.id,
        kind: p.kind,
        change: p.change,
        shape: p.shape,
        cond: job.cond,
        split: splitOf(p),
        phase: 'load',
        firstMs: 0,
        totalMs: 0,
        results: [],
        written: 0,
        describeOff: 0,
        error: String(e).split('\n')[0],
      });
    }
  }
  await pages.close();
  await browser.close();

  const report = buildReport(runs, {
    anchor: entry.startsWith(REPO) ? entry.slice(REPO.length + 1) : entry,
    started: new Date(t0).toISOString(),
    seconds: Math.round((Date.now() - t0) / 1000),
    missing,
    blockedRequests: blocked.n,
    quick: !!values.quick,
  });
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(`${values.out}.json`, `${JSON.stringify(report.json, null, 1)}\n`);
  writeFileSync(`${values.out}.md`, report.md);
  console.log(`\n${report.headline}`);
  console.log(`wrote ${values.out}.json and ${values.out}.md`);
  if (crashed && runs.every((r) => r.error)) return 2;
  return values.gate && !report.pass ? 1 : 0;
}

if (process.argv[1]?.endsWith('score.ts')) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(2);
    },
  );
}
