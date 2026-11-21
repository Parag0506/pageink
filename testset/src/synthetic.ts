// Hand-written synthetic pairs. Each one isolates a single change to the same article.
// Also writes the dynamic fixtures: a lazy article, an infinite list and a page app with recycled nodes.
// All text here is original and released with the repo under its MIT licence.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, loadSources, type Pair, saveSources } from './sources.ts';

type Block =
  | { t: 'p'; text: string }
  | { t: 'html'; html: string }
  | { t: 'fig'; img: string; alt: string; caption: string }
  | { t: 'table'; caption: string; rows: string[][] }
  | { t: 'ul'; items: string[] }
  | { t: 'quote'; text: string };

interface Section {
  id: string;
  title: string;
  blocks: Block[];
}

const svg = (fill: string, shape: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="480" height="270" fill="${fill}"/>${shape}</svg>`,
  )}`;
const LIGHTHOUSE = svg(
  '#cfe3f0',
  '<rect x="220" y="60" width="40" height="180" fill="#b33"/><polygon points="210,60 270,60 240,30" fill="#333"/><rect x="0" y="240" width="480" height="30" fill="#4a6"/>',
);
const LENS = svg(
  '#f3ead2',
  '<circle cx="240" cy="135" r="90" fill="none" stroke="#a80" stroke-width="12"/><circle cx="240" cy="135" r="40" fill="#fc6"/>',
);
const KEEPER = svg(
  '#e6e0f0',
  '<circle cx="240" cy="90" r="40" fill="#865"/><rect x="190" y="140" width="100" height="110" fill="#558"/>',
);

const ARTICLE: Section[] = [
  {
    id: 'origins',
    title: 'Origins of the coastal light',
    blocks: [
      {
        t: 'p',
        text: 'Long before engineers drew plans for stone towers, fishing villages kept a fire burning on the highest rock above the harbour. A boy or an old sailor fed the flames through the night, and boats returning late steered by the glow. The custom was practical rather than grand, and most of these early beacons left no trace beyond a blackened patch of ground.',
      },
      {
        t: 'p',
        text: 'The first purpose-built towers appeared where trade routes crowded into narrow channels. Merchants paid a small toll for each cargo that passed, and the money bought timber, coal and the wages of a keeper. Records from several ports show that the toll was resented in good years and gladly paid after a winter of wrecks.',
      },
      {
        t: 'fig',
        img: LIGHTHOUSE,
        alt: 'A red tower on a green headland',
        caption: 'Figure 1. A simple tower of the kind built on many headlands in the early period.',
      },
      {
        t: 'p',
        text: 'Coal fires gave way to oil lamps once glass could be made clear enough to shelter a flame from the wind. An oil lamp burned more steadily and needed less tending, which allowed one keeper to manage a light alone. The change also moved the flame indoors, behind panes that salt spray quickly dulled.',
      },
    ],
  },
  {
    id: 'optics',
    title: 'Lenses and reflectors',
    blocks: [
      {
        t: 'p',
        text: 'A bare flame sends light in every direction, and most of it is wasted on the sky and the land behind the tower. Polished metal reflectors were the first answer. A curved dish placed behind each lamp gathered the stray light and threw it out toward the sea in a tighter beam.',
      },
      {
        t: 'p',
        text: 'The stepped lens changed everything. By cutting a large lens into rings of glass, each ring bending light by the right amount, makers produced an optic that was thin, light and remarkably bright. A single lamp behind such a lens could be seen from distances that had needed a dozen lamps before.',
      },
      {
        t: 'fig',
        img: LENS,
        alt: 'Concentric rings of a stepped lens',
        caption: 'Figure 2. Rings of glass in a stepped lens, seen from the front.',
      },
      {
        t: 'table',
        caption: 'Table 1. Typical range of a light by optic type',
        rows: [
          ['Optic', 'Lamps', 'Range in clear weather'],
          ['Open fire', 'none', 'about 5 nautical miles'],
          ['Metal reflectors', '10 to 20', 'about 12 nautical miles'],
          ['Stepped lens, first order', '1', 'about 20 nautical miles'],
          ['Stepped lens, fourth order', '1', 'about 14 nautical miles'],
        ],
      },
      {
        t: 'p',
        text: 'Lenses were graded by size into orders, the largest standing taller than a person and weighing several tonnes. Smaller orders served harbour entrances and river mouths, where a ship needed to see the light only for the last few miles of its approach.',
      },
    ],
  },
  {
    id: 'keepers',
    title: 'The life of a keeper',
    blocks: [
      {
        t: 'p',
        text: 'Keeping a light was steady, lonely work. The lamp had to be lit at sunset and put out at dawn, the wick trimmed through the night, and the glass cleaned every morning. Many keepers wrote a short entry in the log at each change of watch, noting the wind, the sea and any vessel in sight.',
      },
      {
        t: 'quote',
        text: 'The glass must be cleaned before breakfast, for a dirty lens is a dark lens, and a dark lens is no light at all.',
      },
      {
        t: 'ul',
        items: [
          'Light the lamp at sunset and record the time.',
          'Trim the wick every four hours through the night.',
          'Wind the clockwork that turns the lens.',
          'Clean the glass and polish the brass each morning.',
          'Report any wreck or vessel in distress at once.',
        ],
      },
      {
        t: 'fig',
        img: KEEPER,
        alt: 'A keeper in a blue coat',
        caption: 'Figure 3. A keeper in the working coat issued by most services.',
      },
      {
        t: 'p',
        text: 'Families often lived at the station, and children learned to read the weather before they learned their letters. Supplies came by boat when the sea allowed, which on exposed rocks could mean weeks of waiting. Stations on the mainland were easier, with a garden, a cow and neighbours within a day of walking.',
      },
    ],
  },
  {
    id: 'automation',
    title: 'Automation and the end of the keepers',
    blocks: [
      {
        t: 'p',
        text: 'Electric lamps arrived at the larger stations first, followed by switches that turned the light on when daylight faded. Each improvement removed one of the duties in the keeper list, and by the middle of the last century a single technician could look after several lights from a shore base.',
      },
      {
        t: 'p',
        text: 'The last resident keepers left their towers within living memory. Some stations were sold as houses or turned into small museums, while others stand empty with only a modern lamp on the gallery. Ships now carry satellite receivers, yet many captains still say that nothing reassures like a familiar light coming over the horizon.',
      },
      {
        t: 'p',
        text: 'Preservation groups now raise money to repaint towers and repair lens rooms. Their volunteers guide visitors up the spiral stairs and explain how the clockwork once turned a tonne of glass with a weight no heavier than a bucket of sand.',
      },
    ],
  },
];

const CSS = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fdfcf9; --muted: #666; --rule: #ccc; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 18px/1.6 Georgia, 'Times New Roman', serif; }
header.site { padding: 12px 24px; border-bottom: 1px solid var(--rule); font: 14px/1.4 system-ui, sans-serif; }
main.article { max-width: 680px; margin: 0 auto; padding: 24px 24px 120px; }
h1 { font-size: 2.1rem; line-height: 1.2; margin: 0.4em 0; }
h2 { font-size: 1.45rem; margin: 1.6em 0 0.5em; }
p { margin: 0 0 1em; }
figure { margin: 1.4em 0; }
figure img { display: block; width: 100%; height: auto; }
figcaption { font-size: 0.85rem; color: var(--muted); margin-top: 0.4em; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; margin: 1.4em 0; }
caption { text-align: left; font-size: 0.85rem; color: var(--muted); padding-bottom: 0.4em; }
td, th { border: 1px solid var(--rule); padding: 4px 8px; text-align: left; }
blockquote { margin: 1.2em 0; padding-left: 1em; border-left: 3px solid var(--rule); font-style: italic; }
aside.summary { border: 1px solid var(--rule); padding: 8px 16px; margin: 1em 0; font-size: 0.95rem; }
@media (max-width: 500px) { body { font-size: 16px; } main.article { padding: 12px 16px 80px; } }
`;

const SIDE_CSS = `
.with-side { display: flex; align-items: flex-start; }
nav.side { position: sticky; top: 0; display: flex; width: 260px; height: 100vh; font: 14px/1.5 system-ui, sans-serif; }
nav.side .toc { flex: 1; padding: 8px 12px; overflow: hidden; }
nav.side .collapse { width: 14px; height: 100vh; background: #eee; text-align: center; cursor: pointer; }
.with-side main.article { margin: 0 0 0 30px; }
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

interface RenderOpts {
  /** Rename every id and class and wrap blocks in an extra div. */
  renamed?: boolean;
  /** Extra HTML placed right after the title. */
  lead?: string;
  script?: string;
  title?: string;
  /** A sticky sidebar with a table of contents and a tall collapse button, left of the article. */
  sidebar?: string[];
}

function renderBlock(b: Block, cls: (s: string) => string): string {
  switch (b.t) {
    case 'p':
      return `<p>${esc(b.text)}</p>`;
    case 'html':
      return b.html;
    case 'quote':
      return `<blockquote><p>${esc(b.text)}</p></blockquote>`;
    case 'fig':
      return `<figure class="${cls('figure')}"><img src="${b.img}" alt="${esc(b.alt)}" width="480" height="270"><figcaption>${esc(b.caption)}</figcaption></figure>`;
    case 'ul':
      return `<ul class="${cls('steps')}">${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    case 'table': {
      const [head, ...rows] = b.rows;
      return `<table class="${cls('data')}"><caption>${esc(b.caption)}</caption><thead><tr>${head!.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
  }
}

export function renderArticle(sections: Section[], o: RenderOpts = {}): string {
  const cls = (s: string) => (o.renamed ? `x-${s}-v2` : s);
  const id = (s: string) => (o.renamed ? `sec-${s}-2` : s);
  const body = sections
    .map((s) => {
      const inner = s.blocks.map((b) => renderBlock(b, cls)).join('\n');
      const wrapped = o.renamed ? `<div class="x-body">${inner}</div>` : inner;
      return `<section id="${id(s.id)}" class="${cls('section')}"><h2 id="${id(`h-${s.id}`)}">${esc(s.title)}</h2>\n${wrapped}</section>`;
    })
    .join('\n');
  const main = `<main class="${o.renamed ? 'x-main article' : 'article'}"><h1 id="${id('title')}">${esc(o.title ?? 'A Short History of Coastal Lights')}</h1>\n${o.lead ?? ''}\n${body}</main>`;
  const shell = o.renamed ? `<div class="x-shell">${main}</div>` : main;
  const page = o.sidebar
    ? `<div class="with-side"><nav class="side" role="navigation"><div class="toc"><h3>Contents</h3><ul>${o.sidebar.map((x) => `<li><a href="#">${esc(x)}</a></li>`).join('')}</ul></div><div class="collapse" title="Collapse sidebar">«</div></nav>${shell}</div>`
    : shell;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title ?? 'A Short History of Coastal Lights')}</title><style>${CSS}${o.sidebar ? SIDE_CSS : ''}</style></head>
<body><header class="${cls('site')}">Ink test set, synthetic article</header>
${page}
${o.script ? `<script>${o.script}</script>` : ''}
</body></html>
`;
}

const clone = (s: Section[]): Section[] => JSON.parse(JSON.stringify(s)) as Section[];
const sec = (s: Section[], id: string) => s.find((x) => x.id === id)!;
const para = (s: Section, i: number) => s.blocks.filter((b) => b.t === 'p')[i] as { t: 'p'; text: string };

const TOC = ARTICLE.map((s) => s.title);

/** The base article with a short note paragraph repeated word for word at the end of every section. */
function withTwins(s: Section[]): Section[] {
  const out = clone(s);
  for (const x of out) {
    x.blocks.push({
      t: 'p',
      text: 'Note: the keepers of this period wrote their logs in ink and never in pencil, so that no entry could be quietly changed after a wreck had been reported to the harbour board.',
    });
  }
  return out;
}

/** Footnote markers after every paragraph, numbered in order from `first`. */
function withFootnotes(s: Section[], first: number): Section[] {
  const out = clone(s);
  let n = first;
  for (const x of out) for (const b of x.blocks) if (b.t === 'p') b.text = `${b.text}[${n++}]`;
  return out;
}

// ---------------------------------------------------------------------------
// Collapsed content: the same article with one part that can close. A has it open. In the
// collapse pairs B has it closed, so notes on it must hide with it. In the reopen pairs B is
// served closed and a script opens it at load, so notes on it must be back in place.
// ---------------------------------------------------------------------------

type Fold = 'details' | 'accordion' | 'tabs' | 'menu';

const FOLD_CSS = `
.acc { overflow: hidden; transition: height 0.3s ease; }
.acc.shut { height: 0; }
.tabs [role=tablist] { display: flex; gap: 8px; font: 14px/1.4 system-ui, sans-serif; margin: 0 0 1em; }
.tabs [role=tab] { border: 1px solid var(--rule); padding: 2px 10px; }
.menu { border: 1px solid var(--rule); padding: 4px 16px; margin: 0 0 1em; }
.menu.closed ul { display: none; }
.menu h3 { font: 600 15px/1.4 system-ui, sans-serif; margin: 6px 0; }
`;

/** Text of the second tab, written for this test set. */
const OTHER_TAB =
  'A second tab holds a short glossary instead. A lantern room is the glazed chamber at the top of a tower, and a gallery is the narrow walkway that runs around it, where keepers stood to clean the outer panes in any weather.';

/** The article with the optics section (or the duty list, for a menu) inside a part that can close. */
function folded(kind: Fold, open: boolean, reopen = false): string {
  const s = clone(ARTICLE);
  const target = sec(s, kind === 'menu' ? 'keepers' : 'optics');
  const inner = (blocks: Block[]) => blocks.map((b) => renderBlock(b, (x) => x)).join('\n');
  let script = '';
  if (kind === 'menu') {
    const i = target.blocks.findIndex((b) => b.t === 'ul');
    const list = target.blocks[i]!;
    target.blocks[i] = {
      t: 'html',
      html: `<div class="menu${open ? '' : ' closed'}" id="duties"><h3>Station duties</h3>${inner([list])}</div>`,
    };
    script = "document.getElementById('duties').classList.remove('closed');";
  } else if (kind === 'details') {
    target.blocks = [
      {
        t: 'html',
        html: `<details id="fold"${open ? ' open' : ''}><summary>Show the section</summary>${inner(target.blocks)}</details>`,
      },
    ];
    script = "document.getElementById('fold').open = true;";
  } else if (kind === 'accordion') {
    target.blocks = [
      { t: 'html', html: `<div class="acc${open ? '' : ' shut'}" id="fold">${inner(target.blocks)}</div>` },
    ];
    script = "document.getElementById('fold').classList.remove('shut');";
  } else {
    target.blocks = [
      {
        t: 'html',
        html: `<div class="tabs"><div role="tablist"><span role="tab" aria-selected="${open}">Lenses</span><span role="tab" aria-selected="${!open}">Glossary</span></div><div role="tabpanel" id="fold"${open ? '' : ' hidden'}>${inner(target.blocks)}</div><div role="tabpanel" id="other"${open ? ' hidden' : ''}><p>${esc(OTHER_TAB)}</p></div></div>`,
      },
    ];
    script =
      "document.getElementById('fold').hidden = false; document.getElementById('other').hidden = true;";
  }
  const page = renderArticle(
    s,
    reopen ? { script: `document.addEventListener('DOMContentLoaded', function () { ${script} });` } : {},
  );
  return page.replace('</style>', `${FOLD_CSS}</style>`);
}

const FOLDS: Record<Fold, string> = {
  details: 'a <details> section',
  accordion: 'an accordion that closes by animating its height to zero with overflow hidden',
  tabs: 'a tab panel, hidden when the other tab is chosen',
  menu: 'a menu list, closed by a class',
};

const COLLAPSE: Record<string, { note: string; a: () => string; b: () => string }> = Object.fromEntries(
  (Object.keys(FOLDS) as Fold[]).flatMap((k) => [
    [
      `collapse-${k}`,
      {
        note: `Part of the page sits in ${FOLDS[k]}. A has it open, B has it closed: notes on it must hide with it, and the rest stay in place.`,
        a: () => folded(k, true),
        b: () => folded(k, false),
      },
    ],
    [
      `reopen-${k}`,
      {
        note: `Part of the page sits in ${FOLDS[k]}. B is served with it closed and opens it at load: every note must be back in place.`,
        a: () => folded(k, true),
        b: () => folded(k, false, true),
      },
    ],
  ]),
);

const CHANGES: Record<string, { note: string; a?: () => string; b: () => string }> = {
  same: { note: 'B is identical to A. Control: everything must land.', b: () => renderArticle(ARTICLE) },
  'para-inserted': {
    note: 'A new paragraph is inserted at the top of the first section, pushing everything down.',
    b: () => {
      const s = clone(ARTICLE);
      sec(s, 'origins').blocks.unshift({
        t: 'p',
        text: 'This account draws on harbour records, keepers logs and the recollections of families who lived at the stations. Dates are given where the records agree and left out where they do not, and readers should treat the early chapters as a sketch rather than a full history.',
      });
      return renderArticle(s);
    },
  },
  'sentence-edited': {
    note: 'One sentence in each of four paragraphs is reworded. The rest of each paragraph is unchanged.',
    b: () => {
      const s = clone(ARTICLE);
      const ed = (sid: string, i: number, from: string, to: string) => {
        const p = para(sec(s, sid), i);
        p.text = p.text.replace(from, to);
      };
      ed(
        'origins',
        1,
        'Merchants paid a small toll for each cargo that passed',
        'Ship owners paid a modest fee on every cargo that went by',
      );
      ed(
        'optics',
        1,
        'The stepped lens changed everything.',
        'Everything changed with the arrival of the stepped lens.',
      );
      ed(
        'keepers',
        0,
        'Keeping a light was steady, lonely work.',
        'Keeping a light was patient and often solitary work.',
      );
      ed(
        'automation',
        1,
        'Some stations were sold as houses or turned into small museums',
        'A number of stations became holiday houses or modest museums',
      );
      return renderArticle(s);
    },
  },
  'quote-repeated': {
    note: 'A summary box near the top repeats three sentences that appear later, so each quote now occurs twice.',
    b: () =>
      renderArticle(ARTICLE, {
        lead: `<aside class="summary"><p>${esc('An oil lamp burned more steadily and needed less tending, which allowed one keeper to manage a light alone.')}</p><p>${esc('The stepped lens changed everything.')} ${esc('Families often lived at the station, and children learned to read the weather before they learned their letters.')}</p></aside>`,
      }),
  },
  'section-moved': {
    note: 'The section on keepers moves from third to first place.',
    b: () => {
      const s = clone(ARTICLE);
      const k = s.splice(2, 1)[0]!;
      s.unshift(k);
      return renderArticle(s);
    },
  },
  'section-deleted': {
    note: 'The section on lenses and reflectors is removed. Notes on it are truly gone.',
    b: () => renderArticle(clone(ARTICLE).filter((s) => s.id !== 'optics')),
  },
  'ids-classes-renamed': {
    note: 'Same text. Every id and class is renamed and extra wrapper elements are added, so structural paths break.',
    b: () => renderArticle(ARTICLE, { renamed: true }),
  },
  'list-reordered': {
    note: 'The duty list is reversed and the table rows are reordered.',
    b: () => {
      const s = clone(ARTICLE);
      for (const x of s) {
        for (const b of x.blocks) {
          if (b.t === 'ul') b.items.reverse();
          if (b.t === 'table') b.rows = [b.rows[0]!, ...b.rows.slice(1).reverse()];
        }
      }
      return renderArticle(s);
    },
  },
  'sticky-sidebar': {
    note: 'A sticky sidebar with a table of contents and a tall collapse button sits left of the article on both versions. B adds one entry to the contents and one paragraph to the article. Margin notes must follow the paragraphs, never the sidebar.',
    a: () => renderArticle(ARTICLE, { sidebar: TOC }),
    b: () => {
      const s = clone(ARTICLE);
      sec(s, 'optics').blocks.unshift({
        t: 'p',
        text: 'Before the lens makers, a few ports simply built taller towers, trusting height alone to carry a weak light further over the water.',
      });
      return renderArticle(s, { sidebar: [...TOC, 'Further reading'] });
    },
  },
  'twin-notes': {
    note: 'Every section ends with the same note, word for word. B inserts a paragraph at the top, so every positional path shifts by one. A note on one twin must not move to another.',
    a: () => renderArticle(withTwins(ARTICLE)),
    b: () => {
      const s = withTwins(ARTICLE);
      sec(s, 'origins').blocks.unshift({ t: 'p', text: 'A short preface was added to this edition.' });
      return renderArticle(s);
    },
  },
  'heading-renamed': {
    note: 'Two section titles are lengthened and a new paragraph opens the first section. The old words of each title are still at its start.',
    b: () => {
      const s = clone(ARTICLE);
      sec(s, 'optics').title = 'Lenses and reflectors, and the lamps behind them';
      sec(s, 'keepers').title = 'The life of a keeper and their family';
      sec(s, 'origins').blocks.unshift({
        t: 'p',
        text: 'Most of what follows comes from harbour records and the logs that keepers were required to keep.',
      });
      return renderArticle(s);
    },
  },
  'footnotes-renumbered': {
    note: 'Every paragraph ends with a footnote marker. B adds a reference near the top, so every later marker number goes up by one.',
    a: () => renderArticle(withFootnotes(ARTICLE, 1)),
    b: () => {
      const s = withFootnotes(ARTICLE, 2);
      const first = para(sec(s, 'origins'), 0);
      first.text = first.text.replace('[2]', '[1][2]');
      return renderArticle(s);
    },
  },
  'table-column-removed': {
    note: 'The middle column of the table is removed. The caption and the text around the table stay.',
    b: () => {
      const s = clone(ARTICLE);
      for (const x of s)
        for (const b of x.blocks) if (b.t === 'table') b.rows = b.rows.map((r) => [r[0]!, r[2]!]);
      return renderArticle(s);
    },
  },
  'opening-rewritten': {
    note: 'The opening sentences of three paragraphs are rewritten. Their last sentences stay, and so do the gaps after them.',
    b: () => {
      const s = clone(ARTICLE);
      const ed = (sid: string, i: number, from: string, to: string) => {
        const p = para(sec(s, sid), i);
        p.text = p.text.replace(from, to);
      };
      ed(
        'origins',
        0,
        'Long before engineers drew plans for stone towers, fishing villages kept a fire burning on the highest rock above the harbour.',
        'In the centuries before stone towers, a village would keep a fire alight on the tallest rock it had.',
      );
      ed(
        'optics',
        0,
        'A bare flame sends light in every direction, and most of it is wasted on the sky and the land behind the tower.',
        'An open flame scatters its light everywhere, and the sky and the hills get most of it.',
      );
      ed(
        'keepers',
        1,
        'Families often lived at the station, and children learned to read the weather before they learned their letters.',
        'Whole families lived on the stations, and the children could read a sky long before a page.',
      );
      return renderArticle(s);
    },
  },
  'image-replaced': {
    note: 'The figure in the first section gets a different image file. The caption stays.',
    b: () => {
      const s = clone(ARTICLE);
      const f = sec(s, 'origins').blocks.find((b) => b.t === 'fig') as { img: string };
      f.img = svg(
        '#dde8dd',
        '<rect x="200" y="40" width="80" height="200" fill="#eee" stroke="#333"/><circle cx="240" cy="70" r="18" fill="#fd5"/>',
      );
      return renderArticle(s);
    },
  },
  ...COLLAPSE,
};

// ---------------------------------------------------------------------------
// Dynamic fixtures
// ---------------------------------------------------------------------------

const WORDS =
  'amber basin cedar delta ember fjord granite harbour inlet juniper kelp lagoon marsh nettle orchard pebble quarry reed shoal tide upland vale willow yarrow zephyr alder bramble cove dune estuary fern glen heath isle jetty knoll ledge moor nook oak pier rill sedge tarn vetch weir'.split(
    ' ',
  );

/** Deterministic pseudo-random words so each list item has a unique sentence. Plain JS so the page can run it too. */
const ITEM_TEXT_JS = `function itemText(i) {
  var x = ((i + 1) * 2654435761) >>> 0;
  function next() {
    x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    return words[x % words.length];
  }
  var title = 'Entry ' + (i + 1) + ': ' + next() + ' ' + next();
  var body = 'Notes on the ' + next() + ' near the ' + next() + ', recorded after the ' + next() +
    ' season, with a remark about the ' + next() + ' and the ' + next() + ' along the ' + next() +
    ' shore (item ' + (i + 1) + ').';
  return { title: title, body: body };
}`;
const itemText = new Function('words', `${ITEM_TEXT_JS}; return itemText;`)(WORDS) as (i: number) => {
  title: string;
  body: string;
};

const LIST_CSS = `${CSS}\nol.feed { list-style: none; padding: 0; } ol.feed li { border-bottom: 1px solid var(--rule); padding: 10px 0; } ol.feed h3 { margin: 0 0 4px; font-size: 1.05rem; } ol.feed p { margin: 0; } #sentinel { height: 40px; }`;

function listPage(count: number, script?: string): string {
  const items = Array.from({ length: count }, (_, i) => {
    const t = itemText(i);
    return `<li><h3>${esc(t.title)}</h3><p>${esc(t.body)}</p></li>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Field notes feed</title><style>${LIST_CSS}</style></head>
<body><header class="site">Ink test set, infinite list</header>
<main class="article"><h1>Field notes feed</h1><ol class="feed" id="feed">
${items}
</ol><div id="sentinel"></div></main>
${script ? `<script>${script}</script>` : ''}
</body></html>
`;
}

const INFINITE_SCRIPT = `
(function () {
  var TOTAL = 60, PAGE = 20, shown = 20;
  var words = ${JSON.stringify(WORDS)};
  ${ITEM_TEXT_JS}
  var feed = document.getElementById('feed');
  function more() {
    var end = Math.min(TOTAL, shown + PAGE);
    for (var i = shown; i < end; i++) {
      var t = itemText(i);
      var li = document.createElement('li');
      var h = document.createElement('h3'); h.textContent = t.title;
      var p = document.createElement('p'); p.textContent = t.body;
      li.append(h, p); feed.appendChild(li);
    }
    shown = end;
    if (shown >= TOTAL) window.__inkSettled = true;
  }
  new IntersectionObserver(function (es) {
    if (es.some(function (e) { return e.isIntersecting; })) setTimeout(more, 150);
  }).observe(document.getElementById('sentinel'));
  window.__inkSettle = async function () {
    while (!window.__inkSettled) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise(function (r) { setTimeout(r, 250); });
    }
    window.scrollTo(0, 0);
  };
})();
`;

function lazyPage(): string {
  const first = ARTICLE.slice(0, 2);
  const rest = ARTICLE.slice(2);
  const later = rest.map((s) => {
    const html = renderArticle([s]).match(/<section[\s\S]*<\/section>/)![0];
    return html;
  });
  const script = `
(function () {
  var parts = ${JSON.stringify(later)};
  var main = document.querySelector('main');
  parts.forEach(function (html, i) {
    setTimeout(function () {
      main.insertAdjacentHTML('beforeend', html);
      if (i === parts.length - 1) window.__inkSettled = true;
    }, 400 * (i + 1));
  });
})();
`;
  return renderArticle(first, { script });
}

/**
 * A page app with two routes. Both render into the same pool of article nodes,
 * so after a route change the node at a given path holds different text.
 */
function spaPage(): string {
  const guide = ARTICLE.flatMap((s) =>
    s.blocks
      .filter((b): b is { t: 'p'; text: string } => b.t === 'p')
      .map((b) => ({ h: s.title, p: b.text })),
  );
  const news = Array.from({ length: guide.length }, (_, i) => {
    const t = itemText(100 + i);
    return { h: t.title, p: t.body };
  });
  const script = `
(function () {
  var routes = { '#/guide': ${JSON.stringify(guide)}, '#/news': ${JSON.stringify(news)} };
  var pool = [];
  var root = document.getElementById('app');
  function render() {
    var data = routes[location.hash] || routes['#/guide'];
    if (location.hash === '#/news') data = data.slice().reverse();
    while (pool.length < data.length) {
      var a = document.createElement('article');
      a.append(document.createElement('h2'), document.createElement('p'));
      root.appendChild(a); pool.push(a);
    }
    // Recycle nodes in a rotated order so paths point at different content.
    var shift = location.hash === '#/news' ? 3 : 0;
    data.forEach(function (d, i) {
      var a = pool[(i + shift) % pool.length];
      a.firstChild.textContent = d.h; a.lastChild.textContent = d.p;
      root.appendChild(a);
    });
    document.title = location.hash === '#/news' ? 'News' : 'Guide';
  }
  addEventListener('hashchange', render);
  if (!location.hash) history.replaceState(null, '', '#/news');
  render();
  window.__inkSettle = async function () {
    location.hash = '#/guide';
    await new Promise(function (r) { setTimeout(r, 50); });
    window.__inkSettled = true;
  };
})();
`;
  const shell = (body: string, sc?: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guide</title><style>${CSS} article h2 { font-size: 1.2rem; }</style></head>
<body><header class="site">Ink test set, page app</header>
<main class="article" id="app">${body}</main>
${sc ? `<script>${sc}</script>` : ''}
</body></html>
`;
  // Version A is the guide route as it renders, frozen without the script.
  const aBody = guide.map((d) => `<article><h2>${esc(d.h)}</h2><p>${esc(d.p)}</p></article>`).join('\n');
  return JSON.stringify({ a: shell(aBody), b: shell('', script) });
}

const DYNAMIC: Record<string, { note: string; a: () => string; b: () => string }> = {
  'lazy-article': {
    note: 'B starts with two sections and appends the rest after delays. Scored before and after it settles.',
    a: () => renderArticle(ARTICLE),
    b: lazyPage,
  },
  'infinite-list': {
    note: 'B shows 20 of 60 items and loads more when the end of the list scrolls into view.',
    a: () => listPage(60),
    b: () => listPage(20, INFINITE_SCRIPT),
  },
  'spa-route': {
    note: 'B opens on another route, then changes route. Nodes are recycled in a different order.',
    a: () => (JSON.parse(spaPage()) as { a: string }).a,
    b: () => (JSON.parse(spaPage()) as { b: string }).b,
  },
};

const LICENSE = 'MIT (original text written for this test set)';

/** Writes every synthetic and dynamic fixture and keeps sources.json in step. Returns the number of pairs. */
export function writeSynthetic(): number {
  const src = loadSources();
  const keep = src.pairs.filter((p) => p.kind !== 'synthetic' && p.kind !== 'dynamic');
  const add: Pair[] = [];
  const a = renderArticle(ARTICLE);
  for (const [name, c] of Object.entries(CHANGES)) {
    const dir = join(FIXTURES, 'synthetic', `syn-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.html'), c.a ? c.a() : a);
    writeFileSync(join(dir, 'b.html'), c.b());
    add.push({
      id: `syn-${name}`,
      kind: 'synthetic',
      change: `syn-${name}`,
      shape: 'article',
      license: LICENSE,
      attribution: 'Ink test set authors',
      commit: true,
      a: {
        url: `fixtures/synthetic/syn-${name}/a.html`,
        label: c.a ? 'base article, variant' : 'base article',
      },
      b: { url: `fixtures/synthetic/syn-${name}/b.html`, label: name },
      note: c.note,
    });
  }
  for (const [name, c] of Object.entries(DYNAMIC)) {
    const dir = join(FIXTURES, 'dynamic', `dyn-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.html'), c.a());
    writeFileSync(join(dir, 'b.html'), c.b());
    add.push({
      id: `dyn-${name}`,
      kind: 'dynamic',
      change: `dyn-${name}`,
      shape: 'app',
      license: LICENSE,
      attribution: 'Ink test set authors',
      commit: true,
      a: { url: `fixtures/dynamic/dyn-${name}/a.html`, label: 'settled' },
      b: { url: `fixtures/dynamic/dyn-${name}/b.html`, label: 'live' },
      note: c.note,
    });
  }
  src.pairs = [...keep, ...add];
  saveSources(src);
  return add.length;
}

if (process.argv[1]?.endsWith('synthetic.ts')) console.log(`wrote ${writeSynthetic()} pairs`);
