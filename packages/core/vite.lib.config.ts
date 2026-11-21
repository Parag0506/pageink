import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => resolve(here, 'src', p);
const FOLDERS = ['anchor', 'capture', 'notes', 'place', 'render', 'store', 'strokes', 'ui'];

// The npm build. One file per module, so the lazy split between ./view and
// ./tools survives and bundlers can drop what a host does not import.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    lib: {
      entry: {
        index: src('index.ts'),
        types: src('types.ts'),
        hash: src('hash.ts'),
        brand: src('brand.ts'),
        'app/view': src('app/view.ts'),
        'app/tools': src('app/tools.ts'),
        ...Object.fromEntries(FOLDERS.map((f) => [`${f}/index`, src(`${f}/index.ts`)])),
      },
      formats: ['es'],
    },
    rolldownOptions: {
      external: Object.keys(pkg.dependencies),
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
  },
});
