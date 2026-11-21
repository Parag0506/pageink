// Renders the extension's icons from the brand files in brand/ at the repository root.
// Manifest icons: 16 and 32 use the small mark, 48 and 128 the full mark. Toolbar icons use
// the small mark at every size, since a toolbar shows them at 16 to 19 points. The SVGs are
// copied for Firefox's toolbar and for the extension pages.
// Run: corepack pnpm --filter pageink-extension icons
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ICONS, TOOLBAR, TOOLBAR_SIZES } from '../build/icons.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brand = resolve(pkg, '../../brand');
const out = resolve(pkg, 'public');
mkdirSync(resolve(out, 'icons'), { recursive: true });

const SVGS = {
  'icons/mark.svg': 'pageink-mark.svg',
  'icons/mark-small.svg': 'pageink-mark-small.svg',
  'icons/logo.svg': 'pageink-logo.svg',
  'icons/logo-dark.svg': 'pageink-logo-dark.svg',
};
for (const [to, from] of Object.entries(SVGS)) copyFileSync(resolve(brand, from), resolve(out, to));

const data = (f) => `data:image/svg+xml;base64,${readFileSync(resolve(brand, f)).toString('base64')}`;
const full = data('pageink-mark.svg');
const small = data('pageink-mark-small.svg');
const jobs = [
  ...Object.entries(ICONS).map(([size, path]) => [Number(size), path, Number(size) <= 32 ? small : full]),
  ...TOOLBAR_SIZES.map((size) => [size, TOOLBAR(size), small]),
];

const browser = await chromium.launch();
for (const [size, path, src] of jobs) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body>`,
  );
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path: resolve(out, path), omitBackground: true });
  await page.close();
}
await browser.close();
console.log(`wrote ${jobs.length} icons and ${Object.keys(SVGS).length} SVGs to public/icons/`);
