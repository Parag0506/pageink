// Reads the phase logs that run.sh wrote and prints one line per check, with what it saw.
//   node apple/sim/summary.mjs apple/build/sim
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const logs = readdirSync(dir)
  .filter((f) => /^[A-Z]_\w+\.log$/.test(f))
  .sort();
const words = (m) =>
  m
    .replace(/^test\d+_/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

const rows = [];
const notes = [];
for (const f of logs) {
  const text = readFileSync(join(dir, f), 'utf8');
  const fails = new Map();
  for (const m of text.matchAll(/error: -\[SimTests\.(\w+) (\w+)\] : (.+)/g)) {
    if (!fails.has(m[2])) fails.set(m[2], m[3].replace(/^XCTAssert\w+ failed( - |: )?/, '').trim());
  }
  for (const m of text.matchAll(/Test Case '-\[SimTests\.(\w+) (\w+)\]' (passed|failed|skipped)/g)) {
    rows.push({ phase: m[1].replace(/Tests$/, ''), name: words(m[2]), result: m[3], why: fails.get(m[2]) ?? '' });
  }
  // A test whose runner crashed has no result line, only a place in the failing list.
  for (const m of text.matchAll(/^\t(\w+)\.(test\w+)\(\)$/gm)) {
    const name = words(m[2]);
    if (!rows.some((r) => r.name === name)) {
      rows.push({ phase: m[1].replace(/Tests$/, ''), name, result: 'failed', why: 'the test runner stopped (crash or hang)' });
    }
  }
  for (const m of text.matchAll(/^SIMNOTE (\w+): (.+)$/gm)) notes.push(`${m[1]}: ${m[2]}`);
  if (!/Test Case '/.test(text)) rows.push({ phase: f.replace(/\.log$/, ''), name: 'did not run', result: 'failed', why: (text.match(/error: .+/) ?? [''])[0] });
}

const pad = Math.max(...rows.map((r) => r.name.length), 10);
console.log('\nSimulator checks');
for (const r of rows) {
  const mark = r.result === 'passed' ? 'PASS' : r.result === 'skipped' ? 'SKIP' : 'FAIL';
  console.log(`  ${mark}  ${r.phase.padEnd(16)} ${r.name.padEnd(pad)}${r.why ? `  ${r.why}` : ''}`);
}
const passed = rows.filter((r) => r.result === 'passed').length;
console.log(`\n  ${passed} of ${rows.length} passed`);
if (notes.length) {
  console.log('\nWhat the tests saw');
  for (const n of notes) console.log(`  ${n}`);
}
