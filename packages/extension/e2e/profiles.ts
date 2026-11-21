/**
 * Global setup for the e2e run. Every browser profile of the run goes into one folder, made
 * here and removed when the run ends, whether its tests passed, failed or timed out. A run that
 * was killed before its teardown leaves its folder behind: the next run removes it, once the
 * process that made it is gone.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'ink-e2e-run-';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const drop = (dir: string): void =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

export default function setup(): () => void {
  const root = tmpdir();
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX)) continue;
    const pid = Number(name.slice(PREFIX.length).split('-')[0]);
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) drop(join(root, name));
  }
  const dir = mkdtempSync(join(root, `${PREFIX}${process.pid}-`));
  // Workers start after this and inherit it. fixtures.ts makes each profile inside.
  process.env.INK_E2E_PROFILES = dir;
  return () => drop(dir);
}
