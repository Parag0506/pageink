/**
 * Safari only: tells the app whether the extension may run on every website, so the app's
 * setup screen can show the step as done or not (NATIVE_PROTOCOL.md, "Site access"). With
 * All Websites on Ask, the pen does not write on a page until the reader taps the toolbar
 * button, and the app is where a new reader looks for help.
 *
 * Safari wakes the background for many reasons and gives no notice when the setting changes
 * in Settings, so the state is sent each time the background starts, when the browser reports
 * a change, and when the popup asks for attention. Only a change is sent again.
 */
import { NATIVE_APP, type SendNative } from '../adapters/folder-native';
import type { Api } from '../api';
import { ALL_SITES } from '../ui/access';

export function keepAccessReported(api: Api, send: SendNative): () => Promise<void> {
  let last: boolean | undefined;
  const report = async () => {
    const p = api.permissions;
    if (!p?.contains) return;
    try {
      const all = await p.contains(ALL_SITES);
      if (all === last) return;
      const r = await send(NATIVE_APP, { v: 1, op: 'access', all });
      // An app from before this message answers with an error. Try again next time.
      if (r?.ok) last = all;
    } catch {
      // No app to tell. Nothing else depends on it.
    }
  };
  api.permissions?.onAdded?.addListener(() => void report());
  api.permissions?.onRemoved?.addListener(() => void report());
  api.runtime.onStartup.addListener(() => void report());
  void report();
  return report;
}
