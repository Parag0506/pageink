/**
 * Where this device keeps its copy of the notes: one place at a time. No network code here;
 * that lives in src/cloud and is loaded only for a cloud place.
 */

export type ProviderId = 'google' | 'onedrive';

export const PROVIDERS: ProviderId[] = ['google', 'onedrive'];

export const PROVIDER_NAME: Record<ProviderId, string> = { google: 'Google Drive', onedrive: 'OneDrive' };

export type Dest = (
  | /** The folder on this device (Chromium), or the Safari app's folder. */ { kind: 'folder' }
  | {
      kind: 'cloud';
      provider: ProviderId;
    }
) & {
  /** Set after a switch from another place: older pages stay here until the reader copies them. */
  since?: number;
};

export const DEST_KEY = 'dest';

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

export async function readDest(area: Area): Promise<Dest | null> {
  const v = (await area.get(DEST_KEY))[DEST_KEY] as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object') return null;
  let d: Dest;
  if (v.kind === 'folder') d = { kind: 'folder' };
  else if (v.kind === 'cloud' && (v.provider === 'google' || v.provider === 'onedrive')) {
    // The account name is never read from here: it stays with the tokens (secrets.ts).
    d = { kind: 'cloud', provider: v.provider };
  } else return null;
  if (typeof v.since === 'number' && Number.isFinite(v.since)) d.since = v.since;
  return d;
}

export const writeDest = (area: Area, d: Dest | null): Promise<void> =>
  d ? area.set({ [DEST_KEY]: d }) : area.remove(DEST_KEY);

/**
 * What went wrong, as the reader should hear it. Each has one next step.
 * The codes are shared with the Safari app (NATIVE_PROTOCOL.md).
 */
export type Problem =
  | 'cancelled'
  | 'denied'
  | 'offline'
  | 'full'
  | 'expired'
  | 'not-set-up'
  | 'locked'
  | 'lock-changed'
  | 'throttled'
  | 'server';

export const PROBLEMS: Problem[] = [
  'cancelled',
  'denied',
  'offline',
  'full',
  'expired',
  'not-set-up',
  'locked',
  'lock-changed',
  'throttled',
  'server',
];

export const isProblem = (v: unknown): v is Problem =>
  typeof v === 'string' && PROBLEMS.includes(v as Problem);

/** Plain words for each problem, with the one thing to do next. */
export function problemText(p: Problem, place: string): { text: string; next: string } {
  switch (p) {
    case 'cancelled':
      return { text: 'The sign-in window was closed before it finished.', next: 'Try again' };
    case 'denied':
      return { text: `${place} did not give access.`, next: 'Try again and choose Allow' };
    case 'offline':
      return { text: 'You seem to be offline. Your notes are safe on this device.', next: 'Sync now' };
    case 'full':
      return { text: `Your ${place} storage is full.`, next: `Free up space in ${place}, then sync again` };
    case 'expired':
      return { text: `Your sign-in to ${place} has expired.`, next: 'Sign in again' };
    case 'not-set-up':
      return { text: 'Not set up in this build.', next: 'Choose another place' };
    case 'locked':
      return { text: 'Your notes there are locked with a password.', next: 'Enter the password' };
    case 'lock-changed':
      return {
        text: `The lock on your notes in ${place} was removed or changed, but not from this device. Syncing has stopped. Your notes are safe on this device.`,
        next: 'Choose what to do',
      };
    case 'throttled':
      return { text: `${place} asked us to slow down.`, next: 'Sync again in a minute' };
    case 'server':
      return { text: `${place} had a problem.`, next: 'Sync again later' };
  }
}
