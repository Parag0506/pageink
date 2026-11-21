// Builds page records with real anchors and seeds them into extension storage.
// Anchors come from the testset harness: notes are written on the page with `describe`.
import { hashKey, idxKey, pageKeyOf } from 'pageink-core/hash';
import type { Note, PageIdentity, PageRecord, Stroke } from 'pageink-core/types';
import type { Page, Worker } from 'playwright';
import type { Written } from '../../testset/page/harness.ts';

/** Page identity from pageink-core when the anchor module provides it, else address without fragment. */
export async function identityOf(url: string): Promise<PageIdentity> {
  try {
    const m = (await import('pageink-core/anchor')) as { pageIdentity?: (u: string) => PageIdentity };
    if (typeof m.pageIdentity === 'function') return m.pageIdentity(url);
  } catch {
    // The anchor module is not there yet.
  }
  const u = new URL(url);
  u.hash = '';
  return { key: u.toString(), aliases: [], host: u.hostname, hosts: [u.hostname], url };
}

/** A small closed scribble around the note box, in note-local units. */
function stroke(id: string, w: number, h: number, t: number): Stroke {
  const W = Math.max(8, Math.round(w));
  const H = Math.max(8, Math.round(h));
  const d = `M0 0C${W / 3} -4 ${(2 * W) / 3} 4 ${W} 0L${W} ${H}C${(2 * W) / 3} ${H + 4} ${W / 3} ${H - 4} 0 ${H}Z`;
  return {
    id,
    t,
    tool: 'pen',
    color: 'ink-1',
    w: 2,
    pts: [0, 0, 50, W * 10, 0, 0, 0, H * 10, 0, -W * 10, 0, 0],
    d,
  };
}

export function recordFrom(
  id: PageIdentity,
  title: string,
  notes: Written[],
  docSize: { w: number; h: number },
): PageRecord {
  const now = Date.now();
  const out: Note[] = [];
  notes.forEach((n, i) => {
    if (!n.described) return;
    const { anchor, frame, origin } = n.described;
    // frac is optional in the format. The dummy extension places by it, so fill it in.
    const a = { ...anchor, frac: anchor.frac ?? { x: origin.x / docSize.w, y: origin.y / docSize.h } };
    out.push({
      id: `bench${i.toString(36)}n`,
      createdAt: now,
      updatedAt: now,
      device: 'bench',
      kind: 'ink',
      anchor: a,
      frame,
      strokes: [stroke(`bench${i.toString(36)}s`, n.box.w, n.box.h, now)],
    });
  });
  return { v: 1, key: id.key, urls: [id.url], title, updatedAt: now, notes: out, deleted: [] };
}

/** Storage items for a record: the record and the site index for every host it can appear on. */
export function storageItems(id: PageIdentity, rec: PageRecord): Record<string, unknown> {
  const m: Record<string, string> = {};
  for (const k of [id.key, ...id.aliases]) m[hashKey(k)] = hashKey(id.key);
  const items: Record<string, unknown> = { [pageKeyOf(id.key)]: rec };
  for (const h of new Set([id.host, ...id.hosts])) items[idxKey(h)] = { v: 1, m };
  return items;
}

/** Host names of the records among the items. */
const hostsIn = (items: Record<string, unknown>): string[] => {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(items)) {
    if (!k.startsWith('p:')) continue;
    for (const u of [(v as PageRecord).key, ...((v as PageRecord).urls ?? [])]) {
      try {
        out.add(new URL(u).hostname);
      } catch {
        // Not an address.
      }
    }
  }
  return [...out];
};

/**
 * Wait until the registered content scripts cover exactly the wanted hosts, and stay so for
 * 200 ms. Clearing and then writing storage makes the background update the registration
 * twice, and the first update can drop it, so one matching look is not enough. Throws when
 * the registration does not settle in 5 s: a timed load would then not measure the
 * registered viewer. Does nothing where the extension has no scripting API (the dummy).
 */
async function settleRegistration(sw: Worker, hosts: string[]): Promise<void> {
  const ok = await sw.evaluate(`(async () => {
    const hosts = ${JSON.stringify(hosts)};
    if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts) return 'none';
    let stable = 0;
    for (let i = 0; i < 500; i++) {
      const all = (await chrome.scripting.getRegisteredContentScripts()).flatMap((s) => s.matches || []);
      const good = hosts.length
        ? hosts.every((h) => all.includes('*://' + h + '/*'))
        : all.length === 0;
      stable = good ? stable + 1 : 0;
      if (stable >= 20) return 'ok';
      await new Promise((r) => setTimeout(r, 10));
    }
    return 'timeout';
  })()`);
  if (ok === 'timeout')
    throw new Error(
      `the extension did not ${hosts.length ? `register its viewer for ${hosts.join(', ')}` : 'drop its registration'}`,
    );
}

/**
 * Seed storage. Where the extension registers its viewer for hosts with ink, wait until the
 * registration covers the seeded hosts, as it would after the visit that wrote the ink.
 */
export async function seed(sw: Worker, items: Record<string, unknown>): Promise<void> {
  await sw.evaluate(
    `chrome.storage.local.clear().then(() => chrome.storage.local.set(${JSON.stringify(items)}))`,
  );
  await settleRegistration(sw, hostsIn(items));
}

/**
 * Wait until the registration covers the hosts of the items already in storage. Used after a
 * browser restart: Chrome counts an extension loaded with --load-extension as updated on every
 * start, which clears its registered scripts, and the background registers them again from
 * storage at once. A store install keeps them across restarts, so a returning reader's first
 * load already has them.
 */
export async function registered(sw: Worker, items: Record<string, unknown>): Promise<void> {
  await settleRegistration(sw, hostsIn(items));
}

/** Empty storage and wait until the extension has dropped its registration: no host has ink. */
export async function clearStorage(sw: Worker): Promise<void> {
  await sw.evaluate('chrome.storage.local.clear()');
  await settleRegistration(sw, []);
}

/** Write `count` notes on an open page with the bundled harness. */
export async function writeNotes(page: Page, bundle: string, seedName: string, count: number) {
  await page.evaluate(bundle);
  const notes = (await page.evaluate(
    `window.__inkTest.write(${JSON.stringify(seedName)}, ${count})`,
  )) as Written[];
  const size = (await page.evaluate(
    '({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, title: document.title })',
  )) as { w: number; h: number; title: string };
  return { notes, size, title: size.title };
}
