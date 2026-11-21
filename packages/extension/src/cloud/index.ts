/**
 * The cloud code, built on its own as cloud.js (build/cloud.ts). It holds every network
 * call the product makes for sync, and nothing else in the product reaches a cloud. The
 * background loads it for a reader who has connected or is connecting a cloud. Loading it
 * only defines functions; nothing here runs until the background calls createCloud.
 */
import type { ProviderId } from '../connect/dest';
import type { ClientIds } from '../connect/ids';
import { type AuthFlow, browserFlow, type SecretArea, tokenStore } from './auth';
import { type CacheStore, type CloudFolder, cloudFolder, type NameCache } from './folder';
import { googleDrive } from './google';
import { fakeHosts, type Hosts, REAL_HOSTS } from './hosts';
import { annotate, type Net } from './http';
import { oneDrive } from './onedrive';
import type { Provider } from './provider';

export type { CloudFolder } from './folder';
export { CloudError } from './http';

import { CloudError } from './http';

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

export interface CloudDeps {
  /** Name lists, and the fake's address in the test build. Nothing secret. */
  storage: Area;
  /** Tokens: the background's own store, out of reach of content scripts. */
  secrets: SecretArea;
  /** Missing until the reader grants it. Safari and Firefox for Android have none. */
  identity?: () => typeof chrome.identity | undefined;
  ids: ClientIds;
  /** Tests give their own sign-in window, addresses and waits. */
  flow?: AuthFlow;
  redirect?: string;
  hosts?: Hosts;
  net?: Omit<Net, 'allow'>;
}

export interface Cloud {
  /** Sign in with the provider's window and make the folder. Returns the account to show. */
  connect(p: ProviderId): Promise<{ account?: string }>;
  /** The place as a folder for sync. */
  open(p: ProviderId): CloudFolder;
  /** Forget the sign-in, after giving it back where the provider allows. Files stay unless told. */
  disconnect(p: ProviderId, removeFiles: boolean): Promise<void>;
}

/** Keys this module keeps in storage.local, so Disconnect can remove every one. Tokens are in `secrets`. */
export const cloudKeys = (p: ProviderId) => [`names:${p}`];

/** In the test build the fake's address is read from storage. A release build has no such branch. */
async function hostsFor(d: CloudDeps): Promise<Hosts> {
  if (d.hosts) return d.hosts;
  if (__INK_CLOUD_FAKE__) {
    const base = (await d.storage.get('cloudFake')).cloudFake;
    if (typeof base === 'string') return fakeHosts(base);
  }
  return REAL_HOSTS;
}

export function createCloud(d: CloudDeps): Cloud {
  const providers = new Map<ProviderId, Promise<Provider>>();

  const flow = (): AuthFlow => {
    if (d.flow) return d.flow;
    const id = d.identity?.();
    if (!id?.launchWebAuthFlow) throw new CloudError('denied', 0, 'no identity');
    return browserFlow(id);
  };

  const redirectFor = () => d.redirect ?? d.identity?.()?.getRedirectURL() ?? '';

  const provider = (p: ProviderId): Promise<Provider> => {
    let made = providers.get(p);
    if (!made) {
      made = (async () => {
        const hosts = await hostsFor(d);
        const redirect = redirectFor();
        const tokens = tokenStore(d.secrets, p);
        // The flow is looked up when it is used: identity appears once the reader grants it.
        const lazy: AuthFlow = (url, interactive) => flow()(url, interactive);
        return p === 'google'
          ? googleDrive({
              hosts: hosts.google,
              clientId: d.ids.google,
              redirect,
              flow: lazy,
              tokens,
              net: d.net,
            })
          : oneDrive({
              hosts: hosts.microsoft,
              clientId: d.ids.microsoft,
              redirect,
              flow: lazy,
              tokens,
              net: d.net,
            });
      })();
      providers.set(p, made);
    }
    return made;
  };

  const cache = (p: ProviderId): CacheStore => {
    const key = `names:${p}`;
    return {
      get: async () => ((await d.storage.get(key))[key] as NameCache | undefined) ?? null,
      set: (c) => (c ? d.storage.set({ [key]: c }) : d.storage.remove(key)),
    };
  };

  /** A folder whose provider is made on first use, so open() itself is cheap. */
  function open(p: ProviderId): CloudFolder {
    let inner: Promise<CloudFolder> | null = null;
    let made: CloudFolder | null = null;
    const get = () =>
      (inner ??= provider(p).then((pr) => (made = cloudFolder({ provider: pr, cache: cache(p) }))));
    return {
      list: async (dir) => (await get()).list(dir),
      read: async (n) => (await get()).read(n),
      write: async (n, t) => (await get()).write(n, t),
      remove: async (n) => (await get()).remove!(n),
      peek: (n) => made?.peek(n),
      takeConflicts: () => made?.takeConflicts() ?? 0,
    };
  }

  return {
    async connect(p) {
      const pr = await provider(p);
      const tag = { provider: p, redirect: redirectFor() || undefined };
      let t: Awaited<ReturnType<Provider['signIn']>>;
      try {
        t = await pr.signIn();
      } catch (e) {
        throw annotate(e, { step: 'authorize', ...tag });
      }
      // A new sign-in starts from a fresh name list.
      await d.storage.remove(`names:${p}`);
      try {
        await pr.folders();
      } catch (e) {
        annotate(e, { step: 'first file call', ...tag });
        if (e instanceof CloudError && e.info?.step === 'file call') e.info.step = 'first file call';
        throw e;
      }
      return { account: t.account };
    },
    open,
    async disconnect(p, removeFiles) {
      const pr = await provider(p);
      // If removing the files fails, the sign-in stays, so the reader can try again.
      if (removeFiles) await pr.removeAll();
      await pr.revoke().catch(() => undefined);
      await d.secrets.remove(`tok:${p}`);
      await d.storage.remove(cloudKeys(p));
      providers.delete(p);
    },
  };
}
