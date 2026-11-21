/**
 * Diagnostics builds only (content/diag.ts). The background is called only behind
 * `if (__INK_DIAG__)`, so every other build leaves this file out, and a test checks that.
 *
 * The PDF viewer cannot post to the check page: it is an extension page on another origin.
 * So it keeps each stroke record itself and sends it here. The background keeps it too, once,
 * and hands it to the content script of every tab on the check page's origin, which posts it
 * to the page.
 * Only records from the extension's own pages are taken, and only that one origin gets them.
 * The check page may also ask whether every website is allowed.
 */
import type { Api } from '../api';
import { type DiagRecord, keepRecord, RELAY } from '../content/diag';
import { ALL_SITES } from '../ui/access';

const isRecord = (r: unknown): r is DiagRecord =>
  !!r &&
  typeof r === 'object' &&
  typeof (r as DiagRecord).id === 'string' &&
  (r as DiagRecord).where === 'pdf';

export function relayDiag(api: Api, origin = __INK_DIAG_ORIGIN__): void {
  if (!origin) return;
  const own = api.runtime.getURL('');
  let chain: Promise<unknown> = Promise.resolve();
  api.runtime.onMessage.addListener((m: { ink?: unknown; record?: unknown; ask?: unknown }, s, reply) => {
    if (m?.ink !== RELAY) return;
    // The check page asks whether every website is allowed, as the popup checks it.
    if (m.ask === 'access' && s.url?.startsWith(`${origin}/`)) {
      const p = api.permissions;
      if (!p?.contains) return;
      p.contains(ALL_SITES).then(
        (all) => reply(all),
        () => reply(undefined),
      );
      return true;
    }
    if (!isRecord(m.record)) return;
    // Content scripts have a tab and a web page address. The viewer is an extension page.
    if (!s.url?.startsWith(own)) return;
    const rec = m.record;
    chain = chain
      .then(() => keepRecord(api, rec))
      .then(() => api.tabs.query({}))
      .then((tabs) =>
        Promise.all(
          tabs
            .filter((t) => t.id !== undefined && t.url?.startsWith(`${origin}/`))
            .map((t) => api.tabs.sendMessage(t.id!, { ink: RELAY, record: rec }).catch(() => {})),
        ),
      )
      .then(
        () => reply(true),
        () => reply(false),
      );
    return true;
  });
}
