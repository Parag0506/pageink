#!/usr/bin/env node
/**
 * Writes docs/RESULTS.md from the latest test set and bench runs, and refreshes the
 * tables between the results markers in README.md and docs/ANCHORING.md.
 *
 *   node scripts/results.mjs            write the files
 *   node scripts/results.mjs --check    exit 1 if a file would change (for CI)
 *   --testset <file>  --bench <file>    read other runs
 *
 * The output depends only on the two JSON files, so a second run changes nothing.
 * Tables are padded the way the formatter pads Markdown, so lint stays clean.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_ANCHOR = 'packages/core/src/anchor/index.ts';

const { values } = parseArgs({
  options: {
    testset: { type: 'string' },
    bench: { type: 'string' },
    check: { type: 'boolean', default: false },
  },
});

const rel = (p) => relative(ROOT, p).split('\\').join('/');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * The published numbers should be those of the anchor module that ships. When the latest
 * run scored another module (the baseline, or a work in progress), use the newest run of
 * the shipped module in the same folder, and say so.
 */
function pickTestset() {
  if (values.testset) return resolve(values.testset);
  const dir = join(ROOT, 'testset/results');
  const latest = join(dir, 'latest.json');
  if (!existsSync(latest)) return latest;
  if (readJson(latest).meta?.anchor === SHIPPED_ANCHOR) return latest;
  const core = join(dir, 'core.json');
  if (existsSync(core) && readJson(core).meta?.anchor === SHIPPED_ANCHOR) return core;
  return latest;
}

const tsPath = pickTestset();
const bPath = values.bench ? resolve(values.bench) : join(ROOT, 'bench/results/latest.json');
for (const p of [tsPath, bPath]) {
  if (!existsSync(p)) {
    console.error(`missing ${rel(p)}. Run the test set and the bench first (see docs/RESULTS.md).`);
    process.exit(2);
  }
}
const T = readJson(tsPath);
const B = readJson(bPath);

// ---------------------------------------------------------------------------
// Formatting

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
const ms = (x, d = 1) => (Number.isFinite(x) ? `${x.toFixed(d)} ms` : 'n/a');
const day = (iso) => (iso ? String(iso).slice(0, 10) : 'unknown date');
const mark = (ok) => (ok ? 'pass' : 'fail');
const len = (s) => [...s].length;

/** A Markdown table padded like the formatter does: width at least 3, dashes fill the column. */
function table(head, align, rows) {
  const cells = [head, ...rows].map((r) => r.map((c) => String(c).replace(/\|/g, '\\|')));
  const w = head.map((_, i) => Math.max(3, ...cells.map((r) => len(r[i]))));
  const pad = (s, i) => {
    const gap = ' '.repeat(w[i] - len(s));
    return align[i] === 'r' ? gap + s : s + gap;
  };
  const line = (r) => `| ${r.map(pad).join(' | ')} |`;
  const sep = `| ${w.map((n, i) => (align[i] === 'r' ? `${'-'.repeat(n - 1)}:` : '-'.repeat(n))).join(' | ')} |`;
  return [line(cells[0]), sep, ...cells.slice(1).map(line)].join('\n');
}

// ---------------------------------------------------------------------------
// Test set

const tgt = T.meta.targets;
const doc = T.totals.documentPages;
const all = T.totals.all;
const anchorName = T.meta.anchor;
const shipped = anchorName === SHIPPED_ANCHOR;
const tsChecks = [
  { name: 'Right place on document pages', value: doc.right, target: tgt.right, ok: doc.right >= tgt.right },
  { name: 'Accounted for', value: all.accounted, target: tgt.accounted, ok: all.accounted >= tgt.accounted },
  { name: 'Wrong place on document pages', value: doc.wrong, target: tgt.wrong, ok: doc.wrong < tgt.wrong },
];
const tsCheckRows = [
  [
    'Right place, of notes whose content still exists (document pages)',
    pct(doc.right),
    `${pct(tgt.right)} or better`,
    mark(tsChecks[0].ok),
  ],
  [
    'Accounted for, placed or in the tray (all runs)',
    pct(all.accounted),
    pct(tgt.accounted),
    mark(tsChecks[1].ok),
  ],
  ['Wrong place (document pages)', pct(doc.wrong), `under ${pct(tgt.wrong)}`, mark(tsChecks[2].ok)],
];
const tsPass = tsChecks.every((c) => c.ok);

const count = (s) => ({
  right: Math.round(s.right * s.present),
  tray: s.trayGone + s.trayEdited,
  wrong: Math.round(s.wrong * s.notes),
});
function groupTable(groups, label) {
  const rows = Object.entries(groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, s]) => {
      const c = count(s);
      return [k, s.notes, c.right, c.tray, s.miss, c.wrong, pct(s.right), pct(s.wrong)];
    });
  return table(
    [label, 'notes', 'right', 'tray, correct', 'miss', 'wrong', 'right of present', 'wrong'],
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r'],
    rows,
  );
}

const slowest = [...(T.perf ?? [])].sort((a, b) => b.totalMs - a.totalMs)[0];
// The run count is left out: pairs are keyed by name, and two runs can share one, so it would undercount.
const tsWhat = `${all.notes.toLocaleString('en-US')} notes${T.meta.quick ? ' (quick subset)' : ''}`;
const tsSource = `\`${rel(tsPath)}\`, anchor module \`${anchorName}\`, run of ${day(T.meta.started)}`;
const tsWarn = shipped
  ? ''
  : `\n\nThese numbers are for \`${anchorName}\`, not for the anchor module that ships (\`${SHIPPED_ANCHOR}\`).`;

// ---------------------------------------------------------------------------
// Bench

const budgets = B.meta.budgets;
const over = Object.entries(B.overhead ?? {});
const lat = Object.entries(B.latency ?? {});
const ptr = Object.entries(B.pointer ?? {});
const realExt = B.meta.product ?? !/dummy/.test(B.meta.ext);
const fin = (xs) => xs.filter(Number.isFinite);
const worst = (xs) => (fin(xs).length ? Math.max(...fin(xs)) : Number.NaN);

// Main-thread time of the extension on a page with no ink: injection of the stub, world setup
// included, plus every task that ran its code, from traced loads. The stub's own measure is shown too.
const extWorst = worst(over.map(([, o]) => o.extMs?.median));
const extMax = worst(over.map(([, o]) => o.extMs?.max));
const extWorstPage = over.find(([, o]) => o.extMs?.median === extWorst)?.[0];
const stubWorst = worst(over.map(([, o]) => o.stubMs?.median));
const stubOk = extWorst < budgets.stubMs && stubWorst < budgets.stubMs;

// A paint difference fails only when it is beyond the noise and repeats in a second run.
const paintFails = over.flatMap(([id, o]) =>
  ['fcp', 'lcp'].filter((m) => o.real?.[m]).map((m) => `${id} ${m.toUpperCase()} +${o[m].delta} ms`),
);
const modes = { replay: 0, live: 0, local: 0 };
for (const [, o] of over) modes[o.mode] = (modes[o.mode] ?? 0) + 1;
const modeText = `${modes.replay} replayed, ${modes.live} live, ${modes.local} local`;

const timed = lat.filter(([, l]) => Number.isFinite(l.warm?.median) || Number.isFinite(l.cold?.median));
const timedPages = timed.length;
const frameMs = budgets.visibleFrameMs ?? 16.7;
/**
 * The design's measure: ink inserted within 50 ms of its anchor content being inserted. A page over
 * it is named with how long that content took to first paint after its insert, with the extension
 * and on the page alone, because ink cannot be on screen before the page's own first layout of it.
 */
/** The same content's first paint after its insert on the page alone, without the extension. */
const alone = (l, k) =>
  Number.isFinite(l.plain?.[k]?.contentPaintMedian) ? ms(l.plain[k].contentPaintMedian) : 'not measured';
const insertOver = (k) =>
  timed
    .filter(([, l]) => l[k]?.median > budgets.visibleMs)
    .map(
      ([id, l]) =>
        `${id} ${ms(l[k].median)}, the page first painted that content ${ms(l[k].contentPaintMedian)} after inserting it with the extension and ${alone(l, k)} without it`,
    );
const insertRow = (k, label) => {
  const over = insertOver(k);
  const worstMs = worst(timed.map(([, l]) => l[k]?.median));
  const worstId = timed.find(([, l]) => l[k]?.median === worstMs)?.[0];
  return [
    `Ink visible within ${budgets.visibleMs} ms of its anchor content existing, ${label}`,
    !lat.length
      ? 'n/a'
      : over.length
        ? `not met on ${over.join('; ')}. Met on ${timedPages - over.length} of ${timedPages} seeded pages`
        : `worst page median ${ms(worstMs)} (${worstId}), ${timedPages} seeded pages`,
    `within ${budgets.visibleMs} ms`,
    lat.length ? mark(!over.length) : 'not run',
  ];
};
/**
 * The reader's measure: ink in the same frame as its content's first paint, or N ms after it. The
 * design says within one frame in every case, so every timed load counts, not only the median. The
 * bench's own gate checks medians, so a CI run does not fail on one slow load.
 */
const seenRow = (k, label) => {
  const runs = timed.flatMap(([id, l]) =>
    (l[k]?.runs ?? []).filter((r) => r.worstSeen != null).map((r) => [id, r.worstSeen]),
  );
  const late = runs.filter(([, x]) => x > frameMs);
  const latePages = [...new Set(late.map(([id]) => id))].map(
    (id) => `${id} ${late.filter(([p]) => p === id).length} of ${runs.filter(([p]) => p === id).length}`,
  );
  const worstMs = worst(runs.map(([, x]) => x));
  const worstId = runs.find(([, x]) => x === worstMs)?.[0];
  const same = runs.filter(([, x]) => x === 0).length;
  const medLate = timed.filter(([, l]) => l[k]?.seenMedian > frameMs).map(([id]) => id);
  return [
    `Ink on screen with its content's first paint, ${label}`,
    !lat.length
      ? 'n/a'
      : `same frame in ${same} of ${runs.length} loads; more than one frame late in ${late.length} (${latePages.join(', ') || 'none'}); worst ${ms(worstMs)} (${worstId}). Medians per page: ${medLate.length ? `over one frame on ${medLate.join(', ')}` : 'all within one frame'}`,
    `same frame, or within one frame (${frameMs} ms), every load`,
    lat.length ? mark(late.length === 0) : 'not run',
  ];
};
/**
 * How long the extension held back the first paint of the content under ink, against the page
 * alone, loads interleaved (bench/src/judge.ts heldBack). Judged on the seeded pages; the stress
 * page is named beside them with both of its groups when it paints in two ways.
 */
const heldMs = budgets.heldBackMs ?? frameMs;
// A page with no note in its first screen has nothing to time.
const held = lat.filter(([, l]) => ['cold', 'warm'].some((k) => Number.isFinite(l.heldBack?.[k]?.delta)));
const isStress = (id, l) => id === B.stress?.id || l.url === B.stress?.page;
const heldSeeded = held.filter(([id, l]) => !isStress(id, l));
const heldText = (h) =>
  h.basis === 'pairs' || h.basis === 'medians'
    ? `${ms(h.delta)} (noise ${ms(h.noise)})`
    : `${ms(h.delta)} (noise ${ms(h.noise)}; ${h.basis})`;
const heldRow = (() => {
  const label = 'First paint of content under ink, held back by the extension';
  const target = `at most ${heldMs} ms (one frame) on every seeded page, cold and warm`;
  if (!heldSeeded.length) return [label, 'not measured', target, 'not measured'];
  const cells = heldSeeded.map(
    ([id, l]) => `${id} ${heldText(l.heldBack.cold)} / ${heldText(l.heldBack.warm)}`,
  );
  const over = heldSeeded.filter(([, l]) => ['cold', 'warm'].some((k) => l.heldBack[k].delta > heldMs));
  const st = held.find(([id, l]) => isStress(id, l))?.[1];
  // Every group of loads of both arms, so a page that paints in two ways shows both.
  const groups = (a) => a.groups.map((g) => `${g.n} at ${ms(g.median)}`).join(', ');
  const stress = st
    ? `. Stress page, reported: ${['cold', 'warm']
        .map(
          (k) =>
            `${k} ${heldText(st.heldBack[k])}, loads without / with the extension ${groups(st.heldBack[k].alone)} / ${groups(st.heldBack[k].with)}`,
        )
        .join('; ')}`
    : '';
  return [label, `cold / warm: ${cells.join('; ')}${stress}`, target, mark(!over.length)];
})();
const scrollEvents =
  lat.reduce((n, [, l]) => n + (l.scroll?.inkEvents ?? 0), 0) + (B.stress?.scroll?.inkEvents ?? 0);
const stressTask = B.stress?.longestInkTask;
/** The long task verdict, in runs that loaded the stress page with and without the extension. */
const sv = B.stress?.verdict;
/**
 * How often a load of the stress page had a task over the limit, with the extension, for the page
 * alone and with a do-nothing extension (bench/src/judge.ts judgeOften). Runs before it judged the
 * few traced loads instead: a long task with ink script where the page alone had none.
 */
const often = B.stress?.often;
const oftenOk = often
  ? often.verdict.cold !== 'fail' && often.verdict.warm !== 'fail'
  : (sv?.onlyWithInk.length ?? 0) === 0;
const oftenSide = (k) => {
  const o = often[k];
  const again = often.verdict[k] === 'pass' ? '' : `; ${often.verdict[k]} when measured again`;
  return `${k} ${o.ext.long} of ${o.ext.loads} with the extension, ${o.plain.long} of ${o.plain.loads} alone, ${o.control.long} of ${o.control.loads} with a do-nothing extension${again}`;
};
const oftenText = often
  ? `loads with a task over ${budgets.inkLongTaskMs} ms: ${oftenSide('cold')}; ${oftenSide('warm')}`
  : `${sv?.onlyWithInk.length ?? 0} seen only with the extension`;
const ptrText = ptr
  .map(([id, x]) => `${id}: ${ms(x.extMs, 2)} for ${x.pointerEvents} pointer moves and ${x.wheels} scrolls`)
  .join('; ');
const pen = B.pen;
const penText = (x) =>
  x ? `median ${ms(x.median)} (IQR ${ms(x.iqr)}, max ${ms(x.max)}, ${x.n} loads)` : 'n/a';

const bRows = [
  [
    "Extension time on the page's main thread, page with no ink",
    over.length
      ? `worst page median ${ms(extWorst, 2)} (${extWorstPage}); highest single load ${ms(extMax, 2)}; stub self-timing worst median ${ms(stubWorst, 2)}`
      : 'n/a',
    `under ${budgets.stubMs} ms`,
    over.length ? mark(stubOk) : 'not run',
  ],
  [
    'First and largest paint, page with no ink',
    over.length
      ? paintFails.length
        ? `slower beyond noise in two runs on ${paintFails.join(', ')}`
        : `no difference beyond noise that repeats, on all ${over.length} pages`
      : 'n/a',
    'no change beyond noise',
    over.length ? mark(paintFails.length === 0) : 'not run',
  ],
  heldRow,
  insertRow('cold', 'cold browser'),
  insertRow('warm', 'warm browser'),
  seenRow('cold', 'cold browser'),
  seenRow('warm', 'warm browser'),
  [
    'Ink script during a scripted scroll',
    lat.length ? `${scrollEvents} events` : 'n/a',
    'none',
    lat.length ? mark(scrollEvents === 0) : 'not run',
  ],
  [
    `Long tasks caused by ink, ${B.stress?.notes ?? 200} notes`,
    !Number.isFinite(stressTask)
      ? 'n/a'
      : sv
        ? `${sv.caused.length} caused by ink; ${oftenText}. Longest task that ran ink script ${ms(stressTask)}, ${ms(B.stress.longestInkTaskInk)} of it ink; ${B.stress.inkLongTasks} such tasks over ${budgets.inkLongTaskMs} ms. Longest page task with / without the extension: cold ${ms(B.stress.cold.longestTask)} / ${ms(B.stress.cold.plainLongestTask)}, warm ${ms(B.stress.warm.longestTask)} / ${ms(B.stress.warm.plainLongestTask)}`
        : `${ms(stressTask)}${Number.isFinite(B.stress?.longestInkTaskInk) ? `, of which ${ms(B.stress.longestInkTaskInk)} inside ink calls, layout they forced included` : ''}`,
    `no task over ${budgets.inkLongTaskMs} ms that would be within it without its ink part, or with over ${budgets.inkLongTaskMs} ms of ink; ${often ? 'loads with a long task no more often than with a do-nothing extension, beyond chance, in two measures' : 'none only with the extension'}`,
    !Number.isFinite(stressTask)
      ? 'not run'
      : mark(sv ? sv.caused.length === 0 && oftenOk : stressTask < budgets.inkLongTaskMs),
  ],
  [
    `Ink's part of any one task, ${B.stress?.notes ?? 200} notes`,
    sv ? `at most ${ms(sv.maxInkMs)}, over ${(B.stress.loads ?? 0) * 2} loads cold and warm` : 'n/a',
    `at most one frame (${budgets.inkTaskFrameMs ?? 16.7} ms), every load`,
    sv ? mark(sv.overFrame.length === 0) : 'not run',
  ],
  [
    'Pointer listeners: extension script while the mouse moves and the page scrolls, no ink',
    ptr.length ? ptrText : 'n/a',
    'no budget, published',
    ptr.length ? 'measured' : 'not run',
  ],
  [
    'Pen-down to first pixel, first stroke on a page with no ink, background stopped',
    penText(pen?.cold),
    'no budget, published',
    pen ? 'measured' : 'not run',
  ],
  [
    'Pen-down to first pixel, first stroke on a page with no ink, background running',
    penText(pen?.warm),
    'no budget, published',
    pen ? 'measured' : 'not run',
  ],
  [
    'Pen-down to first pixel, later strokes',
    penText(pen?.later),
    'no budget, published',
    pen ? 'measured' : 'not run',
  ],
];
const m = B.meta.machine;
const seen = (x) => (x?.seenMedian === 0 ? 'in the same frame' : `${ms(x?.seenMedian)} later`);
// Seeded pages over the 50 ms measure, named under the table so a failing row is never bare.
const slowPages = [
  ...new Set([...insertOver('cold'), ...insertOver('warm')].map((x) => x.split(' ')[0])),
].map((id) => {
  const l = B.latency[id];
  return `${id} (${l.notes} notes): ${ms(l.cold?.median)} cold and ${ms(l.warm?.median)} warm after its anchor content was inserted. With the extension the page first painted that content ${ms(l.cold?.contentPaintMedian)} (cold) and ${ms(l.warm?.contentPaintMedian)} (warm) after inserting it; without the extension, ${alone(l, 'cold')} (cold) and ${alone(l, 'warm')} (warm). Counted from that first paint, the ink came ${seen(l.cold)} (cold) and ${seen(l.warm)} (warm)`;
});
const bFailNote = slowPages.length
  ? `\n\nInk visible over ${budgets.visibleMs} ms on ${slowPages.join('; ')}. [docs/RESULTS.md](docs/RESULTS.md) has the timeline.`
  : '';
const bWhat = `${over.length} pages (${modeText}), ${B.meta.loads} loads per arm on replayed and local pages and ${B.meta.liveLoads ?? B.meta.loads} on live pages, with and without the extension. ${B.meta.browser ?? 'Chromium'} headless${m ? ` on ${m.cpu}, ${m.cores} cores, ${m.memoryGb} GB, ${m.os.replace(/^darwin/, 'macOS kernel')}` : ''}`;
const sz = B.meta.sizes ?? {};
const kb = (n) => (Number.isFinite(n) ? `${n.toLocaleString('en-US')} B` : 'n/a');
const sizeText = B.meta.sizes
  ? `Code that runs in pages, minified, in the bench build measured here (its performance marks included): stub ${kb(sz.stub)} (every page), first read ${kb(sz.boot)} and viewer ${kb(sz.viewer)} (registered on sites with ink), tools ${kb(sz.tools)} (injected on the first pen-down or the draw toggle). Release sizes are in [CONTRACT.md](CONTRACT.md) section 5.`
  : '';
const extNote = /(^|\/)ext-real$/.test(B.meta.ext)
  ? `, a copy of the Chrome bench build: the release code plus the performance marks the bench reads`
  : '';
const bSource = `\`${rel(bPath)}\`, extension \`${B.meta.ext}\`${B.meta.extVersion ? ` (${B.meta.extName} ${B.meta.extVersion})` : ''}${extNote}, run of ${day(B.meta.started)}`;
const bWarn = realExt
  ? ''
  : `\n\nThis bench run measured \`${B.meta.ext}\`, a stand-in that does what the stub does on a page without ink. It is not the built extension. Rerun with \`--ext real\` for the product's numbers.`;

const overRows = over.map(([id, o]) => {
  const p = (k) =>
    Number.isFinite(o[k]?.delta) ? `${o[k].delta > 0 ? '+' : ''}${o[k].delta} (noise ${o[k].noise})` : 'n/a';
  return [
    id,
    o.type,
    o.mode ?? 'n/a',
    p('fcp'),
    p('lcp'),
    Number.isFinite(o.extMs?.median) ? o.extMs.median.toFixed(2) : 'n/a',
    Number.isFinite(o.extMs?.allFrames) ? `${o.extMs.allFrames.toFixed(2)} (${o.extMs.otherFrames})` : 'n/a',
    Number.isFinite(o.stubMs?.median) ? o.stubMs.median.toFixed(2) : 'n/a',
  ];
});
const liveWhy = over.filter(([, o]) => o.mode === 'live').map(([id, o]) => `- ${id}: ${o.modeReason}`);
const side = (x) =>
  Number.isFinite(x?.median)
    ? x.median.toFixed(1)
    : `none in first screen (all notes ${Number.isFinite(x?.allMedian) ? x.allMedian.toFixed(1) : 'n/a'})`;
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const latRows = lat.map(([id, l]) => [
  id,
  l.notes,
  side(l.cold),
  side(l.warm),
  `${f1(l.cold?.contentPaintMedian)} / ${f1(l.warm?.contentPaintMedian)}; alone ${f1(l.plain?.cold?.contentPaintMedian)} / ${f1(l.plain?.warm?.contentPaintMedian)}`,
  `${f1(l.cold?.paintMedian)} / ${f1(l.warm?.paintMedian)}`,
  Number.isFinite(l.cold?.seenMedian)
    ? [l.cold, l.warm].map((x) => (x.seenMedian === 0 ? 'same frame' : `${f1(x.seenMedian)} ms`)).join(' / ')
    : 'n/a',
  Number.isFinite(l.cold?.seenMedian)
    ? `${l.cold.sameFrameLoads + l.warm.sameFrameLoads} of ${l.cold.loads + l.warm.loads}`
    : 'n/a',
  l.warm?.timeline
    ? ['lastAnchor', 'fcp', 'stubStart', 'viewStart', 'firstInk']
        .map((k) => (Number.isFinite(l.warm.timeline[k]) ? Math.round(l.warm.timeline[k]) : 'n/a'))
        .join(', ')
    : 'n/a',
  l.scroll?.inkEvents ?? (id === B.stress?.id || l.url === B.stress?.page ? 'see stress' : 'n/a'),
]);
const penRows = pen
  ? [
      ['first stroke, background stopped', pen.cold],
      ['first stroke, background running', pen.warm],
      ['later strokes', pen.later],
      ['injecting viewer and tools, background stopped', pen.injectCold],
      ['injecting viewer and tools, background running', pen.injectWarm],
    ].map(([k, x]) => [k, f1(x?.median), f1(x?.iqr), f1(x?.max), x?.n ?? 'n/a'])
  : [];
/**
 * Findings are written by hand after reading the traces of a run, in bench/results/findings.json:
 * { "run": <meta.started of that run>, "findings": [...] }. They are published only with that run.
 */
const findingsFile = join(dirname(bPath), 'findings.json');
const F = existsSync(findingsFile) ? readJson(findingsFile) : null;
const findings = F && F.run === B.meta.started ? F.findings : [];
if (F && F.run !== B.meta.started)
  console.warn(`note: ${rel(findingsFile)} is for another bench run, left out`);
const ptrRows = ptr.map(([id, x]) => [
  id,
  x.mode,
  x.pointerEvents,
  ms(x.extMs, 2),
  `${x.usPerEvent} µs`,
  `${x.scriptMs.without.median} / ${x.scriptMs.with.median} ms (${x.scriptMs.delta >= 0 ? '+' : ''}${x.scriptMs.delta}, noise ${x.scriptMs.noise})`,
]);

// ---------------------------------------------------------------------------
// Blocks

const PROMISE_OF_BUDGET = ['1', '1', '1', '2', '2', '2', '2', '2', '2', '2', '1', '1', '1', '1'];
const readmeBlock = [
  table(
    ['promise', 'measure', 'result', 'target', 'status'],
    ['l', 'l', 'l', 'l', 'l'],
    [
      ...bRows.map((r, i) => [PROMISE_OF_BUDGET[i], ...r]),
      [
        '4',
        'Notes in the right place after the page changed (document pages)',
        pct(doc.right),
        `${pct(tgt.right)} or better`,
        mark(tsChecks[0].ok),
      ],
      [
        '4',
        'Notes in the wrong place (document pages)',
        pct(doc.wrong),
        `under ${pct(tgt.wrong)}`,
        mark(tsChecks[2].ok),
      ],
      [
        '4',
        'Notes accounted for (placed or in the tray)',
        pct(all.accounted),
        pct(tgt.accounted),
        mark(tsChecks[1].ok),
      ],
    ],
  ),
  '',
  `Bench: ${bSource}. Test set: ${tsSource}. Details in [docs/RESULTS.md](docs/RESULTS.md).${bFailNote}${bWarn}${tsWarn}`,
].join('\n');

const anchoringBlock = [
  table(['measure', 'result', 'target', 'status'], ['l', 'r', 'l', 'l'], tsCheckRows),
  '',
  groupTable(T.byNoteKind ?? {}, 'note kind'),
  '',
  groupTable(T.byMethod ?? {}, 'ladder step'),
  '',
  `Source: ${tsSource}, ${tsWhat}. Per category of change: [RESULTS.md](RESULTS.md).${tsWarn}`,
].join('\n');

const results = `# Results

This page is written by \`scripts/results.mjs\` from the latest runs. Do not edit it by hand.
DESIGN.md sections 11 and 12 say what each number means and how it is measured.

## Speed budgets

Source: ${bSource}. ${bWhat}. Overall: **${mark(B.pass)}**.${bWarn}

${table(['budget', 'result', 'target', 'status'], ['l', 'l', 'l', 'l'], bRows)}

How each number is taken:

- Public pages are recorded once and replayed from the recording in both arms, so the runs with and
  without the extension get the same bytes. Replay goes through request routing, which turns off the
  HTTP cache in both arms alike. A page that cannot be replayed faithfully (a service worker, requests
  that change on every load, an anti-bot answer) is loaded live, with more loads, in both arms with
  the HTTP cache on. Local pages are served by the bench.
- The arms are interleaved, the first load of each arm is discarded, and paint times are compared by
  median, with the larger interquartile range of the two arms as the noise. A slower paint counts only
  when the difference is larger than the noise and than one frame (16.7 ms), and the same holds in a
  second, separate run of that page.
- Extension main-thread time comes from traced loads. It is everything tagged with the extension:
  injecting the stub (creating its script world included), the stub's own code, and its storage read.
  The budget is about the page's own main thread. The stub also runs in every frame, and frames from
  other sites have their own processes and main threads; their time is shown beside it.
- The extension measured is the bench build, which the bench builds itself: the release code plus
  the performance marks the bench reads. Release builds carry no marks.
- Ink visible: a probe extension, loaded only for these runs, records when each note's ink is inserted
  into the PageInk layer. The page records when each anchor element is inserted, and when the browser
  first painted it (element timing, else the later of the insert and the first contentful paint, which
  can only make the lag look longer). The lag is the worst note whose anchor is in the first screen.
  It is reported two ways: from the anchor content being inserted (the design's measure, 50 ms), and
  from that content's first paint, which is what a reader sees (same frame, or within one frame). Ink
  cannot be on screen before the page's own first layout and paint of its content. Cold is a returning
  reader: a new browser on a profile whose record and viewer registration are already stored, with no
  page loaded before. Warm is the same browser after one discarded load.
- First paint of content under ink: each seeded page is loaded with the extension (no probe) and with
  no extension, cold and warm, the two arms taken in pairs back to back. Per load, the time from
  navigation to the first paint of the last first-screen anchor that element timing reports, the same
  anchors in both arms. Held back is the median of the differences within the pairs, which takes out
  drift of the machine, with their interquartile range as the noise. It counts everything the extension
  does before that paint: its scripts while the page parses, the viewer's start and the first placement.
  An arm whose loads fall into groups more than a frame apart, each with at least a third of the
  loads and three, is compared group by group, the largest difference counts, and the groups are listed. The
  budget is one frame (16.7 ms): ink comes in the same frame as its content, so a frame is the most a
  reader can be made to wait for the page to show it.

Pages with no ink. FCP and LCP: difference in median ms with the extension minus without, and the
noise. Extension ms: median time in the extension per load on the page's own main thread, which the
budget is about. All frames: the same plus the main threads of frames from other sites, which run in
their own processes beside the page, and in brackets how many such frames got the stub.

${table(['page', 'type', 'mode', 'FCP difference', 'LCP difference', 'extension ms', 'all frames ms (frames)', 'stub ms'], ['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r'], overRows)}
${liveWhy.length ? `\nPages measured live, and why:\n\n${liveWhy.join('\n')}\n` : ''}
Seeded pages. Medians over loads in ms, for the worst note whose anchor is in the first screen.
Cold and warm: from the anchor content being inserted to its ink being inserted, the design's measure
(within 50 ms). Content waits: how long the page took to first paint that content after inserting
it, with the extension, and beside it with no extension at all (page alone, the same element timing on
the same loads). The difference is what the extension adds before that paint. After first
paint: ink insert minus the content's first paint; below zero, the ink was already in the page. Seen:
what a reader sees, "same frame" when the ink was painted with its content, else how much later.
Same-frame loads counts cold and warm loads where every first-screen note was in the same frame. A
page with no note in the first screen shows the worst lag over all its notes instead; those are drawn
in idle time below the screen and are not timed against the budget. The warm timeline is ms from
navigation: last anchor inserted, first contentful paint, stub start, viewer start (after the stub's
storage read), first ink mark.

${table(['page', 'notes', 'cold', 'warm', 'content waits with the extension, cold / warm; page alone', 'after first paint, cold / warm', 'seen, cold / warm', 'same-frame loads', 'warm timeline', 'ink events in scroll'], ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l', 'r'], latRows)}

Stress: ${B.stress ? `${B.stress.notes} notes on \`${B.stress.page}\`.${sv ? ` ${B.stress.loads} traced loads per arm: cold (a new browser on a stored profile) and warm (one browser, after one discarded load), each with and without the extension. A task counts against the budget when it is over ${budgets.inkLongTaskMs} ms and would have been within it without its ink part, or when its ink part alone is over ${budgets.inkLongTaskMs} ms. The ink part is the time inside ink calls, layout they forced included. It must also be at most one frame in every task. A long task that ran ink script counts too in an arm where the page without the extension never had a long task. Longest task per load, with the extension: cold ${B.stress.cold.runs.map((x) => ms(x.longestTask)).join(', ')}, warm ${B.stress.warm.runs.map((x) => ms(x.longestTask)).join(', ')}. Without it: cold ${B.stress.cold.plain.map((x) => ms(x)).join(', ')}, warm ${B.stress.warm.plain.map((x) => ms(x)).join(', ')}.` : ''} Longest main-thread task that ran ink script: ${ms(B.stress.longestInkTask)}${Number.isFinite(B.stress.longestInkTaskInk) ? `, of which ${ms(B.stress.longestInkTaskInk)} was inside ink calls (layout they forced included) and the rest the page's own work` : ''}. Ink script events while scrolling it: ${B.stress.scroll?.inkEvents ?? 'n/a'}.` : 'not run.'}

Pointer listeners. The stub listens for pointerdown, pointermove, pointerup, pointercancel and click
on window in the capture phase, so it runs on every pointer move. Each run moves the mouse 400 times
and scrolls 20 times on a page with no ink. Extension ms is from a trace, which slows each call, so it
is an upper bound. Script ms is all script on the page over the same activity, untraced, without and
with the extension.

${table(['page', 'mode', 'pointer moves', 'extension ms', 'per move', 'script ms, without / with'], ['l', 'l', 'r', 'r', 'r', 'l'], ptrRows)}

Pen-down to first pixel. A pen stroke on \`${pen?.page ?? 'n/a'}\`, a page with no ink, so the
tools are not in the page yet. Time from the pen-down event to the call that paints the stroke's first
pixel; the pixel reaches the screen with the next frame. Background stopped: a fresh browser whose
extension background was stopped after the page loaded, so the pen-down wakes it before it can inject
the viewer and the tools. Background running: the same browser, a new load of the page. Later strokes:
the second and third strokes on the first page. The first load of each arm is discarded.

${pen ? table(['stroke', 'median ms', 'IQR ms', 'max ms', 'loads'], ['l', 'r', 'r', 'r', 'r'], penRows) : 'Not run.'}

${sizeText}
${findings.length ? `\nFindings, from this run and from repeats and traces of the same pages on the same machine:\n\n${findings.map((n) => `- ${n}`).join('\n')}\n` : ''}${(B.notes ?? []).length ? `\nNotes from the run:\n\n${B.notes.map((n) => `- ${n}`).join('\n')}\n` : ''}
## Anchor test set

Source: ${tsSource}. ${tsWhat}. Overall: **${mark(tsPass)}**.${tsWarn}

${table(['measure', 'result', 'target', 'status'], ['l', 'r', 'l', 'l'], tsCheckRows)}

Notes in the tray because their content is truly gone: ${doc.trayGone} on document pages.
In the tray after their words were edited: ${doc.trayEdited}. In the tray although the content is still
there (misses): ${doc.miss}.${slowest ? ` Slowest page to resolve all its notes: ${ms(slowest.totalMs)} (${slowest.pair}).` : ''}

### By category of change

${groupTable(T.byChange ?? {}, 'category')}

### By page kind

${groupTable(T.byKind ?? {}, 'page kind')}

### By anchor type

${groupTable(T.byAnchorType ?? {}, 'anchor type')}

## How to rerun

From the repository root:

\`\`\`
corepack pnpm --filter pageink-testset run score --anchor core
corepack pnpm --filter pageink-bench run bench --ext real --anchor core --har record --skip-overhead --skip-ink --skip-pen
corepack pnpm --filter pageink-bench run bench --ext real --anchor core
corepack pnpm results
\`\`\`

\`score\` writes \`testset/results/latest.json\`. \`bench\` builds the bench variant of the extension
itself and writes \`bench/results/latest.json\`. Run it on a quiet machine. Record the
public pages first with \`--har record\` (see \`bench/README.md\`). Live pages still vary with the network.
\`corepack pnpm results\` rewrites this page and
the tables in \`README.md\` and \`docs/ANCHORING.md\`. When the latest test set run scored a module other
than the one that ships, the script uses \`testset/results/core.json\` if that holds a run of the shipped
module.
`;

// ---------------------------------------------------------------------------
// Write

function replaceBlock(text, name, block, file) {
  const start = `<!-- results:${name}:start -->`;
  const end = `<!-- results:${name}:end -->`;
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < a) {
    console.error(`${file}: markers ${start} ... ${end} not found`);
    process.exit(2);
  }
  return `${text.slice(0, a + start.length)}\n${block}\n${text.slice(b)}`;
}

const outputs = [[join(ROOT, 'docs/RESULTS.md'), results]];
for (const [file, name, block] of [
  ['README.md', 'readme', readmeBlock],
  ['docs/ANCHORING.md', 'anchoring', anchoringBlock],
]) {
  const p = join(ROOT, file);
  outputs.push([p, replaceBlock(readFileSync(p, 'utf8'), name, block, file)]);
}

let changed = 0;
for (const [p, text] of outputs) {
  const before = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (before === text) continue;
  changed++;
  if (values.check) console.error(`${rel(p)} is out of date. Run corepack pnpm results.`);
  else writeFileSync(p, text);
}
if (!shipped) console.warn(`note: test set run is for ${anchorName}, not ${SHIPPED_ANCHOR}`);
if (!realExt) console.warn(`note: bench run is for ${B.meta.ext}, not the built extension`);
console.log(
  values.check
    ? `${changed} file(s) out of date`
    : `${changed} file(s) updated, ${outputs.length - changed} unchanged`,
);
process.exit(values.check && changed ? 1 : 0);
