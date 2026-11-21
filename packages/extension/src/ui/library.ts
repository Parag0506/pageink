/**
 * Library tab: every page with notes, search, open, delete, move to a new address,
 * Markdown export, archive export and import.
 */
import { pageIdentity } from 'pageink-core/anchor';
import { erasePage, exportArchive, importArchive, moveNotes, toMarkdown } from 'pageink-core/store';
import type { PageIdentity, PageRecord, PageSummary, Store, SyncReport } from 'pageink-core/types';
import { SLUG } from '../brand';
import { isLocalKey } from '../pdf/identity';
import { h, saveFile, say, when } from './dom';

/** Where a row opens. A PDF file opened from disk has no address: the viewer page asks for the file again. */
export const openHref = (s: PageSummary): string => (isLocalKey(s.url) ? '/pdf.html' : s.url);

export function matches(s: PageSummary, q: string): boolean {
  const n = q.trim().toLowerCase();
  return !n || s.title.toLowerCase().includes(n) || s.url.toLowerCase().includes(n);
}

export const reportText = (r: SyncReport): string =>
  `Imported ${r.pulled} new, merged ${r.merged}${r.errors.length ? `, ${r.errors.length} failed` : ''}`;

const stamp = () => new Date().toISOString().slice(0, 10);

/** Name of a file the reader saves, such as "pageink-notes-2026-11-17.zip". */
export const exportName = (ext: 'zip' | 'md'): string => `${SLUG}-notes-${stamp()}.${ext}`;

export async function exportAllArchive(store: Store, done?: () => void): Promise<void> {
  const bytes = await exportArchive(store);
  saveFile(exportName('zip'), new Blob([bytes as BlobPart], { type: 'application/zip' }));
  done?.();
}

/** Host of a page's address, or '' for keys that are not web addresses. */
export function hostOfPage(s: Pick<PageSummary, 'url'>): string {
  try {
    const u = new URL(s.url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : '';
  } catch {
    return '';
  }
}

/** Pages a page's notes can move to: other pages on the same host. */
export const moveTargets = (s: PageSummary, all: PageSummary[]): PageSummary[] =>
  all.filter((p) => p.key !== s.key && hostOfPage(p) !== '' && hostOfPage(p) === hostOfPage(s));

/** Identity for a pasted address. Null unless it is a web address. */
export function targetOf(address: string): PageIdentity | null {
  const a = address.trim();
  if (!/^https?:\/\//i.test(a)) return null;
  try {
    new URL(a);
  } catch {
    return null;
  }
  return pageIdentity(a);
}

export async function importFile(store: Store, file: File): Promise<SyncReport> {
  return importArchive(store, new Uint8Array(await file.arrayBuffer()));
}

/** Hidden file input behind a button. */
export function importButton(store: Store, done: () => void): HTMLElement {
  const input = h('input', {
    type: 'file',
    accept: '.zip,application/zip',
    id: 'import-file',
    class: 'visually-hidden',
    onchange: async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        say(reportText(await importFile(store, f)));
      } catch (e) {
        say(`Import failed: ${String(e)}`);
      }
      input.value = '';
      done();
    },
  });
  return h(
    'span',
    {},
    input,
    h('button', { type: 'button', id: 'import', onclick: () => input.click() }, 'Import archive'),
  );
}

export function mountLibrary(
  root: HTMLElement,
  store: Store,
  confirmFn: (q: string) => boolean = confirm,
  onExport?: () => void,
): () => Promise<void> {
  let pages: PageSummary[] = [];
  let moving: string | null = null;
  const selected = new Set<string>();
  const search = h('input', {
    type: 'search',
    id: 'search',
    placeholder: 'Search by title or address',
    oninput: () => draw(),
  });
  const body = h('tbody');
  const empty = h('p', { class: 'muted', id: 'empty' });

  const exportMd = async () => {
    const keys = selected.size ? [...selected] : pages.map((p) => p.key);
    const recs = (await Promise.all(keys.map((k) => store.get(k)))).filter((r): r is PageRecord => !!r);
    saveFile(exportName('md'), new Blob([toMarkdown(recs)], { type: 'text/markdown' }));
  };

  const table = h(
    'table',
    { id: 'pages', hidden: true },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', {}, ''),
        h('th', {}, 'Page'),
        h('th', {}, 'Notes'),
        h('th', {}, 'Changed'),
        h('th', {}, ''),
      ),
    ),
    body,
  );

  const mdButton = h('button', { type: 'button', id: 'export-md', onclick: exportMd }, 'Export Markdown');
  root.replaceChildren(
    h('div', { class: 'bar' }, search),
    h(
      'div',
      { class: 'bar' },
      mdButton,
      h(
        'button',
        { type: 'button', id: 'export-archive', onclick: () => exportAllArchive(store, onExport) },
        'Export archive',
      ),
      importButton(store, () => void refresh()),
    ),
    table,
    empty,
  );

  function draw() {
    const shown = pages.filter((p) => matches(p, search.value));
    // An empty table is only a header. The message below says why it is empty.
    table.hidden = shown.length === 0;
    mdButton.textContent = selected.size ? `Export Markdown (${selected.size})` : 'Export Markdown';
    body.replaceChildren(
      ...shown.map((p) =>
        h(
          'tr',
          { 'data-key': p.key },
          h(
            'td',
            {},
            h('input', {
              type: 'checkbox',
              'aria-label': `Select ${p.title || p.url}`,
              checked: selected.has(p.key),
              onchange: (e) => {
                if ((e.target as HTMLInputElement).checked) selected.add(p.key);
                else selected.delete(p.key);
                draw();
              },
            }),
          ),
          h(
            'td',
            {},
            h(
              'a',
              { href: openHref(p), target: '_blank', rel: 'noreferrer', class: 'open' },
              p.title || p.url,
            ),
            h('div', { class: 'url muted' }, isLocalKey(p.url) ? 'PDF file on this device' : p.url),
          ),
          h('td', { class: 'count' }, String(p.notes)),
          h('td', {}, when(p.updatedAt)),
          h(
            'td',
            { class: 'actions' },
            h(
              'button',
              {
                type: 'button',
                class: 'move',
                'aria-expanded': String(moving === p.key),
                onclick: () => {
                  moving = moving === p.key ? null : p.key;
                  draw();
                },
              },
              'Move',
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'danger delete',
                onclick: async () => {
                  if (!confirmFn(`Delete all notes on "${p.title || p.url}"? This cannot be undone.`)) return;
                  // Tombstones, not removal: a sync with the folder or another device cannot bring them back.
                  await erasePage(store, p.key);
                  selected.delete(p.key);
                  say('Deleted');
                  await refresh();
                },
              },
              'Delete',
            ),
          ),
        ),
      ),
    );
    if (moving) {
      const row = body.querySelector<HTMLElement>(`tr[data-key="${CSS.escape(moving)}"]`);
      const p = shown.find((x) => x.key === moving);
      if (row && p) row.after(movePanel(p));
    }
    empty.textContent = pages.length
      ? shown.length
        ? ''
        : 'No pages match.'
      : 'No notes yet. Write on any page with a pen, or switch on Draw from the toolbar button.';
  }

  /**
   * For a page whose address changed: pick the new page from the same site or paste its
   * address. The notes move under new ids and the anchoring finds them on the new page.
   */
  function movePanel(p: PageSummary): HTMLElement {
    const targets = moveTargets(p, pages);
    const pick = h(
      'select',
      { id: 'move-pick', 'aria-label': 'Page on the same site' },
      h(
        'option',
        { value: '' },
        targets.length ? 'Choose a page on this site' : 'No other pages on this site',
      ),
      ...targets.map((t) => h('option', { value: t.url }, t.title || t.url)),
    );
    const paste = h('input', {
      type: 'text',
      id: 'move-address',
      placeholder: 'or paste the new address',
      'aria-label': 'New address',
    });
    const go = h(
      'button',
      {
        type: 'button',
        id: 'move-go',
        class: 'primary',
        onclick: async () => {
          const to = targetOf(paste.value || pick.value);
          if (!to) return say('Choose a page or paste a web address.');
          if (to.key === p.key) return say('That is the same page.');
          const out = await moveNotes(store, p.key, to);
          moving = null;
          say(out ? `Moved ${p.notes === 1 ? '1 note' : `${p.notes} notes`}` : 'Nothing to move');
          await refresh();
        },
      },
      'Move notes',
    );
    const cancel = h(
      'button',
      {
        type: 'button',
        onclick: () => {
          moving = null;
          draw();
        },
      },
      'Cancel',
    );
    return h(
      'tr',
      { class: 'move-row' },
      h(
        'td',
        { colspan: 5 },
        h('p', { class: 'muted' }, 'Move these notes to another page, for a page whose address changed.'),
        h('div', { class: 'bar' }, pick, paste, go, cancel),
      ),
    );
  }

  async function refresh() {
    // A page whose ink was all deleted keeps its tombstones for sync, but is not listed.
    pages = (await store.list()).filter((p) => p.notes > 0).sort((a, b) => b.updatedAt - a.updatedAt);
    if (moving && !pages.some((p) => p.key === moving)) moving = null;
    for (const k of [...selected]) if (!pages.some((p) => p.key === k)) selected.delete(k);
    draw();
  }

  return refresh;
}
