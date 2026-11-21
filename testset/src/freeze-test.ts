// Tests for the freezer's rule on which stylesheets are kept. Run with
// `corepack pnpm --filter pageink-testset run test`.
import { isDroppedSheet } from './freeze.ts';

const DROP = [
  'https://web-static.archive.org/_static/css/banner-styles.css?v=1B2M2Y8A',
  'https://web.archive.org/_static/css/iconochive.css?v=qtvMKcIJ',
  'https://archive.org/includes/athena.css',
  'https://fonts.googleapis.com/css2?family=Lato:ital,wght@0,400;0,700&display=fallback',
  'https://web.archive.org/web/20230301224756cs_/https://fonts.googleapis.com/css?family=Lato',
  'https://use.typekit.net/abc1def.css',
  'https://p.typekit.net/p.css?s=1&k=abc1def',
];

const KEEP = [
  'https://web.archive.org/web/20230301224756cs_/https://developer.mozilla.org/static/css/main.css',
  'https://nodejs.org/docs/v22.12.0/api/assets/style.css',
  'https://arxiv.org/static/browse/0.3.4/css/arxiv.css',
  'https://static.arxiv.org/css/fonts.css',
  'https://en.wikipedia.org/w/load.php?modules=site.styles&only=styles',
  'https://example.org/blog/fonts.googleapis.com.css',
];

let failed = 0;
for (const [list, want] of [
  [DROP, true],
  [KEEP, false],
] as const) {
  for (const href of list) {
    const got = isDroppedSheet(href);
    if (got !== want) failed++;
    console.log(`${got === want ? 'ok  ' : 'FAIL'} ${want ? 'drop' : 'keep'} ${href}`);
  }
}
console.log(failed ? `${failed} failed` : `all ${DROP.length + KEEP.length} passed`);
process.exit(failed ? 1 : 0);
