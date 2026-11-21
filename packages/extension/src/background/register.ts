/**
 * Puts the view code in pages without any web accessible file (DESIGN 5, CONTRACT 4).
 *
 * Hosts with ink get the viewer as a registered content script at document start, top
 * frame only, so it is in the page before the stub's storage read returns. The list of
 * hosts follows the site index: a host is matched only while it has an index entry and
 * ink is not switched off there. Everywhere else the stub asks for a module when it needs
 * one (a pen-down, the draw toggle, a frame woken by the top page, a PDF) and it is
 * injected into that one frame.
 */
import { idxKey } from 'pageink-core/hash';
import type { Api } from '../api';

/** The id of the registered viewer script. */
export const SCRIPT_ID = 'ink-view';
/**
 * The viewer, as registered on hosts with ink. boot.js comes first: it starts the first load's
 * storage read, so the reply is on its way while the browser compiles and runs loader.js.
 */
export const VIEW_FILES = ['content/boot.js', 'content/loader.js'];
/**
 * Modules a content script may ask for. Each is content/<name>.js. Safari keeps PDFs in its
 * own viewer, so its build has no PDF chunk.
 */
export const modulesFor = (target: string): string[] =>
  target === 'safari' ? ['loader', 'tools'] : ['loader', 'tools', 'pdf'];
export const MODULES = modulesFor(__INK_TARGET__);

/** Host names a match pattern can hold: DNS names and bracketed IPv6 addresses. */
const HOST = /^(?:[a-z0-9_-]+\.)*[a-z0-9_-]+$|^\[[0-9a-f:.]+\]$/;
export const patternOf = (host: string): string => `*://${host}/*`;
const hostOfPattern = (p: string): string => p.slice(4, -2);

/** Host names a stored record can be shown on: its key, its addresses and its `host:` entries. */
export function hostsOf(rec: unknown): string[] {
  const r = rec as { key?: unknown; urls?: unknown } | null;
  const out = new Set<string>();
  const add = (u: unknown) => {
    if (typeof u !== 'string') return;
    if (u.startsWith('host:')) out.add(u.slice(5));
    else if (/^https?:\/\//.test(u)) {
      try {
        out.add(new URL(u).hostname);
      } catch {
        // Not an address.
      }
    }
  };
  add(r?.key);
  if (Array.isArray(r?.urls)) for (const u of r.urls) add(u);
  return [...out].filter((h) => HOST.test(h));
}

const offOf = (cfg: unknown): string[] => {
  const off = (cfg as { off?: unknown } | undefined)?.off;
  return Array.isArray(off) ? off.filter((h): h is string => typeof h === 'string') : [];
};

/**
 * Hosts that should carry the viewer. Hosts already registered are known by the hash of
 * their name, so only an index entry no registered host explains costs a read of the
 * records it points at.
 */
export async function wantedHosts(api: Api, known: string[]): Promise<Set<string>> {
  const local = api.storage.local as chrome.storage.LocalStorageArea & { getKeys?: () => Promise<string[]> };
  let items: Record<string, unknown>;
  if (local.getKeys) {
    const keys = await local.getKeys();
    items = await local.get(keys.filter((k) => k.startsWith('idx:') || k === 'cfg'));
  } else items = await local.get(null);
  const off = new Set(offOf(items.cfg));
  const out = new Set<string>();
  const left = new Set(Object.keys(items).filter((k) => k.startsWith('idx:')));
  for (const h of known) {
    const k = idxKey(h);
    if (!left.has(k)) continue;
    left.delete(k);
    if (!off.has(h)) out.add(h);
  }
  if (!left.size) return out;
  // Index entries of hosts not known yet: read the records they point at.
  const slots = new Set<string>();
  for (const k of left) {
    const m = (items[k] as { m?: unknown } | undefined)?.m;
    if (m && typeof m === 'object')
      for (const s of Object.values(m)) if (typeof s === 'string') slots.add(`p:${s}`);
  }
  const recs = slots.size ? await local.get([...slots]) : {};
  for (const rec of Object.values(recs)) {
    for (const h of hostsOf(rec)) if (left.has(idxKey(h)) && !off.has(h)) out.add(h);
  }
  return out;
}

const same = (a: Set<string>, b: string[]): boolean => a.size === b.length && b.every((h) => a.has(h));

/**
 * Runs a scripting call with an option that an older browser may refuse, and without it if
 * the first call fails. Safari ignores options it does not know, but a refusal must not cost
 * the reader the call.
 */
async function withFallback<T>(
  call: (o: Record<string, unknown>) => Promise<T>,
  opt: Record<string, unknown>,
) {
  try {
    return await call(opt);
  } catch {
    return call({});
  }
}

/**
 * Starts keeping the registration in step with the index, and answers inject requests.
 * The same in every browser. Safari stops its background often, on iOS within seconds, and
 * the registration lives on without it. Each start of the background checks that the
 * registration is still there, so a browser that dropped it gets it back on the next request.
 */
export function keepRegistered(api: Api): void {
  const sc = api.scripting;
  if (!sc?.registerContentScripts) return;

  let queue: Promise<void> = Promise.resolve();
  let pending = false;
  let fresh = false;
  const refresh = (renew = false): void => {
    fresh ||= renew;
    if (pending) return;
    pending = true;
    queue = queue
      .then(async () => {
        pending = false;
        const renewNow = fresh;
        fresh = false;
        const [cur] = await sc.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
        const known = (cur?.matches ?? []).map(hostOfPattern);
        const want = await wantedHosts(api, known);
        // After an install or update the files may have changed: register them again.
        if (cur && (renewNow || !want.size)) await sc.unregisterContentScripts({ ids: [SCRIPT_ID] });
        if (!want.size) return;
        const matches = [...want].sort().map(patternOf);
        if (cur && !renewNow) {
          if (!same(want, known))
            await sc.updateContentScripts([
              { id: SCRIPT_ID, matches } as chrome.scripting.RegisteredContentScript,
            ]);
          return;
        }
        const script = { id: SCRIPT_ID, js: VIEW_FILES, matches, runAt: 'document_start', allFrames: false };
        await withFallback(
          (o) => sc.registerContentScripts([{ ...script, ...o } as chrome.scripting.RegisteredContentScript]),
          { persistAcrossSessions: true },
        );
      })
      .catch(() => {
        // Storage or the API failed. The stub still finds the index and asks for the viewer.
      });
  };

  api.runtime.onInstalled.addListener(() => refresh(true));
  api.runtime.onStartup.addListener(() => refresh());
  // This start of the background: register again if the browser lost the registration.
  void sc.getRegisteredContentScripts({ ids: [SCRIPT_ID] }).then(
    (cur) => {
      if (!cur.length) refresh();
    },
    () => {},
  );
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, c] of Object.entries(changes)) {
      if (k.startsWith('idx:')) return refresh();
      if (k === 'cfg' && offOf(c.oldValue).join('\n') !== offOf(c.newValue).join('\n')) return refresh();
    }
  });

  // A content script asks for a module it does not have. Only known files, only into the
  // frame and document that asked.
  api.runtime.onMessage.addListener((m: { ink?: unknown; files?: unknown }, s, reply) => {
    if (m?.ink !== 'inject' || !Array.isArray(m.files)) return;
    const tabId = s.tab?.id;
    const files = m.files.filter((f) => MODULES.includes(f)).map((f) => `content/${f}.js`);
    if (tabId === undefined || !files.length) return;
    const target: chrome.scripting.InjectionTarget = s.documentId
      ? { tabId, documentIds: [s.documentId] }
      : { tabId, frameIds: [s.frameId ?? 0] };
    withFallback((o) => sc.executeScript({ target, files, ...o }), { injectImmediately: true }).then(
      () => reply(true),
      () => reply(false),
    );
    return true;
  });
}
