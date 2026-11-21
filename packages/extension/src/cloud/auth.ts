/**
 * Sign-in without a server of ours. The provider's own page opens in the browser's sign-in
 * window (identity.launchWebAuthFlow) and comes back to the address getRedirectURL() gives.
 * Tokens are kept in the background's own store (background/secrets.ts), which content
 * scripts cannot reach: never in storage.local or storage.sync, never in the notes, never in
 * a log.
 */
import { scrub } from '../connect/explain';
import { CloudError } from './http';
import type { Tokens } from './provider';

/** Opens the address and returns the address the provider sent the window back to. */
export type AuthFlow = (url: string, interactive: boolean) => Promise<string>;

export interface TokenStore {
  get(): Promise<Tokens | null>;
  set(t: Tokens): Promise<void>;
  remove(): Promise<void>;
}

/** The background's secret store, as the cloud code uses it. */
export interface SecretArea {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** The key for a provider's tokens. */
export const tokenKey = (id: string) => `tok:${id}`;

export function tokenStore(secrets: SecretArea, id: string): TokenStore {
  const key = tokenKey(id);
  return {
    async get() {
      const v = (await secrets.get(key)) as Tokens | undefined;
      return v && typeof v.access === 'string' && typeof v.exp === 'number' ? v : null;
    },
    set: (t) => secrets.set(key, t),
    remove: () => secrets.remove(key),
  };
}

/** The browser's sign-in window. Closing it, or a silent try that needs the reader, rejects. */
export function browserFlow(identity: typeof chrome.identity): AuthFlow {
  return async (url, interactive) => {
    try {
      const r = await identity.launchWebAuthFlow({ url, interactive });
      if (!r) throw new Error('no address');
      return r;
    } catch (e) {
      // Chrome says "The user did not approve access.", Firefox "User cancelled or denied
      // access.", and both refuse a silent try that would need the reader. An error page at
      // the provider (such as redirect_uri_mismatch) never comes back, so it ends here too.
      const said = e instanceof Error ? e.message : '';
      throw new CloudError(interactive ? 'cancelled' : 'expired', 0, '', {
        step: 'authorize',
        description: said ? scrub(said, [url]) : undefined,
      });
    }
  };
}

const b64url = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const randomText = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** PKCE (RFC 7636): a random verifier and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomText(48);
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(d)) };
}

/** The parameters the provider put in the query and the fragment of the address it returned. */
export function returned(url: string): URLSearchParams {
  const u = new URL(url);
  const p = new URLSearchParams(u.search);
  for (const [k, v] of new URLSearchParams(u.hash.replace(/^#/, ''))) p.set(k, v);
  return p;
}

/** Map an OAuth error code from the returned address to a problem. */
export function authProblem(error: string, interactive: boolean, description?: string | null): CloudError {
  const info = {
    step: 'authorize' as const,
    error: /^[\w.-]{1,80}$/.test(error) ? error : scrub(error).slice(0, 80),
    description: description ? scrub(description) : undefined,
  };
  if (error === 'access_denied')
    return new CloudError(interactive ? 'denied' : 'expired', 0, info.error, info);
  if (/required|login|consent|interaction|invalid_grant/.test(error))
    return new CloudError('expired', 0, info.error, info);
  return new CloudError(interactive ? 'denied' : 'expired', 0, info.error, info);
}

/** Check the state and the error of a returned address. */
export function checkReturn(url: string, state: string, interactive: boolean): URLSearchParams {
  const p = returned(url);
  const err = p.get('error');
  if (err) throw authProblem(err, interactive, p.get('error_description'));
  if (p.get('state') !== state)
    throw new CloudError('denied', 0, 'state mismatch', {
      step: 'authorize',
      error: 'state_mismatch',
      description: 'The address the sign-in came back with did not carry the state this sign-in sent.',
    });
  return p;
}

/**
 * The access token for requests, renewed in one place. Two requests that both find the
 * token old share one renewal.
 */
export class Session {
  private renewing: Promise<string> | null = null;
  constructor(
    private store: TokenStore,
    private renewFn: (t: Tokens | null) => Promise<Tokens>,
    private now: () => number = Date.now,
  ) {}

  async get(): Promise<string> {
    const t = await this.store.get();
    // A minute early, so a token never runs out in the middle of a request.
    if (t && t.exp - 60_000 > this.now()) return t.access;
    return this.renew();
  }

  renew(): Promise<string> {
    this.renewing ??= (async () => {
      try {
        const old = await this.store.get();
        if (!old) throw new CloudError('expired', 0, 'not signed in');
        const t = await this.renewFn(old);
        await this.store.set({ ...old, ...t });
        return t.access;
      } finally {
        this.renewing = null;
      }
    })();
    return this.renewing;
  }

  tokens = () => this.store.get();
  save = async (patch: Partial<Tokens>) => {
    const t = await this.store.get();
    if (t) await this.store.set({ ...t, ...patch });
  };
}
