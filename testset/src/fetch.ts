// Downloads every pair in sources.json and freezes it into a replayable fixture.
// Pairs whose licence allows it go to fixtures/ (committed). The rest go to cache/ (git-ignored).
//
//   corepack pnpm --filter pageink-testset run fetch [--only id,id] [--kind wikipedia] [--refresh] [--quick]
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { freezeUrl, sha } from './freeze.ts';
import { loadSources, type Pair, pairDir, versionFile } from './sources.ts';
import { writeSourcesMd } from './sources-md.ts';
import { writeSynthetic } from './synthetic.ts';

export interface PairMeta {
  id: string;
  /** `file` is set when the version is stored once in another pair's folder. */
  a: { url: string; sha256: string; bytes: number; file?: string };
  b: { url: string; sha256: string; bytes: number; file?: string };
  css: string[];
  frozenAt: string;
}

/** True when the stored checksum matches the files on disk. */
export function verifyPair(p: Pair): boolean | null {
  const metaFile = join(pairDir(p), 'meta.json');
  if (!existsSync(metaFile)) return null;
  const m = JSON.parse(readFileSync(metaFile, 'utf8')) as PairMeta;
  return (['a', 'b'] as const).every((v) => sha(readFileSync(versionFile(p, v), 'utf8')) === m[v].sha256);
}

/**
 * Pairs that share an address get one frozen copy, so the repo stores it once: the first pair
 * keeps the file and the others point at it from their meta.json.
 */
function dedupe(pairs: Pair[]): void {
  const first = new Map<string, { file: string; sha256: string; bytes: number; commit: boolean }>();
  for (const p of pairs) {
    const dir = pairDir(p);
    const mf = join(dir, 'meta.json');
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, 'utf8')) as PairMeta;
    let changed = false;
    for (const v of ['a', 'b'] as const) {
      const f = first.get(m[v].url);
      if (!f) {
        first.set(m[v].url, {
          file: versionFile(p, v),
          sha256: m[v].sha256,
          bytes: m[v].bytes,
          commit: p.commit,
        });
        continue;
      }
      if (f.commit !== p.commit) continue;
      const rel = relative(dir, f.file);
      if (m[v].file === rel && m[v].sha256 === f.sha256) continue;
      const own = join(dir, `${v}.html`);
      if (existsSync(own)) rmSync(own);
      m[v] = { url: m[v].url, sha256: f.sha256, bytes: f.bytes, file: rel };
      changed = true;
    }
    if (changed) writeFileSync(mf, `${JSON.stringify(m, null, 2)}\n`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      kind: { type: 'string' },
      refresh: { type: 'boolean', default: false },
      quick: { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '3' },
      verify: { type: 'boolean', default: false },
    },
  });
  const n = writeSynthetic();
  console.log(`synthetic and dynamic fixtures written: ${n}`);
  const src = loadSources();
  let pairs = src.pairs.filter((p) => p.kind !== 'synthetic' && p.kind !== 'dynamic');
  if (values.only) {
    const ids = new Set(values.only.split(','));
    pairs = pairs.filter((p) => ids.has(p.id));
  }
  if (values.kind) pairs = pairs.filter((p) => p.kind === values.kind);
  if (values.quick) pairs = pairs.slice(0, 2);
  if (values.verify) {
    let bad = 0;
    for (const p of pairs) {
      const ok = verifyPair(p);
      if (ok === false) bad++;
      console.log(`${ok === null ? 'missing' : ok ? 'ok     ' : 'CHANGED'} ${p.id}`);
    }
    process.exit(bad ? 1 : 0);
  }
  const todo = pairs.filter((p) => values.refresh || !existsSync(join(pairDir(p), 'meta.json')));
  console.log(`${todo.length} of ${pairs.length} pairs to fetch`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  // The script runner names functions with a helper that does not exist inside the page.
  await ctx.addInitScript('window.__name = (f) => f');
  const stamp = new Date().toISOString().slice(0, 10);
  let failed = 0;
  const done = new Map<string, { file: string; commit: boolean; sha256: string; bytes: number }>();
  for (const p of pairs) {
    const mf = join(pairDir(p), 'meta.json');
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, 'utf8')) as PairMeta;
    for (const v of ['a', 'b'] as const) {
      done.set(m[v].url, { ...m[v], file: versionFile(p, v), commit: p.commit });
    }
  }
  // Order so that pairs sharing a version run on the same worker one after the other.
  const queue = [...todo].sort((x, y) => x.a.url.localeCompare(y.a.url));
  const worker = async () => {
    const page = await ctx.newPage();
    for (let p = queue.shift(); p; p = queue.shift()) {
      const dir = pairDir(p);
      mkdirSync(dir, { recursive: true });
      const cssDir = join(dir, '..', '_css');
      try {
        const out: Partial<PairMeta> = { id: p.id, frozenAt: stamp, css: [] };
        const images: Record<string, [number, number]> = {};
        for (const v of ['a', 'b'] as const) {
          // Pairs that share a version share its frozen copy, so the repo stores it once.
          const twin = done.get(p[v].url);
          if (twin && twin.commit === p.commit) {
            copyFileSync(twin.file, join(dir, `${v}.html`));
            const tj = join(dirname(twin.file), 'images.json');
            if (existsSync(tj)) Object.assign(images, JSON.parse(readFileSync(tj, 'utf8')));
            out[v] = { url: p[v].url, sha256: twin.sha256, bytes: twin.bytes };
            continue;
          }
          const f = await freezeUrl(
            page,
            p[v].url,
            join(dir, `${v}.html`),
            cssDir,
            (n) => `../_css/${n}`,
            stamp,
          );
          out[v] = { url: p[v].url, sha256: f.sha256, bytes: f.bytes };
          done.set(p[v].url, {
            file: join(dir, `${v}.html`),
            commit: p.commit,
            sha256: f.sha256,
            bytes: f.bytes,
          });
          out.css = [...new Set([...(out.css ?? []), ...f.css])];
          Object.assign(images, f.images);
        }
        if (existsSync(join(dir, 'images.json'))) {
          Object.assign(images, JSON.parse(readFileSync(join(dir, 'images.json'), 'utf8')), images);
        }
        writeFileSync(join(dir, 'images.json'), `${JSON.stringify(images)}\n`);
        writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(out, null, 2)}\n`);
        console.log(
          `ok   ${p.id}  ${Math.round((out.a!.bytes + out.b!.bytes) / 1024)} KB${p.commit ? '' : '  (cache only)'}`,
        );
      } catch (e) {
        failed++;
        console.log(`FAIL ${p.id}: ${String(e).split('\n')[0]}`);
      }
    }
    await page.close();
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
  await browser.close();
  dedupe(pairs);
  writeSourcesMd();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
