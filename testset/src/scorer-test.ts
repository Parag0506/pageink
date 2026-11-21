// Tests for the scorer's truth rules: each rule finds content that is still there and
// nothing that is gone. Run with `corepack pnpm --filter pageink-testset run test`.

import type { Anchor } from 'pageink-core/types';
import { chromium, type Page } from 'playwright';
import type { Truth } from '../page/harness.ts';
import { anchorEntry, bundleHarness } from './bundle.ts';

const CSS =
  '<style>body{font:16px/1.5 Arial,sans-serif;margin:0;padding:20px;width:600px}p{margin:0 0 16px}</style>';
const filler =
  'Harbor lanterns swayed above the quiet stone wall while the tide came in over the flats and the gulls kept still. ';

interface Case {
  name: string;
  html: string;
  truth: Truth;
  anchor?: Partial<Anchor>;
  textOff?: number;
  expect: { present: boolean; how?: string | RegExp; elId?: string; x?: number; y?: number };
}

const textTruth = (exact: string, prefix: string, suffix: string, extra: Partial<Truth> = {}): Truth => ({
  kind: 'text',
  exact,
  prefix,
  suffix,
  blockText: '',
  tag: 'P',
  relY: 0.5,
  ...extra,
});

const anchorOf = (exact: string, type: Anchor['type'] = 'text', place: Anchor['place'] = 'on'): Anchor => ({
  type,
  quote: { exact, prefix: '', suffix: '' },
  path: { css: '', xpath: '' },
  pos: { start: 0, end: 0 },
  hash: '',
  place,
});

const CASES: Case[] = [
  {
    name: 'one side of the context intact: the words are at the same place',
    html: `<p id="a">${filler}The council met on Tuesday and approved the plan for the new harbor wall after a vote.</p>`,
    truth: textTruth(
      'approved the plan',
      'cil met on Monday evening and ',
      ' for the new harbor wall after a',
    ),
    expect: { present: true, how: 'context-one-side', elId: 'a' },
  },
  {
    name: 'both sides changed and the words reused elsewhere: gone',
    html: `<p id="a">${filler}Someone else approved the plan yesterday in another town entirely, far from here.</p>`,
    truth: textTruth(
      'approved the plan',
      'cil met on Monday evening and ',
      ' for the new harbor wall after a',
    ),
    expect: { present: false },
  },
  {
    name: 'renumbered footnote markers do not hide the context',
    html: `<p id="a">${filler}Mars has a thin atmosphere.[61] Its surface is cold and dry, with dust storms.[63]</p>`,
    truth: textTruth(
      'Its surface is cold',
      'Mars has a thin atmosphere.[58] ',
      ' and dry, with dust storms.[60]',
    ),
    expect: { present: true, how: 'context', elId: 'a' },
  },
  {
    name: 'a gap below a paragraph whose opening was rewritten is found by its end',
    html: `<p id="a">Rewritten opening of the paragraph, with new words about the forming disc and its dust. Because these materials were rare, the planets could not grow very large.[25]</p><p id="b">The giant planets formed further out, beyond the frost line, where ices were common.</p>`,
    truth: {
      kind: 'gap',
      before: {
        exact: 'Due to their higher boiling points, only metals and silica',
        blockText:
          'Due to their higher boiling points, only metals and silicates could exist in solid form near the Sun. Because these materials were rare, the planets could not grow very large.[24]',
        tail: 'Because these materials were rare, the planets could not grow very large.[24]'.slice(-70),
      },
      after: {
        exact: 'Something that is not on the page any more at all, really',
        blockText: 'Something that is not on the page any more at all, really.',
      },
      relY: 0.3,
    },
    anchor: anchorOf('the planets could not grow very large.[24]', 'block', 'below'),
    expect: { present: true, how: /^before-tail-/, elId: 'a' },
  },
  {
    name: 'a table that lost a column is found by its place, not by a twin with the old header',
    html: `<p>${filler}</p><table id="t1"><tr><th>Rank</th> <th>Building</th> <th>City</th></tr><tr><td>1</td> <td>A</td> <td>X</td></tr><tr><td>2</td> <td>B</td> <td>Y</td></tr></table><p>First list ends here and the second starts now.</p><table id="t2"><tr><th>Building</th> <th>City</th></tr><tr><td>C</td> <td>Z</td></tr><tr><td>D</td> <td>W</td></tr></table><p>Height to roof is measured from the lowest entrance.</p>`,
    truth: {
      kind: 'table',
      table: {
        caption: '',
        head: 'Rank Building City',
        firstCol: '1 | 2',
        before: 'Firstlistendshereandthesecondstartsnow.'.slice(-32),
        after: 'Heighttoroofismeasuredfromthelow',
      },
      relY: 0.7,
    },
    expect: { present: true, how: 'place', elId: 't2' },
  },
  {
    name: 'a table whose header row was lightly edited and whose surroundings changed is still found',
    html: `<p>A new hatnote was added here.</p><table id="t1"><tr><th>Penguins Temporal range: Late Danian – Recent, 62–0 Ma</th></tr><tr><td>Kingdom</td></tr><tr><td>Phylum</td></tr></table><p>Penguins are birds.</p><table id="t2"><tr><th>Genus</th> <th>Species</th></tr><tr><td>A</td> <td>1</td></tr><tr><td>B</td> <td>2</td></tr></table>`,
    truth: {
      kind: 'table',
      table: {
        caption: '',
        head: 'Penguins Temporal range: Late Danian-Recent, 62–0 Ma',
        firstCol: 'Kingdom | Phylum',
        before: 'thehatnotethatwasthereonceonly.',
        after: 'Penguinsareagroupofaquaticflight',
      },
      relY: 0.1,
    },
    expect: { present: true, how: 'head-similar', elId: 't1' },
  },
  {
    name: 'a header row that two tables are equally close to is not a match',
    html: `<p>Lead.</p><table id="t1"><tr><th>Penguins Temporal range: Late Danian – Recent, 62–0 Ma</th></tr><tr><td>x</td></tr><tr><td>y</td></tr></table><table id="t2"><tr><th>Penguins Temporal range: Late Danian – Recent, 62–0 Ma</th></tr><tr><td>z</td></tr><tr><td>w</td></tr></table>`,
    truth: {
      kind: 'table',
      table: {
        caption: '',
        head: 'Penguins Temporal range: Late Danian-Recent, 62–0 Ma',
        firstCol: 'Kingdom | Phylum',
      },
      relY: 0.1,
    },
    expect: { present: false },
  },
  {
    name: 'edited words: the anchor quote keeps its distance from the truth words',
    html: `<p id="a">${filler}It was gravitationally bound orbits around the Sun, a reworded line that keeps going on.</p>`,
    truth: textTruth(
      'bound orbits around the Sun, although',
      'still. It was gravitationally ',
      ' the Solar System has been st',
      {
        blockText: `${filler}It was gravitationally bound orbits around the Sun, although the Solar System has been stable.`,
      },
    ),
    anchor: anchorOf('orbits around the Sun, although'),
    textOff: 6,
    expect: { present: true, how: 'edited', elId: 'a' },
  },
];

// The outcome "hidden with its content": correct only when the note is hidden and its content is
// there but not shown on B. A hidden note whose content shows is a miss. A painted note whose
// content is hidden is a wrong place.
const OUTCOMES: { name: string; o: Record<string, unknown>; content: string; want: string }[] = [
  {
    name: 'hidden with content that is closed: correct',
    o: { hiddenNote: true, found: true, present: true },
    content: 'unseen',
    want: 'hidden',
  },
  {
    name: 'hidden while its content is visible: a miss',
    o: { hiddenNote: true, found: true, present: true },
    content: 'shown',
    want: 'miss',
  },
  {
    name: 'painted while its content is hidden: a wrong place',
    o: { hiddenNote: false, found: true, present: true, near: true },
    content: 'unseen',
    want: 'wrong',
  },
  {
    name: 'painted on shown content in place: right, as before',
    o: { hiddenNote: false, found: true, present: true, near: true },
    content: 'shown',
    want: 'right',
  },
  {
    name: 'hidden while its content is gone: in the tray and gone',
    o: { hiddenNote: true, found: false, present: false },
    content: 'gone',
    want: 'tray-gone',
  },
];

/** Content the scorer must see as not shown, and content it must see as shown. */
const SHOWN: { name: string; html: string; want: boolean }[] = [
  {
    name: 'in a closed <details>',
    html: '<details><summary>s</summary><p id="x">Inside words.</p></details>',
    want: false,
  },
  {
    name: 'in an accordion closed to height zero',
    html: '<div style="overflow:hidden;height:0"><p id="x">Inside words.</p></div>',
    want: false,
  },
  { name: 'in a hidden tab panel', html: '<div hidden><p id="x">Inside words.</p></div>', want: false },
  {
    name: 'in a menu shown by opacity zero',
    html: '<div style="opacity:0"><p id="x">Inside words.</p></div>',
    want: false,
  },
  {
    name: 'in an open <details>',
    html: '<details open><summary>s</summary><p id="x">Inside words.</p></details>',
    want: true,
  },
];

async function outcomes(page: Page): Promise<number> {
  let failed = 0;
  await page.setContent(`${CSS}<p>x</p>`);
  await page.evaluate(await bundleHarness(anchorEntry('baseline')));
  for (const c of OUTCOMES) {
    const o = JSON.stringify({ error: false, edited: false, near: false, ...c.o });
    const got = await page.evaluate(
      `window.__inkTest.classify(Object.assign(${o}, { content: () => ${JSON.stringify(c.content)} }))`,
    );
    const ok = got === c.want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}${ok ? '' : `\n     ${got}, want ${c.want}`}`);
  }
  for (const c of SHOWN) {
    await page.setContent(`${CSS}${c.html}`);
    await page.evaluate(await bundleHarness(anchorEntry('baseline')));
    const got = await page.evaluate("window.__inkTest.shownNow(document.getElementById('x'))");
    const ok = got === c.want;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} content ${c.name} is ${c.want ? 'shown' : 'not shown'}`);
  }
  return failed;
}

async function main(): Promise<number> {
  const bundle = await bundleHarness(anchorEntry('baseline'));
  const browser = await chromium.launch();
  const page: Page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  let failed = 0;
  for (const c of CASES) {
    await page.setContent(`${CSS}${c.html}`);
    await page.evaluate(bundle);
    const got = (await page.evaluate(
      `window.__inkTest.truthHere(${JSON.stringify(c.truth)}, ${JSON.stringify(c.anchor ?? null) === 'null' ? 'undefined' : JSON.stringify(c.anchor)}, ${c.textOff ?? 0})`,
    )) as { present: boolean; how: string; elId: string; points: { x: number; y: number }[] };
    const e = c.expect;
    const errs: string[] = [];
    if (got.present !== e.present) errs.push(`present ${got.present}, want ${e.present}`);
    if (e.how && !(typeof e.how === 'string' ? got.how === e.how : e.how.test(got.how)))
      errs.push(`how ${got.how}, want ${e.how}`);
    if (e.elId !== undefined && got.elId !== e.elId) errs.push(`element #${got.elId}, want #${e.elId}`);
    if (c.textOff !== undefined && c.anchor) {
      // The expected origin must sit on the anchor's own first word, not on the truth's.
      const want = (await page.evaluate(`(() => {
        const t = document.getElementById('a').firstChild;
        const i = t.data.indexOf('orbits');
        const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1);
        const b = r.getClientRects()[0]; return { x: b.left + scrollX, y: b.top + scrollY };
      })()`)) as { x: number; y: number };
      const p = got.points[0];
      if (!p || Math.abs(p.x - want.x) > 1 || Math.abs(p.y - want.y) > 1)
        errs.push(`origin ${JSON.stringify(p)}, want ${JSON.stringify(want)}`);
    }
    if (errs.length) failed++;
    console.log(
      `${errs.length ? 'FAIL' : 'ok  '} ${c.name}${errs.length ? `\n     ${errs.join('; ')}` : ''}`,
    );
  }
  failed += await outcomes(page);
  await browser.close();
  console.log(failed ? `${failed} failed` : `all ${CASES.length + OUTCOMES.length + SHOWN.length} passed`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
