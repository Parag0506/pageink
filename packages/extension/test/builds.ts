import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const pkg = resolve(import.meta.dirname, '..');
export const outRoot = join(pkg, '.output');

export type Build = {
  name: string;
  dir: string;
  target: 'chrome' | 'edge' | 'firefox' | 'safari';
  test: boolean;
};

/** The folder of a diagnostics build for the device check (build/targets.ts DIAG_DIR). */
export const DIAG_NAME = 'diag';

/**
 * Every release build folder in .output. The test script builds all of them first. Bench
 * builds (<target>-mv3-bench) keep performance marks for the bench and are never shipped,
 * so they are left out here and checked on their own. So is a diagnostics build (diagBuild).
 */
export function builds(bench = false): Build[] {
  if (!existsSync(outRoot)) return [];
  return readdirSync(outRoot)
    .filter((n) => statSync(join(outRoot, n)).isDirectory() && existsSync(join(outRoot, n, 'manifest.json')))
    .filter((n) => n !== DIAG_NAME && n.endsWith('-bench') === bench)
    .map((name) => {
      const test = name.startsWith('test-');
      const target = name.replace(/^test-/, '').split('-')[0] as Build['target'];
      return { name, dir: join(outRoot, name), target, test };
    });
}

/** The diagnostics build, a Safari build, when one has been made. */
export function diagBuild(): Build | null {
  const dir = join(outRoot, DIAG_NAME, 'safari-mv3');
  if (!existsSync(join(dir, 'manifest.json'))) return null;
  return { name: DIAG_NAME, dir, target: 'safari', test: false };
}

export function files(dir: string, exts = ['.js', '.mjs', '.html', '.css', '.json']): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (exts.some((e) => n.endsWith(e))) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

export const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');

export const manifest = (b: Build) => JSON.parse(read(b.dir, 'manifest.json')) as Record<string, unknown>;

export function globToRegExp(glob: string): RegExp {
  const s = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*');
  return new RegExp(`^${s}$`);
}
