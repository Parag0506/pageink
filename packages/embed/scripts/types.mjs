// Type declarations for dist: this package's files plus pageink-core's types file, with imports
// rewritten, so the published types do not depend on pageink-core being installed.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pkg = resolve(import.meta.dirname, '..');
const tmp = join(pkg, 'dist/.dts');
const out = join(pkg, 'dist/types');
rmSync(tmp, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });

let log = '';
try {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--pretty', 'false'], { cwd: pkg, stdio: 'pipe' });
} catch (e) {
  log = String(e.stdout ?? '') + String(e.stderr ?? '');
}
// Errors in other packages are not ours to fix here. Errors in this one stop the build.
const mine = log.split('\n').filter((l) => /^src\//.test(l));
if (mine.length) {
  console.error(mine.join('\n'));
  process.exit(1);
}

// pageink-core's types file has no imports, so it compiles on its own.
try {
  execFileSync(
    'npx',
    [
      'tsc',
      '../core/src/types.ts',
      '--ignoreConfig',
      '--declaration',
      '--emitDeclarationOnly',
      '--skipLibCheck',
      '--target',
      'es2022',
      '--outDir',
      join(tmp, 'core'),
    ],
    { cwd: pkg, stdio: 'pipe' },
  );
} catch (e) {
  console.error(String(e.stdout ?? '') + String(e.stderr ?? ''));
  process.exit(1);
}
const ownDir = join(tmp, 'embed');
const coreTypes = join(tmp, 'core/types.d.ts');
if (!existsSync(ownDir) || !existsSync(coreTypes)) {
  console.error('tsc wrote no declarations');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
cpSync(ownDir, out, { recursive: true });
cpSync(coreTypes, join(out, 'core.d.ts'));

const bad = [];
const walk = (dir, depth) => {
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) walk(p, depth + 1);
    else if (n.name.endsWith('.d.ts')) {
      const up = depth ? '../'.repeat(depth) : './';
      let text = readFileSync(p, 'utf8').replace(/(['"])pageink-core\/types\1/g, `$1${up}core$1`);
      if (/['"]pageink-core[/'"]/.test(text)) bad.push(p);
      text = text.replace(/\n\/\/# sourceMappingURL=.*$/m, '');
      writeFileSync(p, text);
    }
  }
};
walk(out, 0);
rmSync(tmp, { recursive: true, force: true });
if (bad.length) {
  console.error(`declarations still point into pageink-core: ${bad.join(', ')}`);
  process.exit(1);
}
console.log('types: dist/types');
