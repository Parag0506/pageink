/**
 * Loads the cloud code (cloud.js, built from src/cloud) into the background. Only a reader
 * who connected or is connecting a cloud gets here. Chrome and Edge run the background as a
 * service worker, which may not use import() or a late importScripts(); there the file is
 * read once at start (startCloud) and only defines functions. Firefox's background is a page,
 * so the file is added the first time it is needed. Safari has no cloud.js: the app does it.
 */
import type { Api } from '../api';
import type { Cloud, createCloud } from '../cloud';
import { CLIENT_IDS } from '../connect/ids';
import type { Secrets } from './secrets';

type Module = { createCloud: typeof createCloud };
const mod = () => (globalThis as { inkCloud?: Module }).inkCloud;

/** The file, relative to the extension's root. */
export const CLOUD_FILE = '/cloud.js';

/** Chrome and Edge: called once at the top of the service worker. */
export function startCloud(): void {
  const g = globalThis as { importScripts?: (u: string) => void };
  if ((__INK_TARGET__ === 'chrome' || __INK_TARGET__ === 'edge') && typeof g.importScripts === 'function') {
    try {
      g.importScripts(CLOUD_FILE);
    } catch {
      // Without it the cloud choices report a problem; folders still work.
    }
  }
}

function addScript(src: string): Promise<void> {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => ok();
    s.onerror = () => fail(new Error('cloud code did not load'));
    document.head.append(s);
  });
}

export async function loadCloud(api: Api, secrets: Secrets): Promise<Cloud> {
  if (!mod() && typeof document !== 'undefined') await addScript(api.runtime.getURL(CLOUD_FILE));
  const m = mod();
  if (!m) throw new Error('cloud code missing');
  return m.createCloud({
    storage: api.storage.local,
    secrets,
    // Read when used: on Chrome and Edge the API appears once the reader grants it.
    identity: () => api.identity,
    ids: CLIENT_IDS,
  });
}
