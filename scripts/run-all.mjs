// Runs each command in turn, even after one fails, and exits 1 when any failed. The test
// scripts use it so one run shows every failing engine, not only the first.
// Usage: node scripts/run-all.mjs "<command>" "<command>" ...
import { spawnSync } from 'node:child_process';

const failed = [];
for (const cmd of process.argv.slice(2)) {
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit' });
  if (r.status !== 0) failed.push(cmd);
}
if (failed.length) {
  console.error(`\n${failed.length} failed:`);
  for (const c of failed) console.error(`  ${c}`);
  process.exit(1);
}
