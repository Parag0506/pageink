/**
 * OAuth client ids, set at build time from cloud-ids.json and the git-ignored
 * cloud-ids.local.json (build/targets.ts). They are public by design: an extension
 * cannot keep a secret, so no client secret is used anywhere.
 */
import type { ProviderId } from './dest';

export interface ClientIds {
  google: string;
  microsoft: string;
}

export const CLIENT_IDS: ClientIds = __INK_CLOUD_IDS__;

/** A provider whose id is empty is shown, disabled, with "Not set up in this build." */
export const isSetUp = (p: ProviderId, ids: ClientIds = CLIENT_IDS): boolean =>
  (p === 'google' ? ids.google : ids.microsoft).trim() !== '';
