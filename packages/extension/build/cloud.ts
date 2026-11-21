/**
 * Builds the cloud code (src/cloud) on its own, as cloud.js next to background.js. Keeping it
 * in its own file lets the no-network test pin every network call and address to that one
 * file. Safari has no cloud.js: its app does the cloud work (NATIVE_PROTOCOL.md).
 */
import { resolve } from 'node:path';
import { build } from 'vite';
import { defines, pkgDir, type Target } from './targets.ts';

export const CLOUD_JS = 'cloud.js';

export const hasCloud = (t: Target): boolean => t !== 'safari';

export async function buildCloud(outDir: string, t: Target): Promise<string[]> {
  if (!hasCloud(t)) return [];
  await build({
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    define: { ...defines(t), 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      target: 'es2022',
      lib: {
        entry: resolve(pkgDir, 'src/cloud/index.ts'),
        formats: ['iife'],
        // The background finds it as globalThis.inkCloud.
        name: 'inkCloud',
        fileName: () => CLOUD_JS,
      },
    },
  });
  return [CLOUD_JS];
}
