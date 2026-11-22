/**
 * The end-to-end tests expect a build without the git-ignored cloud-ids.local.json, so they see
 * the same build on every machine (build/targets.ts). A build made with plain `wxt build` on a
 * machine that has the file carries its client ids, and then tests fail for no fault of the
 * code. This finds such a build before any test runs, so the run can say what to do.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The ids in a cloud-ids file that are set. None when the file is missing or not JSON. */
export function idsIn(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return ['google', 'microsoft'].map((k) => v[k]).filter((x): x is string => typeof x === 'string' && !!x);
  } catch {
    return [];
  }
}

/** True when a script, page or manifest of the build in `dir` holds one of `ids`. */
export function carries(dir: string, ids: string[]): boolean {
  if (!ids.length || !existsSync(dir)) return false;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (carries(p, ids)) return true;
    } else if (/\.(js|html|json)$/.test(e.name)) {
      const text = readFileSync(p, 'utf8');
      if (ids.some((id) => text.includes(id))) return true;
    }
  }
  return false;
}

/** What to tell the person when the builds in `dirs` carry local ids. Empty when none does. */
export function localIdsMessage(localFile: string, dirs: string[]): string {
  const ids = idsIn(localFile);
  const bad = dirs.filter((d) => carries(d, ids));
  if (!bad.length) return '';
  return (
    `These builds carry the client ids of cloud-ids.local.json: ${bad.join(', ')}. ` +
    'The end-to-end tests need builds without them. Run `corepack pnpm test:e2e`, which makes ' +
    'the builds first, or build with INK_NO_LOCAL_IDS=1.'
  );
}
