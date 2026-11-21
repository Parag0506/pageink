/**
 * OneDrive through Microsoft Graph. Scope Files.ReadWrite.AppFolder: the extension sees only
 * its own app folder (Apps/<app name> in the reader's OneDrive). Writes are conditional:
 * an update carries the eTag it read, and a new file fails if the name is taken, so two
 * devices never silently overwrite each other. On a mismatch the sync reads, merges and
 * writes again.
 */

import type { AuthStep } from '../connect/explain';
import { type AuthFlow, checkReturn, pkce, randomText, Session, type TokenStore } from './auth';
import type { MicrosoftHosts } from './hosts';
import { allowed, annotate, apiError, CloudError, json, type Net, send } from './http';
import type { Changes, Folders, Provider, RemoteFile, Tokens } from './provider';

export interface OneDriveDeps {
  hosts: MicrosoftHosts;
  clientId: string;
  redirect: string;
  flow: AuthFlow;
  tokens: TokenStore;
  net?: Omit<Net, 'allow'>;
  now?: () => number;
}

/**
 * The scopes asked for, and no others. Files.ReadWrite.AppFolder is the app folder only;
 * offline_access gives a refresh token. No openid, profile, email or User.Read: the token
 * address gives access and refresh tokens for a resource scope without them, and the
 * consent screen then lists the least. The account name is not read, so the screen says
 * "Connected to OneDrive" alone.
 */
export const MS_SCOPES = 'Files.ReadWrite.AppFolder offline_access';

type Item = {
  id: string;
  name: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  size?: number;
  file?: object;
  folder?: object;
  deleted?: object;
  parentReference?: { id?: string };
};

const toRemote = (i: Item): RemoteFile => ({
  id: i.id,
  name: i.name,
  mtime: i.lastModifiedDateTime ? Date.parse(i.lastModifiedDateTime) : 0,
  size: i.size ?? 0,
  version: i.eTag ?? '',
});

export function oneDrive(d: OneDriveDeps): Provider {
  const now = d.now ?? Date.now;
  const net: Net = { ...d.net, allow: [d.hosts.token, d.hosts.graph] };
  const G = d.hosts.graph;

  /**
   * The token request. It runs in the background with fetch, and the browser always adds an
   * Origin header (chrome-extension://... or moz-extension://...) that the code cannot remove.
   * Microsoft redeems a code sent with an Origin header only for a return address registered
   * as "Single-page application"; for one under "Mobile and desktop applications" it answers
   * AADSTS9002326. So the registration must be Single-page application. Its refresh tokens
   * last 24 hours, after which the silent sign-in below gets a new one without a window.
   * There is no second request shape to try: the header is the browser's, not ours. Both
   * answers (AADSTS9002326, and AADSTS9002327 for a missing header) reach the reader with
   * the fix in plain words (connect/explain.ts).
   */
  async function tokenRequest(
    form: Record<string, string>,
    step: AuthStep,
    secrets: string[],
  ): Promise<Tokens> {
    let r: Awaited<ReturnType<typeof send>>;
    try {
      r = await send(net, {
        url: d.hosts.token,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: d.clientId, scope: MS_SCOPES, ...form }).toString(),
      });
    } catch (e) {
      if (e instanceof CloudError) e.info ??= { step, status: e.status || undefined, redirect: d.redirect };
      throw e;
    }
    let body: Record<string, unknown> = {};
    try {
      body = r.text ? (JSON.parse(r.text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (r.res.status !== 200 || typeof body.access_token !== 'string') {
      const said = apiError(r.text, secrets);
      const e = said.error ?? String(r.res.status);
      throw new CloudError(
        e === 'invalid_grant' || e === 'interaction_required' ? 'expired' : 'denied',
        r.res.status,
        e,
        {
          step,
          error: said.error,
          description: said.description,
          status: r.res.status,
          redirect: d.redirect,
        },
      );
    }
    const t: Tokens = { access: body.access_token, exp: now() + Number(body.expires_in ?? 3600) * 1000 };
    if (typeof body.refresh_token === 'string') t.refresh = body.refresh_token;
    return t;
  }

  async function codeFlow(interactive: boolean, hint?: string): Promise<Tokens> {
    const { verifier, challenge } = await pkce();
    const state = randomText(16);
    const p = new URLSearchParams({
      client_id: d.clientId,
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: d.redirect,
      scope: MS_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: interactive ? 'select_account' : 'none',
    });
    if (hint) p.set('login_hint', hint);
    let code: string | null;
    try {
      const back = await d.flow(`${d.hosts.auth}?${p}`, interactive);
      code = checkReturn(back, state, interactive).get('code');
    } catch (e) {
      throw annotate(e, { step: 'authorize', redirect: d.redirect });
    }
    if (!code)
      throw new CloudError(interactive ? 'denied' : 'expired', 0, 'no code', {
        step: 'authorize',
        error: 'no_code',
        redirect: d.redirect,
      });
    return tokenRequest(
      { grant_type: 'authorization_code', code, redirect_uri: d.redirect, code_verifier: verifier },
      'token',
      [code, verifier],
    );
  }

  const session = new Session(
    d.tokens,
    async (old) => {
      if (old?.refresh) {
        try {
          return await tokenRequest({ grant_type: 'refresh_token', refresh_token: old.refresh }, 'refresh', [
            old.refresh,
          ]);
        } catch (e) {
          if (!(e instanceof CloudError && e.code === 'expired')) throw e;
        }
      }
      // The refresh token ran out: try once without a window, then the reader signs in again.
      // Only an address is a login hint; nothing else is kept for it.
      return codeFlow(false, old?.account?.includes('@') ? old.account : undefined);
    },
    now,
  );
  const token = { get: () => session.get(), renew: () => session.renew() };

  async function call(url: string, init: Omit<Parameters<typeof send>[1], 'url'> = {}) {
    // Next and delta links come from Graph. They must still point at Graph.
    if (!allowed(url, [G])) throw new CloudError('denied', 0, 'link outside Graph');
    const r = await send(net, { url, token, ...init });
    const s = r.res.status;
    if (s >= 200 && s < 300) return r;
    if (s === 404) throw new CloudError('not-found', s);
    if (s === 409 || s === 412) throw new CloudError('conflict', s);
    if (s === 410) throw new CloudError('reset', s);
    if (s === 507 || /quotaLimitReached|insufficientStorage/.test(r.text)) throw new CloudError('full', s);
    const said = { step: 'file call' as const, status: s, ...apiError(r.text) };
    if (s === 403) throw new CloudError('denied', s, said.error ?? '', said);
    throw new CloudError('server', s, said.error ?? '', said);
  }

  const SELECT = '$select=id,name,eTag,lastModifiedDateTime,size,file,folder,deleted,parentReference';

  async function children(id: string): Promise<Item[]> {
    const out: Item[] = [];
    let url: string | undefined = `${G}/me/drive/items/${encodeURIComponent(id)}/children?${SELECT}&$top=200`;
    while (url) {
      const r: { value: Item[]; '@odata.nextLink'?: string } = json((await call(url)).text);
      out.push(...r.value);
      url = r['@odata.nextLink'];
    }
    return out;
  }

  /** Every page of a delta, to its delta link. */
  async function delta(url: string): Promise<{ items: Item[]; link: string }> {
    const items: Item[] = [];
    let next: string | undefined = url;
    while (next) {
      const r: { value: Item[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string } = json(
        (await call(next)).text,
      );
      items.push(...r.value);
      if (r['@odata.deltaLink']) return { items, link: r['@odata.deltaLink'] };
      next = r['@odata.nextLink'];
    }
    throw new CloudError('reset', 0, 'no delta link');
  }

  /**
   * CHECK: delta on a folder below the drive's root works for personal accounts; work and
   * school accounts may refuse it. Then the cursor is null and each sync lists the folder.
   */
  async function latest(folder: string): Promise<string | null> {
    try {
      return (await delta(`${G}/me/drive/items/${encodeURIComponent(folder)}/delta?token=latest`)).link;
    } catch (e) {
      if (e instanceof CloudError && (e.code === 'server' || e.code === 'denied' || e.code === 'reset'))
        return null;
      throw e;
    }
  }

  const contentUrl = (folder: string, name: string) =>
    `${G}/me/drive/items/${encodeURIComponent(folder)}:/${encodeURIComponent(name)}:/content`;

  return {
    id: 'onedrive',

    async signIn() {
      const t = await codeFlow(true);
      await d.tokens.set(t);
      return t;
    },

    async folders() {
      const t = await session.tokens();
      if (t?.folders) return t.folders;
      // Asking for the app folder makes it the first time.
      const top = json<Item>((await call(`${G}/me/drive/special/approot?$select=id,name`)).text).id;
      let pages: string;
      try {
        pages = json<Item>((await call(`${G}/me/drive/special/approot:/pages?$select=id`)).text).id;
      } catch (e) {
        if (!(e instanceof CloudError && e.code === 'not-found')) throw e;
        try {
          const r = await call(`${G}/me/drive/items/${encodeURIComponent(top)}/children`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'pages', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
          });
          pages = json<Item>(r.text).id;
        } catch (e2) {
          // Another device made it in the meantime.
          if (!(e2 instanceof CloudError && e2.code === 'conflict')) throw e2;
          pages = json<Item>((await call(`${G}/me/drive/special/approot:/pages?$select=id`)).text).id;
        }
      }
      const f: Folders = { top, pages };
      await session.save({ folders: f });
      return f;
    },

    async list(folder) {
      const files = (await children(folder)).filter((i) => i.file && !i.deleted).map(toRemote);
      return { files, cursor: await latest(folder) };
    },

    async changes(folder, cursor) {
      const { items, link } = await delta(cursor);
      const files: RemoteFile[] = [];
      const gone: string[] = [];
      for (const i of items) {
        if (i.id === folder) continue;
        if (i.deleted) gone.push(i.id);
        else if (i.file && (!i.parentReference?.id || i.parentReference.id === folder))
          files.push(toRemote(i));
        // A file moved out of the folder no longer belongs to it.
        else if (i.file) gone.push(i.id);
      }
      return { files, gone, cursor: link } satisfies Changes;
    },

    /**
     * CHECK: Graph answers /content with a redirect to a short-lived address on its file
     * hosts (*.files.1drv.com, *.sharepoint.com or my.microsoftpersonalcontent.com). The fetch
     * follows it; the manifest's connect-src lists those hosts, and nothing else.
     */
    async download(f) {
      return (await call(`${G}/me/drive/items/${encodeURIComponent(f.id)}/content`)).text;
    },

    async create(folder, name, text) {
      const r = await call(`${contentUrl(folder, name)}?@microsoft.graph.conflictBehavior=fail`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: text,
      });
      return toRemote(json<Item>(r.text));
    },

    async update(f, text) {
      const r = await call(`${G}/me/drive/items/${encodeURIComponent(f.id)}/content`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': f.version },
        body: text,
      });
      return toRemote(json<Item>(r.text));
    },

    async remove(f) {
      try {
        await call(`${G}/me/drive/items/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
      } catch (e) {
        if (!(e instanceof CloudError && e.code === 'not-found')) throw e;
      }
    },

    async removeAll() {
      const { top } = await this.folders();
      // Deleted items go to the OneDrive recycle bin, where the reader can still get them.
      for (const i of await children(top)) {
        await call(`${G}/me/drive/items/${encodeURIComponent(i.id)}`, { method: 'DELETE' }).catch((e) => {
          if (!(e instanceof CloudError && e.code === 'not-found')) throw e;
        });
      }
      await session.save({ folders: undefined });
    },

    // Microsoft has no address to give back a public client's token. Removing it from
    // storage ends this device's access; the reader can also remove the app from their
    // Microsoft account page.
    async revoke() {},
  };
}
