import { defineConfig } from 'vite';
import { GLOBAL } from '../core/src/brand';

// One self-contained script that sets the brand's global and mounts itself from its tag.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    minify: true,
    lib: {
      entry: 'src/iife.ts',
      formats: ['iife'],
      name: GLOBAL,
      fileName: () => 'pageink.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true, minify: true },
    },
  },
});
