// Runs a test suite many times and lists every test that failed at least once. A test that
// fails one run in twenty is found here, not in CI. Part of the runs can be made while busy
// workers load the CPU, which imitates a slow or shared CI runner.
//
// Usage: node scripts/soak.mjs <suite>... [--runs 20] [--load 0] [--loaded <runs>] [--limit 90]
//                                         [--ci] [--build] [--out <folder>] [-- <more test arguments>]
//
//   --runs N     full passes of each suite (default 20)
//   --load K     K busy workers while a loaded pass runs (default 0: no pass is loaded)
//   --loaded M   how many of the N passes are loaded (default: half of them when --load is set)
//   --limit MIN  a test command that runs longer is killed and counts as failed (default 90)
//   --ci         set CI=1, so the configs take their CI settings (fewer workers, longer limits)
//   --build      make the builds a suite needs first (embed dist, extension builds)
//   --out DIR    where soak.md, soak.json and the logs go (default: a new folder in the temp dir)
//   -- ...       passed to every test command, for example a file name to soak one file
//
// To free the machine for a while, make a file named `pause` in the results folder. The soak
// waits before its next pass until the file is gone.
//
// Retries are always off here (--retry=0 for Vitest, --retries=0 for Playwright), whatever the
// configs say. A test that passes on a second try is a failure for this script.
//
// Vitest suites run once per pass. The end-to-end suite runs once per block (unloaded, loaded)
// with --repeat-each. Suites that are plain commands count by exit code.
// `node scripts/soak.mjs --list` prints the suites.
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const reporter = join(import.meta.dirname, 'soak-reporter.mjs');

const NOT_BUDGET = '^(?!.*budget: )';
/** The browser tests of a package in one engine, as its test script runs them. */
const browser = (cwd, engine, budgets) => ({
  kind: 'vitest',
  cwd,
  steps: [
    { args: ['--project', 'browser', `--browser.name=${engine}`, ...(budgets ? ['-t', NOT_BUDGET] : [])] },
    ...(budgets
      ? [
          {
            args: ['--project', 'browser', `--browser.name=${engine}`, '-t', 'budget: '],
            env: { INK_BUDGET_RUN: '1' },
          },
        ]
      : []),
  ],
});
const EMBED_BUILD = 'vite build && vite build -c vite.iife.config.ts && node scripts/types.mjs';
const EXT_BUILD =
  'wxt build && wxt build -b edge && wxt build -b firefox && wxt build -b safari && ' +
  'INK_NO_LOCAL_IDS=1 wxt build --mode bench && INK_CLOUD_FAKE=1 wxt build';

const SUITES = {
  'core-unit': { kind: 'vitest', cwd: 'packages/core', steps: [{ args: ['--project', 'unit'] }] },
  'core-chromium': browser('packages/core', 'chromium', true),
  'core-webkit': browser('packages/core', 'webkit', true),
  'core-firefox': browser('packages/core', 'firefox', true),
  'embed-unit': {
    kind: 'vitest',
    cwd: 'packages/embed',
    build: EMBED_BUILD,
    steps: [{ args: ['--project', 'unit'] }],
  },
  'embed-chromium': { ...browser('packages/embed', 'chromium', false), build: EMBED_BUILD },
  'embed-webkit': { ...browser('packages/embed', 'webkit', false), build: EMBED_BUILD },
  'embed-firefox': { ...browser('packages/embed', 'firefox', false), build: EMBED_BUILD },
  // Unit tests and the three engines in one run, as the extension's test script does.
  extension: { kind: 'vitest', cwd: 'packages/extension', build: EXT_BUILD, steps: [{ args: [] }] },
  'bench-unit': { kind: 'vitest', cwd: 'bench', steps: [{ args: [] }] },
  e2e: { kind: 'playwright', cwd: 'packages/extension', build: EXT_BUILD },
  testset: {
    kind: 'command',
    cwd: 'testset',
    steps: ['tsx src/freeze-test.ts', 'tsx src/scorer-test.ts'],
  },
  'testset-gate': {
    kind: 'command',
    cwd: 'testset',
    steps: ['tsx src/score.ts --anchor core --quick --gate --out {tmp}/testset'],
  },
  'bench-gate': {
    kind: 'command',
    cwd: 'bench',
    steps: ['tsx src/bench.ts --ext real --anchor core --quick --gate --out {tmp}/bench'],
  },
};
const GROUPS = {
  core: ['core-unit', 'core-chromium', 'core-webkit', 'core-firefox'],
  embed: ['embed-unit', 'embed-chromium', 'embed-webkit', 'embed-firefox'],
  fast: [
    'core-unit',
    'core-chromium',
    'core-webkit',
    'core-firefox',
    'embed-unit',
    'embed-chromium',
    'embed-webkit',
    'embed-firefox',
    'extension',
    'bench-unit',
    'testset',
  ],
};

// ---- arguments ---------------------------------------------------------------------

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const more = dash >= 0 ? argv.slice(dash + 1) : [];
const own = dash >= 0 ? argv.slice(0, dash) : argv;
const opt = { runs: 20, load: 0, loaded: -1, limit: 90, ci: false, build: false, out: '' };
const names = [];
for (let i = 0; i < own.length; i++) {
  const a = own[i];
  if (a === '--list') {
    console.log(`Suites: ${Object.keys(SUITES).join(', ')}`);
    console.log(`Groups: ${Object.keys(GROUPS).join(', ')}`);
    process.exit(0);
  } else if (a === '--ci') opt.ci = true;
  else if (a === '--build') opt.build = true;
  else if (a === '--out') opt.out = resolve(own[++i]);
  else if (a === '--runs' || a === '--load' || a === '--loaded' || a === '--limit') {
    const n = Number(own[++i]);
    if (!Number.isInteger(n) || n < 0) fail(`${a} takes a whole number`);
    opt[a.slice(2)] = n;
  } else if (a.startsWith('--')) fail(`unknown option ${a}`);
  else names.push(...(GROUPS[a] ?? [a]));
}
if (!names.length) fail('name a suite (see --list)');
for (const n of names) if (!SUITES[n]) fail(`unknown suite ${n} (see --list)`);
if (opt.runs < 1) fail('--runs must be at least 1');
if (opt.loaded < 0) opt.loaded = opt.load ? Math.floor(opt.runs / 2) : 0;
if (opt.loaded > opt.runs) fail('--loaded cannot be more than --runs');
if (opt.loaded && !opt.load) fail('--loaded needs --load');
const outDir = opt.out || mkdtempSync(join(tmpdir(), 'ink-soak-'));
const logDir = join(outDir, 'logs');
mkdirSync(logDir, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'ink-soak-tmp-'));

function fail(msg) {
  console.error(`soak: ${msg}`);
  process.exit(2);
}

// ---- processes: everything started here is stopped here -------------------------------

/** Busy workers and the running test command. All are killed when this script ends, however. */
const workers = new Set();
let current = null;
let interrupted = false;

// A busy worker spins in short turns and leaves when this script is gone, so a killed soak
// never leaves load behind.
const SPIN = `const parent = ${process.pid};
const alive = () => { try { process.kill(parent, 0); return true; } catch { return false; } };
const turn = () => {
  const end = Date.now() + 200;
  while (Date.now() < end);
  if (!alive()) process.exit(0);
  setImmediate(turn);
};
turn();`;

function startLoad(n) {
  for (let i = 0; i < n; i++) {
    const w = spawn(process.execPath, ['-e', SPIN], { stdio: 'ignore' });
    workers.add(w);
    w.on('exit', () => workers.delete(w));
  }
}
function stopLoad() {
  for (const w of workers) w.kill('SIGKILL');
  workers.clear();
}
function killGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
function stopAll() {
  stopLoad();
  killGroup(current);
  rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    interrupted = true;
    stopAll();
    report();
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  console.error(e);
  stopAll();
  process.exit(2);
});

/**
 * Run a shell command in its own process group, with output to a log file. Resolves with the
 * exit code. A command that runs past the limit is killed and counts as failed.
 */
function run(cmd, cwd, env, log) {
  return new Promise((done) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      detached: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    current = child;
    // The log is written as the command runs, so a long run can be followed.
    writeFileSync(log, '');
    let text = '';
    const take = (d) => {
      text += d;
      appendFileSync(log, d);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      take(`\nsoak: killed after ${opt.limit} minutes\n`);
      killGroup(child);
    }, opt.limit * 60_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      current = null;
      // A test command may leave a browser behind when it is killed or crashes.
      killGroup(child);
      done({ code: code ?? 1, signal, text });
    });
  });
}

const quote = (a) => `'${String(a).replaceAll("'", "'\\''")}'`;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character starts a colour code.
const plain = (s) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

// ---- results -----------------------------------------------------------------------

/** suite -> test key -> { runs, failures: { unloaded, loaded }, messages: Map<first line, count> } */
const table = new Map();
const passes = [];

/**
 * Notes a passing test may carry that must not pass unseen: a time budget that was not judged
 * because the machine was busy, and a browser that had to be started twice.
 */
const NOTES = ['not judged', 'started again'];
const notesIn = (texts) => NOTES.filter((n) => texts.some((t) => String(t).includes(n)));

function note(suite, key, loaded, failed, messages = [], notes = []) {
  const tests = table.get(suite) ?? new Map();
  table.set(suite, tests);
  const t = tests.get(key) ?? { runs: 0, unloaded: 0, loaded: 0, messages: new Map(), notes: {} };
  tests.set(key, t);
  t.runs++;
  for (const n of notes) {
    t.notes[n] ??= [0, 0];
    t.notes[n][loaded ? 1 : 0]++;
  }
  if (!failed) return;
  t[loaded ? 'loaded' : 'unloaded']++;
  for (const m of messages.length ? messages : ['(no message)']) {
    const line = plain(m).split('\n').slice(0, 3).join(' / ').slice(0, 400);
    t.messages.set(line, (t.messages.get(line) ?? 0) + 1);
  }
}

/** Reads one report. Returns how many failures it held, or -1 when there is no report. */
function readVitest(suite, file, loaded) {
  if (!existsSync(file)) return -1;
  const r = JSON.parse(readFileSync(file, 'utf8'));
  let failures = r.errors.length;
  for (const t of r.tests) {
    if (t.state === 'skipped') continue;
    const key = `${t.project ? `[${t.project}] ` : ''}${t.file} > ${t.name}`;
    if (t.state !== 'passed') failures++;
    // A test that passed only on a retry failed once. Retries are off, so this guards the flag.
    note(suite, key, loaded, t.state !== 'passed' || t.retries > 0, t.messages, notesIn(t.notes ?? []));
  }
  for (const e of r.errors) {
    const at = e.file ? `${e.project ? `[${e.project}] ` : ''}${e.file}` : 'no file';
    note(suite, `(error outside a test) ${at}`, loaded, true, [e.message]);
  }
  return failures;
}

function readPlaywright(suite, file, loaded) {
  if (!existsSync(file)) return false;
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const walk = (s, path) => {
    const here = s.title ? [...path, s.title] : path;
    for (const c of s.suites ?? []) walk(c, here);
    for (const spec of s.specs ?? []) {
      for (const t of spec.tests ?? []) {
        for (const res of t.results ?? []) {
          if (res.status === 'skipped') continue;
          const msgs = (res.errors ?? []).map((e) => e.message ?? String(e));
          const notes = notesIn([...(t.annotations ?? []), ...(res.annotations ?? [])].map((a) => a.type));
          note(suite, [...here, spec.title].join(' > '), loaded, res.status !== 'passed', msgs, notes);
        }
      }
    }
  };
  for (const s of r.suites ?? []) walk(s, []);
  for (const e of r.errors ?? []) note(suite, '(error outside a test)', loaded, true, [e.message ?? '']);
  return true;
}

const tail = (text) => plain(text).trim().split('\n').slice(-12).join('\n');

async function vitestPass(name, suite, n, loaded) {
  for (const [i, step] of suite.steps.entries()) {
    const file = join(scratch, `${name}-${n}-${i}.json`);
    // One file may hold no test of a step (no budget test, say): that is not a failure.
    const args = [
      'run',
      ...step.args,
      '--retry=0',
      '--passWithNoTests',
      '--reporter=dot',
      `--reporter=${reporter}`,
      ...more,
    ];
    const cmd = `corepack pnpm exec vitest ${args.map(quote).join(' ')}`;
    const log = join(logDir, `${name}-${n}${suite.steps.length > 1 ? `-${i}` : ''}.log`);
    const r = await run(cmd, join(repo, suite.cwd), { ...step.env, INK_SOAK_REPORT: file }, log);
    const failures = readVitest(name, file, loaded);
    rmSync(file, { force: true });
    // The run failed and no test says why: the run itself is the failure.
    note(name, `(run) vitest ${step.args.join(' ')}`, loaded, failures < 0 || (r.code !== 0 && !failures), [
      `exit ${r.code}${r.signal ? ` ${r.signal}` : ''}\n${tail(r.text)}`,
    ]);
    if (interrupted) return;
  }
}

async function playwrightBlock(name, suite, repeat, loaded) {
  const file = join(scratch, `${name}-${loaded ? 'loaded' : 'unloaded'}.json`);
  const args = ['test', `--repeat-each=${repeat}`, '--retries=0', '--reporter=dot,json', ...more];
  const cmd = `corepack pnpm exec playwright ${args.map(quote).join(' ')}`;
  const log = join(logDir, `${name}-${loaded ? 'loaded' : 'unloaded'}.log`);
  const r = await run(cmd, join(repo, suite.cwd), { PLAYWRIGHT_JSON_OUTPUT_FILE: file }, log);
  const read = readPlaywright(name, file, loaded);
  rmSync(file, { force: true });
  note(name, '(run) playwright test', loaded, !read, [`exit ${r.code}\n${tail(r.text)}`]);
}

async function commandPass(name, suite, n, loaded) {
  for (const [i, step] of suite.steps.entries()) {
    const cmd = `corepack pnpm exec ${step.replaceAll('{tmp}', scratch)}`;
    const log = join(logDir, `${name}-${n}${suite.steps.length > 1 ? `-${i}` : ''}.log`);
    const r = await run(cmd, join(repo, suite.cwd), {}, log);
    note(name, step, loaded, r.code !== 0, [`exit ${r.code}\n${tail(r.text)}`]);
    if (interrupted) return;
  }
}

function report() {
  const lines = ['# Soak', ''];
  lines.push(
    `Machine: ${availableParallelism()} cores. Busy workers in a loaded pass: ${opt.load}. ` +
      `CI settings: ${opt.ci ? 'yes' : 'no'}. Retries: off.${interrupted ? ' Stopped early.' : ''}`,
    '',
  );
  lines.push(
    '| suite | passes | unloaded | loaded | tests | tests that failed |',
    '|---|---|---|---|---|---|',
  );
  let bad = 0;
  for (const name of names) {
    const tests = table.get(name) ?? new Map();
    const done = passes.filter((p) => p.suite === name);
    const failed = [...tests.values()].filter((t) => t.unloaded + t.loaded > 0).length;
    bad += failed;
    const loaded = done.filter((p) => p.loaded).reduce((a, p) => a + p.count, 0);
    const all = done.reduce((a, p) => a + p.count, 0);
    lines.push(`| ${name} | ${all} | ${all - loaded} | ${loaded} | ${tests.size} | ${failed} |`);
  }
  lines.push('');
  if (!bad) lines.push('No test failed.');
  else {
    lines.push(
      '| suite | test | runs | failures | unloaded | loaded | messages |',
      '|---|---|---|---|---|---|---|',
    );
    for (const name of names) {
      for (const [key, t] of table.get(name) ?? []) {
        const f = t.unloaded + t.loaded;
        if (!f) continue;
        const msgs = [...t.messages].map(([m, c]) => `${c}x ${m}`).join('<br>');
        const cell = (s) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
        lines.push(
          `| ${name} | ${cell(key)} | ${t.runs} | ${f} | ${t.unloaded} | ${t.loaded} | ${cell(msgs)} |`,
        );
      }
    }
  }
  // What passed with a note: it must not pass for a plain pass.
  const noted = [];
  for (const name of names)
    for (const [key, t] of table.get(name) ?? [])
      for (const [n, [calm, busy]] of Object.entries(t.notes))
        noted.push(`| ${name} | ${key.replaceAll('|', '\\|')} | ${n} | ${t.runs} | ${calm} | ${busy} |`);
  if (noted.length)
    lines.push(
      '',
      'Tests that passed with a note. "not judged": a time budget was not judged, because other work had the machine or it changed pace. "started again": the browser did not start and was started once more.',
      '',
      '| suite | test | note | runs | unloaded | loaded |',
      '|---|---|---|---|---|---|',
      ...noted,
    );
  lines.push('', '| suite | pass | loaded | minutes | load average at the start |', '|---|---|---|---|---|');
  for (const p of passes)
    lines.push(`| ${p.suite} | ${p.label} | ${p.loaded ? 'yes' : 'no'} | ${p.minutes} | ${p.loadavg} |`);
  const md = `${lines.join('\n')}\n`;
  writeFileSync(join(outDir, 'soak.md'), md);
  const json = {
    options: opt,
    passes,
    suites: Object.fromEntries(
      [...table].map(([s, tests]) => [
        s,
        [...tests].map(([test, t]) => ({ test, ...t, messages: Object.fromEntries(t.messages) })),
      ]),
    ),
  };
  writeFileSync(join(outDir, 'soak.json'), JSON.stringify(json, null, 2));
  return { md, bad };
}

// ---- the run -----------------------------------------------------------------------

if (opt.ci) process.env.CI = '1';
delete process.env.INK_TEST_REPORTS;
console.log(`soak: results in ${outDir}`);

if (opt.build) {
  const built = new Set();
  for (const name of names) {
    const s = SUITES[name];
    if (!s.build || built.has(`${s.cwd} ${s.build}`)) continue;
    built.add(`${s.cwd} ${s.build}`);
    console.log(`soak: building for ${name}`);
    const r = await run(s.build, join(repo, s.cwd), {}, join(logDir, `build-${name}.log`));
    if (r.code !== 0) {
      console.error(tail(r.text));
      fail(`the build for ${name} failed`);
    }
  }
}

/** One pass or block, timed, with the load on or off around it. */
async function timed(suite, label, loaded, count, work) {
  // A file named pause in the results folder holds the soak before its next pass.
  while (existsSync(join(outDir, 'pause')) && !interrupted) await new Promise((r) => setTimeout(r, 1000));
  if (loaded) startLoad(opt.load);
  const t0 = Date.now();
  const before = loadavg()[0].toFixed(1);
  try {
    await work();
  } finally {
    stopLoad();
  }
  const minutes = ((Date.now() - t0) / 60000).toFixed(1);
  passes.push({ suite, label, loaded, count, minutes, loadavg: before });
  const failed = [...(table.get(suite)?.values() ?? [])].filter((t) => t.unloaded + t.loaded > 0).length;
  console.log(
    `soak: ${suite} ${label}${loaded ? ' (loaded)' : ''}: ${minutes} min, ${failed} failing tests so far`,
  );
  report();
}

for (const name of names) {
  const suite = SUITES[name];
  if (interrupted) break;
  if (suite.kind === 'playwright') {
    const calm = opt.runs - opt.loaded;
    if (calm)
      await timed(name, `${calm} repeats`, false, calm, () => playwrightBlock(name, suite, calm, false));
    if (opt.loaded && !interrupted)
      await timed(name, `${opt.loaded} repeats`, true, opt.loaded, () =>
        playwrightBlock(name, suite, opt.loaded, true),
      );
    continue;
  }
  // Loaded and unloaded passes take turns, so both see the same stretch of time.
  let left = opt.loaded;
  for (let n = 1; n <= opt.runs && !interrupted; n++) {
    const loaded = left > 0 && (n % 2 === 0 || opt.runs - n < left);
    if (loaded) left--;
    const work = suite.kind === 'vitest' ? vitestPass : commandPass;
    await timed(name, `${n}`, loaded, 1, () => work(name, suite, n, loaded));
  }
}

const { md, bad } = report();
console.log(`\n${md}`);
console.log(`soak: results in ${outDir}`);
process.exit(bad ? 1 : 0);
