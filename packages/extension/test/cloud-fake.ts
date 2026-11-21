/**
 * A local fake of Google Drive and of OneDrive (Microsoft Graph), with their sign-in pages
 * and token addresses, for the unit tests and the browser tests. It follows the documented
 * behaviour the code relies on: paging, slow-down answers, tokens that expire, refresh
 * tokens, eTag conflicts, names that two files can share on Drive, and delta links.
 * It is test code only. Nothing in the product imports it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';

export interface FakeFile {
  id: string;
  name: string;
  parent: string;
  text: string;
  mtime: number;
  version: number;
  folder: boolean;
  trashed: boolean;
  /** Graph: change number of the last change, for delta. */
  seq: number;
  deleted?: boolean;
}

interface Hit {
  method: string;
  path: string;
  search: string;
}

const rid = () => randomBytes(9).toString('base64url');

export class Fake {
  base = '';
  account = 'reader@example.test';
  /** The reader is signed in with the provider in the browser, so a silent sign-in works. */
  session = true;
  /** The next sign-in is refused by the reader. */
  deny = false;
  /** The sign-in page waits for a click on "Allow". */
  interactive = false;
  /** Answer this many API requests with "slow down". */
  throttle = 0;
  /** Uploads fail as if the storage were full. */
  full = false;
  /** Files per page in listings, small to make the code page. */
  pageSize = 3;
  /** Every connection is dropped, as when the device is offline. */
  offline = false;
  /** Connections dropped while offline. */
  dropped = 0;
  /** Requests seen, in order. */
  log: Hit[] = [];
  /** The sign-in page sends the reader back with this error, as a provider does. */
  authError: { error: string; error_description?: string } | null = null;
  /** The sign-in page shows its own error page and never sends the reader back. */
  authErrorPage = '';
  /** The token address answers with this error. */
  tokenError: {
    status: number;
    body: Record<string, unknown> | ((form: URLSearchParams) => Record<string, unknown>);
  } | null = null;
  /**
   * How the Microsoft return address is registered. "spa" refuses a code redeemed without an
   * Origin header (AADSTS9002327), "desktop" one redeemed with it (AADSTS9002326). Unset: no check.
   */
  msPlatform: 'spa' | 'desktop' | null = null;
  /** Drive or Graph answers every file call with this error. */
  apiError: { status: number; body: Record<string, unknown> } | null = null;
  /** Every scope asked for at a sign-in page, in order. */
  scopes: string[] = [];

  google = {
    files: new Map<string, FakeFile>(),
    tokens: new Map<string, number>(),
    sessions: new Map<string, string>(),
    revoked: [] as string[],
  };
  ms = {
    items: new Map<string, FakeFile>(),
    codes: new Map<string, { challenge: string; redirect: string }>(),
    access: new Map<string, number>(),
    refresh: new Map<string, boolean>(),
    seq: 1,
    approot: '',
  };
  private clock = Date.UTC(2026, 0, 1);
  private server: Server | null = null;

  /** Times only go up, a little each call, like a server's clock. */
  tick(): number {
    this.clock = Math.max(this.clock + 1000, Date.now());
    return this.clock;
  }

  async start(): Promise<this> {
    this.server = createServer((q, r) => {
      void this.handle(q, r).catch((e) => {
        r.writeHead(500, { 'content-type': 'text/plain' }).end(String(e));
      });
    });
    await new Promise<void>((ok) => this.server!.listen(0, '127.0.0.1', ok));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }

  /** Every access token stops working, as an hour going by would do. */
  expireAccess(): void {
    for (const k of this.google.tokens.keys()) this.google.tokens.set(k, 0);
    for (const k of this.ms.access.keys()) this.ms.access.set(k, 0);
  }

  /** Every refresh token stops working, as a day going by would do for a single-page app. */
  expireRefresh(): void {
    for (const k of this.ms.refresh.keys()) this.ms.refresh.set(k, false);
  }

  // ----- views for tests ---------------------------------------------------

  private live(m: Map<string, FakeFile>) {
    return [...m.values()].filter((f) => !f.trashed && !f.deleted);
  }

  /** Drive: the files in <top>/pages, by name. Two with one name both show. */
  drivePages(): FakeFile[] {
    const all = [...this.google.files.values()].filter((f) => !this.trashedUp(f));
    const pages = all.find((f) => f.folder && f.name === 'pages');
    return pages ? all.filter((f) => f.parent === pages.id && !f.folder) : [];
  }

  driveTop(): FakeFile | undefined {
    return this.live(this.google.files).find((f) => f.folder && f.parent === 'root');
  }

  /** OneDrive: the files in approot/pages. */
  msPages(): FakeFile[] {
    const pages = this.live(this.ms.items).find(
      (f) => f.folder && f.name === 'pages' && f.parent === this.ms.approot,
    );
    return pages ? this.live(this.ms.items).filter((f) => f.parent === pages.id && !f.folder) : [];
  }

  msTop(): FakeFile[] {
    return this.live(this.ms.items).filter((f) => f.parent === this.ms.approot);
  }

  /** Another device writes a Drive file directly. */
  driveWrite(name: string, text: string, parent = this.drivePagesId()): FakeFile {
    const f: FakeFile = {
      id: rid(),
      name,
      parent,
      text,
      mtime: this.tick(),
      version: 1,
      folder: false,
      trashed: false,
      seq: 0,
    };
    this.google.files.set(f.id, f);
    return f;
  }

  drivePagesId(): string {
    return this.live(this.google.files).find((f) => f.folder && f.name === 'pages')?.id ?? '';
  }

  /** Another device changes a OneDrive file directly. */
  msTouch(id: string, text: string): void {
    const f = this.ms.items.get(id)!;
    f.text = text;
    f.version++;
    f.mtime = this.tick();
    f.seq = this.ms.seq++;
  }

  /** Remove a file as another device or the reader would. */
  remove(id: string): void {
    const g = this.google.files.get(id);
    if (g) this.google.files.delete(id);
    const m = this.ms.items.get(id);
    if (m) {
      m.deleted = true;
      m.seq = this.ms.seq++;
    }
  }

  // ----- the server ----------------------------------------------------------

  private async handle(q: IncomingMessage, r: ServerResponse): Promise<void> {
    if (this.offline) {
      this.dropped++;
      q.socket.destroy();
      return;
    }
    const u = new URL(q.url ?? '/', this.base);
    const body = await new Promise<Buffer>((ok) => {
      const parts: Buffer[] = [];
      q.on('data', (c: Buffer) => parts.push(c));
      q.on('end', () => ok(Buffer.concat(parts)));
    });
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, if-match, x-upload-content-type',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
      'access-control-expose-headers': 'location, retry-after',
    };
    if (q.method === 'OPTIONS') return void r.writeHead(204, cors).end();
    this.log.push({ method: q.method ?? 'GET', path: u.pathname, search: decodeURIComponent(u.search) });
    const send = (status: number, data?: unknown, headers: Record<string, string> = {}) => {
      const text = data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data);
      r.writeHead(status, {
        'content-type': typeof data === 'string' ? 'text/plain' : 'application/json',
        ...cors,
        ...headers,
      });
      r.end(text);
    };
    const p = u.pathname;
    if (p.startsWith('/google/')) return this.googleRoute(q, u, body, send);
    if (p.startsWith('/ms/') || p.startsWith('/graph/') || p.startsWith('/msfiles/')) {
      return this.msRoute(q, u, body, send);
    }
    send(404, { error: 'unknown' });
  }

  private slowDown(send: Send, google: boolean): boolean {
    if (this.throttle <= 0) return false;
    this.throttle--;
    if (google && this.throttle % 2 === 0) {
      send(403, { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } });
    } else send(429, { error: { code: 'TooManyRequests' } }, { 'retry-after': '0' });
    return true;
  }

  // ----- Google ----------------------------------------------------------------

  private driveJson(f: FakeFile) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.folder ? FOLDER : 'application/json',
      modifiedTime: new Date(f.mtime).toISOString(),
      size: String(Buffer.byteLength(f.text)),
      version: String(f.version),
      trashed: f.trashed,
    };
  }

  private trashedUp(f: FakeFile): boolean {
    for (let x: FakeFile | undefined = f; x; x = this.google.files.get(x.parent)) if (x.trashed) return true;
    return false;
  }

  /** Enough of Drive's search language for the code: and-joined terms. */
  private match(f: FakeFile, query: string): boolean {
    const unq = (s: string) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    for (const term of query.split(/\s+and\s+/)) {
      const name = /^name\s*=\s*'((?:\\.|[^'])*)'$/.exec(term);
      const mime = /^mimeType\s*=\s*'([^']*)'$/.exec(term);
      const parent = /^'([^']*)'\s+in\s+parents$/.exec(term);
      const since = /^modifiedTime\s*>\s*'([^']*)'$/.exec(term);
      if (name) {
        if (f.name !== unq(name[1]!)) return false;
      } else if (mime) {
        if ((f.folder ? FOLDER : 'application/json') !== mime[1]) return false;
      } else if (parent) {
        if (f.parent !== parent[1]) return false;
      } else if (/^trashed\s*=\s*false$/.test(term)) {
        if (this.trashedUp(f)) return false;
      } else if (since) {
        if (!(f.mtime > Date.parse(since[1]!))) return false;
      } else throw new Error(`fake Drive: unknown search term ${term}`);
    }
    return true;
  }

  private googleAuthOk(q: IncomingMessage): boolean {
    const t = /^Bearer (.+)$/.exec(q.headers.authorization ?? '')?.[1];
    return !!t && (this.google.tokens.get(t) ?? 0) > Date.now();
  }

  private multipart(q: IncomingMessage, body: Buffer): { meta: Record<string, unknown>; text: string } {
    const b = /boundary=([^;]+)/.exec(q.headers['content-type'] ?? '')?.[1];
    if (!b) throw new Error('no boundary');
    const parts = body
      .toString('utf8')
      .split(`--${b}`)
      .slice(1, -1)
      .map((s) => s.slice(s.indexOf('\r\n\r\n') + 4, -2));
    return { meta: JSON.parse(parts[0]!), text: parts[1] ?? '' };
  }

  private uploads = new Map<string, { id?: string; meta: Record<string, unknown> }>();

  private googleRoute(q: IncomingMessage, u: URL, body: Buffer, send: Send) {
    const p = u.pathname;
    const sp = u.searchParams;
    if (p === '/google/auth') {
      const back = sp.get('redirect_uri')!;
      const state = sp.get('state') ?? '';
      const go = (frag: Record<string, string>) =>
        send(302, '', { location: `${back}#${new URLSearchParams({ ...frag, state })}` });
      this.scopes.push(sp.get('scope') ?? '');
      if (this.authErrorPage)
        return send(400, this.errorPage(this.authErrorPage), { 'content-type': 'text/html' });
      if (this.authError) return go(this.authError);
      if (sp.get('response_type') !== 'token' || sp.get('scope') !== DRIVE_SCOPE)
        return go({ error: 'invalid_request' });
      if (sp.get('prompt') === 'none' && !this.session) return go({ error: 'interaction_required' });
      if (this.deny) return go({ error: 'access_denied' });
      const token = `g-${rid()}`;
      this.google.tokens.set(token, Date.now() + 3600_000);
      this.session = true;
      const frag = { access_token: token, token_type: 'Bearer', expires_in: '3600', scope: DRIVE_SCOPE };
      if (this.interactive && sp.get('prompt') !== 'none') {
        const to = `${back}#${new URLSearchParams({ ...frag, state })}`;
        return send(200, `<!doctype html><title>Sign in</title><a id="allow" href="${to}">Allow</a>`, {
          'content-type': 'text/html',
        });
      }
      return go(frag);
    }
    if (p === '/google/revoke') {
      const t = new URLSearchParams(body.toString()).get('token') ?? '';
      this.google.tokens.delete(t);
      this.google.revoked.push(t);
      return send(200, {});
    }
    if (!this.googleAuthOk(q)) return send(401, { error: { code: 401, message: 'Invalid Credentials' } });
    if (this.apiError) return send(this.apiError.status, this.apiError.body);
    if (this.slowDown(send, true)) return;
    const files = this.google.files;
    const api = '/google/drive/v3';
    const up = '/google/upload/drive/v3';
    if (p === `${api}/about`)
      return send(200, { user: { emailAddress: this.account, displayName: 'Reader' } });
    if (p === `${api}/files` && q.method === 'GET') {
      const want = sp.get('q') ?? '';
      const all = [...files.values()]
        .filter((f) => this.match(f, want))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const size = Math.min(Number(sp.get('pageSize') ?? 100), this.pageSize);
      const from = Number(sp.get('pageToken') ?? 0);
      const page = all.slice(from, from + size).map((f) => this.driveJson(f));
      const more = from + size < all.length ? { nextPageToken: String(from + size) } : {};
      return send(200, { files: page, ...more });
    }
    if (p === `${api}/files` && q.method === 'POST') {
      const meta = JSON.parse(body.toString());
      const f: FakeFile = {
        id: rid(),
        name: meta.name,
        parent: meta.parents?.[0] ?? 'root',
        text: '',
        mtime: this.tick(),
        version: 1,
        folder: meta.mimeType === FOLDER,
        trashed: false,
        seq: 0,
      };
      files.set(f.id, f);
      return send(200, this.driveJson(f));
    }
    const one = new RegExp(`^${api}/files/([^/]+)$`).exec(p);
    if (one) {
      const f = files.get(decodeURIComponent(one[1]!));
      if (!f) return send(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });
      if (q.method === 'GET')
        return sp.get('alt') === 'media' ? send(200, f.text) : send(200, this.driveJson(f));
      if (q.method === 'DELETE') {
        files.delete(f.id);
        return send(204);
      }
      if (q.method === 'PATCH') {
        const meta = JSON.parse(body.toString() || '{}');
        if (meta.trashed === true) f.trashed = true;
        f.mtime = this.tick();
        return send(200, this.driveJson(f));
      }
    }
    const session = new RegExp(`^${up}/session/([^/]+)$`).exec(p);
    if (session && q.method === 'PUT') {
      const s = this.uploads.get(session[1]!);
      if (!s) return send(404, {});
      this.uploads.delete(session[1]!);
      return send(200, this.driveJson(this.driveStore(s.id, s.meta, body.toString('utf8'))));
    }
    const upload = new RegExp(`^${up}/files(?:/([^/]+))?$`).exec(p);
    if (upload) {
      if (this.full) return send(403, { error: { code: 403, errors: [{ reason: 'storageQuotaExceeded' }] } });
      const id = upload[1] ? decodeURIComponent(upload[1]) : undefined;
      if (id && !files.has(id)) return send(404, { error: { code: 404 } });
      if (sp.get('uploadType') === 'resumable') {
        const sid = rid();
        this.uploads.set(sid, { id, meta: JSON.parse(body.toString() || '{}') });
        return send(200, {}, { location: `${this.base}${up}/session/${sid}` });
      }
      const { meta, text } = this.multipart(q, body);
      return send(200, this.driveJson(this.driveStore(id, meta, text)));
    }
    send(404, { error: { code: 404 } });
  }

  private driveStore(id: string | undefined, meta: Record<string, unknown>, text: string): FakeFile {
    if (id) {
      const f = this.google.files.get(id)!;
      f.text = text;
      f.version++;
      f.mtime = this.tick();
      return f;
    }
    const f: FakeFile = {
      id: rid(),
      name: String(meta.name),
      parent: (meta.parents as string[] | undefined)?.[0] ?? 'root',
      text,
      mtime: this.tick(),
      version: 1,
      folder: false,
      trashed: false,
      seq: 0,
    };
    this.google.files.set(f.id, f);
    return f;
  }

  // ----- Microsoft ---------------------------------------------------------------

  private graphJson(f: FakeFile) {
    return {
      id: f.id,
      name: f.name,
      eTag: `"{${f.id}},${f.version}"`,
      lastModifiedDateTime: new Date(f.mtime).toISOString(),
      size: Buffer.byteLength(f.text),
      parentReference: { id: f.parent },
      ...(f.folder ? { folder: { childCount: 0 } } : { file: { mimeType: 'application/json' } }),
      ...(f.deleted ? { deleted: { state: 'deleted' } } : {}),
    };
  }

  private msOpenid = false;

  private errorPage(code: string): string {
    return `<!doctype html><title>Error</title><p id="error">Error 400: ${code}</p>`;
  }

  private idToken(): string {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'none' })}.${part({ preferred_username: this.account, name: 'Reader' })}.`;
  }

  private issue(send: Send) {
    const access = `m-${rid()}`;
    const refresh = `r-${rid()}`;
    this.ms.access.set(access, Date.now() + 3600_000);
    this.ms.refresh.set(refresh, true);
    send(200, {
      token_type: 'Bearer',
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      // An id token only comes with openid, as Microsoft does.
      ...(this.msOpenid ? { id_token: this.idToken() } : {}),
      scope: 'Files.ReadWrite.AppFolder',
    });
  }

  private newItem(name: string, parent: string, folder: boolean, text = ''): FakeFile {
    const f: FakeFile = {
      id: rid(),
      name,
      parent,
      text,
      mtime: this.tick(),
      version: 1,
      folder,
      trashed: false,
      seq: this.ms.seq++,
    };
    this.ms.items.set(f.id, f);
    return f;
  }

  private child(parent: string, name: string): FakeFile | undefined {
    return this.live(this.ms.items).find(
      (f) => f.parent === parent && f.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private msRoute(q: IncomingMessage, u: URL, body: Buffer, send: Send) {
    const p = u.pathname;
    const sp = u.searchParams;
    if (p === '/ms/authorize') {
      const back = sp.get('redirect_uri')!;
      const state = sp.get('state') ?? '';
      const go = (o: Record<string, string>) =>
        send(302, '', { location: `${back}?${new URLSearchParams({ ...o, state })}` });
      this.scopes.push(sp.get('scope') ?? '');
      this.msOpenid = (sp.get('scope') ?? '').split(' ').includes('openid');
      if (this.authErrorPage)
        return send(400, this.errorPage(this.authErrorPage), { 'content-type': 'text/html' });
      if (this.authError) return go(this.authError);
      if (sp.get('code_challenge_method') !== 'S256' || !sp.get('code_challenge')) {
        return go({ error: 'invalid_request' });
      }
      if (sp.get('prompt') === 'none' && !this.session) return go({ error: 'login_required' });
      if (this.deny) return go({ error: 'access_denied' });
      const code = `c-${rid()}`;
      this.ms.codes.set(code, { challenge: sp.get('code_challenge')!, redirect: back });
      this.session = true;
      return go({ code });
    }
    if (p === '/ms/token') {
      const f = new URLSearchParams(body.toString());
      this.scopes.push(f.get('scope') ?? '');
      if (this.tokenError) {
        const b = this.tokenError.body;
        return send(this.tokenError.status, typeof b === 'function' ? b(f) : b);
      }
      const origin = !!q.headers.origin;
      if (this.msPlatform === 'desktop' && origin)
        return send(
          400,
          msError(
            'invalid_request',
            9002326,
            "Cross-origin token redemption is permitted only for the 'Single-Page Application' client-type.",
          ),
        );
      if (this.msPlatform === 'spa' && !origin)
        return send(
          400,
          msError(
            'invalid_request',
            9002327,
            "Tokens issued for the 'Single-Page Application' client-type may only be redeemed via cross-origin requests.",
          ),
        );
      if (f.get('grant_type') === 'authorization_code') {
        const c = this.ms.codes.get(f.get('code') ?? '');
        this.ms.codes.delete(f.get('code') ?? '');
        const verifier = f.get('code_verifier') ?? '';
        const ok =
          c &&
          c.redirect === f.get('redirect_uri') &&
          createHash('sha256').update(verifier).digest('base64url') === c.challenge;
        if (!ok) return send(400, { error: 'invalid_grant' });
        return this.issue(send);
      }
      if (f.get('grant_type') === 'refresh_token') {
        const rt = f.get('refresh_token') ?? '';
        if (!this.ms.refresh.get(rt)) return send(400, { error: 'invalid_grant' });
        this.ms.refresh.delete(rt);
        return this.issue(send);
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    if (p.startsWith('/msfiles/')) {
      const f = this.ms.items.get(decodeURIComponent(p.slice('/msfiles/'.length)));
      return f && !f.deleted ? send(200, f.text) : send(404, {});
    }
    const t = /^Bearer (.+)$/.exec(q.headers.authorization ?? '')?.[1];
    if (!t || (this.ms.access.get(t) ?? 0) <= Date.now()) {
      return send(401, { error: { code: 'InvalidAuthenticationToken' } });
    }
    if (this.apiError) return send(this.apiError.status, this.apiError.body);
    if (this.slowDown(send, false)) return;
    const G = '/graph/v1.0/me/drive';
    if (!this.ms.approot) {
      const root = this.newItem('Apps', 'root', true);
      this.ms.approot = root.id;
    }
    const approot = this.ms.items.get(this.ms.approot)!;
    if (p === `${G}/special/approot`) return send(200, this.graphJson(approot));
    const byPath = new RegExp(`^${G}/special/approot:/(.+?):?$`).exec(p);
    if (byPath && q.method === 'GET') {
      const f = this.child(approot.id, decodeURIComponent(byPath[1]!));
      return f ? send(200, this.graphJson(f)) : send(404, { error: { code: 'itemNotFound' } });
    }
    const put = new RegExp(`^${G}/items/([^/:]+):/(.+?):/content$`).exec(p);
    if (put && q.method === 'PUT') {
      if (this.full) return send(507, { error: { code: 'quotaLimitReached' } });
      const parent = decodeURIComponent(put[1]!);
      const name = decodeURIComponent(put[2]!);
      const had = this.child(parent, name);
      if (had && sp.get('@microsoft.graph.conflictBehavior') === 'fail') {
        return send(409, { error: { code: 'nameAlreadyExists' } });
      }
      if (had) {
        this.msTouch(had.id, body.toString('utf8'));
        return send(200, this.graphJson(had));
      }
      return send(201, this.graphJson(this.newItem(name, parent, false, body.toString('utf8'))));
    }
    const item = new RegExp(`^${G}/items/([^/:]+)(/children|/content|/delta)?$`).exec(p);
    if (!item) return send(404, { error: { code: 'itemNotFound' } });
    const id = decodeURIComponent(item[1]!);
    const f = this.ms.items.get(id);
    if (!f || f.deleted) return send(404, { error: { code: 'itemNotFound' } });
    const what = item[2];
    if (what === '/children' && q.method === 'GET') {
      const all = this.live(this.ms.items)
        .filter((x) => x.parent === id)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const size = Math.min(Number(sp.get('$top') ?? 200), this.pageSize);
      const from = Number(sp.get('$skiptoken') ?? 0);
      const next =
        from + size < all.length
          ? { '@odata.nextLink': `${this.base}${p}?$skiptoken=${from + size}&$top=${size}` }
          : {};
      return send(200, { value: all.slice(from, from + size).map((x) => this.graphJson(x)), ...next });
    }
    if (what === '/children' && q.method === 'POST') {
      const meta = JSON.parse(body.toString());
      if (this.child(id, meta.name)) return send(409, { error: { code: 'nameAlreadyExists' } });
      return send(201, this.graphJson(this.newItem(meta.name, id, !!meta.folder)));
    }
    if (what === '/delta') {
      const token = sp.get('token');
      const link = (s: number) => `${this.base}${p}?token=${s}`;
      if (token === 'latest') return send(200, { value: [], '@odata.deltaLink': link(this.ms.seq) });
      const since = Number(token ?? 0);
      if (!Number.isFinite(since) || since > this.ms.seq)
        return send(410, { error: { code: 'resyncRequired' } });
      const changed = [...this.ms.items.values()]
        .filter((x) => x.seq >= since && (x.parent === id || x.id === id))
        .sort((a, b) => a.seq - b.seq);
      const from = Number(sp.get('skip') ?? 0);
      const size = this.pageSize;
      const page = changed.slice(from, from + size).map((x) => this.graphJson(x));
      if (from + size < changed.length) {
        return send(200, {
          value: page,
          '@odata.nextLink': `${this.base}${p}?token=${since}&skip=${from + size}`,
        });
      }
      return send(200, { value: page, '@odata.deltaLink': link(this.ms.seq) });
    }
    if (what === '/content' && q.method === 'GET') {
      return send(302, '', { location: `${this.base}/msfiles/${encodeURIComponent(f.id)}?sig=${rid()}` });
    }
    if (what === '/content' && q.method === 'PUT') {
      if (this.full) return send(507, { error: { code: 'quotaLimitReached' } });
      const want = q.headers['if-match'];
      if (want && want !== this.graphJson(f).eTag) return send(412, { error: { code: 'resourceModified' } });
      this.msTouch(f.id, body.toString('utf8'));
      return send(200, this.graphJson(f));
    }
    if (!what && q.method === 'DELETE') {
      const gone = (x: FakeFile) => {
        x.deleted = true;
        x.seq = this.ms.seq++;
        for (const c of this.live(this.ms.items)) if (c.parent === x.id) gone(c);
      };
      gone(f);
      return send(204);
    }
    if (!what && q.method === 'GET') return send(200, this.graphJson(f));
    send(405, {});
  }
}

/** A Microsoft token error body, shaped like the real one. */
export function msError(error: string, code: number, text: string): Record<string, unknown> {
  const trace = '0000aaaa-11bb-cccc-dd22-eeeeee333333';
  return {
    error,
    error_description: `AADSTS${code}: ${text} Request origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'.\r\nTrace ID: ${trace}\r\nCorrelation ID: ${trace}\r\nTimestamp: 2026-01-01 00:00:00Z`,
    error_codes: [code],
    trace_id: trace,
    correlation_id: trace,
  };
}

type Send = (status: number, data?: unknown, headers?: Record<string, string>) => void;

/** A sign-in window for node tests: follows the provider's page to where it sends the reader back. */
export function nodeFlow(fake: Fake) {
  return async (url: string, interactive: boolean): Promise<string> => {
    const r = await fetch(url, { redirect: 'manual' });
    const to = r.headers.get('location');
    if (!to) throw Object.assign(new Error(interactive ? 'cancelled' : 'expired'), { fake });
    return to;
  };
}
