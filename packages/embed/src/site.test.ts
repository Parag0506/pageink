/**
 * The home page and the privacy page that site/build.mjs makes. Google reads both before it lets
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

test('the build writes both pages, the stylesheet and the pictures', () => {
  for (const f of ['index.html', 'privacy/index.html', 'site.css'])
    expect(existsSync(join(out, f)), f).toBe(true);
  expect(files(join(out, 'assets')).length).toBeGreaterThan(2);
});

test.each(['index.html', 'privacy/index.html'])('%s is a whole page with one h1', (f) => {
  const html = read(out, f);
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
  expect(html).toMatch(new RegExp(`<h1[^>]*>[\\s\\S]*alt="${NAME}"[\\s\\S]*</h1>`));
  expect(seen(html)).toContain(`Why ${NAME} asks for Google Drive or OneDrive access`);
  expect(html).toContain('<a href="privacy/">');
  const pkg = JSON.parse(read(repo, 'package.json')) as { repository: { url: string } };
  const source = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  expect(html).toContain(`<a href="${source}">`);
  expect(html).toContain(`<a href="${source}/issues">`);
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
  for (const f of all) {
    if (!/\.(html|css|svg)$/.test(f)) continue;
    const text = read(f);
    for (const re of remote) expect(re.exec(text)?.[0], `${relative(out, f)} ${re}`).toBeUndefined();
    // What a page does load is a file of the site.
    for (const m of text.matchAll(/\b(?:src|srcset)="([^"]+)"|<link\b[^>]*\bhref="([^"]+)"/g)) {
      const ref = (m[1] ?? m[2]) as string;
      expect(existsSync(resolve(dirname(f), ref)), `${relative(out, f)} loads ${ref}`).toBe(true);
    }
  }
});

describe('the Markdown converter', () => {
  const good = '# Title\n\nSome **bold** text with `code`, a [link](LICENSE)\nand https://example.org/a.\n';
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
