import { defineConfig } from 'vite';

// The module build. The drawing tools and the backup helpers stay in their own chunks,
// so a page that only shows ink loads neither.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'pageink.mjs',
    },
    rollupOptions: {
      output: { chunkFileNames: 'chunks/[name]-[hash].mjs', minify: true },
    },
  },
});
