import { pageIdentity } from 'pageink-core/anchor';
import { createStore } from 'pageink-core/store';
import { defineBackground } from 'wxt/utils/define-background';
import { sendNativeOf } from '../src/adapters/folder-native';
import { localKV } from '../src/adapters/kv';
import { pickApi } from '../src/api';
import { attentionOf, showAttention } from '../src/background/attention';
import { loadCloud, startCloud } from '../src/background/cloud-load';
import { relayDiag } from '../src/background/diag-relay';
import { folderKind, folderOpener, folderState } from '../src/background/folder';
import { createPlace } from '../src/background/place';
import { keepRegistered } from '../src/background/register';
import { listen } from '../src/background/router';
import { backgroundSecrets } from '../src/background/secrets';
import { keepAccessReported } from '../src/background/site-access';
import { createSyncer, type Syncer } from '../src/background/syncer';
import { PROVIDER_NAME, readDest } from '../src/connect/dest';
import { noteNudge, readNudge } from '../src/nudge';
import { readStatus, writeStatus } from '../src/sync-status';

export default defineBackground(() => {
  // Chrome and Edge only: the cloud file must be read while the worker starts (cloud-load.ts).
  startCloud();
  const api = pickApi();
  keepRegistered(api);
  // The device check: strokes in the PDF viewer reach the check page. Diagnostics builds only.
  if (__INK_DIAG__) relayDiag(api);
  const area = api.storage.local;
  // Tokens and the lock key: the background's IndexedDB, never storage.local, which content
  // scripts can read. Development builds kept them, and the account name, in storage.local;
  // they are moved once, at start.
  const secrets = backgroundSecrets({
    local: area,
    session: (api.storage as { session?: Parameters<typeof backgroundSecrets>[0]['session'] }).session,
  });
  void secrets.get('lockKey').catch(() => {});
  const store = createStore(localKV(api));
  const kind = folderKind(__INK_TARGET__);
  const folderOpen = folderOpener(api, kind);
  let syncer: Syncer;
  const place = createPlace({
    area,
    secrets,
    store,
    kind,
    openFolder: folderOpen,
    loadCloud: () => loadCloud(api, secrets),
    send: kind === 'native' ? sendNativeOf(api) : undefined,
    syncer: () => syncer,
  });
  // Safari: the app's setup screen shows whether every website is allowed.
  const reportAccess = kind === 'native' ? keepAccessReported(api, sendNativeOf(api)) : undefined;
  const attention = async () => {
    void reportAccess?.();
    const dest = await readDest(area);
    const a = await attentionOf({
      store,
      // Firefox has no folder, but a cloud counts as the backup there too.
      archive: kind === 'archive' && dest?.kind !== 'cloud',
      folder: async () => (dest?.kind === 'cloud' ? 'ok' : folderState(folderOpen)),
      nudge: () => readNudge(area),
      problem: async () => ({
        problem: (await readStatus(area)).problem,
        place: dest?.kind === 'cloud' ? PROVIDER_NAME[dest.provider] : undefined,
        provider: dest?.kind === 'cloud' ? dest.provider : undefined,
      }),
    });
    await showAttention(api, a);
    return a;
  };
  let access: string | undefined;
  syncer = createSyncer({
    store,
    open: place.open,
    sync: place.sync,
    status: (s) => writeStatus(area, s),
    lastFull: async () => (await readStatus(area)).lastFull,
    // A burst of strokes makes at most one write every few seconds.
    debounceMs: 2000,
    minGapMs: 5000,
    // A change in access shows on the action at once, so nothing fails silently.
    onAccess: (a) => {
      if (a === access) return;
      access = a;
      void attention().catch(() => {});
    },
  });
  let checked = 0;
  listen({
    api,
    syncer,
    attention,
    place: place.handle,
    nudge: (act) => noteNudge(area, act),
    // A page with ink loaded: pull what other devices wrote for it, and see whether the
    // backup prompt is due. The prompt counts pages, so it is checked once a minute at most.
    onPage: (url) => {
      void syncer.fresh(pageIdentity(url).key).catch(() => {});
      if (Date.now() - checked < 60_000) return;
      checked = Date.now();
      void attention().catch(() => {});
    },
  });
  // Pushes need a change listener. Firefox without a cloud has nowhere to push, but a cloud
  // may be connected later, so the listener stays and the syncer finds no place.
  api.storage.onChanged.addListener((changes, a) => {
    if (a === 'local') syncer.changed(changes);
  });
  const start = () => {
    void syncer.full().catch(() => {});
    void attention().catch(() => {});
  };
  api.runtime.onStartup.addListener(start);
  api.runtime.onInstalled.addListener((d) => {
    // First run: show the short guide once.
    if (d.reason === 'install') void api.tabs.create({ url: api.runtime.getURL('/options.html#welcome') });
    start();
  });
});
