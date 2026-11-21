/**
 * Messages between the parts of the extension. Every message has an `ink`
 * field so foreign messages are ignored cheaply.
 */
import type { ElementPath, SyncReport } from 'pageink-core/types';
import type { Dest, Problem, ProviderId } from './connect/dest';
import type { AuthDetail } from './connect/explain';

/** Sent to content scripts. */
export type ToContent =
  /** Toggle draw, or set it when `on` is given. Sent to the top frame only. */
  | { ink: 'draw'; on?: boolean }
  /** Load the viewer in a subframe because the top page has ink. */
  | { ink: 'wake' }
  /** Ask the top frame for its state. Reply: StateReply. */
  | { ink: 'state' }
  /** Ask the frame that holds the frame element with this id for its path. Reply: ElementPath. */
  | { ink: 'framePath'; frameId: number }
  /** Ink switched on or off for this site, from the popup. Sent to every frame. */
  | { ink: 'site'; on: boolean };

export interface StateReply {
  loaded: boolean;
  off: boolean;
  draw: boolean;
  notes: number;
}

/** Sent to the background. */
export type ToBackground =
  /** From a subframe. Reply: TopReply. */
  | { ink: 'top' }
  /** From a subframe. Relayed to every frame of the tab. Reply: ElementPath or undefined. */
  | { ink: 'framePath'; frameId: number }
  /** From the top frame once its viewer is up. Relays `wake` to every frame. */
  | { ink: 'wakeFrames' }
  /** Reply: data URL or undefined. */
  | { ink: 'capture' }
  /** From the popup. */
  | { ink: 'draw'; tabId: number; on?: boolean }
  /** From the top frame when its note count changes. Sets the action badge. */
  | { ink: 'badge'; n: number }
  /** From the options page and the popup when they open. A full two-way sync. Reply: SyncReply. */
  | { ink: 'sync' }
  /** From the popup and the options page. Reply: Attention. Also refreshes the action badge. */
  | { ink: 'attention' }
  /** From a page after the reader granted folder access again. Reply: SyncReply. */
  | { ink: 'reconnected' }
  /** What the reader did with the backup prompt. Reply: Attention. */
  | { ink: 'nudge'; act: 'dismiss' | 'export' | 'chosen' }
  /** From a content script: inject these modules into its frame. Answered in background/register.ts. */
  | { ink: 'inject'; files: string[] }
  /** Diagnostics builds only: a stroke record from the PDF viewer. Answered in background/diag-relay.ts. */
  | { ink: 'diag'; record: unknown }
  | ToPlace;

/** The connect screen's messages. Reply: PlaceReply. */
export type ToPlace =
  /** Where notes are kept now, and how it is going. */
  | { ink: 'place' }
  /** Sign in to a cloud and make it the place. `switching`: another place was in use. */
  | { ink: 'connect'; provider: ProviderId; switching?: boolean }
  /** The folder on this device was picked (the page keeps its handle). */
  | { ink: 'useFolder'; switching?: boolean }
  /** Stop using the place. Files in a cloud are removed only with removeFiles: true. */
  | { ink: 'disconnect'; removeFiles?: boolean }
  /** After a switch: also bring the pages from before the switch to the new place. */
  | { ink: 'copyAll' }
  | { ink: 'lock'; op: 'on'; password: string }
  /** Turn the lock off on purpose, from this device. Also the way out when the lock file was removed or changed. */
  | { ink: 'lock'; op: 'off' }
  /** Put the lock file back from this device, after it was removed or changed elsewhere. */
  | { ink: 'lock'; op: 'restore' }
  | { ink: 'lock'; op: 'unlock'; password?: string; code?: string }
  | { ink: 'lock'; op: 'recovery' };

export type LockStatus =
  | 'off'
  | 'on'
  | 'turning-on'
  | 'turning-off'
  | 'needs-password'
  /** This device holds the key, and the lock file is missing or not the one it knows. */
  | 'changed'
  | 'unknown';

export interface PlaceState {
  dest: Dest | null;
  /** The folder's name, in the Safari app. */
  folder?: string;
  account?: string;
  lastSync?: number;
  problem?: Problem;
  /** Files found locked by a password this device does not hold. */
  locked?: number;
  lock: LockStatus;
  /** This device holds the key, so it can show a recovery key. */
  recovery?: boolean;
  /** With lock 'changed': the lock file is gone, or it is there but not the one this device knows. */
  trouble?: 'missing' | 'changed';
  /** With lock 'changed': this device knows the lock's settings, so it can put the lock file back. */
  canRestore?: boolean;
  /** Files left alone because, while the lock is on, they are not ours. */
  refused?: number;
}

export interface PlaceReply {
  ok?: boolean;
  state?: PlaceState;
  account?: string;
  /** The Safari app finishes the sign-in in its own window. */
  pending?: boolean;
  /** With pending: the address that brings the Safari app to the front to finish it. */
  open?: string;
  report?: SyncReport;
  problem?: Problem;
  /** wrong, short, already, no-lock, bad-lock, some-locked, or a short message. */
  error?: string;
  /** A failed sign-in: what the provider said, scrubbed. Never a token or a code. */
  detail?: AuthDetail;
  lock?: LockStatus;
  /** A recovery key. */
  code?: string;
}

export interface TopReply {
  url: string;
  frameId: number;
}

export interface SyncReply {
  report?: SyncReport;
  /** "none": no folder. "permission": the folder needs a click to grant access again. */
  error?: 'none' | 'permission' | string;
}

export type FramePathReply = ElementPath | undefined;
