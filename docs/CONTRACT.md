# PageInk: architecture and module contract

This file, `DESIGN.md`, `FORMAT.md` and `packages/core/src/types.ts` describe how the code is put
together. When they disagree, `types.ts` wins, then this file.

## 1. Layout

Each folder has one job and a small public surface. A change to one folder should not need a change in
another. A change to the shared files is a change to the contract, so it gets its own review.

| Folder                                                                    | Holds                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/core/src/types.ts`, `hash.ts`, `brand.ts`, `css.ts`, `index.ts` | Shared types, storage key helpers, the product name, style sheet helper  |
| `packages/core/src/strokes/`                                              | Outline, highlighter path, encode and decode, hit test                   |
| `packages/core/src/capture/`                                              | Pointer and touch routing, live canvas                                   |
| `packages/core/src/anchor/`                                               | Describe, resolve (the ladder), text search, text marks, page identity   |
| `packages/core/src/place/`                                                | Placement, scaling, docking, batching, observers                         |
| `packages/core/src/render/`                                               | Layer, shadow root, SVG, theme mapping, badge, SVG and PNG export        |
| `packages/core/src/ui/`                                                   | Floating bar, tray panel, menus                                          |
| `packages/core/src/notes/`                                                | Grouping, lasso, history, move, split, join                              |
| `packages/core/src/store/`                                                | Store over a KV, merge, patches, folder sync, archive, Markdown          |
| `packages/core/src/app/`                                                  | `view.ts` and `tools.ts`: the controller that wires the folders together |
| `packages/extension/`                                                     | Stub, loader, background, popup, options, PDF viewer page, adapters      |
| `packages/extension/src/background/register.ts`                           | Registers the viewer on hosts with ink; injects modules where asked      |
| `packages/extension/src/cloud/`                                           | Google Drive and OneDrive as a FolderIO, built alone as `cloud.js`       |
| `packages/extension/src/content/diag.ts`, `src/background/diag-relay.ts`  | Stroke records for the device check, in diagnostics builds only          |
| `packages/embed/`                                                         | One script build of pageink-core with a pluggable store                  |
| `apple/`                                                                  | Xcode wrapper for Safari on Mac and iPad                                 |
| `testset/`                                                                | Page pairs, note generator, scorer, results                              |
| `bench/`                                                                  | Load cost and latency harness                                            |

Each pageink-core folder has an `index.ts` that exports exactly the names in section 3, typed with the
function types from `types.ts` (`export const describe: Describe = ...`). Extra exports are allowed.
A folder imports only from `../types`, `../hash`, its own files, npm packages already in
`package.json`, and the other folders named for it in section 3.

## 2. Rules

- TypeScript, strict. No `any` in exported signatures. No default exports in pageink-core.
- pageink-core uses no extension APIs (`chrome.*`, `browser.*`). It runs in any page.
- No network calls anywhere in `pageink-core`, `extension` or `embed`: no `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `sendBeacon`, no remote `import()`, no remote fonts or images.
  Two exceptions, both in section 6: the PDF read, and `packages/extension/src/cloud/`, which is
  built on its own as `cloud.js` and talks only to the cloud the reader connected.
- Nothing is bundled into the product that is not MIT, BSD, ISC or Apache 2.0. Check the licence file
  before adding a dependency. Tools that only run during development may use other open source licences.
- Docs, comments and UI text: short plain sentences. No em dashes. Comments say why, not what.
- Tests sit next to the code. Pure logic: `*.test.ts` (node). Anything that needs a DOM or layout:
  `*.browser.test.ts` (real Chromium, WebKit and Firefox through Vitest browser mode). Pen and touch
  input go through `packages/core/src/capture/testkit.ts`, which is real CDP input in Chromium and the
  same events built by hand elsewhere. A test that needs the browser's own scrolling, selection or
  coalescing runs in Chromium only and says why. Extension flows: Playwright in `packages/extension/e2e/`.
- Only input the browser made counts (`isTrusted`). A page script can never write, erase, undo,
  place a note or press the bar. The stub, capture, the bar and the viewer take a `real` test seam;
  tests pass `fromTest` from the capture testkit, which accepts trusted events and the events the
  testkit built, and nothing a test builds the way a page script would. Products never set it.
- Commands, from the repo root. Use `corepack pnpm`, not a global pnpm.
  - `corepack pnpm --filter pageink-core exec vitest run src/<folder>` runs one folder's tests.
  - `corepack pnpm tc <folder> [<folder>]` typechecks and shows only those folders.
  - `corepack pnpm exec biome check --write <path>` formats and lints.
- A folder is tested alone, against fakes that implement the types.
- Every public function has a test. Every mechanism in DESIGN has a test that would fail if the
  mechanism were removed.
- Layout reads and writes are never interleaved in a loop. Read everything, then write everything.
- Nothing runs on scroll for normal pages. No timers that poll. No work on pages without ink beyond
  the stub.

## 3. Module APIs

Types are in `types.ts`. Coordinates called "document space" are CSS pixels from the document's top-left
(`clientX + scrollX`, `clientY + scrollY`). In a frame, it is that frame's document.

### strokes/  (imports: nothing)

```
outline: Outline              makeStroke: MakeStroke        rebaseStroke: RebaseStroke
encodePts: EncodePts          decodePts: DecodePts
strokeBBox: StrokeBBox        hitStroke: HitStroke
```
The pen outline has variable width from pressure. The highlighter is a flat wide band.
The pen outline is our own code. The highlighter band uses `perfect-freehand`.

### capture/  (imports: strokes)

```
createCapture: CreateCapture
```
Input rules are DESIGN 8. Listens on `window` in the capture phase. The layer never takes pointer events.
Draws the live stroke on a small canvas inside `host.mount` from raw samples, with coalesced and
predicted samples where the browser has them. Pen: always ink. Touch: ink only while `host.draw()`,
one finger draws, two fingers scroll and zoom. Mouse: ink while `host.draw()` or while the modifier is
held. A pen tap that does not move is left to the page. A stroke that did move swallows the click that
follows it. Palm touches are ignored while a pen is down.

### anchor/  (imports: nothing)

```
createResolver: CreateResolver    describe: Describe    describeRange: DescribeRange
recognizeTextMark: RecognizeTextMark    pageIdentity: PageIdentityFn
```
`describe` and `resolve` are two halves of one mapping. For the same page state,
`resolve(describe(box).anchor).origin` equals `describe(box).origin`. Origins are in FORMAT "Units".
An element with the attribute `data-ink-media` is always anchored as `media`. This is how the PDF viewer
and host apps mark fixed surfaces. The resolver caches the document text until `invalidate()`.
Resolving 200 notes on a 50,000 word page must fit in one frame budget after the first call.
`quick()` is step 1 of the ladder on a model of the anchor's own block. It builds no document text and
returns undefined when only the full ladder can decide. `prepare(ms)` builds the document text in slices,
`ready()` says when it is built, and `locate()` returns the element a path points at, unchecked.

### render/  (imports: nothing)

```
createLayer: CreateLayer    svgToPng: SvgToPng
```
One host element `<ink-layer>` appended to `<html>`, closed shadow root, `pointer-events: none`,
no box (`display: contents`). The surfaces inside it are positioned from the document and carry the
highest z-index, so the highlighter can blend with the page under it. The host must stay without a box:
with one, WebKit can give it a layer of its own when a pinned or moving part of the page lies under its
corner, paint the highlighter into that layer, and the highlight then covers the words (a test reads
the screen for this, `shown()` in `src/testkit.ts`). `customElements` is not available to content
scripts, so the host is a plain unknown element. The highlighter blends so text stays readable. The
layer prints with the page. Colours are CSS variables switched by theme. `auto` reads the page background.
Styles are constructed style sheets adopted on the shadow root, and dynamic values are set through the
CSSOM, so the layer works on pages and extension pages with a strict `style-src`.

### place/  (imports: render types only; the resolver and layer are passed in)

```
createPlacer: CreatePlacer
```
DESIGN 5 promise 2 and 7.4. Text marks are drawn from `resolved.range.getClientRects()`.
Re-placement triggers are listed in DESIGN 7.4. Notes with no anchor are reported through
`unplaced()` and retried when the page changes.
A pass runs from a resize observation right after the browser's layout, never from a forced layout.
Until the document text is built, notes near the screen use the resolver's `quick()`; the others, and
any note `quick()` cannot decide, wait for the text, built in idle slices. `waiting()` counts them.
Once the text is ready, every quick placement is checked with `resolve()`.
Each note is cut to the box its anchor's clipping ancestors leave (`Resolved.clips`, `NotePose.clip`).
A note whose content is closed, hidden or transparent is hidden with it: it is listed by `hidden()`,
never by `unplaced()`, and returns when the content shows. It counts as hidden only while
`resolver.hidden()` finds its element still holding the quote; otherwise it is unplaced.

### ui/  (imports: nothing)

```
createUi: CreateUi
```
Plain DOM inside `host.mount`. No framework. Works with pen, touch, mouse and keyboard.
Touch targets are at least 44 px on coarse pointers. The bar hides after `barHideMs` and returns on
`wake()`.
The bar is fixed to one edge by style rules alone, so it stays on screen through rotation and
resize. The grip moves it to another edge, and a drag is held inside the screen. The one node
outside `host.mount` is `.iu-room` (`room.ts`), an empty box beside the mount in the same shadow
root. While the bar is shown at the bottom edge it sits below the page's content and lets the
page scroll on by the height the bar covers (DESIGN 8). It is fitted from resize and
intersection observers, never on scroll, and it changes no box or style of the page.

### notes/  (imports: strokes)

```
pickNote: PickNote    lassoSelect: LassoSelect    createHistory: CreateHistory
moveNote: MoveNote    splitNote: SplitNote        joinNotes: JoinNotes
```

### store/  (imports: nothing)

```
createStore: CreateStore    emptyRecord: EmptyRecord    merge: Merge    applyPatch: ApplyPatch
syncFolder: SyncFolder      exportArchive: ExportArchive    importArchive: ImportArchive
LockedError    isLocked(e)    recordText(rec)
toMarkdown: ToMarkdown      memoryKV(): KV    memoryFolder(): FolderIO
acceptRecord(raw, id)       cleanRecord(raw)    cleanConfig(raw)    safeParse(text)
erasePatch(rec, only?)      erasePage(store, key, only?)    moveNotes(store, fromKey, to)
showsInk(note)              laterId(id, t)    rootOf(id)    canon(v)    sameRecord(a, b)
isRecord(v)                 indexTargets(rec)    fileName(key)    DEFAULT_CONFIG    LIMITS    ARCHIVE_LIMITS
```
`memoryKV` and `memoryFolder` are in-memory fakes for tests everywhere.
Merge, slots and the checks on stored data are in FORMAT. The store reads each record slot
through `cleanRecord` and checks that the record belongs to the page (FORMAT "Storage keys").
`acceptRecord` is the one way code outside the store takes a raw record read from storage: it
returns the clean copy when the record belongs to that identity, and null otherwise.
`erasePatch` is the change behind Clear page and the library's Delete: a tombstone for every note
and stroke, with `only` to pick the notes (Clear page in a frame clears that frame's notes).
A folder's `read` throws `LockedError` for a file sealed with a password lock the device does not
hold. `syncFolder` lists such files in `SyncReport.locked`, not in `errors`, and writes nothing for
their pages. `opts.since` leaves out pages that exist only in the store and last changed before
that time (a switch to a new place copies nothing old by itself).
`showsInk` is false for an ink note with no strokes, which the merge rule can leave: such a note is
not placed, counted, listed, exported or moved.
`Store.setConfig(patch)` stores only the fields it is given, so defaults stay out of storage and a
later default still applies. A field set to undefined is removed. `config()` fills in defaults.

### app/  (imports: every folder)

```
view.ts:   createViewer: CreateViewer
tools.ts:  attachTools: AttachTools
```
`view.ts` must not import `capture`, `ui`, `notes`, or the describe half of `anchor` statically.
They arrive with `tools.ts` through a dynamic import. This split is the lazy loading of DESIGN 5.

## 4. Storage and loading

- Keys and the index are in FORMAT "Storage keys".
- The stub is the only code on every page. It reads `idx:<hash of host>` and `cfg` in one
  `storage.local.get`. It adds window listeners in the capture phase for `pointerdown`, `pointermove`,
  `pointerup`, `pointercancel` and `click`. They are added at document start so a page that stops events
  at the window cannot hide the pen from the ink. Pointer listeners cannot delay scrolling, and with no
  ink and no tools each call returns at once. Events a page script made are ignored.
  A host in `cfg.off` gets nothing more. In the browser's own PDF viewer the stub stops and starts the
  PDF chunk. When `penReady` is on and the pen does not need the toggle, the stub also cancels stylus
  touches (`touchType` `stylus`) until the tools load, so a Pencil does not scroll or start Scribble.
  If the host has an index entry, the stub starts the viewer with the record the index maps the page
  address to. If the host is in `cfg.drawOn` (and `rememberDraw` is not off), it starts the viewer,
  which turns draw mode back on. The stub reads settings raw, so a field of the wrong type counts as
  absent. The loader hands the record it read to the viewer only as the clean copy `acceptRecord`
  returns for this page; anything else is left out and read again through the store. The viewer's
  first reads of the settings, the site index and the record are answered from what the stub and the
  boot script read. The viewer waits for no write before it places the first notes: when the settings
  hold no device id yet, the store makes one, uses it at once and stores it after the reads in its
  queue (`readConfig` in `store.ts`). Pointer events seen before the tools load are buffered and handed
  to `viewer.adopt()`.
- How the code gets into the page (`build/content.ts`, `src/background/register.ts`). The viewer
  (`content/loader.js`), the tools (`content/tools.js`) and the PDF chunk (`content/pdf.js`) are plain
  scripts. Each stores its exports on `globalThis.__ink` in the content script world, which pages
  cannot see, and the tools take the viewer's shared modules from there. No content script is web
  accessible; the only web accessible file is `pdf.html`, at a per-session address in Chromium.
  - Hosts with ink: the background keeps one registered content script, `content/boot.js` then
    `content/loader.js`, at `document_start`, top frame only, matching exactly the hosts that have an
    index entry and are not in `cfg.off`. It follows `idx:` changes and `cfg.off`, and registers again
    after an install or update. `boot.js` runs first and on its own (it holds only the page identity
    and the storage keys), so its read is on its way while `loader.js` is compiled. It starts one read
    of every key the viewer's first load needs:
    the site index of each host the page can be on (a Wikipedia article is on its desktop and mobile
    hosts), the record slot this address maps to, and `cfg`. Keys storage does not hold count as
    read and empty. The stub uses that read when the index points at the same slot, and the loader
    hands all of it to the viewer, so the viewer starts after one storage trip.
  - Everywhere else: when the stub needs a module it is missing (a pen touch, the draw toggle, a frame
    woken by its top page, a PDF), it sends `{ ink: 'inject', files }` and the background injects
    those files into that frame and document with `scripting.executeScript`. A pen touch asks for the
    viewer and the tools in one request. The viewer asks for the tools through `globalThis.__ink.need`.
  - Safari does the same (Safari 17 or later; 4.2). Two differences: Safari keeps PDFs in its own
    viewer, so its build has no `content/pdf.js`; and Safari stops its background often, so the stub
    sends a lost inject request once more, and each start of the background registers the viewer
    again if Safari lost the registration. A scripting option a browser refuses
    (`persistAcrossSessions`, `injectImmediately`) is dropped and the call made again without it.
    No build bundles the viewer or the tools into the stub.
- Build modes. Only the release build ships; the others go to their own folders under `.output`.
  - Release (`wxt build`, `wxt zip`): no performance marks, no diagnostics, no test hooks.
  - Bench (`wxt build --mode bench`, `.output/<target>-mv3-bench`): the release code plus performance
    marks (`ink:stub-start`, `ink:stub`, `ink:boot`, `ink:inject`, `ink:view-start`, `ink:first-ink`,
    `ink:placed`, `ink:pen-first-pixel`). The bench, the timing end-to-end tests and the iPad
    simulator tests use it, because they read the marks.
  - Diagnostics (`INK_DIAG_ORIGIN=http://<this Mac>:<port>`, Safari only, `.output/diag`): capture
    reports each gesture through a probe for the device check in `apple/device`, to that one origin
    only. Strokes in the PDF viewer reach the check page through the background. The switch is a
    compile-time constant, so other builds carry none of the code; store zips, `INK_RELEASE=1` and the
    app's Release configuration refuse such a build, and a test checks the shipped builds.
  - Test (`INK_CLOUD_FAKE=1`, `.output/test-<target>-mv3`): talks to local fakes of the clouds, for the
    cloud browser tests. It cannot be zipped.
  - The no-network test scans the release, bench and diagnostics builds with the same allow-list. A
    diagnostics build may also name its one check page origin, as the target of `postMessage`.
- A private window: the viewer keeps ink in memory only, never saved or synced, unless the reader
  chose `privateKeep`. Ink already stored still shows.
- The view chunk computes the page identity, looks up the record through the index, and renders.
- Saves are read, merge, write. A second tab or a frame on the same page never overwrites.
- Frames: the stub in a subframe does no storage read. It wakes when the top frame's record has notes
  for frames (relayed by the background) or when a pen touches down inside the frame.

## 4.1 Settings

`cfg` holds `InkConfig` (`types.ts`). Only fields that differ from the defaults are stored.

| Field            | Default | Meaning                                                            |
| ---------------- | ------- | ------------------------------------------------------------------ |
| `device`         | random  | Id of this install, made on the first read                         |
| `off`            | `[]`    | Hosts where ink is switched off                                    |
| `modifier`       | `Alt`   | Key that makes a mouse draw: `Alt`, `Control`, `Meta` or `none`    |
| `penReady`       | build   | Hold stylus touches back before the tools load. On for iPad Safari |
| `penNeedsToggle` | false   | The pen writes only while draw mode is on                          |
| `rememberDraw`   | true    | Keep draw mode on for a site once the reader switched it on there  |
| `drawOn`         | `[]`    | Hosts where draw mode was left on                                  |
| `barHideMs`      | 4000    | The bar hides after this long without ink input                    |
| `penW`, `hiW`    | 2, 14   | Pen and highlighter widths                                         |
| `theme`          | `auto`  | `auto`, `light` or `dark`                                          |
| `thumbs`         | true    | Save a small picture with notes written on blank areas             |
| `privateKeep`    | false   | Keep ink written in private windows                                |
| `hinted`         | unset   | The one-time hint after the first ink was shown                    |
| `pdf`            | true    | Open PDFs in the bundled viewer (extension only)                   |
| `folder`         | unset   | Name of the connected backup folder (the place itself is `dest`)   |
| `lastSync`       | unset   | Time of the last folder sync                                       |

Every field is checked on read (`cleanConfig`). A field that fails is left out and its default applies.

## 4.2 Platform notes: Safari and the scripting API

What Safari supports, as checked in November 2026. iOS and iPadOS carry the same Safari version
number as the system. MDN's compatibility data lists Safari on iOS as the same as on macOS for
every `scripting` entry.

| What the extension uses                                                                                     | Safari                               | Source   |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------- |
| `scripting.executeScript` with `files`, `target.frameIds`, a service worker background                      | 15.4                                 | [1], [2] |
| `registerContentScripts`, `getRegisteredContentScripts`, `updateContentScripts`, `unregisterContentScripts` | 16.4                                 | [1], [3] |
| `persistAcrossSessions` (on by default; scripts kept in Safari's own store)                                 | 16.4                                 | [1], [4] |
| `world` in registered scripts and in `executeScript`                                                        | 16.4, 15.4                           | [1]      |
| `unregisterContentScripts` really removes the script                                                        | 17.4                                 | [5]      |
| `target.documentIds` and `sender.documentId`                                                                | 18.4                                 | [1], [6] |
| `injectImmediately`                                                                                         | accepted; scripts always run at once | [1], [7] |

- The extension needs nothing newer than Safari 17, the floor the app already has (iOS 17,
  macOS 14). On 17.0 to 17.3 a host whose ink is all deleted may still get the viewer at
  document start, because unregistering did not take effect there [5]; the viewer then finds no
  ink and shows nothing. Before 18.4 the background
  targets the frame by `frameId`, as it does in Firefox.
- The background on iOS must be non-persistent, and Safari unloads it when the reader is not using
  the extension [8]; WebKit's current code waits 30 seconds. Registered scripts are kept by Safari
  itself, not by the background, so the viewer still comes on hosts with ink while the background
  sleeps. A message from a content script wakes the background. Open WebKit bugs report messages
  that did not wake it on iOS 17 [9] or were dropped while it loaded (fixed in 2026) [10]; the stub
  therefore sends a lost inject request once more.
- `runtime.onInstalled` does not mean "just installed" in Safari. WebKit decides the reason each
  time it loads the extension [14]: "update" when the version or the bundle changed; "install"
  when nothing changed and the extension is loaded while the browser already runs (turned on, or
  off and on, or loaded again); and no installed event, only `onStartup`, when it is loaded in
  the first seconds of the browser's life. An Apple engineer says the same of turning an
  extension off and on [15]. So a reader who turns the extension on in Settings and then opens Safari gets no
  installed event, and a later load sends "install" again. The first-run guide therefore keeps
  its own flag and checks it at each start (section 6, "First-run guide").
- Site access on Ask: content scripts in the manifest do not run on a site until the reader allows
  it [11], and `executeScript` and registered scripts need the same access. The stub never runs on
  such a site, so the popup and the app say what to tap (section 6, "Site access").
- `import()` in a Safari content script is still not documented to work [12]. Nothing in the page
  code uses it: modules are plain scripts that the background registers or injects.
- Safari does not inject into `about:blank` and `srcdoc` frames, with `executeScript` either [13].
  Such frames get no ink in Safari, as before.

What the iPad simulator showed (iOS 26.5, `apple/sim`, phase H): the registered viewer ran at
document start on every load of a page with ink, after Safari was quit and after the simulator
rebooted, and draw mode on a site without ink injected the viewer and the tools on request.
Phase B: with the extension turned on in Settings while Safari was closed, the first start of
Safari opened the guide as a tab behind the page in front. After Safari was quit and opened
several times and Clear History had closed every tab, no guide tab came back.

[1] MDN browser compatibility data, `webextensions/api/scripting.json`,
https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/scripting.json.
[2] WebKit, "New WebKit Features in Safari 15.4", https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/.
[3] WebKit, "WebKit Features in Safari 16.4", https://webkit.org/blog/13966/webkit-features-in-safari-16-4/.
[4] WebKit bug 265899, https://bugs.webkit.org/show_bug.cgi?id=265899.
[5] WebKit, "WebKit Features in Safari 17.4", https://webkit.org/blog/15063/webkit-features-in-safari-17-4/.
[6] WebKit, "WebKit Features in Safari 18.4", https://webkit.org/blog/16574/webkit-features-in-safari-18-4/.
[7] WebKit bug 261765, https://bugs.webkit.org/show_bug.cgi?id=261765.
[8] Apple, "Optimizing your web extension for Safari",
https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari.
[9] WebKit bug 263113, https://bugs.webkit.org/show_bug.cgi?id=263113.
[10] WebKit bug 317981, https://bugs.webkit.org/show_bug.cgi?id=317981.
[11] MDN browser compatibility data, `webextensions/manifest/content_scripts.json`,
https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/content_scripts.json.
[12] Apple Developer Forums thread 768182, https://developer.apple.com/forums/thread/768182.
[13] WebKit bug 263817, https://bugs.webkit.org/show_bug.cgi?id=263817.
[14] WebKit source, `determineInstallReasonDuringLoad` in
https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Extensions/Cocoa/WebExtensionContextCocoa.mm,
and `freshlyCreatedTimeout` (5 seconds) in `WebExtensionController.cpp` beside it. Safari's own
code is not public, so this is read from WebKit and from what the simulator showed, above.
[15] Apple Developer Forums thread 679429, https://developer.apple.com/forums/thread/679429.

## 5. Budgets (DESIGN 11)

| Budget                                      | Limit                                                                                                                             | Measured                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Stub main-thread time on a page with no ink | under 5 ms                                                                                                                        | `docs/RESULTS.md`                                                       |
| Stub size, minified, every browser          | at most 3,072 B (`test/stub-size.test.ts`)                                                                                        | 3,051 B in Chrome, Edge and Firefox, 3,066 B in Safari                  |
| First read (`content/boot.js`)              | under 7,300 B (`test/stub-size.test.ts`)                                                                                          | 7,169 B, every browser                                                  |
| Viewer (`content/loader.js`), minified      | under 118,960 B (`test/stub-size.test.ts`)                                                                                        | 118,854 B (43,865 B gzip), every browser                                |
| Tools (`content/tools.js`), minified        | under 85,100 B (`test/stub-size.test.ts`)                                                                                         | 84,997 B (32,531 B gzip), every browser                                 |
| Ink visible after its anchor content exists | within 50 ms, when the page's first layout allows                                                                                 | `docs/RESULTS.md`, with the page's own time to first paint it           |
| Ink visible after its content's first paint | same frame, or within one frame (16.7 ms), in every case                                                                          | `docs/RESULTS.md`                                                       |
| Script on scroll, normal pages              | none                                                                                                                              | `docs/RESULTS.md`                                                       |
| Long task caused by ink, 200 notes          | none over 50 ms that would be within it without its ink part, or with over 50 ms of ink; ink part of any one task at most 16.7 ms | `docs/RESULTS.md`, beside the page's longest task without the extension |

Sizes are of the release builds. The bench build adds the performance marks: its stub is 3,366 B.
The PDF chunk (`content/pdf.js`, not in Safari) is 3,026 B. The library's own view bundle has its
budget in `packages/core/src/app/size.test.ts`.

## 6. Decisions that fill gaps in DESIGN

- **PDF bytes.** A content script on a PDF address re-reads that same address once and hands the bytes
  to the bundled viewer in a frame. Outside `cloud.js` this is the only network read in the product. It
  is listed in `network-allow.json` by file and exact count, and the no-network test checks that its address is the page's own. Local PDF files are opened from the viewer page with a file picker.
- **Print is the PDF export.** The layer prints with the page.
- **Thumbnails** for viewport anchors come from the `captureVisible` hook.
- **In-page navigation** is detected in the content script (Navigation API, `popstate`, `hashchange`,
  and an address check after DOM changes). No extra permission.
- **Firefox** has no folder picker. It syncs with a cloud, or by importing and exporting the
  archive. Firefox for Android has no sign-in window, so it has the archive only.
- **Site access.** Without access to all sites the stub never runs, so the pen cannot write and the
  page cannot say why. The popup checks `permissions.contains` for all sites and for its tab's site
  and shows one line that calls `permissions.request` from the reader's tap (`src/ui/access.ts`). On
  Safari the background also tells the app (`{ op: "access" }`, NATIVE_PROTOCOL.md), whose setup
  screen shows the step as done or not.
- **First-run guide.** The short guide (`options.html#welcome`) opens once per install
  (`src/background/first-run.ts`). A flag in storage, `welcomed`, is written before the tab is
  opened, so no later start, update, re-enable or second installed event can open it again. If
  storage cannot be read or written, nothing opens. An installed event with reason "install"
  opens it; any other reason sets the flag and opens nothing. In Safari each start of the
  background also reads the flag and, when it is not set, waits two seconds for an installed
  event and then opens the guide itself, because Safari may send no event at all (4.2). The guide
  never covers a page in use: in Chrome, Edge and Firefox the event comes as the reader adds the
  extension, so it opens in front; in Safari it opens in front only when the tab in front is
  blank, and otherwise as a background tab. A tab whose address Safari hides counts as a page.
- **Clouds.** The reader's own Google Drive or OneDrive, with no server of ours. All cloud network
  code is in `packages/extension/src/cloud/`, built as `cloud.js`, loaded by the background for a
  reader who connects a cloud. Chrome and Edge service workers may not use `import()` (checked),
  so there the file is read at worker start and only defines functions; Firefox adds it when
  first needed; Safari has none and asks its app (NATIVE_PROTOCOL.md). The no-network test pins
  every call and address in it to five hosts, and `connect-src` allows only the cloud hosts.
  Sign-in uses `identity.launchWebAuthFlow`, asked for at the click on Chrome and Edge.
- **One place at a time.** A folder, the Safari app, or one cloud (`dest` in storage). A switch
  leaves the old place's files alone and copies only what changes from then on, until the reader
  chooses "Copy my notes to the new place". Disconnect keeps the files unless the reader says yes
  twice.
- **Password lock.** Optional, for any place. Files are sealed on the device (FORMAT.md,
  "Password lock"). The key stays on each device, in the background's own IndexedDB, out of
  reach of content scripts.
- **Text marks** have no strokes. They are drawn fresh from the text range on every placement.
- **Grouping** joins strokes of the same tool only. A pen stroke never joins a highlighter note.
- **Pen dots.** A quick pen tap on plain content leaves a dot, so the dots on letters work. A tap on a
  link, a control or anything with a pointer cursor leaves no ink and goes to the page.
- **Fonts in the PDF viewer.** Only the permissively licensed fonts that PDF.js ships are bundled.
  Other fonts fall back to the system's. A test checks that no GPL file is in a build.
- **Deleting a page in the Safari app** records its note and stroke ids as deleted, each with a time
  never older than the newest stroke of its note, and keeps the later time when an id is already
  there. Removing only the file would not last, because the next sync would write it back.
- **Clear page** in the toolbar removes all ink on the page for good, after a confirm step. It is
  not an undo step, and the undo steps before it go too. In a frame it clears that frame's notes.
