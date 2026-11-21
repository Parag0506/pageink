/**
 * Workspace packages import the TypeScript sources through `exports`. The
 * published package uses `publishConfig.exports`, which must offer the same
 * entry points, built into dist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const dir = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
  exports: Record<string, string>;
  publishConfig: { exports: Record<string, { types: string; import: string; default: string }> };
  files: string[];
  sideEffects: boolean;
};

test('the published entry points match the workspace ones, built into dist', () => {
  expect(Object.keys(pkg.publishConfig.exports)).toEqual(Object.keys(pkg.exports));
  for (const [k, from] of Object.entries(pkg.exports)) {
    const js = from.replace('./src/', './dist/').replace(/\.ts$/, '.js');
    expect(pkg.publishConfig.exports[k]).toEqual({
      types: js.replace(/\.js$/, '.d.ts'),
      import: js,
      default: js,
    });
  }
});

test('every workspace entry point exists, and the package ships only dist and the readme', () => {
  for (const [k, from] of Object.entries(pkg.exports)) {
    if (k.includes('*')) continue;
    expect(existsSync(join(dir, from)), from).toBe(true);
  }
  expect(pkg.files).toEqual(['dist', 'README.md']);
  expect(pkg.sideEffects).toBe(false);
  expect(existsSync(join(dir, 'README.md'))).toBe(true);
});
