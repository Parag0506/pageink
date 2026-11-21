/**
 * The backup prompt. Notes live in this browser's storage, which goes away with the
 * extension. Once there is ink on a few pages and no backup folder, the popup asks once,
 * quietly, and the action icon shows a dot. Its state has its own storage key.
 */
export const NUDGE_KEY = 'nudge';

/** Pages with ink before the prompt shows. */
export const NUDGE_PAGES = 3;
const DAY = 24 * 60 * 60 * 1000;
/** After the first "Not now" the folder prompt may come back once, this much later. */
export const NUDGE_AGAIN = 14 * DAY;
/** Firefox has no folder, so the archive prompt may repeat, at most this often. */
export const NUDGE_MONTH = 30 * DAY;

export type NudgeKind = 'folder' | 'archive';

export interface NudgeState {
  /** Times the reader chose "Not now". */
  dismissed?: number;
  /** Epoch ms of the last "Not now" or archive export. */
  at?: number;
  /** A folder was chosen once. The folder prompt never shows again. */
  chosen?: boolean;
}

export interface NudgeInput {
  /** Pages with at least one note. */
  pages: number;
  /** A backup folder is connected. */
  folder: boolean;
  /** Firefox: archive. Chromium and Safari: a folder. */
  archive: boolean;
  st: NudgeState;
  now: number;
}

/** Which prompt to show, if any. */
export function nudgeKind(i: NudgeInput): NudgeKind | null {
  if (i.pages < NUDGE_PAGES) return null;
  const since = i.st.at === undefined ? Number.POSITIVE_INFINITY : i.now - i.st.at;
  if (i.archive) return since >= NUDGE_MONTH ? 'archive' : null;
  if (i.folder || i.st.chosen) return null;
  const n = i.st.dismissed ?? 0;
  if (n >= 2 || (n === 1 && since < NUDGE_AGAIN)) return null;
  return 'folder';
}

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export async function readNudge(area: Area): Promise<NudgeState> {
  const v = (await area.get(NUDGE_KEY))[NUDGE_KEY] as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object') return {};
  const out: NudgeState = {};
  if (typeof v.dismissed === 'number' && v.dismissed >= 0)
    out.dismissed = Math.min(9, Math.floor(v.dismissed));
  if (typeof v.at === 'number' && Number.isFinite(v.at)) out.at = v.at;
  if (v.chosen === true) out.chosen = true;
  return out;
}

/** Record what the reader did with the prompt. */
export async function noteNudge(area: Area, act: 'dismiss' | 'export' | 'chosen', now = Date.now()) {
  const st = await readNudge(area);
  if (act === 'dismiss') Object.assign(st, { dismissed: (st.dismissed ?? 0) + 1, at: now });
  else if (act === 'export') st.at = now;
  else st.chosen = true;
  await area.set({ [NUDGE_KEY]: st });
}

export const NUDGE_TEXT: Record<NudgeKind, string> = {
  folder: 'Your notes live only in this browser. Keep a copy in your own cloud or folder.',
  archive: 'Your notes live only in this browser. Export an archive to keep a copy.',
};
