// Lists failed tests, and end-to-end tests that passed only when run again, from the JSON
// reports of Vitest and Playwright. CI appends the list to the job summary and keeps it as an
// artifact, so a failure is easy to find and a retry never hides a flaky test.
// Usage: node scripts/test-summary.mjs <report.json or folder>... [--out list.md]
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const at = args.indexOf('--out');
const out = at >= 0 ? args[at + 1] : undefined;
const inputs = at >= 0 ? args.filter((_, i) => i !== at && i !== at + 1) : args;

const files = [];
for (const p of inputs) {
  if (!existsSync(p)) continue;
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p)) if (f.endsWith('.json')) files.push(join(p, f));
  } else files.push(p);
}

const failed = [];
const flaky = [];
for (const file of files) {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const from = basename(file, '.json');
  if (Array.isArray(r.testResults)) {
    // Vitest.
    for (const f of r.testResults) {
      const name = f.name.split('/packages/').pop();
      for (const a of f.assertionResults ?? [])
        if (a.status === 'failed') failed.push(`${from}: ${name} > ${a.fullName}`);
      if (f.status === 'failed' && !(f.assertionResults ?? []).some((a) => a.status === 'failed'))
        failed.push(`${from}: ${name}: ${(f.message ?? '').split('\n')[0]}`);
    }
  } else if (Array.isArray(r.suites)) {
    // Playwright.
    const walk = (suite, path) => {
      const here = suite.title ? [...path, suite.title] : path;
      for (const s of suite.suites ?? []) walk(s, here);
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests ?? []) {
          const name = `${from}: ${[...here, spec.title].join(' > ')}`;
          if (t.status === 'unexpected') failed.push(name);
          else if (t.status === 'flaky') {
            const why = t.results?.find((x) => x.status !== 'passed')?.error?.message ?? '';
            flaky.push(`${name}: ${why.split('\n')[0].slice(0, 200)}`);
          }
        }
      }
    };
    for (const s of r.suites) walk(s, []);
  }
}

const lines = ['## Tests', '', `Reports read: ${files.length}.`, ''];
lines.push(failed.length ? `Failed (${failed.length}):` : 'No test failed.');
for (const n of failed) lines.push(`- ${n}`);
lines.push('');
lines.push(
  flaky.length ? `Passed only on the retry (${flaky.length}), to be fixed:` : 'No test needed a retry.',
);
for (const n of flaky) lines.push(`- ${n}`);
const md = `${lines.join('\n')}\n`;

console.log(md);
if (out) writeFileSync(out, md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
