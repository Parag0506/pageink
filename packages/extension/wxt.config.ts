import { copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'wxt';
import { buildCloud } from './build/cloud.ts';
import { buildContent } from './build/content.ts';
import { buildPdfAssets, pdfjsAlias, pdfjsOffline } from './build/pdfjs.ts';
import {
  DIAG_DIR,
  DIAG_FILE,
  defines,
  diagOrigin,
  isFake,
  manifestFor,
  pkgDir,
  type Target,
} from './build/targets.ts';
import { NAME, SLUG } from './src/brand.ts';

const repo = resolve(pkgDir, '../..');
// The test build talks to local fakes. It must never be packed for a store.
if (isFake() && process.argv.includes('zip')) throw new Error('INK_CLOUD_FAKE builds cannot be zipped.');
/** Files every build and every store zip carries at its root. */
export const LEGAL = ['LICENSE', 'NOTICE'];

/** A diagnostics build for the device check goes to its own folder, apart from the shipped builds. */
const diag = !!process.env.INK_DIAG_ORIGIN;

export default defineConfig({
  imports: false,
  // The test build gets its own folder, so it never replaces a release build.
  ...(isFake() ? { outDirTemplate: 'test-{{browser}}-mv{{manifestVersion}}' } : {}),
  ...(diag ? { outDir: `.output/${DIAG_DIR}` } : {}),
  manifestVersion: 3,
  manifest: ({ browser }) => manifestFor(browser as Target),
  vite: ({ browser, mode }) => ({
    define: defines(browser as Target, mode),
    resolve: { alias: pdfjsAlias(browser as Target) },
    plugins: [
      pdfjsOffline(),
      // Pages write the product name as %NAME%, so it lives in one place.
      { name: 'brand', transformIndexHtml: (html: string) => html.replaceAll('%NAME%', NAME) },
    ],
    // The preload polyfill uses fetch. Extension pages load their own chunks.
    build: { modulePreload: { polyfill: false } },
  }),
  // Firefox reviewers rebuild the add-on from this zip, so it holds the workspace
  // with pageink-core, the lockfile and a short note on how to build.
  zip: {
    // Store zips carry the product name, not the workspace package name: pageink-<version>-chrome.zip.
    name: SLUG,
    sourcesRoot: repo,
    includeSources: [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.base.json',
      'biome.json',
      'LICENSE',
      'NOTICE',
      'packages/core/**',
      'packages/extension/**',
      // The network scan the extension's tests use.
      'scripts/netscan.ts',
      // The other workspace packages are listed in the lockfile. Their manifests let it install as is.
      'packages/embed/package.json',
      'testset/package.json',
      'bench/package.json',
    ],
    excludeSources: [
      'packages/*/node_modules/**',
      'packages/extension/.output/**',
      'packages/extension/test-results/**',
      'packages/extension/cloud-ids.local.json',
      'packages/extension/dev-key.pem',
    ],
  },
  hooks: {
    'zip:start': () => {
      if (process.env.INK_DIAG_ORIGIN)
        throw new Error('A store zip cannot carry diagnostics. Unset INK_DIAG_ORIGIN.');
    },
    // WXT reads the popup's <title> for the toolbar title before the pages are
    // transformed, so the placeholder is filled in the manifest too.
    'build:manifestGenerated': (_wxt, manifest) => {
      const fill = (v: unknown): unknown =>
        typeof v === 'string'
          ? v.replaceAll('%NAME%', NAME)
          : Array.isArray(v)
            ? v.map(fill)
            : v && typeof v === 'object'
              ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
              : v;
      Object.assign(manifest, fill(manifest));
    },
    'build:done': async (wxt, output) => {
      const files = [
        ...(await buildContent(wxt.config.outDir, wxt.config.browser as Target, wxt.config.mode)),
        ...(await buildCloud(wxt.config.outDir, wxt.config.browser as Target)),
        ...(await buildPdfAssets(wxt.config.outDir, wxt.config.browser as Target)),
      ];
      for (const name of LEGAL) {
        copyFileSync(join(repo, name), join(wxt.config.outDir, name));
        files.push(name);
      }
      const origin = diagOrigin(wxt.config.browser as Target);
      if (origin) {
        writeFileSync(
          join(wxt.config.outDir, DIAG_FILE),
          `Diagnostics build for the device check. It reports to ${origin}. Never ship it.\n`,
        );
        files.push(DIAG_FILE);
      }
      for (const fileName of files) output.publicAssets.push({ type: 'asset', fileName });
    },
  },
});
