// Turns scored runs into results/latest.json and a Markdown summary.
import type { NoteResult } from '../page/harness.ts';

export interface Run {
  pair: string;
  kind: string;
  change: string;
  shape: string;
  cond: string;
  /** Tuning or held-out (sources.json). */
  split?: string;
  phase: string;
  firstMs: number;
  totalMs: number;
  results: NoteResult[];
  written: number;
  /** Notes where describe's own origin on A was off from the truth rule. */
  describeOff: number;
  error?: string;
}

export const TARGETS = { right: 0.95, accounted: 1, wrong: 0.02 };

interface Tally {
  notes: number;
  right: number;
  trayGone: number;
  trayEdited: number;
  miss: number;
  wrong: number;
  /** Hidden with content that is there but not shown. Correct. */
  hidden: number;
  error: number;
  unwritten: number;
  present: number;
}

const empty = (): Tally => ({
  notes: 0,
  right: 0,
  trayGone: 0,
  trayEdited: 0,
  miss: 0,
  wrong: 0,
  hidden: 0,
  error: 0,
  unwritten: 0,
  present: 0,
});

function add(t: Tally, r: NoteResult): void {
  t.notes++;
  // Content that is there but hidden on B cannot be placed, so it is not counted as present.
  if (r.present && r.outcome !== 'hidden') t.present++;
  const k = {
    right: 'right',
    'tray-gone': 'trayGone',
    'tray-edited': 'trayEdited',
    miss: 'miss',
    wrong: 'wrong',
    hidden: 'hidden',
    error: 'error',
    unwritten: 'unwritten',
  }[r.outcome] as keyof Tally;
  t[k]++;
}

export function rates(t: Tally) {
  const scored = t.notes - t.unwritten;
  return {
    /** Right place among notes whose content still exists. */
    right: t.present ? t.right / t.present : 1,
    /** Placed or in the tray, never an error. */
    accounted: scored ? (scored - t.error) / scored : 1,
    wrong: scored ? t.wrong / scored : 0,
    /** Right place or correctly in the tray, over every note. */
    correct: scored ? (t.right + t.trayGone + t.trayEdited + t.hidden) / scored : 1,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function group(runs: Run[], key: (run: Run, r: NoteResult) => string | undefined): Map<string, Tally> {
  const m = new Map<string, Tally>();
  for (const run of runs) {
    for (const r of run.results) {
      const k = key(run, r);
      if (k === undefined) continue;
      let t = m.get(k);
      if (!t) {
        t = empty();
        m.set(k, t);
      }
      add(t, r);
    }
  }
  return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function table(title: string, m: Map<string, Tally>): string {
  const rows = [...m.entries()].map(([k, t]) => {
    const r = rates(t);
    return `| ${k} | ${t.notes} | ${t.right} | ${t.trayGone + t.trayEdited} | ${t.hidden} | ${t.miss} | ${t.wrong} | ${t.error} | ${pct(r.right)} | ${pct(r.wrong)} |`;
  });
  return [
    `### ${title}`,
    '',
    '| group | notes | right | tray (correct) | hidden (correct) | miss | wrong | error | right of present | wrong |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
}

export function buildReport(
  runs: Run[],
  meta: {
    anchor: string;
    started: string;
    seconds: number;
    missing: string[];
    blockedRequests: number;
    quick: boolean;
  },
) {
  const all = empty();
  const docs = empty();
  for (const run of runs) {
    for (const r of run.results) {
      add(all, r);
      if (run.kind !== 'dynamic') add(docs, r);
    }
  }
  const rd = rates(docs);
  const ra = rates(all);
  const pass = rd.right >= TARGETS.right && ra.accounted >= TARGETS.accounted && ra.wrong < TARGETS.wrong;
  const byPair = group(
    runs,
    (run) => `${run.pair} @${run.cond}${run.phase === 'load' ? '' : ` (${run.phase})`}`,
  );
  const byChange = group(runs, (run) => run.change);
  const byKind = group(runs, (run) => run.kind);
  const byType = group(runs, (_, r) => r.anchorType ?? 'none');
  const byMethod = group(
    runs,
    (_, r) => r.method ?? (r.outcome.startsWith('tray') || r.outcome === 'miss' ? 'tray' : r.outcome),
  );
  const byNote = group(runs, (_, r) => r.kind);
  const byCond = group(runs, (run) => run.cond);
  const splitOf = (run: Run) => run.split ?? 'tuning';
  const bySplit = group(
    runs,
    (run) => `${splitOf(run)} ${run.kind === 'dynamic' ? 'dynamic' : 'document pages'}`,
  );
  const byChangeSplit = group(runs, (run) => `${run.change} (${splitOf(run)})`);
  const failures = runs.flatMap((run) =>
    run.results
      .filter((r) => r.outcome === 'miss' || r.outcome === 'wrong' || r.outcome === 'error')
      .map((r) => ({ pair: run.pair, cond: run.cond, phase: run.phase, split: splitOf(run), ...r })),
  );
  const perf = runs
    .filter((r) => r.results.length)
    .map((r) => ({
      pair: r.pair,
      cond: r.cond,
      phase: r.phase,
      firstMs: Math.round(r.firstMs * 10) / 10,
      totalMs: Math.round(r.totalMs * 10) / 10,
    }));
  const maxTotal = perf.reduce((m, p) => Math.max(m, p.totalMs), 0);
  const describeOff = runs.reduce((s, r) => s + (r.phase === 'settled' ? 0 : r.describeOff), 0);
  const obj = (m: Map<string, Tally>) =>
    Object.fromEntries([...m.entries()].map(([k, t]) => [k, { ...t, ...rates(t) }]));
  const json = {
    meta: { ...meta, targets: TARGETS },
    pass,
    totals: { all: { ...all, ...ra }, documentPages: { ...docs, ...rd } },
    byChange: obj(byChange),
    byKind: obj(byKind),
    byAnchorType: obj(byType),
    byMethod: obj(byMethod),
    byNoteKind: obj(byNote),
    byCondition: obj(byCond),
    byPair: obj(byPair),
    bySplit: obj(bySplit),
    byChangeSplit: obj(byChangeSplit),
    failures,
    /** Every note in one line: pair, condition, phase, note id, anchor type, outcome, ladder method, score. */
    notes: runs.flatMap((run) =>
      run.results.map((r) => [
        run.pair,
        run.cond,
        run.phase,
        r.id,
        r.anchorType ?? '',
        r.outcome,
        r.method ?? '',
        r.score === undefined ? null : Math.round(r.score * 1000) / 1000,
      ]),
    ),
    errors: runs.filter((r) => r.error).map((r) => ({ pair: r.pair, cond: r.cond, error: r.error })),
    perf,
    describeOff,
  };
  const headline = `${pass ? 'PASS' : 'FAIL'}  anchor ${meta.anchor}: right ${pct(rd.right)} of present (document pages, target ${pct(TARGETS.right)}), accounted ${pct(ra.accounted)}, wrong ${pct(ra.wrong)} (target under ${pct(TARGETS.wrong)}), ${all.notes} notes in ${runs.length} runs`;
  const fail = failures.slice(0, 400).map(
    (f) =>
      `| ${f.pair}${f.split === 'heldout' ? ' (held-out)' : ''} @${f.cond}${f.phase === 'load' ? '' : ` ${f.phase}`} | ${f.kind} | ${f.anchorType ?? ''}/${f.place ?? ''} | ${f.outcome} | ${f.method ?? ''} | ${f.truthHow} | ${f.dist ?? ''} | ${String(f.cause.quoteCountB ?? '')} | ${f.cause.pathFound ? (f.cause.pathHasQuote ? 'quote' : 'no quote') : 'missing'} | ${String(
        f.cause.quote ?? '',
      )
        .replace(/\|/g, '/')
        .slice(0, 50)} |`,
  );
  const md = [
    '# Anchor test set results',
    '',
    `Anchor module: \`${meta.anchor}\`. Run started ${meta.started}, took ${meta.seconds} s${meta.quick ? ', quick mode' : ''}.`,
    '',
    `**${headline}**`,
    '',
    '| measure | document pages | all runs | target |',
    '| --- | ---: | ---: | ---: |',
    `| notes | ${docs.notes} | ${all.notes} | |`,
    `| right place, of notes whose content still exists | ${pct(rd.right)} | ${pct(ra.right)} | ${pct(TARGETS.right)} or better |`,
    `| accounted for (placed or in the tray) | ${pct(rd.accounted)} | ${pct(ra.accounted)} | 100% |`,
    `| wrong place | ${pct(rd.wrong)} | ${pct(ra.wrong)} | under ${pct(TARGETS.wrong)} |`,
    `| in the tray and truly gone | ${docs.trayGone} | ${all.trayGone} | |`,
    `| in the tray after the words were edited | ${docs.trayEdited} | ${all.trayEdited} | |`,
    `| in the tray but still present (miss) | ${docs.miss} | ${all.miss} | |`,
    `| hidden with content that is closed or hidden on B | ${docs.hidden} | ${all.hidden} | |`,
    '',
    `Slowest page: ${maxTotal.toFixed(1)} ms to resolve all its notes. Describe disagreed with the truth rule on A for ${describeOff} notes. Blocked network requests during replay: ${meta.blockedRequests}.`,
    meta.missing.length
      ? `\nNot fetched, skipped: ${meta.missing.join(', ')}. Run \`corepack pnpm --filter pageink-testset run fetch\`.`
      : '',
    '',
    'Held-out pairs were chosen by rule before any tuning (sources.json, `heldout`). Layout runs take the split of their fixture.',
    '',
    table('By split', bySplit),
    table('By category of change', byChange),
    table('By category of change and split', byChangeSplit),
    table('By page kind', byKind),
    table('By anchor type', byType),
    table('By ladder method', byMethod),
    table('By note kind', byNote),
    table('By condition', byCond),
    table('By pair', byPair),
    `### Misses and wrong places (${failures.length})`,
    '',
    'Columns: pair, note kind, anchor type and place, outcome, ladder method, how the truth found the content, distance from the expected origin in px, times the quote occurs on B, structural path on B, quote.',
    '',
    '| pair | note | anchor | outcome | method | truth | dist | quote count | path | quote |',
    '| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- |',
    ...fail,
    failures.length > 400 ? `\n${failures.length - 400} more in latest.json.` : '',
    '',
  ].join('\n');
  return { json, md, headline, pass };
}
