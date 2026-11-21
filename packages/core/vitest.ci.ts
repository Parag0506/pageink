// Options the Vitest configs of every package take on CI. Shared runners have 2 to 4 cores,
// so test files run two at a time. With INK_TEST_REPORTS set, each run also writes a JSON
// report there, named by package, project and browser, for scripts/test-summary.mjs.
//
// INK_BUDGET_RUN=1 marks the run of the time budget tests ("budget: ..." in the name), which
// the test script makes on its own after the other browser tests. Those files then run one at
// a time, on CI and on a laptop, so no other test file shares the machine while a budget is
// measured. Its report gets "-budget" in the name.
import { join } from 'node:path';
import type { InlineConfig } from 'vitest/node';

type Options = Pick<InlineConfig, 'maxWorkers' | 'fileParallelism' | 'reporters'>;

export function ciOptions(pkg: string): Options {
  const argv = process.argv;
  const flag = (name: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const budgetRun = process.env.INK_BUDGET_RUN === '1';
  const out: Options = {};
  if (process.env.CI) out.maxWorkers = 2;
  if (budgetRun) {
    out.maxWorkers = 1;
    out.fileParallelism = false;
  }
  const dir = process.env.INK_TEST_REPORTS;
  if (dir) {
    const parts = [pkg, flag('project') ?? 'all', flag('browser.name') ?? 'node'];
    if (budgetRun) parts.push('budget');
    out.reporters = ['default', ['json', { outputFile: join(dir, `${parts.join('-')}.json`) }]];
  }
  return out;
}
