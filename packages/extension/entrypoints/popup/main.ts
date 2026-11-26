import { createStore } from 'pageink-core/store';
import { localKV } from '../../src/adapters/kv';
import { pickApi } from '../../src/api';
import type { Attention } from '../../src/background/attention';
import { folderKind } from '../../src/background/folder';
import { NAME } from '../../src/brand';
import { hostOf, readCfg, setSite } from '../../src/cfg';
import type { StateReply, ToBackground, ToContent } from '../../src/messages';
import { showAccess } from '../../src/ui/access';
import { showAttention } from '../../src/ui/attention';
import { showRate } from '../../src/ui/rate';

const api = pickApi();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const draw = $<HTMLButtonElement>('draw');
const site = $<HTMLInputElement>('site');
const count = $('count');
const note = $('note');

async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
  // Tests open the popup as a page and name the tab.
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  if (forced) return api.tabs.get(forced);
  return (await api.tabs.query({ active: true, currentWindow: true }))[0];
}

const ask = (tabId: number) =>
  (
    api.tabs.sendMessage(tabId, { ink: 'state' } satisfies ToContent, { frameId: 0 }) as Promise<StateReply>
  ).catch(() => undefined);

function show(s: StateReply | undefined) {
  draw.disabled = !s || s.off;
  draw.setAttribute('aria-pressed', String(!!s?.draw));
  draw.textContent = s?.draw ? 'Drawing on' : 'Draw on this page';
  const n = s?.notes ?? 0;
  count.textContent =
    n === 0 ? 'No notes on this page' : n === 1 ? '1 note on this page' : `${n} notes on this page`;
}

const openOptions = (tab: string) => async (e: Event) => {
  e.preventDefault();
  await api.tabs.create({ url: api.runtime.getURL(`/options.html#${tab}`) });
  window.close();
};
$('library').addEventListener('click', openOptions('library'));
$('settings').addEventListener('click', openOptions('settings'));

// Opening the popup is a moment to sync both ways, and to say what needs the reader.
void api.runtime.sendMessage({ ink: 'sync' } satisfies ToBackground).catch(() => {});
const attention = (api.runtime.sendMessage({ ink: 'attention' } satisfies ToBackground) as Promise<Attention>)
  .catch(() => undefined)
  .then((a) =>
    showAttention(
      {
        root: $('attention'),
        text: $('attention-text'),
        go: $<HTMLButtonElement>('attention-go'),
        later: $<HTMLButtonElement>('attention-later'),
      },
      a,
      {
        api,
        kind: folderKind(__INK_TARGET__),
        openOptions: (tab) => void openOptions(tab)(new Event('click')),
      },
    ),
  );

// The rating line asks only when nothing else is asked, so it waits for the line above.
void attention.then(() =>
  showRate(
    {
      line: $('rate'),
      text: $('rate-text'),
      go: $<HTMLButtonElement>('rate-go'),
      no: $<HTMLButtonElement>('rate-no'),
      link: $<HTMLButtonElement>('rate-link'),
      foot: $('about'),
    },
    {
      area: api.storage.local,
      url: __INK_RATE_URL__,
      pages: () => createStore(localKV(api)).list(),
      open: (url) => api.tabs.create({ url }),
      close: () => window.close(),
      busy: () => !$('attention').hidden,
    },
  ),
);

async function main() {
  const tab = await currentTab();
  const host = hostOf(tab?.url);
  $('host').textContent = host || NAME;
  // Without access to websites the pen does not write, and nothing else would say why.
  void showAccess(
    { root: $('access'), button: $<HTMLButtonElement>('access-go') },
    api,
    tab?.url,
    __INK_TARGET__,
  );
  const cfg = await readCfg(api.storage.local);
  site.checked = !!host && !cfg.off?.includes(host);
  site.disabled = !host;
  if (!tab?.id) return show(undefined);
  const tabId = tab.id;
  show(await ask(tabId));

  draw.addEventListener('click', async () => {
    const on = draw.getAttribute('aria-pressed') !== 'true';
    await api.runtime.sendMessage({ ink: 'draw', tabId, on } satisfies ToBackground);
    show(await ask(tabId));
  });
  site.addEventListener('change', async () => {
    const on = site.checked;
    await setSite(api.storage.local, host, on);
    // Every frame of the page hears it, so the ink leaves or returns now.
    await api.tabs.sendMessage(tabId, { ink: 'site', on } satisfies ToContent).catch(() => {});
    note.hidden = false;
    note.textContent = on
      ? `${NAME} is on for this site.`
      : `${NAME} is off for this site. Your notes are kept.`;
    show(await ask(tabId));
  });
}

void main();
