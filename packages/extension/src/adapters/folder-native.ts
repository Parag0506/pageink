/**
 * FolderIO for Safari through the wrapper app (runtime.sendNativeMessage).
 * The app owns the folder the reader picked and does the file work.
 *
 * Protocol, version 1. Also in packages/extension/NATIVE_PROTOCOL.md.
 *
 * Request, extension to app:
 *   { v: 1, op: "status" }
 *   { v: 1, op: "list",   dir: "pages" }
 *   { v: 1, op: "read",   name: "pages/abc.ink.json" }
 *   { v: 1, op: "write",  name: "pages/abc.ink.json", text: "<utf-8 JSON>" }
 *   { v: 1, op: "remove", name: "pages/abc.ink.json" }
 *   { v: 1, op: "connect", place: "google" | "onedrive" }
 *   { v: 1, op: "disconnect", removeFiles: false }
 *
 * Reply, app to extension:
 *   { ok: true }                                         write, remove
 *   { ok: true, folder: "PageInk Notes" }                    status, folder connected
 *   { ok: true, folder: null }                           status, no folder yet
 *   { ok: true, folder: "Google Drive", place: "google", account: "a@b.c" }   status, a cloud
 *   { ok: true, account: "a@b.c" }                       connect, done
 *   { ok: true, pending: true, open: "<app link>" }      connect, the app finishes it
 *   { ok: true, files: [{ name, mtime, size }] }         list; name is relative to the folder root
 *   { ok: true, text: "..." }                            read
 *   { ok: false, error: "not-found" | "no-folder" | "denied" | "<message>" }
 *
 * Names always use "/" and never start with "/" or contain "..". mtime is epoch ms.
 * A list of a missing directory is an empty list, not an error.
 */
import type { FolderIO } from 'pageink-core/types';

export type NativeRequest =
  | { v: 1; op: 'status' }
  | { v: 1; op: 'list'; dir: string }
  | { v: 1; op: 'read'; name: string }
  | { v: 1; op: 'write'; name: string; text: string }
  | { v: 1; op: 'remove'; name: string }
  | { v: 1; op: 'connect'; place: 'google' | 'onedrive' }
  | { v: 1; op: 'disconnect'; removeFiles: boolean }
  /** Whether Safari lets the extension run on every website. The app's setup screen shows it. */
  | { v: 1; op: 'access'; all: boolean };

export type NativeReply =
  | {
      ok: true;
      folder?: string | null;
      place?: 'folder' | 'google' | 'onedrive' | null;
      account?: string;
      pending?: boolean;
      /** With pending: the address that opens the app to finish the sign-in. */
      open?: string;
      /** A write the app keeps until the cloud can be reached. */
      queued?: boolean;
      files?: { name: string; mtime: number; size: number }[];
      text?: string;
    }
  | { ok: false; error: string };

export type SendNative = (app: string, msg: NativeRequest) => Promise<NativeReply | undefined>;

/** Safari ignores the application id and talks to the containing app. */
export const NATIVE_APP = 'app.ink.safari';

export class NativeError extends Error {
  constructor(readonly code: string) {
    super(`native folder: ${code}`);
  }
}

function safe(name: string): string {
  if (name.startsWith('/') || name.split('/').includes('..')) throw new NativeError('bad-name');
  return name;
}

async function call(send: SendNative, msg: NativeRequest): Promise<Extract<NativeReply, { ok: true }>> {
  const r = await send(NATIVE_APP, msg);
  if (!r) throw new NativeError('no-reply');
  if (!r.ok) throw new NativeError(r.error);
  return r;
}

/** Name of the connected folder, or null when the app has none. */
export async function nativeStatus(send: SendNative): Promise<string | null> {
  return (await call(send, { v: 1, op: 'status' })).folder ?? null;
}

export interface NativePlace {
  /** What the reader sees: the folder's name, or the cloud's. Null when nothing is chosen. */
  folder: string | null;
  place: 'folder' | 'google' | 'onedrive' | null;
  account?: string;
}

/** Where the app keeps the notes. An app from before cloud support says only "folder". */
export async function nativePlace(send: SendNative): Promise<NativePlace> {
  const r = await call(send, { v: 1, op: 'status' });
  const folder = r.folder ?? null;
  const place = r.place ?? (folder ? 'folder' : null);
  const out: NativePlace = { folder, place };
  if (typeof r.account === 'string') out.account = r.account;
  return out;
}

/**
 * Ask the app to sign in to a cloud. The app shows the provider's page itself
 * (ASWebAuthenticationSession) and keeps the tokens in its keychain; the extension never
 * sees them. `pending` means the app finishes it in its own window; `open` is the app's own
 * address that brings it to the front for that, when the app gave one.
 */
export async function nativeConnect(
  send: SendNative,
  place: 'google' | 'onedrive',
): Promise<{ account?: string; pending?: boolean; open?: string }> {
  const r = await call(send, { v: 1, op: 'connect', place });
  const out: { account?: string; pending?: boolean; open?: string } = {
    account: r.account,
    pending: r.pending === true,
  };
  // Only the app's own scheme: never a web address or a script.
  if (
    out.pending &&
    typeof r.open === 'string' &&
    /^[a-z][a-z0-9.+-]*:\/\/connect\?place=(google|onedrive)&request=[0-9a-f]{32}$/i.test(r.open) &&
    !/^(https?|javascript|data|file):/i.test(r.open)
  ) {
    out.open = r.open;
  }
  return out;
}

export async function nativeDisconnect(send: SendNative, removeFiles: boolean): Promise<void> {
  await call(send, { v: 1, op: 'disconnect', removeFiles });
}

export function nativeFolder(send: SendNative): FolderIO {
  return {
    async list(dir) {
      return (await call(send, { v: 1, op: 'list', dir: safe(dir) })).files ?? [];
    },
    async read(name) {
      const r = await call(send, { v: 1, op: 'read', name: safe(name) });
      if (typeof r.text !== 'string') throw new NativeError('no-text');
      return r.text;
    },
    async write(name, text) {
      await call(send, { v: 1, op: 'write', name: safe(name), text });
    },
    async remove(name) {
      await call(send, { v: 1, op: 'remove', name: safe(name) });
    },
  };
}

export const sendNativeOf =
  (api: typeof chrome): SendNative =>
  (app, msg) =>
    api.runtime.sendNativeMessage(app, msg) as Promise<NativeReply | undefined>;
