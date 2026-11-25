// Builds the project's web site as plain files. It uses no packages and the pages load nothing
// from another server. They have no JavaScript and no web fonts.
//
// Usage: node site/build.mjs [out folder] [--privacy <file>] [--verification <file>] [--bing <file>]
//
// The out folder defaults to site/dist. Every page is an entry in PAGES below. The nav, the
// footer, sitemap.xml, the canonical tags, the share tags and the structured data all follow
// from that list. The privacy page is made from PRIVACY.md at build time, so the two cannot
// differ. The converter below knows only the Markdown that file uses. On anything else it stops
// the build and names the line, so nothing is ever printed wrong.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const here = import.meta.dirname;
const repo = resolve(here, '..');

/** The public address of the site, with its end slash. Canonical, sitemap and share addresses start here. */
const SITE = 'https://parag0506.github.io/pageink/';

/** The path part of SITE. A page that can be served at any depth, such as 404.html, links from here. */
const BASE = new URL(SITE).pathname;

/**
 * Store listings. Add one entry per store once the extension is published there, for example
 * { name: 'Chrome Web Store', url: 'https://...' }. While the list is empty the home page shows
 * no store links and says the extension is built from source.
 */
const STORES = [
  {
    name: 'Chrome Web Store',
    url: 'https://chromewebstore.google.com/detail/pageink/okegfngejejaddeaobgpamojcdddlmgf',
  },
  {
    name: 'Microsoft Edge Add-ons',
    url: 'https://microsoftedge.microsoft.com/addons/detail/pageink/nocfjhikfelnnjakadlpchhppdihamdo',
  },
  {
    name: 'App Store, for Safari on iPad',
    url: 'https://apps.apple.com/app/id6837846057',
  },
];

/** What is still on its way to a store, as one sentence. An empty string leaves it out. */
const IN_REVIEW = 'The Firefox add-on and the Safari app for Mac are in review.';

/** The one-minute film of the product in use. An empty string leaves the link out. */
const FILM = 'https://www.youtube.com/watch?v=7c85j0Y0f2Q';

/** Pictures the pages use, copied into assets/ in the out folder. */
const ASSETS = [
  'brand/pageink-logo.svg',
  'brand/pageink-logo-dark.svg',
  'brand/pageink-mark-small.svg',
  'brand/png/pageink-mark-32-transparent.png',
  'docs/media/1-writing.webp',
  'docs/media/3-reload.webp',
  'docs/media/og.png',
];

/** The picture a link shows when it is shared. It is made from the logo and a real screenshot. */
const SHARE = {
  file: 'og.png',
  width: 1200,
  height: 630,
  alt: 'The logo, and handwriting on a web page article',
};

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** What the pages take from the rest of the repository, so nothing is written twice. */
function facts() {
  // The brand file is TypeScript. It is read as text so this script runs on every Node the
  // project supports without a flag.
  const brand = readFileSync(join(repo, 'packages/core/src/brand.ts'), 'utf8');
  const name = /export const NAME = '([^']+)'/.exec(brand)?.[1];
  if (!name) throw new Error('No NAME in packages/core/src/brand.ts');

  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const repoUrl = String(pkg.repository?.url ?? '')
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repoUrl))
    throw new Error('package.json has no GitHub repository address');

  const owner = /^Copyright \(c\) (.+)$/m.exec(readFileSync(join(repo, 'LICENSE'), 'utf8'))?.[1];
  if (!owner) throw new Error('No copyright line in LICENSE');

  // The version people install is the extension's.
  const version = JSON.parse(readFileSync(join(repo, 'packages/extension/package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new Error('No version in packages/extension/package.json');

  return { name: esc(name), plainName: name, repoUrl, version, copyright: `Copyright &copy; ${esc(owner)}` };
}

/** The width and height of a PNG or WebP picture, read from its first bytes. */
function imageSize(file) {
  const b = readFileSync(file);
  if (b.toString('latin1', 1, 4) === 'PNG') return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
    }
    if (chunk === 'VP8X') return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  }
  throw new Error(`Cannot read the size of ${relative(repo, file)}`);
}

// ---- Markdown ----------------------------------------------------------------------------

/** Block starts the converter does not know. A line that matches one stops the build. */
const UNKNOWN_BLOCKS = [
  [/^\s*>/, 'a block quote'],
  [/^\s*(```|~~~)/, 'a code fence'],
  [/^\s*\d+[.)]\s/, 'a numbered list'],
  [/^\s*[*+]\s/, 'a list that does not start with "- "'],
  [/^\s*([-*_=])(\s*\1){2,}\s*$/, 'a rule or an underlined heading'],
  [/^\s*-\s*$/, 'an empty list item'],
  [/^\s*</, 'HTML'],
  [/^(?!#{1,6} +\S)#/, 'a heading that is not one to six "#", a space and text'],
];

/** Marks the converter does not know, looked for in the text left between the ones it does. */
const UNKNOWN_MARKS = [
  [/\*/, 'a "*" that is not part of **bold**'],
  [/[<>]/, 'HTML or an angle bracket'],
  [/\\/, 'a backslash'],
  [/\]/, 'a "]" with no link'],
  [/~~/, 'struck out text'],
  [/&#?\w+;/, 'an HTML entity'],
  [/(^|\W)_\S|\S_(\W|$)/, 'emphasis with "_"'],
  [/\bhttp:\/\/|\bwww\./, 'a bare address that is not https'],
];

/**
 * Turns Markdown into HTML. It knows headings, paragraphs, "- " lists, tables, links, bare
 * https addresses, **bold** and `code`, which is what PRIVACY.md uses. `link` turns the target
 * of a link into an address: a file in the repository, or a page of this site written as
 * "/" (home) or "/name/".
 */
function markdown(text, file, link) {
  const fail = (line, what) => {
    throw new Error(`${file}:${line}: ${what}. The site's Markdown converter does not know it.`);
  };

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((l, i) => {
    if (/\s{2,}$/.test(l) && l.trim()) fail(i + 1, 'a line break made with trailing spaces');
    for (const [re, what] of UNKNOWN_BLOCKS) if (re.test(l)) fail(i + 1, what);
  });
  const at = (i) => (lines[i] ?? '').trimEnd();

  const counts = new Map();
  const ids = new Set();
  const fragments = [];

  /** Inline marks. `line` is the line `src` starts on; a paragraph keeps its line ends. */
  function inline(src, line, inside = {}) {
    let out = '';
    let text = '';
    let textLine = line;
    const lineOf = (i) => line + src.slice(0, i).split('\n').length - 1;
    const flush = () => {
      for (const [re, what] of UNKNOWN_MARKS) if (re.test(text)) fail(textLine, what);
      out += esc(text);
      text = '';
    };

    let i = 0;
    while (i < src.length) {
      const ln = lineOf(i);
      if (src[i] === '`') {
        const end = src.indexOf('`', i + 1);
        if (src[i + 1] === '`' || end < 0) fail(ln, 'code that is not one pair of "`"');
        flush();
        out += `<code>${esc(src.slice(i + 1, end))}</code>`;
        i = end + 1;
      } else if (src.startsWith('**', i)) {
        const end = closing(src, i + 2);
        const body = end < 0 ? '' : src.slice(i + 2, end);
        if (inside.bold || !body || body !== body.trim() || body.startsWith('*') || src[end + 2] === '*')
          fail(ln, 'bold that is not a plain **pair**');
        flush();
        out += `<strong>${inline(body, ln, { ...inside, bold: true })}</strong>`;
        i = end + 2;
      } else if (src[i] === '[') {
        const m = /^\[([^[\]]+)\]\(([^()\s]+)\)/.exec(src.slice(i));
        if (!m || inside.link || text.endsWith('!')) fail(ln, 'a "[" that is not a plain [link](target)');
        flush();
        out += `<a href="${esc(target(m[2], ln))}">${inline(m[1], ln, { ...inside, link: true })}</a>`;
        i += m[0].length;
      } else if (src.startsWith('https://', i) && !/[\w/]$/.test(text) && !inside.link) {
        const url = bare(src.slice(i));
        flush();
        out += `<a href="${esc(url)}">${esc(url)}</a>`;
        i += url.length;
      } else {
        if (!text) textLine = ln;
        text += src[i];
        i++;
      }
    }
    flush();
    return out;
  }

  /** Where the next "**" is, skipping code. */
  function closing(src, from) {
    for (let i = from; i < src.length; i++) {
      if (src[i] === '`') {
        const end = src.indexOf('`', i + 1);
        if (end < 0) return -1;
        i = end;
      } else if (src.startsWith('**', i)) return i;
    }
    return -1;
  }

  /** A bare address, without the punctuation of the sentence around it. */
  function bare(rest) {
    let url = /^[^\s<>"`]+/.exec(rest)[0];
    for (;;) {
      const open = url.split('(').length;
      const shut = url.split(')').length;
      if (/[?!.,:;'*_~]$/.test(url) || (url.endsWith(')') && shut > open)) url = url.slice(0, -1);
      else return url;
    }
  }

  function target(to, line) {
    if (/^https:\/\//.test(to)) return to;
    if (to.startsWith('#')) {
      fragments.push([to.slice(1), line]);
      return to;
    }
    if (/^\/([\w-]+\/)*$/.test(to)) return link(to, line, fail);
    if (/^[\w.-]+(\/[\w.-]+)*(#[\w-]+)?$/.test(to) && !to.split('/').includes('..'))
      return link(to, line, fail);
    return fail(line, `a link to "${to}"`);
  }

  /** The id GitHub gives a heading, so links to a part of the page work the same here. */
  function idFor(src) {
    const base = src
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .toLowerCase()
      .replace(/[^\w\- ]/g, '')
      .replace(/ /g, '-');
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    const id = seen ? `${base}-${seen}` : base;
    ids.add(id);
    return id;
  }

  /** A list or a table ends at a blank line or a heading. Text right under it would join it. */
  const ended = (i, what) => {
    if (at(i) && !/^#{1,6} /.test(at(i))) fail(i + 1, `a line right under ${what} that is not part of it`);
  };
  const cells = (i) => {
    const l = at(i);
    if (!l.endsWith('|') || l.length < 2) fail(i + 1, 'a table row that does not end with "|"');
    return l
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
  };

  const out = [];
  let h1 = 0;
  let i = 0;
  while (i < lines.length) {
    const l = at(i);
    const heading = /^(#{1,6}) +(\S.*)$/.exec(l);
    if (!l) {
      i++;
    } else if (heading) {
      const level = heading[1].length;
      if (heading[2].endsWith('#')) fail(i + 1, 'a heading closed with "#"');
      if (level === 1) h1++;
      out.push(`<h${level} id="${esc(idFor(heading[2]))}">${inline(heading[2], i + 1)}</h${level}>`);
      i++;
    } else if (l.startsWith('|')) {
      const head = cells(i);
      if (!/^\|(\s*-{3,}\s*\|)+$/.test(at(i + 1)) || cells(i + 1).length !== head.length)
        fail(i + 2, 'a table without a plain "| --- |" line under its first row');
      const labels = head.map((c) => inline(c, i + 1));
      const rows = [];
      for (i += 2; at(i).startsWith('|'); i++) {
        const row = cells(i);
        if (row.length !== head.length) fail(i + 1, 'a table row with the wrong number of cells');
        const tds = row.map((c, k) => {
          const label = esc(labels[k].replace(/<[^>]+>/g, ''));
          return `<td data-label="${label}">${inline(c, i + 1)}</td>`;
        });
        rows.push(`<tr>${tds.join('')}</tr>`);
      }
      ended(i, 'a table');
      const ths = labels.map((c) => `<th scope="col">${c}</th>`).join('');
      out.push(`<table>\n<thead><tr>${ths}</tr></thead>\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table>`);
    } else if (l.startsWith('- ')) {
      const items = [];
      while (at(i).startsWith('- ')) {
        const first = i;
        const item = [at(i).slice(2).trim()];
        for (i++; /^ {2}\S/.test(at(i)); i++) {
          if (/^ {2}-\s/.test(at(i))) fail(i + 1, 'a list inside a list');
          item.push(at(i).slice(2));
        }
        items.push(`<li>${inline(item.join('\n'), first + 1)}</li>`);
      }
      // A blank line between items makes a different kind of list.
      let next = i;
      while (next < lines.length && !at(next)) next++;
      if (next > i && at(next).startsWith('- ')) fail(next + 1, 'a list with blank lines between its items');
      ended(i, 'a list');
      out.push(`<ul>\n${items.join('\n')}\n</ul>`);
    } else {
      const first = i;
      const para = [];
      while (at(i) && !/^(#{1,6} |- )/.test(at(i))) {
        if (/^\s/.test(at(i))) fail(i + 1, 'an indented line');
        if (at(i).startsWith('|')) fail(i + 1, 'a table with no blank line before it');
        para.push(at(i));
        i++;
      }
      if (!para.length) fail(i + 1, 'a line that fits no block');
      out.push(`<p>${inline(para.join('\n'), first + 1)}</p>`);
    }
  }

  if (h1 !== 1) fail(1, `${h1} first-level headings where the page needs exactly one`);
  for (const [id, line] of fragments)
    if (!ids.has(id)) fail(line, `a link to "#${id}", which no heading has`);
  return out.join('\n');
}

// ---- Pages -------------------------------------------------------------------------------

/**
 * Every page of the site, in the order of the nav. To add a page, add an entry here. The nav,
 * the footer, sitemap.xml, the canonical tag, the share tags and the structured data follow.
 * `n` is the product name as plain text.
 *
 * path         Where the page lives under SITE: '' for home, 'name/' for a page (written to
 *              name/index.html), or a file name such as '404.html'.
 * name         A few words for the nav, the footer and the breadcrumb.
 * nav          true lists the page in the top nav and the footer.
 * title        The <title>, and the title a shared link shows.
 * description  The meta description, and the text a shared link shows. Aim for 120 to 160 characters.
 * h1           The page's one main heading, as plain text. An HTML body must hold exactly one <h1>
 *              with these words. A Markdown body takes it from the file's one "# " line instead.
 * body         { md: 'FILE.md' }: a Markdown file in the repository, made into HTML by markdown()
 *              above. Links in it may go to files in the repository or to pages here ("/privacy/").
 *              Or { html: (f, page, href) => '...' }: HTML written here. `href('privacy/')` gives
 *              the address of another page from this one.
 * lastmod      'YYYY-MM-DD', the day the page's words last changed, for the sitemap. A Markdown body
 *              may leave it out and hold a line such as "Last updated: 21 November 2026." instead.
 * index        false keeps the page out of search: a noindex tag, no canonical, not in the sitemap.
 * jsonld       (f, page) => [objects] for the page's structured data. Without it, an indexed page
 *              that is not home gets a WebPage and a BreadcrumbList.
 * guide        The words of the link to this page in the home page's "Guides" list. A guide ends
 *              with one line that links the stores, and with the applies line below.
 * applies      true ends a page that is not a guide with the line "Applies to <name> <version>.
 *              Last checked <lastmod>." The version is the extension's. Set lastmod to the day
 *              someone checked the page against the product, not only the day its words changed.
 * figures      [{ src, alt, caption, before }]: real screenshots for a Markdown body, which has no
 *              pictures of its own. Each goes just before the heading whose id is `before`. `src`
 *              must be in ASSETS. Its width and height are read from the file.
 */
const PAGES = (n) => [
  {
    path: '',
    name: 'Home',
    nav: true,
    title: `${n} browser extension: write by hand on any web page`,
    description: `Free, open source browser extension. Write and draw by hand on any web page with Apple Pencil, a finger or a mouse. Your notes come back on the same words.`,
    h1: `${n} lets you write and draw by hand on any web page, with Apple Pencil, a finger or a mouse.`,
    body: { html: home },
    lastmod: '2026-11-25',
    applies: true,
    jsonld: homeData,
  },
  {
    path: 'notes-stay-after-reload/',
    name: 'Notes after a reload',
    title: `How ${n} keeps handwritten notes after a reload`,
    description: `${n} ties each handwritten note to the words under it, so it comes back after a reload or a reflow. How it works, the test results, and where it fails.`,
    body: { md: 'site/pages/notes-stay-after-reload.md' },
    lastmod: '2026-11-25',
    guide: 'How handwritten notes stay on the same words after a reload',
    figures: [
      {
        src: 'docs/media/3-reload.webp',
        alt: 'A demo article after a reload, with its ink back on the same words: an underline, two circles, a star in the margin and a highlight',
        caption:
          'After a reload, the ink is back on the words it was written on. The article is a demo page.',
        before: 'why-do-drawings-on-a-web-page-disappear-when-i-refresh',
      },
    ],
  },
  {
    path: 'apple-pencil-safari/',
    name: 'Apple Pencil in Safari',
    title: 'Write on web pages in Safari on iPad with Apple Pencil',
    description: `Write on a live web page in Safari on iPad with Apple Pencil or a finger. How to turn on the extension, fixes when the page scrolls, and limits.`,
    body: { md: 'site/pages/apple-pencil-safari.md' },
    lastmod: '2026-11-25',
    guide: 'How to write on a web page in Safari on iPad with Apple Pencil',
  },
  {
    path: 'edge-web-notes-alternative/',
    name: 'Edge after Web Notes',
    title: `Write on web pages in Edge after Web Notes: ${n}`,
    description: `Microsoft Edge no longer supports Web Notes. ${n} is a free extension for writing and drawing on the live page with a mouse, a pen or a finger.`,
    body: { md: 'site/pages/edge-web-notes-alternative.md' },
    lastmod: '2026-11-25',
    guide: 'What to use in Microsoft Edge now that Web Notes is gone',
  },
  {
    path: 'privacy/',
    name: 'Privacy policy',
    nav: true,
    title: `Privacy policy: ${n}`,
    description: `${n} has no account, no server and no analytics. This page lists what it stores, what leaves your device, and how to check each fact.`,
    body: { md: 'PRIVACY.md' },
  },
  {
    path: '404.html',
    name: 'Page not found',
    title: `Page not found: ${n}`,
    description: `This address has no page on the ${n} site.`,
    h1: 'Page not found',
    body: { html: notFound },
    index: false,
  },
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The date of a "Last updated: 21 November 2026." line, as 2026-11-21. */
function lastUpdated(text, file) {
  const m = /^Last updated: (\d{1,2}) (\w+) (\d{4})\.$/m.exec(text);
  const month = MONTHS.indexOf(m?.[2] ?? '') + 1;
  if (!m || !month) throw new Error(`${file} has no line such as "Last updated: 21 November 2026."`);
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Checks the list and adds what each page needs to know about itself. */
function plan(f, opt) {
  const seen = new Set();
  return PAGES(f.plainName).map((p) => {
    for (const k of ['name', 'title', 'description', ...(p.body?.md ? [] : ['h1'])])
      if (typeof p[k] !== 'string' || !p[k].trim()) throw new Error(`Page "${p.path}" has no ${k}`);
    if (!/^(([\w-]+\/)*|[\w-]+\.html)$/.test(p.path))
      throw new Error(`Page path "${p.path}" is not '', 'name/' or 'name.html'`);
    if (seen.has(p.path)) throw new Error(`Two pages at "${p.path}"`);
    seen.add(p.path);
    const index = p.index !== false;
    const file = p.path === '' || p.path.endsWith('/') ? `${p.path}index.html` : p.path;
    // A page that is not indexed may be served at any address, so it links from the site's root.
    const root = index ? '../'.repeat(p.path.split('/').length - 1) : BASE;
    let source = '';
    let lastmod = p.lastmod;
    if (p.body?.md) {
      const path = p.body.md === 'PRIVACY.md' ? opt.privacy : join(repo, p.body.md);
      source = readFileSync(path, 'utf8');
      p.mdName = relative(repo, path).startsWith('..') ? basename(path) : relative(repo, path);
      lastmod ??= lastUpdated(source, p.mdName);
    } else if (typeof p.body?.html !== 'function') throw new Error(`Page "${p.path}" has no body`);
    if (index && !/^\d{4}-\d{2}-\d{2}$/.test(lastmod ?? ''))
      throw new Error(`Page "${p.path}" needs a lastmod such as 2026-11-25`);
    return { ...p, index, file, root, source, lastmod, url: `${SITE}${p.path}` };
  });
}

/** A value from a verification file, as a meta tag for the home page. Nothing when there is no file. */
function verification(file, asked, meta, who) {
  if (!existsSync(file)) {
    if (asked) throw new Error(`No verification file at ${file}`);
    return '';
  }
  const raw = readFileSync(file, 'utf8').trim();
  const value = /content="([^"]*)"/.exec(raw)?.[1] ?? raw;
  if (!/^[\w-]+$/.test(value)) throw new Error(`${file} must hold only the value ${who} gives for ${meta}`);
  return `<meta name="${meta}" content="${value}">`;
}

/** Structured data as a JSON-LD block. It is data the browser does not run. */
const jsonld = (graph) =>
  `<script type="application/ld+json">\n${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2).replace(/</g, '\\u003c')}\n</script>`;

/** The structured data of a page that is not home: what the page is, and where it sits. */
function pageData(f, p) {
  return [
    {
      '@type': 'WebPage',
      '@id': `${p.url}#page`,
      url: p.url,
      name: p.title,
      description: p.description,
      isPartOf: { '@id': `${SITE}#website` },
      about: { '@id': `${SITE}#app` },
      inLanguage: 'en',
      dateModified: p.lastmod,
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: f.plainName, item: SITE },
        { '@type': 'ListItem', position: 2, name: p.name, item: p.url },
      ],
    },
  ];
}

/** The site and the product. Only stores where it is published are named. */
function homeData(f, p) {
  return [
    { '@type': 'WebSite', '@id': `${SITE}#website`, url: SITE, name: f.plainName, inLanguage: 'en' },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE}#app`,
      name: f.plainName,
      url: SITE,
      description: p.description,
      applicationCategory: 'BrowserApplication',
      // Chrome and Edge run the extension on these systems. The App Store has it for iPad.
      operatingSystem: 'Windows, macOS, Linux, ChromeOS, iPadOS 17 or later',
      downloadUrl: STORES[0].url,
      installUrl: STORES[0].url,
      isAccessibleForFree: true,
      license: 'https://opensource.org/licenses/MIT',
      inLanguage: 'en',
      image: `${SITE}assets/${SHARE.file}`,
      screenshot: [`${SITE}assets/1-writing.webp`, `${SITE}assets/3-reload.webp`],
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      sameAs: [f.repoUrl, ...STORES.map((s) => s.url)],
    },
  ];
}

/** One whole page. */
function render(f, p, all, meta) {
  const href = (path) => `${p.root}${path}` || './';
  const toPage = all.filter((q) => q.nav).map((q) => [href(q.path), q.name, q === p]);
  const repoLinks = [
    [f.repoUrl, 'Source code'],
    [`${f.repoUrl}/issues`, 'Issues'],
  ];
  const nav = [...toPage, ...repoLinks];
  const foot = [
    ...toPage,
    ...repoLinks,
    [`${f.repoUrl}/blob/main/CHANGELOG.md`, 'Changelog'],
    [`${f.repoUrl}/blob/main/LICENSE`, 'MIT licence'],
  ];
  const list = (links) =>
    links
      .map(
        ([to, text, here]) =>
          `<li><a href="${esc(to)}"${here ? ' aria-current="page"' : ''}>${esc(text)}</a></li>`,
      )
      .join('\n');

  const main = p.body.md
    ? markdown(p.source, p.mdName, (to, line, fail) => {
        if (to.startsWith('/')) {
          if (!all.some((q) => q.index && `/${q.path}` === to))
            fail(line, `a link to "${to}", which is not a page here`);
          return href(to.slice(1));
        }
        if (!existsSync(join(repo, to.split('#')[0])))
          fail(line, `a link to "${to}", which is not a file in the repository`);
        return `${f.repoUrl}/blob/main/${to}`;
      })
    : p.body.html(f, p, href, all);
  // The Markdown converter already holds a file to one "# " heading.
  const h1s = [...main.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
  if (!p.body.md && (h1s.length !== 1 || h1s[0][1] !== esc(p.h1)))
    throw new Error(`Page "${p.path}" must have one <h1> that reads "${p.h1}"`);

  const title = esc(p.title);
  const description = esc(p.description);
  const share = `${SITE}assets/${SHARE.file}`;
  const head = p.index
    ? [
        `<link rel="canonical" href="${p.url}">`,
        '<meta property="og:type" content="website">',
        `<meta property="og:site_name" content="${f.name}">`,
        `<meta property="og:title" content="${title}">`,
        `<meta property="og:description" content="${description}">`,
        `<meta property="og:url" content="${p.url}">`,
        `<meta property="og:image" content="${share}">`,
        `<meta property="og:image:width" content="${SHARE.width}">`,
        `<meta property="og:image:height" content="${SHARE.height}">`,
        `<meta property="og:image:alt" content="${esc(SHARE.alt)}">`,
        '<meta name="twitter:card" content="summary_large_image">',
        `<meta name="twitter:title" content="${title}">`,
        `<meta name="twitter:description" content="${description}">`,
        `<meta name="twitter:image" content="${share}">`,
        `<meta name="twitter:image:alt" content="${esc(SHARE.alt)}">`,
        ...(p.path === '' ? meta : []),
        jsonld((p.jsonld ?? pageData)(f, p)),
      ]
    : ['<meta name="robots" content="noindex">'];
  const home = p.path === '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<meta name="description" content="${description}">
${head.filter(Boolean).join('\n')}
<link rel="icon" type="image/png" sizes="32x32" href="${p.root}assets/pageink-mark-32-transparent.png">
<link rel="icon" type="image/svg+xml" href="${p.root}assets/pageink-mark-small.svg">
<link rel="stylesheet" href="${p.root}site.css">
</head>
<body>
<header class="top">
<a class="logo" href="${href('')}">${logo(f, p.root, home ? 276 : 166)}</a>
<nav aria-label="Pages">
<ul class="links">
${list(nav)}
</ul>
</nav>
</header>
<main>
${[withFigures(p, main), p.guide ? storeLine(f) : '', p.guide || p.applies ? applies(f, p) : ''].filter(Boolean).join('\n')}
</main>
<footer class="foot">
<nav aria-label="More">
<ul class="links">
${list(foot)}
</ul>
</nav>
<p>${f.copyright}</p>
</footer>
</body>
</html>
`;
}

/** The sitemap: every indexed page, with the day its words last changed. */
function sitemap(pages) {
  const urls = pages
    .filter((p) => p.index)
    .map((p) => `<url><loc>${p.url}</loc><lastmod>${p.lastmod}</lastmod></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

/** The logo, in the dark form where the reader's system is dark. Letters are outlines, so alt names it. */
const logo = (f, root, width) => `<picture>
<source media="(prefers-color-scheme: dark)" srcset="${root}assets/pageink-logo-dark.svg">
<img src="${root}assets/pageink-logo.svg" alt="${f.name}" width="${width}" height="${Math.round((width * 170) / 552)}">
</picture>`;

/** A page's screenshots, each put just before the heading it names. */
function withFigures(p, main) {
  let html = main;
  for (const fig of p.figures ?? []) {
    if (!ASSETS.includes(fig.src))
      throw new Error(`Page "${p.path}" shows ${fig.src}, which is not in ASSETS`);
    if (!fig.alt?.trim() || !fig.caption?.trim())
      throw new Error(`Page "${p.path}": ${fig.src} needs an alt and a caption`);
    const at = `<h2 id="${fig.before}">`;
    if (!html.includes(at)) throw new Error(`Page "${p.path}" has no heading "${fig.before}" for ${fig.src}`);
    const [w, h] = imageSize(join(repo, fig.src));
    const figure = `<figure class="shot">
<img src="${p.root}assets/${basename(fig.src)}" alt="${esc(fig.alt)}" width="${w}" height="${h}" loading="lazy" decoding="async">
<figcaption>${esc(fig.caption)}</figcaption>
</figure>`;
    html = html.replace(at, `${figure}\n${at}`);
  }
  return html;
}

/** One line with every store, for the end of a guide. The home page has the full list. */
function storeLine(f) {
  const links = STORES.map((s) => `<a href="${esc(s.url)}">${esc(s.name)}</a>`);
  if (!links.length)
    return `<p class="get"><a href="${esc(f.repoUrl)}#install-from-source">Install ${f.name} from source</a>.</p>`;
  const list = links.length > 1 ? `${links.slice(0, -1).join(', ')} or ${links.at(-1)}` : links[0];
  const soon = IN_REVIEW ? ` ${esc(IN_REVIEW)}` : '';
  return `<p class="get">Get ${f.name} free from ${list}.${soon}</p>`;
}

/** Which version a page describes, and the day it was last checked against it. */
function applies(f, p) {
  const [y, m, d] = p.lastmod.split('-').map(Number);
  return `<p class="applies">Applies to ${f.name} ${esc(f.version)}. Last checked ${d} ${MONTHS[m - 1]} ${y}.</p>`;
}

function getIt(f) {
  const source = `<a href="${esc(f.repoUrl)}#install-from-source">Install from source</a>`;
  if (!STORES.length)
    return `<p>${f.name} is not in any browser store yet. ${source} shows how to build it and load it into Chrome, Edge, Firefox or Safari.</p>`;
  const items = STORES.map((s) => {
    if (!/^https:\/\//.test(s.url ?? '') || !s.name)
      throw new Error('Each STORES entry needs a name and an https url');
    return `<li><a href="${esc(s.url)}">${esc(s.name)}</a></li>`;
  });
  const soon = IN_REVIEW ? `${esc(IN_REVIEW)} ` : '';
  return `<ul class="stores">\n${items.join('\n')}\n</ul>\n<p>${soon}${source} shows how to build it yourself.</p>`;
}

/** Every sentence here restates README.md or PRIVACY.md. Change those first, then this. */
function home(f, p, href, all) {
  const n = f.name;
  const guides = all
    .filter((q) => q.guide)
    .map((q) => `<li><a href="${href(q.path)}">${esc(q.guide)}</a></li>`);
  const reload = all.find((q) => q.path === 'notes-stay-after-reload/');
  const sameWords = 'stays on the same words when the page changes or reflows';
  return `<h1 class="lead">${esc(p.h1)}</h1>
<p>The ${n} browser extension keeps your ink on your device. The ink loads with the page and ${reload ? `<a href="${href(reload.path)}">${sameWords}</a>` : sameWords}. The extension runs in Chrome and Edge, and an app brings it to Safari on iPad. ${n} is also a library any site can add to its own pages.</p>
<section>
<h2>How to write on a web page with the extension</h2>
<ol>
<li>Add ${n} to Chrome or Edge from ${
    STORES.filter((s) => /Chrome|Edge/.test(s.name))
      .map((s) => `<a href="${esc(s.url)}">${esc(s.name)}</a>`)
      .join(' or ') || 'its store'
  }. Chrome or Edge 119 or later is needed.</li>
<li>Open any web page. Click the ${n} button in the toolbar, then <strong>Draw on this page</strong>. The button then reads <strong>Drawing on</strong>. You can also press Alt+Shift+D, the suggested shortcut.</li>
<li>Write with the mouse, the trackpad or a finger. A bar with the tools shows on the page.</li>
<li>Press Esc to stop. Open the page another day, and the ink loads with it.</li>
</ol>
<p>For a quick mark, hold Alt and drag with the mouse, with no need to turn on Draw. With a pen, touch the page and write. No switch is needed, and a finger still scrolls.</p>
</section>
<div class="shots">
<figure>
<img src="assets/1-writing.webp" alt="Writing on an article with a pen" width="1280" height="800">
<figcaption>Write on any page with a pen, a finger or a mouse.</figcaption>
</figure>
<figure>
<img src="assets/3-reload.webp" alt="The same ink back on the page after a reload" width="1280" height="800" loading="lazy" decoding="async">
<figcaption>The same ink is back on the page after a reload.</figcaption>
</figure>
</div>
${FILM ? `<p><a href="${esc(FILM)}">Watch the one-minute film</a> of it in use. The link opens YouTube.</p>` : ''}
<p>${n} is free and open source under the MIT licence. There is no account with us and no server of ours. Apart from reading an open PDF once more for its viewer, the extension talks to nobody unless you connect your own cloud, and then only to that cloud.</p>
<section>
<h2>Get ${n}</h2>
${getIt(f)}
</section>
${guides.length ? `<section>\n<h2>Guides</h2>\n<ul>\n${guides.join('\n')}\n</ul>\n</section>` : ''}
<section>
<h2>What you can do with it</h2>
<ul>
<li>Write and draw by hand on any web page. On an iPad, Apple Pencil writes and a finger still scrolls. A pen on a Windows touch screen writes the same way. So far, pen input has been tested only with simulated input, not on a real iPad or a real Windows pen.</li>
<li>With a mouse, a trackpad or a finger, switch on Draw and write.</li>
<li>Highlight and underline words. A straight highlighter or pen line over text becomes a mark on those words, and it is redrawn on them at any width.</li>
<li>Annotate PDFs in the extension's own viewer. In Chrome and Edge a PDF opens there by itself. In Safari, you pick the file.</li>
<li>Come back later and your notes are on the same words. If a passage is gone, its note waits in a tray with its words.</li>
<li>Save a page with its ink as a picture, save your notes as a Markdown file, or print the page with its ink.</li>
<li>Keep a copy in a folder you choose, or in your own Google Drive or OneDrive, and see the same notes on another device. So far, Google Drive and OneDrive have been tested only against local stand-ins for the services, and some points still need a check with the real ones.</li>
</ul>
</section>
<section class="panel">
<h2>Why ${n} asks for Google Drive or OneDrive access</h2>
<p>You do not need a cloud to use ${n}. Your notes live in the browser's storage for the extension.</p>
<p>If you choose, you can keep a copy of your notes in your own Google Drive or OneDrive. ${n} asks for access only then, when you click to connect. It uses that access only to show, keep and sync your own notes, so a second device that connects the same place gets them too.</p>
<ul>
<li>Each page you wrote on becomes one small file in your Drive or OneDrive.</li>
<li>In Google Drive, ${n} can reach only the files it made itself, in one folder you can see in your Drive. It asks for the <code>drive.file</code> scope and no other.</li>
<li>In OneDrive, ${n} can reach only its own app folder.</li>
<li>It cannot see anything else in your Drive or OneDrive.</li>
<li>When you connect Google Drive, ${n} reads your account's email address from Google, to show which account is connected and to renew the sign-in without asking again. The address is kept on your device, and Disconnect removes it.</li>
<li>Your notes go straight from your device to your own Drive or OneDrive. We have no servers and receive nothing.</li>
<li>Your data is not sold and is not used for advertising.</li>
<li>You can disconnect at any time. ${n} then asks whether to keep the files or delete them.</li>
</ul>
<p>The <a href="${href('privacy/')}">privacy policy</a> has every detail and says how to check each one.</p>
</section>
<section>
<h2>About ${n}</h2>
<p>${n} is an open source project on GitHub. You can read the code, build it and change it. To report a problem or ask a question, <a href="${esc(f.repoUrl)}/issues">open an issue on GitHub</a>.</p>
<p>The <a href="${esc(f.repoUrl)}/blob/main/CHANGELOG.md">changelog</a> lists what changed in each version.</p>
</section>`;
}

function notFound(f, p, href) {
  return `<h1>${esc(p.h1)}</h1>
<p>There is no page at this address. Go to the <a href="${href('')}">${f.name} home page</a>, or read the <a href="${href('privacy/')}">privacy policy</a>.</p>`;
}

// ---- Main --------------------------------------------------------------------------------

function options(argv) {
  const o = {
    out: join(here, 'dist'),
    privacy: join(repo, 'PRIVACY.md'),
    verification: join(here, 'verification.txt'),
    bing: join(here, 'bing-verification.txt'),
  };
  const named = ['--privacy', '--verification', '--bing'];
  const given = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = named.includes(a) ? a.slice(2) : a.startsWith('-') ? '' : 'out';
    const value = key === 'out' ? a : argv[++i];
    if (!key || !value || given.has(key)) throw new Error(`Cannot read the argument "${a}"`);
    o[key] = resolve(value);
    given.add(key);
  }
  return { ...o, given };
}

try {
  const o = options(process.argv.slice(2));
  const f = facts();
  const meta = [
    verification(o.verification, o.given.has('verification'), 'google-site-verification', 'Search Console'),
    verification(o.bing, o.given.has('bing'), 'msvalidate.01', 'Bing Webmaster Tools'),
  ];
  const pages = plan(f, o);
  // Every page is made before anything is written, so a failed build leaves no half site.
  const files = {
    ...Object.fromEntries(pages.map((p) => [p.file, render(f, p, pages, meta)])),
    'sitemap.xml': sitemap(pages),
    'site.css': readFileSync(join(here, 'site.css'), 'utf8'),
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(o.out, name)), { recursive: true });
    writeFileSync(join(o.out, name), text);
  }
  mkdirSync(join(o.out, 'assets'), { recursive: true });
  for (const a of ASSETS) copyFileSync(join(repo, a), join(o.out, 'assets', basename(a)));
  console.log(`Site written to ${o.out}`);
} catch (e) {
  console.error(`Site build failed. ${e.message}`);
  process.exit(1);
}
