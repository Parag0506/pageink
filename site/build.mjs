// Builds the project's home page and its privacy page as plain files. It uses no packages and
// the pages load nothing from another server.
//
// Usage: node site/build.mjs [out folder] [--privacy <file>] [--verification <file>]
//
// The out folder defaults to site/dist. The privacy page is made from PRIVACY.md at build time,
// so the two cannot differ. The converter below knows only the Markdown that file uses. On
// anything else it stops the build and names the line, so nothing is ever printed wrong.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const here = import.meta.dirname;
const repo = resolve(here, '..');

/**
 * Store listings. Add one entry per store once the extension is published there, for example
 * { name: 'Chrome Web Store', url: 'https://...' }. While the list is empty the home page shows
 * no store links and says the extension is built from source.
 */
const STORES = [];

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
];

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

  return { name: esc(name), repoUrl, copyright: `Copyright &copy; ${esc(owner)}` };
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
 * of a link into an address.
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

/** The Search Console value, as a meta tag for the home page. Nothing when there is no file. */
function verification(file, asked) {
  if (!existsSync(file)) {
    if (asked) throw new Error(`No verification file at ${file}`);
    return '';
  }
  const raw = readFileSync(file, 'utf8').trim();
  const value = /content="([^"]*)"/.exec(raw)?.[1] ?? raw;
  if (!/^[\w-]+$/.test(value))
    throw new Error(`${file} must hold only the value Search Console gives for google-site-verification`);
  return `<meta name="google-site-verification" content="${value}">`;
}

function page({ f, root, title, description, head, top, main }) {
  const nav = [
    root ? [root, 'Home'] : ['privacy/', 'Privacy policy'],
    [f.repoUrl, 'Source code'],
    [`${f.repoUrl}/issues`, 'Issues'],
  ];
  const foot = [
    [`${root}privacy/`, 'Privacy policy'],
    [f.repoUrl, 'Source code'],
    [`${f.repoUrl}/issues`, 'Issues'],
    [`${f.repoUrl}/blob/main/LICENSE`, 'MIT licence'],
  ];
  const list = (links) => links.map(([to, text]) => `<li><a href="${esc(to)}">${text}</a></li>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<meta name="description" content="${description}">
${head ? `${head}\n` : ''}<link rel="icon" type="image/png" sizes="32x32" href="${root}assets/pageink-mark-32-transparent.png">
<link rel="icon" type="image/svg+xml" href="${root}assets/pageink-mark-small.svg">
<link rel="stylesheet" href="${root}site.css">
</head>
<body>
<header class="top">
${top}
<nav aria-label="Pages">
<ul class="links">
${list(nav)}
</ul>
</nav>
</header>
<main>
${main}
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

/** The logo, in the dark form where the reader's system is dark. Letters are outlines, so alt names it. */
const logo = (f, root, width) => `<picture>
<source media="(prefers-color-scheme: dark)" srcset="${root}assets/pageink-logo-dark.svg">
<img src="${root}assets/pageink-logo.svg" alt="${f.name}" width="${width}" height="${Math.round((width * 170) / 552)}">
</picture>`;

function getIt(f) {
  const source = `<a href="${esc(f.repoUrl)}#install-from-source">Install from source</a>`;
  if (!STORES.length)
    return `<p>${f.name} is not in any browser store yet. ${source} shows how to build it and load it into Chrome, Edge, Firefox or Safari.</p>`;
  const items = STORES.map((s) => {
    if (!/^https:\/\//.test(s.url ?? '') || !s.name)
      throw new Error('Each STORES entry needs a name and an https url');
    return `<li><a href="${esc(s.url)}">${esc(s.name)}</a></li>`;
  });
  return `<ul>\n${items.join('\n')}\n</ul>\n<p>${source} shows how to build it yourself.</p>`;
}

/** Every sentence here restates README.md or PRIVACY.md. Change those first, then this. */
function home(f, meta) {
  const n = f.name;
  const lead = `${n} lets you write and draw by hand on any web page, with a pen, a finger or a mouse.`;
  return page({
    f,
    root: '',
    title: `${n}: write and draw by hand on any web page`,
    description: lead,
    head: meta,
    top: `<h1 class="logo">${logo(f, '', 276)}</h1>`,
    main: `<p class="lead">${lead}</p>
<p>Your ink loads with the page, stays for good, and stays on the same words when the page changes or reflows. It is a browser extension for Chrome, Edge, Firefox and Safari, and a library any site can add to its own pages.</p>
<p>${n} is free and open source under the MIT licence. There is no account with us and no server of ours. Apart from reading an open PDF once more for its viewer, the extension talks to nobody unless you connect your own cloud, and then only to that cloud.</p>
<div class="shots">
<figure>
<img src="assets/1-writing.webp" alt="Writing on an article with a pen" width="1280" height="800">
<figcaption>Write on any page with a pen, a finger or a mouse.</figcaption>
</figure>
<figure>
<img src="assets/3-reload.webp" alt="The same ink back on the page after a reload" width="1280" height="800">
<figcaption>The same ink is back on the page after a reload.</figcaption>
</figure>
</div>
${FILM ? `<p><a href="${esc(FILM)}">Watch the one-minute film</a> of it in use. The link opens YouTube.</p>` : ''}
<section>
<h2>Get ${n}</h2>
${getIt(f)}
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
<p>The <a href="privacy/">privacy policy</a> has every detail and says how to check each one.</p>
</section>`,
  });
}

function privacy(f, file) {
  const link = (to, line, fail) => {
    const path = to.split('#')[0];
    if (!existsSync(join(repo, path))) fail(line, `a link to "${to}", which is not a file in the repository`);
    return `${f.repoUrl}/blob/main/${to}`;
  };
  const name = relative(repo, file).startsWith('..') ? basename(file) : relative(repo, file);
  return page({
    f,
    root: '../',
    title: `Privacy policy: ${f.name}`,
    description: `How ${f.name} uses, keeps and shares your data.`,
    head: '',
    top: `<a class="logo" href="../">${logo(f, '../', 166)}</a>`,
    main: markdown(readFileSync(file, 'utf8'), name, link),
  });
}

// ---- Main --------------------------------------------------------------------------------

function options(argv) {
  const o = {
    out: join(here, 'dist'),
    privacy: join(repo, 'PRIVACY.md'),
    verification: join(here, 'verification.txt'),
  };
  const given = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a === '--privacy' || a === '--verification' ? a.slice(2) : a.startsWith('-') ? '' : 'out';
    const value = key === 'out' ? a : argv[++i];
    if (!key || !value || given.has(key)) throw new Error(`Cannot read the argument "${a}"`);
    o[key] = resolve(value);
    given.add(key);
  }
  return { ...o, verificationAsked: given.has('verification') };
}

try {
  const o = options(process.argv.slice(2));
  const f = facts();
  // Both pages are made before anything is written, so a failed build leaves no half site.
  const files = {
    'index.html': home(f, verification(o.verification, o.verificationAsked)),
    'privacy/index.html': privacy(f, o.privacy),
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
