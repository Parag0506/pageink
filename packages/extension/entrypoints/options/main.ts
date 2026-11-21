import { createStore } from 'pageink-core/store';
import { localKV } from '../../src/adapters/kv';
import { pickApi } from '../../src/api';
import { folderKind } from '../../src/background/folder';
import type { ToBackground } from '../../src/messages';
import { mountLibrary } from '../../src/ui/library';
import { mountSettings } from '../../src/ui/settings';
import { mountWelcome } from '../../src/ui/welcome';

const api = pickApi();
const store = createStore(localKV(api));
const library = document.getElementById('library')!;
const settings = document.getElementById('settings')!;
const welcome = document.getElementById('welcome')!;
const kind = folderKind(__INK_TARGET__);
const tell = (m: ToBackground) => api.runtime.sendMessage(m).catch(() => undefined);
// An export is a backup on Firefox, so the backup prompt rests for a month.
const exported = () => void tell({ ink: 'nudge', act: 'export' });
const refreshLibrary = mountLibrary(library, store, confirm, exported);
const refreshSettings = mountSettings(settings, {
  api,
  store,
  kind,
  changed: () => void refreshLibrary(),
  exported,
  // A chosen folder ends the backup prompt for good and clears a lapsed badge.
  connected: () => void tell({ ink: 'nudge', act: 'chosen' }),
});

function showTab() {
  // The guide sits on top of the library, so the first page shows both.
  const guide = location.hash === '#welcome';
  welcome.hidden = !guide;
  if (guide) void mountWelcome(welcome, { api, kind, done: () => (location.hash = '#library') });
  const tab = location.hash === '#settings' ? 'settings' : 'library';
  library.hidden = tab !== 'library';
  settings.hidden = tab !== 'settings';
  for (const t of ['library', 'settings']) {
    document.getElementById(`tab-${t}`)?.setAttribute('aria-selected', String(t === tab));
  }
  void (tab === 'library' ? refreshLibrary() : refreshSettings());
}

addEventListener('hashchange', showTab);
// Pages written in other tabs show up without a reload.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || library.hidden) return;
  if (Object.keys(changes).some((k) => k.startsWith('p:'))) void refreshLibrary();
});
showTab();
// Opening this page is a moment to sync both ways. The page shows what arrived.
void tell({ ink: 'sync' }).then(() => {
  void (library.hidden ? refreshSettings() : refreshLibrary());
});
