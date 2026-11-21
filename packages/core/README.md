# pageink-core

Handwriting on any web page, as a library. A reader writes with a pen, or with a finger or mouse once
the draw toggle is on. The ink is saved with an anchor in the page's text, so it comes back on the same
words after a reload, a reflow or an edit to the page. It has no framework, no server and makes no
network requests. The browser extension and the embed script are both built on it.

Not on npm yet. In this repository, depend on it as `"pageink-core": "workspace:*"`.

## Show and write ink

`createViewer` reads the page's record from a key-value store and paints it. The drawing tools load on
the first pen touch or when you ask for them.

```js
import { memoryKV } from 'pageink-core/store';
import { createViewer } from 'pageink-core/view';

const viewer = await createViewer({ kv: memoryKV() });
await viewer.ready;

const cmd = await viewer.tools(); // load the bar and the pen now
cmd.setDraw(true); // mouse and touch draw too
```

`memoryKV()` forgets everything on reload. It is for tests and demos.

## Keep ink with your own store

Any object with these four methods works. Values are plain JSON.

```ts
import type { KV } from 'pageink-core/types';
import { createViewer } from 'pageink-core/view';

const kv: KV = {
  async get(keys) {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = localStorage.getItem(`notes/${k}`);
      if (v !== null) out[k] = JSON.parse(v);
    }
    return out;
  },
  async set(items) {
    for (const [k, v] of Object.entries(items)) localStorage.setItem(`notes/${k}`, JSON.stringify(v));
  },
  async remove(keys) {
    for (const k of keys) localStorage.removeItem(`notes/${k}`);
  },
  async keys(prefix) {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(`notes/${prefix}`))
      .map((k) => k.slice('notes/'.length));
  },
};

const viewer = await createViewer({ kv });
```

Add `onChange(cb)` to the store when other tabs or devices can change it, so the page follows them.
Saves are read, merge, write, so two tabs never overwrite each other.

## Modules

Import only what you use. The package has no side effects, so bundlers drop the rest.

| Import                 | What it holds                                                          |
| ---------------------- | ---------------------------------------------------------------------- |
| `pageink-core/view`    | `createViewer`: loads a record and paints it. Small, for every page.   |
| `pageink-core/tools`   | `attachTools`: pen, highlighter, eraser, lasso, bar. Loaded lazily.    |
| `pageink-core/types`   | Every type: records, notes, the `KV` interface, options.               |
| `pageink-core/hash`    | Storage keys for pages and sites.                                      |
| `pageink-core/brand`   | The product name and the layer element's tag.                          |
| `pageink-core/store`   | `createStore`, `merge`, `applyPatch`, folder sync, archives, Markdown. |
| `pageink-core/anchor`  | Describe and find anchors, page identity.                              |
| `pageink-core/place`   | Placement of notes on the page.                                        |
| `pageink-core/render`  | The ink layer and PNG export.                                          |
| `pageink-core/strokes` | Pen outlines, point encoding, hit tests.                               |
| `pageink-core/capture` | Pointer and touch input.                                               |
| `pageink-core/notes`   | Grouping, lasso, undo history, move, split and join.                   |
| `pageink-core/ui`      | The floating bar and the moved notes tray.                             |
| `pageink-core`         | The types and the hash helpers together.                               |

`merge` runs anywhere, including Node:

```js
import { merge } from 'pageink-core/store';

const both = merge(recordFromThisDevice, recordFromTheFolder);
```

## Format

Records, storage keys and the folder layout are described in
[docs/FORMAT.md](https://github.com/Parag0506/pageink/blob/main/docs/FORMAT.md). The same files are read by
the extension, the embed script and the apps.

## Licence

MIT. See `LICENSE` in the repository and `NOTICE` for the packages it includes.
