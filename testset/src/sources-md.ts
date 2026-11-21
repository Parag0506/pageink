// Writes SOURCES.md: source, licence and attribution for every pair, and whether its frozen copy
// is committed or fetched on demand.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, loadSources, type Pair, pairDir, ROOT, splitOf } from './sources.ts';

/**
 * Where the shared stylesheets in `fixtures/_css/` come from, per site, and their licences.
 * Each was checked against the project's own licence file. Files whose licence states no
 * permission to share them are listed in `unclear` by name. The freezer drops Wayback Machine
 * toolbar styles and font-service rules, so those are not kept here.
 */
const STYLESHEETS: Record<string, { origin: string; unclear?: Record<string, string> }> = {
  'en.wikipedia.org': {
    origin:
      'MediaWiki core, the Vector skin and extensions such as Cite, Popups and CentralNotice, served by ResourceLoader: GPL-2.0-or-later (https://github.com/wikimedia/mediawiki/blob/master/COPYING). The Codex design system: GPL-2.0-or-later. OOUI: MIT (https://github.com/wikimedia/oojs-ui). Site, gadget, banner and template styles are wiki pages, under CC BY-SA 4.0 like the text.',
  },
  'developer.mozilla.org': {
    origin: "MDN's front end, mdn/yari: MPL-2.0 (https://github.com/mdn/yari). One file is empty.",
  },
  'doc.rust-lang.org': {
    origin:
      "The mdBook theme, its highlight themes and its fonts.css: MPL-2.0 (https://github.com/rust-lang/mdBook). Font Awesome 4.7 CSS: MIT, as its header says. The book's own styles (rust-lang/book, theme/): MIT or Apache-2.0.",
  },
  'docs.djangoproject.com': {
    origin:
      'The djangoproject.com site styles: BSD-3-Clause (https://github.com/django/djangoproject.com), with normalize.css and Font Awesome 4.2 CSS bundled in, both MIT, as their headers say.',
  },
  'docs.python.org': {
    origin:
      "Sphinx's basic and classic themes: BSD-2-Clause (https://github.com/sphinx-doc/sphinx). Pygments styles: BSD-2-Clause. python-docs-theme: PSF License Version 2 (https://github.com/python/python-docs-theme).",
  },
  'nodejs.org': {
    origin:
      'The Node.js API docs styles, doc/api_assets/style.css and hljs.css in nodejs/node: MIT (https://github.com/nodejs/node/blob/main/LICENSE).',
  },
  'arxiv.org': {
    origin:
      "arXiv's design system and its fonts.css: MIT (https://github.com/arXiv/design-system). ar5iv-css: MIT (https://github.com/dginev/ar5iv-css). The page's own inline styles come from the same design system.",
  },
};

/** Every stylesheet in fixtures/_css, with the committed pairs that use it. */
function stylesheetUse(pairs: Pair[]): Map<string, Set<string>> {
  const dir = join(FIXTURES, '_css');
  const use = new Map<string, Set<string>>();
  if (!existsSync(dir)) return use;
  for (const f of readdirSync(dir)) if (f.endsWith('.css')) use.set(f, new Set());
  for (const p of pairs) {
    const d = pairDir(p);
    const meta = join(d, 'meta.json');
    const names = new Set<string>();
    if (existsSync(meta))
      for (const n of (JSON.parse(readFileSync(meta, 'utf8')).css ?? []) as string[]) names.add(n);
    for (const v of ['a.html', 'b.html']) {
      const f = join(d, v);
      if (existsSync(f))
        for (const m of readFileSync(f, 'utf8').matchAll(/_css\/([0-9a-f]{16}\.css)/g)) names.add(m[1]!);
    }
    for (const n of names) use.get(n)?.add(p.id);
  }
  return use;
}

/** The site a pair was frozen from, past any web archive prefix. */
function siteOf(p: Pair): string {
  const u = p.a.url.replace(/^https?:\/\/web\.archive\.org\/web\/\d+[a-z_]*\//, '');
  try {
    return new URL(u).host;
  } catch {
    return p.kind;
  }
}

function stylesheetLines(pairs: Pair[]): string[] {
  const use = stylesheetUse(pairs);
  const byId = new Map(pairs.map((p) => [p.id, p]));
  const bySite = new Map<string, { files: Set<string>; pairs: Set<string> }>();
  const unused: string[] = [];
  for (const [f, ids] of use) {
    if (!ids.size) unused.push(f);
    for (const id of ids) {
      const site = siteOf(byId.get(id)!);
      const e = bySite.get(site) ?? { files: new Set(), pairs: new Set() };
      e.files.add(f);
      e.pairs.add(id);
      bySite.set(site, e);
    }
  }
  const rows = [...bySite.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([site, e]) => `| ${site} | ${e.files.size} | ${STYLESHEETS[site]?.origin ?? 'not checked'} |`);
  const unclear = Object.entries(STYLESHEETS).flatMap(([site, s]) =>
    Object.entries(s.unclear ?? {}).map(
      ([f, why]) =>
        `- \`${f}\` (${site}): ${why} Used by ${[...(use.get(f) ?? [])].sort().join(', ') || 'no pair'}.`,
    ),
  );
  return [
    '## Stylesheets',
    '',
    `The ${use.size} stylesheets in \`fixtures/_css/\` are the pages' own, saved by content hash and shared between pairs. Font and image addresses in them are removed.`,
    '',
    '| source | files | origin and licence |',
    '| --- | --- | --- |',
    ...rows,
    '',
    ...(unclear.length
      ? [
          'These files state no licence that allows sharing them. They are kept only as part of the frozen pages:',
          '',
          ...unclear,
          '',
        ]
      : []),
    ...(unused.length ? [`Not used by any pair: ${unused.sort().join(', ')}.`, ''] : []),
  ];
}

export function writeSourcesMd(): void {
  const s = loadSources();
  const rows = s.pairs.map((p) => {
    const meta = join(pairDir(p), 'meta.json');
    const sums = existsSync(meta)
      ? (JSON.parse(readFileSync(meta, 'utf8')) as { a: { sha256: string }; b: { sha256: string } })
      : null;
    const where =
      p.kind === 'synthetic' || p.kind === 'dynamic'
        ? 'committed, written for this set'
        : p.commit
          ? 'committed'
          : 'fetch on demand';
    const link = (v: { url: string; label: string }) =>
      v.url.startsWith('http') ? `[${v.label}](${v.url})` : `\`${v.url}\``;
    const sum = sums ? `${sums.a.sha256.slice(0, 12)} / ${sums.b.sha256.slice(0, 12)}` : 'not fetched';
    return `| ${p.id} | ${p.kind} | ${splitOf(p) === 'heldout' ? 'held out' : 'tuning'} | ${link(p.a)} | ${link(p.b)} | ${p.license} | ${p.attribution.replace(/\|/g, '/')} | ${where} | ${sum} |`;
  });
  const committed = s.pairs.filter((p) => p.commit).length;
  const own = s.pairs.filter((p) => p.kind === 'synthetic' || p.kind === 'dynamic').length;
  const md = [
    '# Test set sources',
    '',
    'Every content pair, where it comes from, its licence and attribution.',
    'Only pairs whose licence allows redistribution have their frozen copies committed under `fixtures/`.',
    'The rest are fetched on demand into `cache/`, which is never committed.',
    'Changes made in freezing: the text, structure and stylesheets are kept. Scripts, frames, fonts and other remote resources are removed. Images are replaced by blank pictures of the same size during replay.',
    '',
    `${s.pairs.length} pairs: ${own} written for this set, ${committed - own} frozen from public sources and committed, ${s.pairs.length - committed} fetch on demand.`,
    '',
    'Wikipedia text is available under the Creative Commons Attribution-ShareAlike 4.0 licence (https://creativecommons.org/licenses/by-sa/4.0/).',
    'MDN Web Docs prose by Mozilla Contributors is available under CC BY-SA 2.5 (https://creativecommons.org/licenses/by-sa/2.5/).',
    'Python documentation is copyright the Python Software Foundation and used under the PSF License Version 2.',
    'The Rust Programming Language book is available under the MIT or Apache 2.0 licences.',
    'Django documentation is available under the BSD 3-Clause licence. Node.js documentation is available under the MIT licence.',
    'arXiv papers are committed only when the paper carries a CC BY or CC BY-SA licence.',
    '',
    'Held-out pairs were chosen by rule before any tuning (README, "Tuning and held-out pairs").',
    "A version shared by two pairs (the same revision) is stored once, in the first pair's folder.",
    '',
    '| pair | kind | split | version A | version B | licence | attribution | copy | sha256 A / B |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...stylesheetLines(s.pairs.filter((p) => p.commit)),
  ].join('\n');
  writeFileSync(join(ROOT, 'SOURCES.md'), md);
}

if (process.argv[1]?.endsWith('sources-md.ts')) writeSourcesMd();
