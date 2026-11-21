import { stripCredentials } from '../hash';
import type { PageIdentity, PageRecord } from '../types';

/**
 * A record's `urls` lists every address seen for the document. It also keeps one
 * `host:<name>` entry per host the document can appear on. Family hosts cannot be
 * derived from an address, and the index must be rebuilt from a record alone when it
 * comes back from a folder or an archive.
 */
const HOST = 'host:';

export function identityUrls(id: PageIdentity): string[] {
  const hosts = new Set([...id.hosts, id.host].filter(Boolean));
  return [stripCredentials(id.url), id.key, ...id.aliases, ...[...hosts].map((h) => HOST + h)].filter(
    Boolean,
  );
}

function hostOf(s: string): string | null {
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    return new URL(s).hostname || null;
  } catch {
    return null;
  }
}

/** Hosts and address keys the index should list for this record. */
export function indexTargets(rec: PageRecord): { hosts: string[]; addrs: string[] } {
  const hosts = new Set<string>();
  const addrs = new Set<string>([rec.key]);
  const k = hostOf(rec.key);
  if (k) hosts.add(k);
  for (const u of rec.urls) {
    if (u.startsWith(HOST)) {
      const h = u.slice(HOST.length);
      if (h) hosts.add(h);
      continue;
    }
    addrs.add(u);
    const h = hostOf(u);
    if (h) hosts.add(h);
  }
  return { hosts: [...hosts].sort(), addrs: [...addrs].sort() };
}

/** Real addresses only, best first: the key when it is an address, then the others. */
export function addresses(rec: PageRecord): string[] {
  const out = rec.urls.filter((u) => !u.startsWith(HOST) && hostOf(u));
  if (hostOf(rec.key)) out.unshift(rec.key);
  return [...new Set(out)];
}

/** An identity good enough to file a record that came without one. */
export function identityOf(rec: PageRecord): PageIdentity {
  const { hosts } = indexTargets(rec);
  return {
    key: rec.key,
    aliases: [],
    host: hosts[0] ?? '',
    hosts,
    url: addresses(rec)[0] ?? rec.key,
  };
}
