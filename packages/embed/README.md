# pageink-embed

Handwriting on your own pages, as one script. Readers write with a pen, or with a finger or mouse once
the draw toggle is on. Their ink loads with the page and stays in place when the text reflows or changes.
It uses the same record format and the same folder backup as the PageInk browser extension
(see `docs/FORMAT.md`). It makes no network requests.

## Add it to a page

```html
<script src="pageink.js" data-ink></script>
```

That is all. The ink is kept in IndexedDB on the reader's device, keyed by the page address.
The script sets the global `PageInk`. The handle made from the tag is `PageInk.auto`.
For sites that used the pre-release pencil layer, the global `Ink` still works and points at the
same object, but it is deprecated: the first use logs a note in the console. A page that already has its own `window.Ink` keeps it.

Tag attributes, each optional:

| Attribute               | Meaning                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `data-store`            | `indexeddb` (default) or `local` (localStorage)                  |
| `data-page`             | Fixed identity for this page's ink                               |
| `data-pen-needs-toggle` | The pen needs the draw toggle too, like touch and mouse          |
| `data-theme`            | `auto` (default), `light` or `dark`                              |
| `data-modifier`         | `Alt` (default), `Control`, `Meta` or `none`                     |
| `data-bar-hide-ms`      | The tool bar hides after this long. Default 4000                 |
| `data-tools`            | `eager` (default) or `lazy`                                      |
| `data-handle`           | `false` hides the small draw handle that lazy tools show         |
| `data-legacy`           | Selector for sections with ink from the pre-release pencil layer |

The older `data-pen-only="false"` still works and means the same as `data-pen-needs-toggle`.

## Mount from code

```js
import { mount } from 'pageink-embed'; // or the global PageInk.mount

const ink = mount({ store: 'indexeddb', page: 'lesson-12' });
await ink.ready;
```

Options:

- `store`: `'indexeddb'` (default), `'local'`, or any object that implements `KV` (below).
- `page`: a fixed key. Use it when your addresses are not stable, for example when the same lesson
  is served at several addresses or behind a query string. Each key has its own record. Default: the
  page address, with tracking parameters and the fragment dropped.
- `penNeedsToggle`: `false` (default) means a pen writes with no toggle, and touch and mouse write
  only while the draw toggle is on. `true` means the pen needs the toggle too. The older
  `penOnly: false` still works and means `penNeedsToggle: true`.
- `theme`, `modifier`, `barHideMs`: as the tag attributes. They apply without being saved, so removing
  an option undoes it.
- `tools`: `'eager'` (default) shows the tool bar at once. `'lazy'` loads the tools on the first pen
  hover or touch, or on the first call that needs them. Use it for pages that mostly show ink.
- `handle`: with lazy tools, a small draw handle shows on the edge of the screen once the page is
  idle, so touch and mouse readers can find drawing. The tools load when it is used. `false` hides it,
  for sites that give readers their own button that calls `ink.draw(true)`.
- `legacy`: see `MIGRATING.md`.

One mount at a time. Call `destroy()` before mounting again.

## The handle

```ts
ink.ready                      // Promise: ink is on screen (and the bar, with eager tools)
ink.draw(on?)                  // draw toggle, default on
ink.tool('pen' | 'hi' | 'eraser' | 'lasso')
ink.undo(); ink.redo()
ink.state()                    // { draw, tool, color, notes, tray, canUndo, canRedo, ... }
ink.on('state', (s) => {})     // tool state changed; returns an unsubscribe
ink.on('change', () => {})     // this page's stored ink changed, here or in another tab
ink.export.markdown()          // Promise<string>: this page's notes
ink.export.png(area?)          // Promise<Blob>: the ink in view, or in a document rect
ink.export.archive()           // Promise<Uint8Array>: zip of every page in the store
ink.importArchive(bytes)       // merge a zip from export.archive() or the extension
ink.sync(folderIO)             // two-way sync with a folder
ink.addNotes(notes)            // add notes, for example from migrateLegacy
ink.destroy()                  // save, then remove ink and tools from the page
```

All commands return promises. Merges are per stroke, so importing or syncing twice is harmless.

## Your own store

Sites that keep reader data in their own database pass a `KV`:

```ts
interface KV {
  get(keys: string[]): Promise<Record<string, unknown>>; // missing keys are left out
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  keys(prefix: string): Promise<string[]>; // every key starting with prefix
  onChange?(cb: (changed: Record<string, unknown | undefined>) => void): () => void;
}
```

Values are plain JSON. Keys are `p:<hash>` (one page record), `idx:<hash>` (the pages with ink on a
host) and `cfg` (settings). `onChange` is optional. When present, it should report changes made by any
tab, including this one, with `undefined` for a removed key. `MIGRATING.md` has a worked example over
a server API.

Built-in stores, also exported: `PageInk.indexedDbKV({ name })` (tells other tabs through a
BroadcastChannel) and `PageInk.localKV({ prefix })` (tells other tabs through the storage event).

## Back up to a folder

Where the File System Access API exists, readers can keep their ink in a folder they choose, for
example one that their cloud drive syncs. The folder has the same layout the extension uses, so both
can share it.

```js
button.onclick = async () => {
  const dir = await showDirectoryPicker({ mode: 'readwrite' });
  const report = await PageInk.auto.sync(PageInk.fsFolder(dir));
};
```

`fsFolder` takes any `FileSystemDirectoryHandle`, including the origin private file system
(`navigator.storage.getDirectory()`). Browsers without a folder picker can use
`export.archive()` and `importArchive()`.

## Marking parts of the page

- `data-ink-media` marks a fixed drawing surface: a diagram, a canvas, a slide, a scanned page. Ink
  written on it is stored as a fraction of the element, and scales with its width. Images, figures,
  tables, video and canvas are treated this way already. Give the attribute a stable value, such as a
  file name, so the surface is found again if the page around it changes:
  `<div data-ink-media="diagram-3">`.
- `data-ink-off` marks an element, and everything inside it, where gestures never become ink: a code
  editor, a map, a game, a signature pad. A pen that touches down there reaches your page as usual. A
  stroke that starts outside may still cross it. It also works inside shadow roots, on the element or
  on any host around it.

## Builds

`corepack pnpm --filter pageink-embed build` writes:

| File               | What                                                           |
| ------------------ | -------------------------------------------------------------- |
| `dist/pageink.js`  | One self-contained script, global `PageInk`, auto mount        |
| `dist/pageink.mjs` | ES module entry; tools and backup code load from `dist/chunks` |
| `dist/types/`      | Type declarations for the module build                         |

Sizes, minified (gzip): `pageink.js` 221 KB (84 KB). Module build: the entry and the chunks it loads at
once, about 133 KB (51 KB); tools chunk 67 KB (25 KB), loaded at mount with eager tools or on demand with
lazy tools; backup chunk 19 KB (9 KB), loaded on the first export, import or sync. Run
`corepack pnpm --filter pageink-embed sizes` for current numbers.

## Example and tests

- `corepack pnpm --filter pageink-embed example` serves `example/` at `http://127.0.0.1:5190/example/`.
- `corepack pnpm --filter pageink-embed shots [dir]` takes screenshots of it.
- `corepack pnpm --filter pageink-embed test` builds, then runs the tests in Node, Chromium, WebKit and Firefox.
