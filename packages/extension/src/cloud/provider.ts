/**
 * The seam between the cloud folder (folder.ts) and one storage service. A provider knows
 * how to sign in and how to do five things with files by id. Everything else, names,
 * caching, conflicts and sync, is shared. Dropbox, later, is one more file like google.ts.
 */

export interface RemoteFile {
  id: string;
  name: string;
  /** Epoch ms, from the service's clock. */
  mtime: number;
  size: number;
  /** Changes on every write: Drive's version number, Graph's eTag. */
  version: string;
}

export interface Listing {
  files: RemoteFile[];
  /** Where a change check starts next time. Null when the service has no cheap check. */
  cursor: string | null;
}

export interface Changes {
  files: RemoteFile[];
  /** Ids removed since the cursor. */
  gone: string[];
  cursor: string;
}

export interface Folders {
  /** The visible top folder the reader can open. The lock file lives here. */
  top: string;
  /** Its "pages" folder. */
  pages: string;
}

/** The token a provider keeps between runs, in storage.local only. */
export interface Tokens {
  access: string;
  /** Epoch ms when the access token stops working. */
  exp: number;
  refresh?: string;
  /** The account shown to the reader. */
  account?: string;
  folders?: Folders;
}

export interface Provider {
  readonly id: 'google' | 'onedrive';
  /** Sign in with the provider's own window. Interactive: the reader clicked. */
  signIn(): Promise<Tokens>;
  /** Find or make the top folder and its pages folder. */
  folders(): Promise<Folders>;
  list(folder: string): Promise<Listing>;
  /** Changes in a folder since the cursor. Throws CloudError "reset" when the cursor is too old. */
  changes(folder: string, cursor: string): Promise<Changes>;
  download(f: RemoteFile): Promise<string>;
  /** Throws CloudError "conflict" when the service can tell the name is already taken. */
  create(folder: string, name: string, text: string): Promise<RemoteFile>;
  /** Throws CloudError "conflict" when f.version is no longer the file's version. */
  update(f: RemoteFile, text: string): Promise<RemoteFile>;
  remove(f: RemoteFile): Promise<void>;
  /** Put the top folder and everything in it in the service's bin. Only after a clear yes. */
  removeAll(): Promise<void>;
  /** Give the sign-in back to the provider, where it has a way to. */
  revoke(): Promise<void>;
}
