/**
 * Google Drive. Scope drive.file only: the extension sees only the files it made, in one
 * visible folder named after the product in the reader's My Drive. Drive allows two files
 * with one name, so files are found by id; the cloud folder maps names to ids.
 */
import { NAME } from '../brand';
import { type AuthFlow, checkReturn, randomText, Session, type TokenStore } from './auth';
import type { GoogleHosts } from './hosts';
import { annotate, apiError, CloudError, json, type Net, send } from './http';
import type { Changes, Folders, Listing, Provider, RemoteFile, Tokens } from './provider';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,modifiedTime,size,version,trashed';
/** Drive's limit for a multipart upload. Larger files use a resumable upload. */
export const MULTIPART_MAX = 5 * 1024 * 1024;

export interface GoogleDeps {
  hosts: GoogleHosts;
  clientId: string;
  /** identity.getRedirectURL(): https://<id>.chromiumapp.org/ or https://<id>.extensions.allizom.org/ */
  redirect: string;
  flow: AuthFlow;
  tokens: TokenStore;
  net?: Omit<Net, 'allow'>;
  /** The visible folder's name. */
  folderName?: string;
  now?: () => number;
}

type DriveFile = {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
  version?: string;
  trashed?: boolean;
};

const toRemote = (f: DriveFile): RemoteFile => ({
  id: f.id,
  name: f.name,
  mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
  size: Number(f.size ?? 0),
  version: String(f.version ?? f.modifiedTime ?? ''),
});

/** Quote a value for a Drive search. */
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * The sign-in address. This uses the token flow (response_type=token) with a "Web
 * application" client, which needs no secret and gives a one-hour token renewed silently
 * with prompt=none. Google documents it for JavaScript apps and keeps it for them, while it
 * recommends the code flow with PKCE; for a Web client that flow needs the client secret at
 * the token address, and a secret cannot be kept in an extension. redirect_uri must match an
 * entry under "Authorized redirect URIs" exactly: scheme, case and the trailing slash. The
 * only scope is drive.file. include_granted_scopes=false keeps any earlier grant out of the
 * token, so it never carries more than drive.file.
 */
export function googleAuthUrl(d: GoogleDeps, state: string, interactive: boolean, hint?: string): string {
  const p = new URLSearchParams({
    client_id: d.clientId,
    redirect_uri: d.redirect,
    response_type: 'token',
    scope: DRIVE_SCOPE,
    state,
    include_granted_scopes: 'false',
  });
  // "none" renews without a window, using the reader's session with Google in this browser.
  p.set('prompt', interactive ? 'select_account' : 'none');
  if (hint) p.set('login_hint', hint);
  return `${d.hosts.auth}?${p}`;
}

export function googleDrive(d: GoogleDeps): Provider {
  const now = d.now ?? Date.now;
  const net: Net = { ...d.net, allow: [d.hosts.revoke, d.hosts.api, d.hosts.upload] };
  const folderName = d.folderName ?? NAME;

  async function flow(interactive: boolean, hint?: string): Promise<Tokens> {
    const state = randomText(16);
    let p: URLSearchParams;
    try {
      const back = await d.flow(googleAuthUrl(d, state, interactive, hint), interactive);
      p = checkReturn(back, state, interactive);
    } catch (e) {
      throw annotate(e, { step: interactive ? 'authorize' : 'refresh', redirect: d.redirect });
    }
    const access = p.get('access_token');
    if (!access)
      throw new CloudError('denied', 0, 'no token', {
        step: 'authorize',
        error: 'no_token',
        redirect: d.redirect,
      });
    // CHECK: Google lists the scopes it granted. A reader may untick Drive access.
    const scope = p.get('scope');
    if (scope && !scope.split(' ').includes(DRIVE_SCOPE))
      throw new CloudError('denied', 0, 'scope', {
        step: 'authorize',
        error: 'scope_not_granted',
        description: 'Drive access was not ticked on the consent screen.',
        redirect: d.redirect,
      });
    return { access, exp: now() + Number(p.get('expires_in') ?? 3600) * 1000 };
  }

  const session = new Session(d.tokens, async (old) => flow(false, old?.account), now);
  const token = { get: () => session.get(), renew: () => session.renew() };
  const slowDown = (status: number, body: string) =>
    status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body);

  async function call(url: string, init: Omit<Parameters<typeof send>[1], 'url'> = {}) {
    const r = await send(net, { url, token, slowDown, ...init });
    const s = r.res.status;
    if (s >= 200 && s < 300) return r;
    if (s === 404) throw new CloudError('not-found', s);
    if (s === 403 && /storageQuotaExceeded|quotaExceeded/.test(r.text)) throw new CloudError('full', s);
    const said = { step: 'file call' as const, status: s, ...apiError(r.text) };
    if (s === 403) throw new CloudError('denied', s, said.error ?? '', said);
    if (s === 412) throw new CloudError('conflict', s);
    throw new CloudError('server', s, said.error ?? '', said);
  }

  const get = async <T>(path: string, params: Record<string, string>) =>
    json<T>((await call(`${d.hosts.api}${path}?${new URLSearchParams(params)}`)).text);

  async function find(name: string, parent: string): Promise<string | null> {
    const r = await get<{ files: DriveFile[] }>('/files', {
      q: `name = ${q(name)} and mimeType = ${q(FOLDER)} and ${q(parent)} in parents and trashed = false`,
      fields: 'files(id,name)',
      spaces: 'drive',
      pageSize: '10',
    });
    return r.files[0]?.id ?? null;
  }

  async function mkdir(name: string, parent: string): Promise<string> {
    const r = await call(`${d.hosts.api}/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
    });
    return json<{ id: string }>(r.text).id;
  }

  /** Multipart for small files, a resumable upload for large ones. */
  async function upload(
    method: 'POST' | 'PATCH',
    path: string,
    meta: object,
    text: string,
  ): Promise<RemoteFile> {
    const body = new TextEncoder().encode(text);
    if (body.length < MULTIPART_MAX) {
      const b = `ink${randomText(12).replace(/[^a-zA-Z0-9]/g, '')}`;
      const part =
        `--${b}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${b}\r\ncontent-type: application/json\r\n\r\n${text}\r\n--${b}--\r\n`;
      const r = await call(`${d.hosts.upload}${path}?uploadType=multipart&fields=${FIELDS}`, {
        method,
        headers: { 'content-type': `multipart/related; boundary=${b}` },
        body: part,
      });
      return toRemote(json<DriveFile>(r.text));
    }
    const start = await call(`${d.hosts.upload}${path}?uploadType=resumable&fields=${FIELDS}`, {
      method,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'application/json',
      },
      body: JSON.stringify(meta),
    });
    const at = start.res.headers.get('location');
    if (!at) throw new CloudError('server', 0, 'no upload address');
    const r = await call(at, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
    return toRemote(json<DriveFile>(r.text));
  }

  return {
    id: 'google',

    async signIn() {
      const t = await flow(true);
      await d.tokens.set(t);
      // CHECK: about.get with drive.file gives the account's address to show the reader.
      const about = await get<{ user?: { emailAddress?: string; displayName?: string } }>('/about', {
        fields: 'user(emailAddress,displayName)',
      }).catch(() => ({}) as { user?: undefined });
      const account = about.user?.emailAddress ?? about.user?.displayName;
      const full: Tokens = { ...t, account };
      await d.tokens.set(full);
      return full;
    },

    async folders() {
      const t = await session.tokens();
      if (t?.folders) return t.folders;
      const top = (await find(folderName, 'root')) ?? (await mkdir(folderName, 'root'));
      const pages = (await find('pages', top)) ?? (await mkdir('pages', top));
      const f: Folders = { top, pages };
      await session.save({ folders: f });
      return f;
    },

    async list(folder) {
      const files: RemoteFile[] = [];
      let pageToken = '';
      do {
        const r = await get<{ files: DriveFile[]; nextPageToken?: string }>('/files', {
          q: `${q(folder)} in parents and trashed = false`,
          fields: `nextPageToken,files(${FIELDS})`,
          spaces: 'drive',
          pageSize: '1000',
          ...(pageToken ? { pageToken } : {}),
        });
        files.push(...r.files.filter((f) => f.trashed !== true).map(toRemote));
        pageToken = r.nextPageToken ?? '';
      } while (pageToken);
      // The change check asks for files changed after the newest time seen here.
      const newest = Math.max(0, ...files.map((f) => f.mtime));
      return { files, cursor: String(newest) } satisfies Listing;
    },

    async changes(folder, cursor) {
      // A few seconds back, so a write that landed in the same second is not missed.
      const since = new Date(Math.max(0, Number(cursor) - 5000)).toISOString();
      const files: RemoteFile[] = [];
      const gone: string[] = [];
      let pageToken = '';
      let newest = Number(cursor) || 0;
      do {
        const r = await get<{ files: DriveFile[]; nextPageToken?: string }>('/files', {
          // Trashed files are asked for too: they are the removals.
          q: `${q(folder)} in parents and modifiedTime > ${q(since)}`,
          fields: `nextPageToken,files(${FIELDS})`,
          spaces: 'drive',
          pageSize: '1000',
          ...(pageToken ? { pageToken } : {}),
        });
        for (const f of r.files) {
          const rf = toRemote(f);
          newest = Math.max(newest, rf.mtime);
          if (f.trashed) gone.push(f.id);
          else files.push(rf);
        }
        pageToken = r.nextPageToken ?? '';
      } while (pageToken);
      return { files, gone, cursor: String(newest) } satisfies Changes;
    },

    async download(f) {
      return (await call(`${d.hosts.api}/files/${encodeURIComponent(f.id)}?alt=media`)).text;
    },

    create(folder, name, text) {
      return upload('POST', '/files', { name, parents: [folder], mimeType: 'application/json' }, text);
    },

    async update(f, text) {
      // Drive has no conditional write, so the version is checked just before. Two devices
      // writing in the same moment are caught by the next sync's merge.
      const now = await get<DriveFile>(`/files/${encodeURIComponent(f.id)}`, { fields: FIELDS });
      if (now.trashed) throw new CloudError('not-found', 404);
      if (String(now.version) !== f.version) throw new CloudError('conflict', 412);
      return upload('PATCH', `/files/${encodeURIComponent(f.id)}`, {}, text);
    },

    async remove(f) {
      try {
        await call(`${d.hosts.api}/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
      } catch (e) {
        if (!(e instanceof CloudError && e.code === 'not-found')) throw e;
      }
    },

    async removeAll() {
      const { top } = await this.folders();
      // The bin, not a delete, so the reader can still get the files back from Drive.
      await call(`${d.hosts.api}/files/${encodeURIComponent(top)}?fields=id`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      });
      await session.save({ folders: undefined });
    },

    async revoke() {
      const t = await d.tokens.get();
      if (!t) return;
      // Revoking a token that ran out does nothing, so renew it first (no window: Google's
      // session in this browser). Best effort: the token goes from storage whether or not
      // Google answers.
      const access = t.exp - 60_000 > now() ? t.access : await session.renew().catch(() => t.access);
      await send(net, {
        url: d.hosts.revoke,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: access }).toString(),
      }).catch(() => undefined);
    },
  };
}
