/**
 * The pages that site/build.mjs makes, among them the home page and the privacy page. Google reads both before it lets
 * the sign-in leave testing, so the privacy page must say all that PRIVACY.md says, and neither
 * page may load anything from another server. The site has no package of its own. The test sits
 * here so it runs with this package's tests, in `corepack pnpm test` and on CI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { NAME } from 'pageink-core/brand';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const repo = resolve(import.meta.dirname, '../../..');
const script = join(repo, 'site/build.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'site-test-'));
const out = join(tmp, 'out');

const build = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

function files(dir: string): string[] {
  const found: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) found.push(...files(p));
    else found.push(p);
  }
  return found.sort();
}

/** What a reader sees of a page: the body without tags, entities decoded, spaces folded. */
function seen(html: string): string {
  return fold(
    html
      .replace(/^[\s\S]*<body>/, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&copy;/g, '(c)')
      .replace(/&amp;/g, '&'),
  );
}

const fold = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The JSON-LD blocks of a page, and the page without them. They are data the browser does not run. */
const LD = /<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/g;
const ld = (html: string) => [...html.matchAll(LD)].map((m) => JSON.parse(m[1] as string));
const withoutLd = (html: string) => html.replace(LD, '');

/** Where the site is published, read from the build script so the test follows it. */
const SITE = /const SITE = '([^']+)'/.exec(read(repo, 'site/build.mjs'))?.[1] as string;
const indexed = [
  'index.html',
  'notes-stay-after-reload/index.html',
  'apple-pencil-safari/index.html',
  'edge-web-notes-alternative/index.html',
  'privacy/index.html',
];
const guides = indexed.filter((f) => !['index.html', 'privacy/index.html'].includes(f));

/** A piece of Markdown without its marks: links keep their words, bold and code lose their signs. */
const unmarked = (md: string) =>
  fold(
    md
      .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
      .replace(/\*\*/g, '')
      .replace(/`/g, ''),
  );

beforeAll(() => {
  const r = build(out);
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('the build writes the pages, the sitemap, the stylesheet and the pictures', () => {
  for (const f of [
    'index.html',
    'privacy/index.html',
    '404.html',
    'sitemap.xml',
    'site.css',
    'assets/og.png',
  ])
    expect(existsSync(join(out, f)), f).toBe(true);
  expect(files(join(out, 'assets')).length).toBeGreaterThan(2);
});

test.each([...indexed, '404.html'])('%s is a whole page with one h1', (f) => {
  const html = withoutLd(read(out, f));
  expect(html).toMatch(/^<!doctype html>\n<html lang="en">/);
  expect(html).toMatch(/<meta name="viewport"/);
  expect(html).toMatch(/<title>[^<]+<\/title>/);
  expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  expect(html).not.toMatch(/<script/i);
  for (const img of html.match(/<img [^>]*>/g) ?? []) expect(img).toMatch(/ alt="[^"]+"/);
  expect(html).not.toMatch(/<ul[^>]*>\s*<\/ul>/);
  // No em dashes in anything a reader sees.
  expect(html).not.toContain(String.fromCharCode(0x2014));
});

test('the home page names the product and links to the policy, the source and the issues', () => {
  const html = read(out, 'index.html');
  expect(html).toContain(`<title>${NAME}`);
  // The h1 is a sentence about the product. The logo is a link home, not the heading.
  expect(html).toMatch(new RegExp(`<h1[^>]*>${NAME} [^<]+</h1>`));
  expect(html).toMatch(new RegExp(`<a class="logo" href="\\./">[\\s\\S]*?alt="${NAME}"`));
  expect(seen(html)).toContain(`Why ${NAME} asks for Google Drive or OneDrive access`);
  expect(html).toContain('<a href="privacy/">');
  const pkg = JSON.parse(read(repo, 'package.json')) as { repository: { url: string } };
  const source = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  expect(html).toContain(`<a href="${source}">`);
  expect(html).toContain(`<a href="${source}/issues">`);
});

describe('the guides', () => {
  const version = (JSON.parse(read(repo, 'packages/extension/package.json')) as { version: string }).version;

  test('the home page links every guide', () => {
    const html = read(out, 'index.html');
    for (const f of guides) expect(html).toContain(`<a href="${f.replace(/index\.html$/, '')}">`);
  });

  test('the home page links the Firefox add-on and does not call it in review', () => {
    const html = read(out, 'index.html');
    expect(html).toContain('<a href="https://addons.mozilla.org/firefox/addon/pageink/">');
    for (const said of html.match(/[^>.]*in review/g) ?? []) expect(said).not.toContain('Firefox');
  });

  test.each(guides)('%s links the stores and says which version it was checked against', (f) => {
    const html = read(out, f);
    expect(html).toMatch(/<p class="get">[^\n]*chromewebstore\.google\.com[^\n]*apps\.apple\.com/);
    expect(html).toMatch(/<p class="get">[^\n]*addons\.mozilla\.org\/firefox\/addon\/pageink\//);
    for (const said of html.match(/[^>.]*in review/g) ?? []) expect(said).not.toContain('Firefox');
    const applies = /Applies to (\S+) (\S+)\. Last checked \d{1,2} [A-Z][a-z]+ \d{4}\./.exec(seen(html));
    expect(applies?.slice(1)).toEqual([NAME, version]);
    // The footer links the source, the issues, the changelog, the licence and the policy.
    for (const end of ['/issues', '/blob/main/CHANGELOG.md', '/blob/main/LICENSE', '../privacy/'])
      expect(html).toMatch(new RegExp(`<a href="[^"]*${end.replace(/\./g, '\\.')}"`));
  });

  test('a screenshot in a guide is a file of the site, with its size and alt text', () => {
    const html = read(out, 'notes-stay-after-reload/index.html');
    const img = /<img src="\.\.\/assets\/([^"]+\.webp)" alt="[^"]+" width="(\d+)" height="(\d+)"/.exec(html);
    expect(img?.slice(1)).toEqual(['3-reload.webp', '1280', '800']);
    expect(existsSync(join(out, 'assets', img?.[1] as string))).toBe(true);
  });
});

describe('the privacy page says what PRIVACY.md says', () => {
  const lines = read(repo, 'PRIVACY.md').split('\n');
  const page = () => read(out, 'privacy/index.html');

  test('every heading is a heading', () => {
    const headings = lines.filter((l) => /^#+ /.test(l));
    expect(headings.length).toBeGreaterThan(5);
    const html = page();
    for (const h of headings) {
      const level = h.indexOf(' ');
      const inPage = [...html.matchAll(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, 'g'))].map(
        (m) => seen(`<body>${m[1]}`),
      );
      expect(inPage, h).toContain(unmarked(h.slice(level + 1)));
    }
  });

  test('every line of text is on the page, word for word', () => {
    const text = seen(page());
    let checked = 0;
    for (const line of lines) {
      if (!line.trim() || /^\|[\s|-]+\|$/.test(line)) continue;
      // A table row is checked cell by cell. Any other line is checked whole, without its marks.
      const parts = line.startsWith('|')
        ? line.slice(1, -1).split('|')
        : [line.replace(/^#+ /, '').replace(/^- /, '')];
      for (const p of parts) {
        expect(text, line).toContain(unmarked(p));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  test('links to files go to the repository, and nothing points at a file the site lacks', () => {
    const hrefs = [...page().matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1] as string);
    expect(hrefs.length).toBeGreaterThan(5);
    for (const h of hrefs) expect(h).toMatch(/^(https:\/\/|\.\.\/(privacy\/)?$|#)/);
    expect(hrefs.some((h) => h.endsWith('/blob/main/SECURITY.md'))).toBe(true);
  });
});

test('no page, stylesheet or picture loads anything from another server', () => {
  const remote = [
    /\bsrc(set)?\s*=\s*["']?\s*(https?:)?\/\//i,
    /<link\b[^>]*\bhref\s*=\s*["']?\s*(https?:)?\/\//i,
    /@import/i,
    /url\(\s*["']?\s*(https?:)?\/\//i,
    /<(script|iframe|object|embed|form)\b/i,
  ];
  const all = files(out);
  expect(all.length).toBeGreaterThan(5);
  const base = new URL(SITE).pathname;
  for (const f of all) {
    if (!/\.(html|css|svg)$/.test(f)) continue;
    // The canonical link names the page's own public address. It loads nothing.
    const text = withoutLd(read(f)).replace(/<link rel="canonical" href="https:\/\/[^"]+">/, '');
    for (const re of remote) expect(re.exec(text)?.[0], `${relative(out, f)} ${re}`).toBeUndefined();
    // What a page does load is a file of the site. 404.html links from the site's root.
    for (const m of text.matchAll(/\b(?:src|srcset)="([^"]+)"|<link\b[^>]*\bhref="([^"]+)"/g)) {
      const ref = (m[1] ?? m[2]) as string;
      const file = ref.startsWith(base) ? join(out, ref.slice(base.length)) : resolve(dirname(f), ref);
      expect(existsSync(file), `${relative(out, f)} loads ${ref}`).toBe(true);
    }
  }
});

describe('what search engines and shared links read', () => {
  test.each(indexed)('%s names one address, the same in the canonical tag, og:url and the sitemap', (f) => {
    const html = read(out, f);
    const url = SITE + f.replace(/index\.html$/, '');
    expect(html.match(/<link rel="canonical" href="([^"]+)">/g)).toEqual([
      `<link rel="canonical" href="${url}">`,
    ]);
    expect(html).toContain(`<meta property="og:url" content="${url}">`);
    expect(read(out, 'sitemap.xml')).toContain(`<loc>${url}</loc>`);
    for (const tag of ['og:title', 'og:description', 'og:image', 'twitter:card', 'twitter:image'])
      expect(html, tag).toMatch(new RegExp(`(property|name)="${tag}" content="[^"]+"`));
  });

  test('the sitemap lists the indexed pages, each with a date, and nothing else', () => {
    const xml = read(out, 'sitemap.xml');
    const locs = [...xml.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod><\/url>/g)];
    expect(locs.map((m) => m[1])).toEqual(indexed.map((f) => SITE + f.replace(/index\.html$/, '')));
    expect(xml.match(/<url>/g)).toHaveLength(locs.length);
  });

  test('the page that is not found is kept out of search', () => {
    const html = read(out, '404.html');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toMatch(/rel="canonical"|og:url|ld\+json/);
  });

  test('the structured data parses and says only what is so', () => {
    const [home] = ld(read(out, 'index.html'));
    const types = home['@graph'].map((o: { '@type': string }) => o['@type']);
    expect(types).toEqual(['WebSite', 'SoftwareApplication']);
    const app = home['@graph'][1];
    expect(app).toMatchObject({ name: NAME, applicationCategory: 'BrowserApplication' });
    expect(app.offers).toMatchObject({ price: '0', priceCurrency: 'USD' });
    for (const k of ['aggregateRating', 'review']) expect(app[k]).toBeUndefined();
    const [privacy] = ld(read(out, 'privacy/index.html'));
    expect(privacy['@graph'].map((o: { '@type': string }) => o['@type'])).toEqual([
      'WebPage',
      'BreadcrumbList',
    ]);
  });
});

describe('the Markdown converter', () => {
  const good =
    '# Title\n\nLast updated: 1 January 2026.\n\nSome **bold** text with `code`, a [link](LICENSE)\nand https://example.org/a.\n';
  const convert = (name: string, md: string) => {
    const file = join(tmp, `${name}.md`);
    const dir = join(tmp, name);
    writeFileSync(file, md);
    return { r: build(dir, '--privacy', file), dir };
  };

  test('builds a page from the constructs it knows', () => {
    const rest =
      '## Part `x`\n\nSee [the part](#part-x):\n- one\n  more\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
    const { r, dir } = convert('good', `${good}\n${rest}`);
    expect(r.status, r.stderr).toBe(0);
    const html = read(dir, 'privacy/index.html');
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain('<strong>bold</strong> text with <code>code</code>');
    expect(html).toContain('<a href="https://example.org/a">https://example.org/a</a>.');
    expect(html).toContain('<h2 id="part-x">Part <code>x</code></h2>');
    expect(html).toContain(
      '<p>See <a href="#part-x">the part</a>:</p>\n<ul>\n<li>one\nmore</li>\n<li>two</li>\n</ul>',
    );
    expect(html).toContain('<tr><td data-label="A">1</td><td data-label="B">2</td></tr>');
    expect(html).toMatch(/<a href="https:\/\/[^"]+\/blob\/main\/LICENSE">link<\/a>/);
  });

  test('links to a page of the site by its path', () => {
    const { r, dir } = convert('site-link', `${good}\nGo [home](/).\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(read(dir, 'privacy/index.html')).toContain('<p>Go <a href="../">home</a>.</p>');
    expect(convert('no-page', `${good}\nGo [there](/nowhere/).\n`).r.status).toBe(1);
  });

  test.each([
    ['a code fence', '```\ncode\n```'],
    ['an indented block', '    code'],
    ['a numbered list', '1. one\n2. two'],
    ['a star list', '* one'],
    ['a nested list', '- one\n  - inner'],
    ['a loose list', '- one\n\n- two'],
    ['a block quote', '> quoted'],
    ['a rule', '---'],
    ['an underlined heading', 'Title two\n========='],
    ['a seventh-level heading', '####### deep'],
    ['a second h1', '# Again'],
    ['an image', '![alt](brand/pageink-mark.svg)'],
    ['HTML', '<b>bold</b>'],
    ['HTML inside text', 'a <b>bold</b> word'],
    ['an HTML entity', 'this &amp; that'],
    ['single-star emphasis', 'some *leaning* text'],
    ['underscore emphasis', 'some _leaning_ text'],
    ['bold that never closes', 'some **bold text'],
    ['code that never closes', 'some `code text'],
    ['struck out text', 'some ~~old~~ text'],
    ['a backslash escape', 'a \\* star'],
    ['a reference link', '[text][ref]'],
    ['a link to a missing file', '[text](NO_SUCH_FILE.md)'],
    ['a link out of the repository', '[text](../x.md)'],
    ['a link that is not https', '[text](http://example.org)'],
    ['a link to a missing heading', '[text](#nowhere)'],
    ['a bare http address', 'see http://example.org'],
    ['a hard line break', 'one  \ntwo'],
    ['a table with alignment', '| A | B |\n| :-- | --: |\n| 1 | 2 |'],
    ['a table row with a cell missing', '| A | B |\n| --- | --- |\n| 1 |'],
    ['text right under a table', '| A | B |\n| --- | --- |\n| 1 | 2 |\ntext'],
    ['text right under a list', '- one\ntext'],
  ])('stops the build on %s', (name, md) => {
    const { r, dir } = convert(name.replace(/\W+/g, '-'), `${good}\n${md}\n`);
    expect(r.status, `${md}\n${r.stdout}`).toBe(1);
    expect(r.stderr).toMatch(/\.md:\d+: /);
    // Nothing is written when the build stops.
    expect(existsSync(dir)).toBe(false);
  });
});

describe('the Search Console value', () => {
  const tag = /<meta name="google-site-verification" content="([^"]*)">/;
  const own = join(repo, 'site/verification.txt');

  test('is in the home page only when site/verification.txt exists', () => {
    const m = tag.exec(read(out, 'index.html'));
    if (existsSync(own)) expect(m?.[1]).toBe(read(own).trim());
    else expect(m).toBeNull();
    expect(read(out, 'privacy/index.html')).not.toMatch(tag);
  });

  test('is read from a one-line file', () => {
    const file = join(tmp, 'verification.txt');
    writeFileSync(file, 'abc_DEF-123\n');
    const dir = join(tmp, 'verified');
    expect(build(dir, '--verification', file).status).toBe(0);
    const html = read(dir, 'index.html');
    expect(tag.exec(html)?.[1]).toBe('abc_DEF-123');
    expect(html.indexOf('google-site-verification')).toBeLessThan(html.indexOf('</head>'));
  });

  test('stops the build when the file holds something else', () => {
    const file = join(tmp, 'bad-verification.txt');
    writeFileSync(file, '"><script>x</script>\n');
    expect(build(join(tmp, 'unverified'), '--verification', file).status).toBe(1);
  });

  test('for Bing is read from its own file', () => {
    const file = join(tmp, 'bing.txt');
    writeFileSync(file, 'ABC123\n');
    const dir = join(tmp, 'bing');
    expect(build(dir, '--bing', file).status).toBe(0);
    expect(read(dir, 'index.html')).toContain('<meta name="msvalidate.01" content="ABC123">');
    expect(read(dir, 'privacy/index.html')).not.toContain('msvalidate.01');
  });
});

test('the product name is not written by hand in the site sources', () => {
  // The same rule as packages/extension/test/brand.test.ts: the name comes from the brand file.
  for (const f of ['site/build.mjs', 'site/site.css']) {
    const code = read(repo, f)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
    expect(code, f).not.toMatch(new RegExp(`\\b${NAME}\\b`));
  }
});
