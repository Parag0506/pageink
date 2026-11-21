# Moving from the earlier pencil layer

This guide is only for sites that used the pre-release pencil layer. A new site does not need it.

The earlier pencil layer kept ink per section, as integer triples (x, y, pressure times ten) in a
720 unit wide column, measured from the section's top-left corner. It drew one SVG overlay per
section and scaled it with the section width. This guide swaps it for `pageink.js` and brings the old
ink across, so every old stroke stays exactly where it was, at every width.

## 1. Remove the old layer

- Delete the pencil layer code: the stroke outline and highlighter path builders, the per-section
  overlays and their ResizeObserver, the pointer and touch handlers, and its undo and clear.
- Delete its pen button, tool tray and toast. The new script brings its own bar, tray and undo.
- Delete the CSS for the overlays (`svg` layers inside sections) and the tool tray.
- Keep the old stored data until step 5 is done.

## 2. Add the script

```html
<script src="/pageink.js" data-ink data-store="indexeddb" data-legacy="main section[id]"></script>
```

- `data-legacy` names the sections that may hold old ink. Each gets an empty `<ink-surface>` child
  that covers it and takes no pointer events. Migrated notes are anchored to it. Sections are made
  `position: relative` if they were static. New ink still anchors to the text under it.
- If your addresses are not stable (the same lesson under several addresses, or one address for many
  lessons), add `data-page="<lesson id>"`, or mount from code with `page`.
- Mark areas that must never take ink, such as code editors or interactive widgets, with
  `data-ink-off`. Mark fixed drawings with `data-ink-media`.
- A section without an id needs `data-ink-legacy-key="<the key its old ink used>"`.

## 3. Optional: keep ink in your own database

If readers sign in and their old ink lived on your server, give the script a store over your API.
A store is five small functions over string keys and JSON values. This is your site's code, so it
can call your own server.

```js
// One row per (reader, key). The API is yours; this shape is only an example.
function serverKV(base) {
  const listeners = new Set();
  const tell = (changed) => queueMicrotask(() => listeners.forEach((cb) => cb(changed)));
  const call = (path, body) =>
    fetch(base + path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => {
      if (!r.ok) throw new Error(`ink store: ${r.status}`);
      return r.json();
    });

  return {
    // { keys: ["p:abc", "cfg"] } -> { "p:abc": {...} }   (leave out missing keys)
    get: (keys) => call('/ink/get', { keys }),
    // { items: { "p:abc": {...} } } -> {}
    set: (items) => call('/ink/set', { items }).then(() => tell(items)),
    // { keys: [...] } -> {}
    remove: (keys) =>
      call('/ink/remove', { keys }).then(() => tell(Object.fromEntries(keys.map((k) => [k, undefined])))),
    // { prefix: "p:" } -> ["p:abc", "p:def"]
    keys: (prefix) => call('/ink/keys', { prefix }),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const ink = PageInk.mount({ store: serverKV('/api'), legacy: 'main section[id]' });
```

Notes:

- Writes are read, merge, write. Two tabs never lose each other's strokes, even without `onChange`.
- `onChange` only needs to report this tab's own writes. Other tabs catch up on their next save.
- Records are a few kilobytes per page. Store the JSON as is.
- Drop the `data-ink` attribute from the tag when you mount from code.

## 4. Run the migration once per section

Old ink was stored as one object per page, mapping section keys to stroke lists:
`{ "<section key>": [{ k: "pen" | "hi", c: 0 | 1, w, p: [x, y, p10, ...] }, ...] }`.

```js
async function migrateOldInk(ink, oldData) {
  await ink.ready;
  const notes = [];
  for (const [key, strokes] of Object.entries(oldData)) {
    const section = document.getElementById(key) ?? document.querySelector(`[data-ink-legacy-key="${key}"]`);
    if (!section || !strokes.length) continue;
    notes.push(...PageInk.migrateLegacy(section, strokes, { key }));
  }
  await ink.addNotes(notes);
  return notes.length;
}
```

- Each stroke becomes part of a note. Strokes that touch or sit within 40 column units of each other
  share a note, so they move together with the lasso.
- Pen colour 0 becomes `ink-1`, colour 1 becomes `ink-2`, the highlighter becomes `hi-1`. Colours
  follow the light or dark theme as before.
- Note ids come from the old data. Running the migration again adds nothing, and a note the reader has
  since erased stays erased. You can run it on every page load until you are sure, then remove it.
- Mark each page as migrated in your own data (for example a `migrated: true` flag next to the old
  ink), and delete the old data once you have checked the result.

### Why the notes are anchored to the section surface

The old layer drew a point at the section's left edge plus x times width over 720, and the same for y.
Migrated notes are `media` notes on the section's `<ink-surface>`, with a frame width of 720. Media
notes are placed at the element's corner and scaled by its current width over the frame width, which
is the same formula. So old ink lands exactly where the old layer drew it, at every width, including
ink in the side margins. Anchoring each stroke to the nearest paragraph instead would follow text
reflow, but it would move ink that the reader had placed by eye against the old layout.

## 5. Check the result

1. Open a lesson with old ink at your usual column width. Every stroke should be where it was.
2. Narrow the window until the column shrinks, then widen it again. The ink scales with the column,
   as before.
3. Write a new note with a pen, reload, and check that it is still there.
4. `await PageInk.auto.export.markdown()` in the console lists the page's notes. Migrated notes show the
   section's heading as their quote.
5. `PageInk.auto.state().tray` should be 0. A non-zero count means a section's surface was not found,
   usually because the section has no id and no `data-ink-legacy-key`.
6. Check a page with no old ink: nothing should change on it.

Once every page is checked, delete the old stored data and the migration call.

## Pages that use the global `Ink`

The script's global is now `PageInk`, and the file is `pageink.js`. The old global `Ink` still
works and points at the same object, but it is deprecated and logs a note on first use. Replace
`Ink.` with `PageInk.` in your page code and load `pageink.js` in place of `ink.js`.
