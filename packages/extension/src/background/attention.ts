/**
 * What the action button asks the reader to look at, if anything: folder access that
 * lapsed (a "!" badge and a Reconnect line in the popup), or the backup prompt (a dot).
 * The badge set here is the default for every tab. A tab's note count is set per tab.
 */
import type { Store } from 'pageink-core/types';
import type { Api } from '../api';
import type { Problem, ProviderId } from '../connect/dest';
import { type NudgeKind, type NudgeState, nudgeKind } from '../nudge';

export interface Attention {
  /** The folder is still chosen but the browser wants a click before it can be used again. */
  lapsed: boolean;
  nudge: NudgeKind | null;
  /**
   * A problem with the place that needs the reader: a sign-in that expired, a password to
   * enter, no access, or full storage. Passing ones (offline, slow down) wait for the next sync.
   */
  problem?: Problem;
  /** The place's name, for the line in the popup. */
  place?: string;
  /** The cloud, so the popup can sign in again from its button. */
  provider?: ProviderId;
}

export interface AttentionDeps {
  store: Store;
  /** Firefox: no folder, the archive is the backup. */
  archive: boolean;
  /** none: no folder chosen. permission: chosen, access lapsed. ok: usable. */
  folder: () => Promise<'none' | 'permission' | 'ok'>;
  /** The place's lasting problem, if any, and its name. */
  problem?: () => Promise<{ problem?: Problem; place?: string; provider?: ProviderId }>;
  nudge: () => Promise<NudgeState>;
  now?: () => number;
}

export async function attentionOf(d: AttentionDeps): Promise<Attention> {
  const folder = d.archive ? 'none' : await d.folder().catch(() => 'none' as const);
  const st = await d.nudge();
  // Counting pages reads every record, so it is skipped when the answer cannot change.
  const could = d.archive || (folder === 'none' && !st.chosen && (st.dismissed ?? 0) < 2);
  const pages = could ? (await d.store.list()).filter((p) => p.notes > 0).length : 0;
  const p: { problem?: Problem; place?: string; provider?: ProviderId } | undefined = await d
    .problem?.()
    .catch(() => ({}));
  const lasting = p?.problem && ['expired', 'locked', 'denied', 'full'].includes(p.problem);
  return {
    ...(lasting ? { problem: p!.problem, place: p!.place, provider: p!.provider } : {}),
    lapsed: folder === 'permission',
    nudge: nudgeKind({
      pages,
      folder: folder !== 'none',
      archive: d.archive,
      st,
      now: (d.now ?? Date.now)(),
    }),
  };
}

/**
 * Badge colours, from the brand. White text on each keeps 4.5:1 or more, and each fill
 * stands apart from the cream icon and from light and dark toolbars. The note count and
 * the backup dot use the darkened quill colour; lapsed access uses red.
 */
export const BADGE = { note: '#9a5530', alert: '#b3261e', text: '#ffffff' } as const;

/** Badge text and colour for the whole action. Empty text clears it. */
export function badgeOf(a: Attention): { text: string; color: string } {
  if (a.lapsed || a.problem) return { text: '!', color: BADGE.alert };
  if (a.nudge) return { text: '•', color: BADGE.note };
  return { text: '', color: BADGE.note };
}

export async function showAttention(api: Api, a: Attention): Promise<void> {
  const action = api.action;
  if (!action?.setBadgeText) return;
  const b = badgeOf(a);
  try {
    await action.setBadgeText({ text: b.text });
    if (b.text) {
      await action.setBadgeBackgroundColor?.({ color: b.color });
      await action.setBadgeTextColor?.({ color: BADGE.text });
    }
  } catch {
    // Some browsers have no badge. The popup still says it.
  }
}
