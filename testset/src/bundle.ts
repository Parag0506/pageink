// Bundles an anchor module and the in-page harness into one script for page injection.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { ROOT } from './sources.ts';

export const REPO = join(ROOT, '..');

/** Short names for --anchor. Anything else is a path to a module exporting describe and createResolver. */
export function anchorEntry(name: string): string {
  if (name === 'baseline') return join(ROOT, 'baseline', 'index.ts');
  if (name === 'core') return join(REPO, 'packages', 'core', 'src', 'anchor', 'index.ts');
  const p = resolve(process.env.INIT_CWD ?? process.cwd(), name);
  return existsSync(p) ? p : resolve(REPO, name);
}

/** IIFE that sets window.__inkTest = { anchor, write, score, ... }. */
export async function bundleHarness(entry: string): Promise<string> {
  if (!existsSync(entry)) throw new Error(`anchor entry not found: ${entry}`);
  const contents = [
    `import * as anchor from ${JSON.stringify(entry)};`,
    `import * as harness from ${JSON.stringify(join(ROOT, 'page', 'harness.ts'))};`,
    'window.__inkTest = Object.assign({ anchor }, harness);',
  ].join('\n');
  const out = await build({
    stdin: { contents, resolveDir: ROOT, loader: 'ts', sourcefile: 'ink-test-entry.ts' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
    nodePaths: [join(ROOT, 'node_modules'), join(REPO, 'node_modules')],
  });
  return out.outputFiles[0]!.text;
}

/** Bundles a module on its own as an IIFE that assigns its exports to a global. */
export async function bundleGlobal(entry: string, globalName: string): Promise<string> {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName,
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
    nodePaths: [join(ROOT, 'node_modules'), join(REPO, 'node_modules')],
  });
  return out.outputFiles[0]!.text;
}
