// Types and loaders for sources.json. Shared by fetch, add and score.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCES = join(ROOT, 'sources.json');
export const FIXTURES = join(ROOT, 'fixtures');
export const CACHE = join(ROOT, 'cache');
export const CACHE_FIXTURES = join(CACHE, 'fixtures');
export const RESULTS = join(ROOT, 'results');

export type PairKind = 'wikipedia' | 'arxiv' | 'docs' | 'wayback' | 'synthetic' | 'dynamic';

export interface Version {
  url: string;
  label: string;
}

export interface Pair {
  id: string;
  kind: PairKind;
  /** What differs between A and B. Used to group scores. */
  change: string;
  /** Rough shape of the page: prose, tables, figures, lists, reference, article, app. */
  shape: string;
  license: string;
  attribution: string;
  /** True only when the licence allows the frozen copy to live in the public repo. */
  commit: boolean;
  a: Version;
  b: Version;
  note?: string;
  /**
   * Held out from tuning. Chosen once by rule before any tuning: a real-content pair is held
   * out when the SHA-1 of its id is divisible by 3. Never look at these while changing the module.
   */
  heldout?: boolean;
}

/** Tuning or held-out. Synthetic and dynamic pages are always tuning. */
export function splitOf(p: Pair): 'tuning' | 'heldout' {
  return p.heldout ? 'heldout' : 'tuning';
}

/** One rendering condition. Zoom is emulated as a narrower layout viewport with a higher pixel ratio. */
export interface Condition {
  w: number;
  h?: number;
  zoom?: number;
  scheme?: 'light' | 'dark';
  /** Add the testset dark stylesheet on top of the page's own CSS. */
  darkCss?: boolean;
}

export interface LayoutSet {
  /** Pair id whose version A is reused. */
  fixture: string;
  conditions: string[];
}

export interface Sources {
  version: 1;
  /** Condition used to write notes on version A. */
  base: string;
  conditions: Record<string, Condition>;
  pairs: Pair[];
  layouts: LayoutSet[];
}

export function loadSources(): Sources {
  return JSON.parse(readFileSync(SOURCES, 'utf8')) as Sources;
}

export function saveSources(s: Sources): void {
  writeFileSync(SOURCES, `${JSON.stringify(s, null, 2)}\n`);
}

/** Folder that holds the frozen copies of a pair, committed or cached. */
export function pairDir(p: Pick<Pair, 'id' | 'commit' | 'kind'>): string {
  if (p.kind === 'synthetic' || p.kind === 'dynamic') return join(FIXTURES, p.kind, p.id);
  return join(p.commit ? FIXTURES : CACHE_FIXTURES, p.id);
}

/**
 * Frozen file of one version. A version that is the same frozen copy as another pair's is stored
 * once: its meta.json names the other file (`file`, relative to the pair folder).
 */
export function versionFile(p: Pick<Pair, 'id' | 'commit' | 'kind'>, v: 'a' | 'b'): string {
  const dir = pairDir(p);
  const mf = join(dir, 'meta.json');
  if (existsSync(mf)) {
    const m = JSON.parse(readFileSync(mf, 'utf8')) as Record<string, { file?: string } | undefined>;
    const f = m[v]?.file;
    if (f) return join(dir, f);
  }
  return join(dir, `${v}.html`);
}

export function hasFixture(p: Pair): boolean {
  return existsSync(versionFile(p, 'a')) && existsSync(versionFile(p, 'b'));
}
