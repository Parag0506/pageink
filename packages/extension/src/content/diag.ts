/**
 * Diagnostics for the device check in apple/device. Only a build made with INK_DIAG_ORIGIN set
 * carries this code (build/targets.ts). Every other build compiles it out, and a test checks
 * that no trace of it is left in them.
 *
 * Each gesture's probe is kept in the extension's own storage, the last few hundred only.
 * The check page gets the records through window.postMessage aimed at its one origin, so no
 * other page can receive them. The records hold counts and times, never page content.
 * Nothing leaves the device by this route: the check page decides what to send to the Mac.
 *
 * The PDF viewer is an extension page with an origin of its own, so it cannot post to the
 * check page. It keeps its records in the same storage, and the check page reads them when the
 * person comes back. It also sends each one to the background, which hands it to the content
 * script of any tab on the check page's origin (background/diag-relay.ts).
 */
import { createProbe } from 'pageink-core/capture';
import type { Probe, StrokeProbe } from 'pageink-core/types';
import type { Api } from '../api';
import { diagOf } from './modules';

/** Storage key of the record list. */
export const DIAG_KEY = 'diag:log';
/** Tag on messages to the check page. Also the marker the release checks look for. */
export const DIAG_TAG = 'ink-diag';
/** Tag on messages from the check page. */
const ASK_TAG = 'ink-check';
/** How many records are kept. */
export const KEEP = 300;
/** Runtime message that carries one record between the viewer, the background and the check page. */
export const RELAY = 'diag';

export interface DiagRecord extends StrokeProbe {
  id: string;
  /** page: a web page. pdf: the extension's PDF viewer. */
  where: 'page' | 'pdf';
  /** The path on the check page's origin. Any other site is only "other". */
  page: string;
  /** Wall clock, for the order of records from different pages. */
  at: number;
  /**
   * For the first stroke after a load that the stub buffered: what the stub saw. loadMs runs
   * from pen-down until the tools took the buffer; injectMs is the part of it spent waiting
   * for the background to put the viewer and the tools into the page.
   */
  stub?: { stylus: number; stylusCancelled: number; buffered: number; loadMs: number; injectMs: number };
}

const pageOf = (where: DiagRecord['where']): string => {
  if (where === 'pdf') return 'pdf viewer';
  return location.origin === __INK_DIAG_ORIGIN__ ? location.pathname : 'other';
};

const onCheckPage = (win: Window): boolean => win.location.origin === __INK_DIAG_ORIGIN__;

function post(win: Window, kind: string, data: Record<string, unknown>): void {
  win.postMessage({ [DIAG_TAG]: kind, ...data }, __INK_DIAG_ORIGIN__);
}

/** A probe for ViewerOptions.hooks.probe. Keeps each record and shows it to the check page. */
export function probeFor(api: Api, where: DiagRecord['where']): Probe {
  let chain: Promise<unknown> = Promise.resolve();
  return createProbe(window, (p: StrokeProbe) => {
    const rec: DiagRecord = {
      ...p,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      where,
      page: pageOf(where),
      at: Date.now(),
    };
    const early = diagOf();
    if (p.replayed && !early.reported && early.buffered) {
      early.reported = true;
      rec.stub = {
        stylus: early.stylus,
        stylusCancelled: early.stylusCancelled,
        buffered: early.buffered,
        loadMs: Math.round(early.adoptedAt - early.downAt),
        injectMs: Math.round(early.injectMs),
      };
    }
    if (where === 'page' && onCheckPage(window)) post(window, 'record', { record: rec });
    const kept = chain.then(() => keepRecord(api, rec)).catch(() => {});
    chain = kept;
    if (where !== 'pdf') return;
    // The viewer keeps it first, so it is in the log whatever the background does. Then the
    // background passes it on to a check page that is open now. A message the background never
    // answers holds up nothing.
    void kept.then(() => api.runtime.sendMessage({ ink: RELAY, record: rec })).catch(() => {});
  });
}

/** Adds one record to the stored list, once. */
export async function keepRecord(api: Api, rec: DiagRecord): Promise<void> {
  const r = await api.storage.local.get(DIAG_KEY);
  const list = Array.isArray(r[DIAG_KEY]) ? (r[DIAG_KEY] as DiagRecord[]) : [];
  if (list.some((x) => x?.id === rec.id)) return;
  await api.storage.local.set({ [DIAG_KEY]: [...list, rec].slice(-KEEP) });
}

/**
 * On the check page only: say hello, hand over the stored records when asked, and pass on new
 * ones as they are stored, which covers strokes made in the PDF viewer.
 */
export function startRelay(win: Window, api: Api, build: Record<string, unknown>): void {
  if (!onCheckPage(win) || win !== win.top) return;
  const hello = async () => {
    // Whether every website is allowed. Without it the Pencil writes only where Safari was told yes.
    const all = await (api.runtime.sendMessage({ ink: RELAY, ask: 'access' }) as Promise<unknown>).catch(
      () => undefined,
    );
    post(win, 'hello', {
      build,
      viewer: api.runtime.getURL('pdf.html'),
      early: { ...diagOf() },
      all: typeof all === 'boolean' ? all : null,
    });
  };
  const sendLog = () =>
    api.storage.local.get(DIAG_KEY).then(
      (r) => post(win, 'log', { records: Array.isArray(r[DIAG_KEY]) ? r[DIAG_KEY] : [] }),
      () => {},
    );
  win.addEventListener('message', (e) => {
    if (e.origin !== __INK_DIAG_ORIGIN__) return;
    const ask = (e.data as Record<string, unknown> | null)?.[ASK_TAG];
    if (ask === 'hello') void hello();
    else if (ask === 'log') void sendLog();
    else if (ask === 'clear') void api.storage.local.remove(DIAG_KEY).then(sendLog, () => {});
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && DIAG_KEY in changes) void sendLog();
  });
  // A record from the PDF viewer, passed on by the background as it happens.
  api.runtime.onMessage.addListener((m: { ink?: unknown; record?: unknown }, s) => {
    if (m?.ink !== RELAY || s.tab || !m.record || typeof m.record !== 'object') return;
    post(win, 'record', { record: m.record });
  });
  if (win.document.readyState === 'loading')
    win.addEventListener('DOMContentLoaded', () => void hello(), { once: true });
  else void hello();
}
