/**
 * Settings tab: where a copy of the notes is kept (connect.ts), input and look, and the
 * sites where ink is off.
 */
import type { InkConfig, Store } from 'pageink-core/types';
import type { Api } from '../api';
import type { FolderKind } from '../background/folder';
import { NAME } from '../brand';
import { resetCfg, withSite } from '../cfg';
import { type CfgWithPdf, pdfOn } from '../pdf/cfg';
import { mountConnect } from './connect';
import { h, say } from './dom';
import { exportAllArchive, importButton } from './library';

export interface SettingsDeps {
  api: Api;
  store: Store;
  kind: FolderKind;
  /** Called after an import so the library can refresh. */
  changed?: () => void;
  /** Called after an archive export. */
  exported?: () => void;
  /** Called after a folder is connected or reconnected. */
  connected?: () => void;
}

const field = (label: string, id: string, input: HTMLElement, help?: string) =>
  h(
    'div',
    { class: 'field' },
    h('label', { for: id }, label),
    input,
    help ? h('p', { class: 'help muted', id: `${id}-help` }, help) : null,
  );

export function mountSettings(root: HTMLElement, d: SettingsDeps): () => Promise<void> {
  const { api, store } = d;

  const placeBox = h('div', { id: 'place-box' });
  const refreshPlace = mountConnect(placeBox, {
    api,
    kind: d.kind,
    store,
    connected: d.connected,
    platform: async () => (await api.runtime.getPlatformInfo?.())?.os ?? '',
    archive: () =>
      h(
        'div',
        { class: 'bar' },
        h(
          'button',
          {
            type: 'button',
            id: 'export-archive-settings',
            onclick: () => exportAllArchive(store, d.exported),
          },
          'Export archive',
        ),
        importButton(store, () => d.changed?.()),
      ),
  });

  function inputs(cfg: InkConfig): HTMLElement[] {
    const set = (patch: Partial<InkConfig>) => store.setConfig(patch).then(() => say('Saved'));
    const num = (
      id: string,
      value: number,
      min: number,
      max: number,
      step: number,
      fn: (n: number) => void,
    ) =>
      h('input', {
        type: 'number',
        id,
        value: String(value),
        min,
        max,
        step,
        onchange: (e) => {
          const n = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(n) && n >= min && n <= max) fn(n);
        },
      });
    const check = (label: string, id: string, on: boolean, help: string, fn: (on: boolean) => void) =>
      field(
        label,
        id,
        h('input', {
          type: 'checkbox',
          id,
          checked: on,
          'aria-describedby': `${id}-help`,
          onchange: (e) => fn((e.target as HTMLInputElement).checked),
        }),
        help,
      );
    const select = (id: string, value: string, options: [string, string][], fn: (v: string) => void) => {
      const s = h(
        'select',
        { id, onchange: () => fn(s.value) },
        ...options.map(([v, l]) => h('option', { value: v }, l)),
      );
      s.value = value;
      return s;
    };
    return [
      field(
        'Draw with the mouse while holding',
        'modifier',
        select(
          'modifier',
          cfg.modifier,
          [
            ['Alt', 'Alt (Option)'],
            ['Control', 'Control'],
            ['Meta', 'Command or Windows key'],
            ['none', 'Nothing'],
          ],
          (v) => set({ modifier: v as InkConfig['modifier'] }),
        ),
      ),
      field(
        'Hide the bar after (seconds)',
        'bar-hide',
        num('bar-hide', cfg.barHideMs / 1000, 1, 60, 1, (n) => set({ barHideMs: n * 1000 })),
      ),
      field(
        'Pen width',
        'pen-w',
        num('pen-w', cfg.penW, 0.5, 12, 0.5, (n) => set({ penW: n })),
      ),
      field(
        'Highlighter width',
        'hi-w',
        num('hi-w', cfg.hiW, 4, 40, 1, (n) => set({ hiW: n })),
      ),
      field(
        'Open PDFs with ink',
        'pdf-open',
        h('input', {
          type: 'checkbox',
          id: 'pdf-open',
          checked: pdfOn(cfg as CfgWithPdf),
          onchange: (e) => set({ pdf: (e.target as HTMLInputElement).checked } as Partial<InkConfig>),
        }),
      ),
      field(
        'Theme',
        'theme',
        select(
          'theme',
          cfg.theme,
          [
            ['auto', 'Match the page'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ],
          (v) => set({ theme: v as InkConfig['theme'] }),
        ),
      ),
      check(
        'Keep Draw on for a site',
        'remember-draw',
        cfg.rememberDraw !== false,
        'When you leave Draw on, it is on again the next time you open that site.',
        (on) => set({ rememberDraw: on }),
      ),
      check(
        'Pen writes only in Draw mode',
        'pen-needs-toggle',
        cfg.penNeedsToggle === true,
        'Off: a pen writes at any time. On: a pen writes only while Draw is on, like a mouse.',
        (on) => set({ penNeedsToggle: on }),
      ),
      check(
        'Save a small picture with notes on blank areas',
        'thumbs',
        cfg.thumbs !== false,
        'It helps you find such a note if the page changes. It is kept with your notes.',
        (on) => set({ thumbs: on }),
      ),
      check(
        'Keep ink written in private windows',
        'private-keep',
        cfg.privateKeep === true,
        'Off: ink written in a private window is gone when the window closes.',
        (on) => set({ privateKeep: on }),
      ),
      field(
        'Sites where Draw stays on',
        'draw-on',
        h(
          'span',
          { class: 'bar' },
          h('span', { id: 'draw-on', class: 'muted' }, cfg.drawOn?.length ? cfg.drawOn.join(', ') : 'None'),
          cfg.drawOn?.length
            ? h(
                'button',
                { type: 'button', id: 'draw-on-clear', onclick: () => set({ drawOn: [] }).then(refresh) },
                'Forget',
              )
            : null,
        ),
        'Sites where you left Draw on. Forget them to start with Draw off everywhere.',
      ),
    ];
  }

  function sites(cfg: InkConfig): HTMLElement {
    const add = h('input', { type: 'text', id: 'site-add', placeholder: 'example.com' });
    const save = async (off: string[]) => {
      await store.setConfig({ off });
      await refresh();
    };
    const list = h(
      'ul',
      { class: 'sites', id: 'sites' },
      ...cfg.off.map((s) =>
        h(
          'li',
          {},
          s,
          h(
            'button',
            {
              type: 'button',
              'aria-label': `Switch ink on for ${s}`,
              onclick: () => save(withSite(cfg.off, s, true)),
            },
            'Remove',
          ),
        ),
      ),
    );
    if (!cfg.off.length) list.append(h('li', { class: 'muted' }, `${NAME} is on everywhere.`));
    const form = h(
      'form',
      {
        class: 'bar',
        onsubmit: (e) => {
          e.preventDefault();
          const v =
            add.value
              .trim()
              .toLowerCase()
              .replace(/^https?:\/\//, '')
              .split('/')[0] ?? '';
          if (v) void save(withSite(cfg.off, v, false));
        },
      },
      add,
      h('button', { type: 'submit', id: 'site-add-button' }, 'Switch off'),
    );
    return h('div', {}, list, form);
  }

  async function refresh() {
    const cfg = await store.config();
    await refreshPlace();
    root.replaceChildren(
      h('h2', {}, 'Keep a copy of your notes'),
      placeBox,
      h('h2', {}, 'Writing'),
      ...inputs(cfg),
      h('h2', {}, 'Sites where ink is off'),
      sites(cfg),
      h('h2', {}, 'Reset'),
      reset(),
    );
  }

  /** Back to the default settings, after a second click. Notes are never touched. */
  function reset(): HTMLElement {
    const box = h('div', { class: 'bar', id: 'reset' });
    const ask = h(
      'button',
      {
        type: 'button',
        id: 'reset-settings',
        onclick: () => {
          box.replaceChildren(
            h('span', {}, 'Every setting goes back to its default. Your notes stay.'),
            h(
              'button',
              {
                type: 'button',
                id: 'reset-confirm',
                class: 'danger',
                onclick: async () => {
                  await resetCfg(api.storage.local);
                  say('Settings reset');
                  await refresh();
                },
              },
              'Reset',
            ),
            h(
              'button',
              { type: 'button', id: 'reset-cancel', onclick: () => box.replaceChildren(ask) },
              'Cancel',
            ),
          );
        },
      },
      'Reset settings to defaults',
    );
    box.append(ask);
    return box;
  }
  return refresh;
}
