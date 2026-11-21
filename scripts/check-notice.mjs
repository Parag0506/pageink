#!/usr/bin/env node
/**
 * Checks that NOTICE lists every third-party package that can end up in a shipped bundle.
 *
 * Required packages are the union of:
 * - every npm package whose code a shipped entry point pulls in, found by bundling the
 *   entry points with the same bundler the builds use and keeping modules that render code;
 * - every runtime dependency declared by a shipped package, so a new dependency needs a
 *   NOTICE entry before its first import lands.
 *
 * It also checks each required package's licence against CONTRACT section 2.
 * Exit 0 when NOTICE is complete, 1 on a gap, 2 when the check itself fails.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = ['packages/core', 'packages/extension', 'packages/embed'];
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);

const pkgJson = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const workspaceNames = new Set(SHIPPED.map((d) => pkgJson(join(ROOT, d)).name));

/** Source files that start a shipped bundle. Tests are left out. */
function entries() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) out.push(p);
    }
  };
  walk(join(ROOT, 'packages/extension/entrypoints'));
  for (const f of ['stub.main.ts', 'loader.ts', 'pdf.ts']) {
    const p = join(ROOT, 'packages/extension/src/content', f);
    if (existsSync(p)) out.push(p);
  }
  for (const f of ['index.ts', 'iife.ts']) {
    const p = join(ROOT, 'packages/embed/src', f);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/** Package name from a resolved module path inside node_modules. */
function packageOf(id) {
  const i = id.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const rest = id.slice(i + '/node_modules/'.length).split('/');
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

async function bundled() {
  const req = createRequire(join(ROOT, 'package.json'));
  const viteReq = createRequire(req.resolve('vite/package.json'));
  const { rolldown } = await import(pathToFileURL(viteReq.resolve('rolldown')).href);
  const found = new Map();
  // One bundle per entry, so a failure names its entry.
  for (const input of entries()) {
    const bundle = await rolldown({
      input,
      cwd: dirname(input),
      platform: 'browser',
      logLevel: 'silent',
      transform: {
        define: { __INK_TARGET__: '"chrome"', __INK_PEN_READY__: 'false' },
      },
    });
    const out = await bundle.generate({ format: 'es' });
    await bundle.close();
    for (const chunk of out.output) {
      if (chunk.type !== 'chunk') continue;
      for (const [id, m] of Object.entries(chunk.modules)) {
        const name = m.renderedLength > 0 ? packageOf(id.replace(/\\/g, '/')) : null;
        if (!name || workspaceNames.has(name)) continue;
        if (!found.has(name))
          found.set(name, { dir: id.slice(0, id.lastIndexOf(name) + name.length), from: [] });
        found.get(name).from.push(relative(ROOT, input));
      }
    }
  }
  return found;
}

function declared() {
  const found = new Map();
  for (const d of SHIPPED) {
    const dir = join(ROOT, d);
    const req = createRequire(join(dir, 'package.json'));
    for (const name of Object.keys(pkgJson(dir).dependencies ?? {})) {
      if (workspaceNames.has(name)) continue;
      let pdir = null;
      try {
        pdir = dirname(req.resolve(`${name}/package.json`));
      } catch {
        // Some packages do not export package.json, so look for the folder directly.
        const p = join(dir, 'node_modules', name);
        if (existsSync(p)) pdir = p;
      }
      found.set(name, { dir: pdir, from: [`${d}/package.json`] });
    }
  }
  return found;
}

function noticeEntries() {
  const text = readFileSync(join(ROOT, 'NOTICE'), 'utf8');
  const map = new Map();
  for (const m of text.matchAll(/^Package: (\S+)\nVersion: (\S+)\nLicence: (.+)$/gm)) {
    map.set(m[1], { version: m[2], licence: m[3].trim() });
  }
  return map;
}

/**
 * Licence files the built PDF viewer carries. NOTICE must name each one, and
 * name no pdf/ licence file that the build does not carry. Skipped without a build.
 */
function pdfLicences(notice) {
  const out = join(ROOT, 'packages/extension/.output');
  const dir = existsSync(out)
    ? readdirSync(out)
        .map((n) => join(out, n, 'pdf'))
        .find((d) => existsSync(d))
    : undefined;
  if (!dir) {
    console.log('note: no extension build, so the PDF viewer files were not checked');
    return [];
  }
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/licen[cs]e/i.test(n)) files.push(`pdf/${relative(dir, p).replace(/\\/g, '/')}`);
    }
  };
  walk(dir);
  const gaps = files
    .filter((f) => !notice.includes(f))
    .map((f) => `${f} ships in the build but NOTICE does not name it`);
  for (const m of notice.matchAll(/\bpdf\/[\w./-]*LICEN[CS]E[\w.-]*/gi)) {
    const f = m[0].replace(/\.+$/, '');
    if (!files.includes(f)) gaps.push(`NOTICE names ${f}, which the build does not carry`);
  }
  return gaps;
}

async function main() {
  const required = await bundled();
  for (const [name, info] of declared()) {
    if (required.has(name)) required.get(name).from.push(...info.from);
    else required.set(name, info);
  }
  const notice = noticeEntries();
  const gaps = [];
  const warnings = [];
  for (const [name, info] of [...required].sort(([a], [b]) => a.localeCompare(b))) {
    const meta = info.dir && existsSync(join(info.dir, 'package.json')) ? pkgJson(info.dir) : {};
    const licence = typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? 'unknown');
    const entry = notice.get(name);
    const from = [...new Set(info.from)].join(', ');
    if (!entry) gaps.push(`${name} ${meta.version ?? ''} (${licence}) is not in NOTICE. Used by: ${from}`);
    if (!ALLOWED.has(licence))
      gaps.push(`${name} has licence ${licence}, which CONTRACT section 2 does not allow`);
    if (entry && meta.version && entry.version !== meta.version)
      warnings.push(
        `${name}: NOTICE says ${entry.version}, installed ${meta.version}. Check the copyright line.`,
      );
    if (entry && entry.licence.split(' ')[0] !== licence)
      warnings.push(`${name}: NOTICE says ${entry.licence}, package.json says ${licence}`);
    if (info.dir && !readdirSync(info.dir).some((f) => /^(licen[cs]e|copying)/i.test(f)))
      warnings.push(`${name} ships no licence file. NOTICE must carry the full licence text.`);
  }
  for (const name of notice.keys())
    if (!required.has(name)) warnings.push(`${name} is in NOTICE but no shipped code uses it now`);
  gaps.push(...pdfLicences(readFileSync(join(ROOT, 'NOTICE'), 'utf8')));

  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const g of gaps) console.error(`gap: ${g}`);
  console.log(`${required.size} third-party packages checked, ${gaps.length} gap(s)`);
  return gaps.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
