# PageInk: design

Handwriting and drawing on any web page, for the reader's own use.
The ink loads with the page, stays for good, and stays in place when the page changes.
A pen writes and a finger scrolls. Storage is on the device, with sync through a place the reader owns:
a folder, or the reader's own Google Drive or OneDrive. There is no account and no server of ours. The
extension talks to nobody unless the reader connects a cloud, and then only to that cloud.

Section numbers are stable. Code comments and `CONTRACT.md` refer to them.
The record format (section 6) is in `FORMAT.md`.

---

## 5. The four promises and the mechanism behind each

### Promise 1: the page loads as fast as it normally does

- **A stub of under 3 KB is the only thing injected on every page.** It does two things: one read of a
  small per-site index from extension storage, and a few pointer listeners on the window that wait for a
  pen or for the draw toggle. Pointer listeners cannot delay scrolling. It does not touch the DOM, does
  not read layout, and wakes the background worker only when a pen touches down or the reader asks to
  draw.
- **The index read is local.** Content scripts can read `storage.local` directly. Key: `idx:<site hash>`,
  value: the list of page keys on that site that have ink. One small async read. No message passing.
- **Everything else is in the page only where it is needed, and never loaded by address.** On a site
  with ink, the background registers the renderer as a content script for that site, so it is in the page
  at document start. Elsewhere the background puts the renderer and the drawing tools into the page when
  a pen touches down or the toggle is switched on. No content script file is web accessible, so a page
  cannot find the extension by probing for its files.
- **The same in every browser, Safari included.** Safari on Mac and iPad gets the same stub and the
  same registered and injected code (Safari 17 or later; section 10). Until the tools are in, the stub
  holds a Pencil's touches back and keeps the pointer events, so the first stroke after a page load
  writes instead of scrolling and loses no points.
- **Nothing waits on the network.** Pages never do. Only the background talks to a cloud, and only for
  a reader who connected one.
- **Budget, held by an automated test (section 11):** under 5 ms of main-thread time added on pages with
  no ink, and no change in first paint or largest paint beyond run-to-run noise. On a page with ink, the
  content under it first paints at most one frame later than without the extension.

### Promise 2: ink appears with the page, with no lag

- **Stored ready to paint.** Each stroke is saved with its finished outline path string. Showing it is one
  SVG insert, with no geometry to recompute.
- **The page record is read directly by the content script** from `storage.local` (key `p:<page hash>`,
  typically 5 to 20 KB). No background worker in the path.
- **One overlay for the document,** inside a closed shadow root on a custom element attached to
  `<html>`. The element has no box of its own; its surfaces are `position: absolute` and
  `pointer-events: none`. The browser scrolls them with the page. No script runs during scroll.
- **Notes inside an inner scrolling area** (a code pane, a chat pane) follow that area through one passive
  scroll listener that sets a transform, throttled to animation frames.
- **Placement is batched:** all layout reads in one pass, all writes in the next, so the page never
  re-lays-out twice because of ink. The pass runs right after the browser's own layout, so ink forces no
  layout while the page loads, and each pass is kept to a few milliseconds.
- **The code is there before the record.** On a site with ink the renderer runs at document start, and
  a small boot script, run before the renderer, starts reading this address's record beside the stub's
  index read, so the reply is on its way while the renderer is compiled. The viewer
  starts as soon as storage answers, with nothing left to load, and places the first notes right after
  the page's first layout, so they are in its first paint.
- **No style pass of our own before the page's.** Until the page has painted, the renderer reads the
  page's colours in its first placement, after the page's own style pass, not before it.
- **While the page loads,** notes whose content has just arrived are tried in the next frame, right
  after its layout, so their ink comes with the content's first paint. The full document text is built
  once the parser is done.
- **Near the screen first.** Notes within two screens of the viewport are placed first. The rest are placed
  from an `IntersectionObserver` as the reader scrolls.
- **The first paint waits only for the first screen.** Everything the viewer does before the page's first
  paint holds that paint back, so a pass that runs in a frame places only notes whose anchors are on the
  screen. Notes never drawn whose anchors lie off it are placed in idle time right after.
- **Target:** ink visible within 50 ms of its anchor content existing in the page, when the page's own
  first layout allows it, and in every case within one frame of that content's first paint.
- **Writing is low-latency:** the live stroke is drawn on a small canvas from raw pointer samples, including
  coalesced samples, and predicted samples where the browser offers them. It is committed to SVG on pen-up.

### Promise 3: ink is permanent

- **Storage belongs to the extension, not the site.** Clearing a site's data does not clear it. The
  extension asks for `unlimitedStorage`.
- **Automatic backup to a folder the reader owns** (iCloud Drive, Google Drive, Dropbox, any synced
  folder). One small JSON file per page. The same files are the sync between devices and browsers.
- **Merging is per stroke.** Every stroke and note has an id. Deletions are recorded. Two devices can both
  write while offline and nothing is overwritten.
- **Export at any time:** page with ink as an image or PDF, all notes as Markdown, everything as one
  archive. Import reads the same files.
- **Uninstall safety:** because the folder backup is on by default once a folder is chosen, removing the
  extension does not remove the notes.

### Promise 4: ink stays in place when the page changes

Section 7 has the full method. In short:

1. Strokes written together form one **note**, which moves as one rigid piece.
2. Each note has an **anchor** with several independent ways to find it again.
3. A note's position is stored **relative to its anchor**, never relative to the page.
4. Marks that follow text (highlight, underline, strike-through) are stored as **text marks** and redrawn
   on those words however they wrap.
5. On a new layout, each note is placed again from its anchor. A margin note that no longer fits docks
   into free space near its paragraph, or folds into a marker, and never covers the words.
6. On changed content, anchors are found by a ladder of methods, ending in an approximate text match.
7. **Nothing is ever lost.** A note whose passage is gone waits in a "moved notes" tray on that page, with
   the original words, and re-attaches with one tap.
8. A public **test set** measures how many notes land in the right place (section 12).

---

## 7. Anchoring: the method

### 7.1 Grouping strokes into notes

A stroke joins the current note when it starts within 1.5 seconds of the previous stroke's end **and** within
40 px of the note's bounding box. Otherwise it starts a new note. The lasso can split and join notes.
Both numbers are tuned on the test set.

### 7.2 Choosing the anchor when a note is written

1. Find what the note sits on: use `caretPositionFromPoint` / `caretRangeFromPoint` and
   `elementsFromPoint` under the note's box, looking through the overlay.
2. **On text:** anchor type `text`. The quote is the words under the note, widened to whole words.
3. **Beside text** (margin, gap between paragraphs): type `block`, anchored to the nearest block by vertical
   overlap, with `place` set to the side. The quote is the first line the note is level with.
4. **On an image, figure, table, video or canvas:** type `media`. Position is a fraction of the element box.
   A shape drawn round the words of one table cell is on those words, as in 2.
5. **Nothing usable** (blank page area, full-screen canvas app): type `viewport`, tied to the nearest
   element with an id or landmark role, else to the page fraction, and a small thumbnail is kept.
6. Always store all locators that exist: quote, structural path, text position, block hash.

### 7.3 Recognising text marks

A highlighter or pen stroke is turned into a text mark when it is close to straight, its height is under
1.5 line heights, and it covers at least 60% of one or more line boxes. It is saved as the covered text
range plus a style. It is redrawn from `Range.getClientRects()` with a slight hand-drawn wobble, so it wraps
with the text at any width or zoom. A circle or bracket around words stays as ink, anchored `text`.
A word at an end of the stroke is marked only when the stroke runs along most of it, so a line that
runs a little past the last word does not take in the next one.
A pen stroke in the gap between two lines could underline the one or strike the other, so it stays ink.

### 7.4 Finding anchors again (the ladder)

For each note, in order, stopping at the first that passes a quote check:

1. Structural path, then confirm the element's text still contains the quote (or the block hash matches).
2. Exact quote search in the document text, using prefix and suffix to choose between repeats, and the
   text position as the tie-breaker.
3. Approximate quote search (tolerates edits inside and around the passage), scored with prefix and suffix.
   A match must clear a similarity bar; the bar is set on the test set so wrong-place results stay under 2%.
4. For media: same `src`, then same file name, then caption or alt text, then position among siblings.
5. No match: the note goes to the tray. It is listed in the tray with its saved words and where on the
   page it was. One tap puts it into "place me" mode; the next tap on the page re-anchors it.

Then place the note: anchor box now, plus the stored offset, times the scale factor. If a margin note would
fall off the page or over content, dock it into free space: the same side, the other side, the gap above
its block, the gap below, then the nearest gap within about a screen. Free means no text line, image,
control or other ink under it, read from the line boxes near the anchor. Scale it to fit, never below
half size, and draw a thin leader to the nearest edge of its line, round the text, left out when the note
sits by its line. With no free space, fold it into a small marker beside its line that shows the note on
hover, tap or key, and unfold it when there is room again. A docked note holds its place on small layout
changes, and returns to where it was written when the layout allows. Text marks and ink written on the
words never dock.

Re-placement triggers: `ResizeObserver` on anchor elements, on `<body>` and on clipping ancestors,
window resize, web font load, image load, a debounced `MutationObserver` (content, and the attributes
that open and close sections), `toggle`, `close`, `transitionend` and `animationend` events,
orientation change, and in-page navigation.

While the page loads, step 1 runs on the anchor's own block, with no text built for the whole document.
The document text is built afterwards in small slices, and then the full ladder checks every note. A page
whose whole text builds in a couple of milliseconds once it is parsed is read whole first, since one walk
of it costs less than walking the blocks around each note.

### 7.5 Hard page types and the mechanism for each

| Page type                                           | Mechanism                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responsive layout, rotation, zoom, reader font size | Covered by anchoring plus docking. Text marks rewrap by themselves.                                                                                                                                                                                                                                                                                      |
| Dark mode or theme switch                           | Stroke colours are semantic and mapped per theme, so ink stays readable.                                                                                                                                                                                                                                                                                 |
| Late-built pages, lazy loading, infinite lists      | Notes wait. A `MutationObserver` attaches each note when its quote appears. Unattached notes sit in the tray until then, without an error.                                                                                                                                                                                                               |
| Single-page apps                                    | Listen for in-page navigation in the content script (Navigation API, `popstate`, `hashchange`). Each route has its own page key. Re-anchor after render. Quote-based locators survive recycled DOM nodes.                                                                                                                                                |
| Embedded frames, including cross-origin             | The content script runs in every frame (`all_frames`). Each frame has its own layer; the record is stored under the top page with the frame noted in the anchor.                                                                                                                                                                                         |
| Shadow DOM, including closed roots                  | Walk shadow trees with the extension-only accessors (`chrome.dom.openOrClosedShadowRoot`, Firefox `openOrClosedShadowRoot`). Fallback: anchor to the host element by fraction.                                                                                                                                                                           |
| Logged-in and personal pages                        | Same method. Records never leave the device or the place the reader chose. A per-site off switch exists.                                                                                                                                                                                                                                                 |
| Pages that change every day (news fronts, feeds)    | Anchors follow the item (its text and link), not the slot. Items that left the page go to the tray with their quote and link.                                                                                                                                                                                                                            |
| Canvas and WebGL apps (maps, design tools)          | Anchor to the canvas element by fraction, with a thumbnail. Ink is correct for the view it was written on; the tray entry shows the thumbnail when the view differs.                                                                                                                                                                                     |
| PDFs                                                | The extension opens PDFs in its own bundled viewer page (PDF.js). Ink is anchored by page number and PDF coordinates, which never move. arXiv PDF addresses offer the HTML version when one exists.                                                                                                                                                      |
| A document with several addresses                   | Section 7.6.                                                                                                                                                                                                                                                                                                                                             |
| Collapsed and hidden content                        | Each note is cut to the ancestors that are cutting its content, followed from their resize reports, and hides with content that is closed, hidden or transparent until it shows again.                                                                                                                                                                   |
| Modal dialogs and popovers                          | Notes on a modal dialog or an open popover are painted in hosts of their own shown in the browser's top layer, above them: one for the highlighter, which blends as a whole with what is under it, and one for the pen. They exist only while such notes do and never close the page's popovers. Notes under a `clip-path` are cut to the box it leaves. |
| Pages the browser translates                        | While a translation is shown (a `translated-*` class on `<html>`, a changed `lang`, or Edge's marks), notes whose words no longer match are held, listed apart in the tray, and return with the original. Nothing is written as missing.                                                                                                                 |
| Private windows                                     | Ink works and stored ink still shows, but new ink is kept in memory only, never saved or synced, and the bar says so. The reader can choose to keep private ink.                                                                                                                                                                                         |

### 7.6 Page identity

The page key is the address after: dropping the fragment (unless it is a route, `#/` or `#!`), dropping
tracking parameters (`utm_*`, `fbclid`, `gclid` and similar), and sorting the remaining query. A same-site
`rel=canonical` address is stored as an alias. Known families map to one record with the version noted
(arXiv `abs` / `html` / `pdf` and `v1`, `v2`; Wikipedia article and its permanent links; docs sites'
"latest" and numbered versions). When a record is opened at a different version, the ladder in 7.4 does
the re-anchoring.

---

## 8. Input and tools

- **iPad:** the Pencil writes; a finger scrolls and taps. No mode switch.
- **Touch laptops and touch Chromebooks:** a draw toggle. On: one finger draws, two fingers scroll.
  Off: normal touch. The toggle lives in the floating bar and on a keyboard shortcut.
- **Windows and Android pens:** draw without the toggle, like the Pencil.
- **Mouse and trackpad:** draw while the toggle is on, or while a modifier key is held.
- **Tools:** pen (two colours to start), highlighter, eraser by stroke, lasso to move, split or join notes,
  undo and redo.
- **The floating bar** is small, hides itself after a few seconds without ink input, and comes back on
  pen hover or pen-down. It lives in the same shadow root as the overlay.
- **The bar never hides the page for good.** It sits on one edge of the screen: the bottom on touch
  screens, the right elsewhere. The grip moves it: a tap sends it to the next edge, a drag with pen,
  finger or mouse to the nearest one. It cannot leave the screen, and style rules keep it on its edge
  through rotation and resize. The edge is kept for the page session and nothing is stored. A bar
  shown at the bottom keeps room at the end of the page, so the last line scrolls clear of it. The
  room is one empty box in the overlay. No box or style of the page is touched, a page that locks its
  scrolling is left alone, and a page that does not scroll gets room only where a new scrollbar
  takes no space.
- **Never in the way:** buttons, links and form fields on the page stay tappable with the pen unless a
  stroke is already in progress. Palm contact is ignored while a pen is down. Drags on sliders,
  scrollbars, draggable items, media controls, selection handles and parts marked `data-ink-off` go
  to the page.
- **Only the reader's own input counts.** Events a page script makes are never trusted, so a page
  cannot write, erase, undo, place a note or press the bar.
- **Draw mode is kept per site.** Switched on at a site, it comes back on there on the next visit,
  with a one-line note that says how to stop. A setting turns this off. Another setting makes the pen
  need draw mode too, so it scrolls like a finger until draw mode is on.
- **Clear page** in the bar's menu removes all ink on the page for good, after a confirm step. It
  writes a tombstone for every note and stroke, so no synced copy brings the ink back, and it cannot
  be undone.
- **The first ink** shows a one-line hint once, ever.

---

## 9. Permissions

The extension asks for these, and for nothing else. Each has one job.

| Permission          | Browsers                  | Why                                                                                                                                                                                                            |
| ------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`           | all                       | Keeps the notes and the settings in the extension's own storage on the device.                                                                                                                                 |
| `unlimitedStorage`  | all                       | Lets that storage grow past the browser's small default, so a reader with many notes never loses one.                                                                                                          |
| Access to all sites | all (`host_permissions`)  | Ink comes back by itself when the reader returns to any page. Without it the reader would have to click on every visit.                                                                                        |
| `scripting`         | all                       | Puts the drawing code into a page only where it is needed: on sites with ink at load, elsewhere at the first pen touch. No content file is web accessible, so a page cannot detect the extension by its files. |
| `identity`          | Chrome and Edge: optional | Opens the cloud provider's own sign-in window. Asked for only when the reader clicks Google Drive or OneDrive.                                                                                                 |
| `identity`          | Firefox: listed           | The same. Firefox does not allow it as optional; it shows no warning for it.                                                                                                                                   |
| `nativeMessaging`   | Safari only               | Reaches the app on the same device, which keeps the reader's folder or cloud and shows the setup steps.                                                                                                        |

Safari has `scripting` like the other browsers (section 10). Its app signs in to a cloud, so it has no
`identity` either. The only web accessible file is `pdf.html`, the
PDF viewer, which a page shows in a frame; on Chrome and Edge its address changes every session.

The content security policy allows `connect-src` only to the cloud hosts, and nothing on Safari. A test
parses every built file, including the bench build and a diagnostics build when one exists, and fails
on any network call outside the one cloud file and the PDF read, and on any address outside the pinned
cloud hosts. Another checks each manifest field by field.

If a reader takes away access to all sites, the pen does not write on a page until they click the
toolbar button, and nothing in the page can say why. On Safari this happens when "All Websites" is left
on Ask. So the popup checks the access and shows one line that asks for it again, and the Safari app's
setup screen shows "All Websites: Allow" as its own step with a live check.

---

## 10. Platform notes

| Platform                                     | Route                              | Notes                                                                                           |
| -------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| Chrome and Edge on desktop and touch laptops | Manifest V3 extension              | First target. Other Chromium browsers may work but are untested.                                |
| Firefox desktop and Android                  | Same codebase                      | Android tablets with a pen come for free here.                                                  |
| Safari on Mac                                | Same codebase in the Xcode wrapper | Safari 17 or later (macOS 14 or later). During development: "Allow unsigned extensions".        |
| Safari on iPad                               | Same wrapper, iPad target          | Main device, iPadOS 17 or later. The wrapper app also holds the notes library, export and sync. |
| Embedded in a site's own pages               | `embed/` script                    | The embed script. Same format, same sync.                                                       |

Known facts to design around:

- The Pencil reports `pointerType: "pen"` with pressure in Safari. Do not design around hover.
- iPad system handwriting-to-text (Scribble) is kept out of the way by the stylus `preventDefault` in
  section 8.
- Touchscreen MacBooks take a finger, not a Pencil. Whether Chrome there reports a finger as `touch` or as
  `mouse` decides how the draw toggle tells a finger from the trackpad. The toggle design works either way.
- Chrome's built-in PDF viewer cannot be drawn on, which is why PDFs go to the bundled viewer.
- Safari loads the page code like the other browsers: the stub on every page, the viewer registered
  with `scripting.registerContentScripts` on hosts with ink, and the viewer and tools injected with
  `scripting.executeScript` elsewhere. On iPad Safari stops the extension's background often; the
  registered viewer does not need it, and the stub's request for the tools wakes it. What Safari
  supports, with versions and sources, is in `CONTRACT.md` section 4.2.

---

## 11. Speed budgets and how they are tested

| Budget                                                        | How it is measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Under 5 ms main-thread time on a page with no ink             | `bench/`: 20 popular pages, 10 loads each (20 for pages that cannot be replayed), with and without the extension, in Playwright. Traced time in the extension's scripts on the page's main thread, and the stub's own `performance.measure` in the bench build.                                                                                                                                                                                                                                                                            |
| No measurable change in first paint and largest paint         | Same runs; compare medians against the run-to-run spread.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| First paint of content under ink held back at most one frame  | Seeded pages, cold and warm, loaded with the extension and with none, interleaved. When the first-screen content with ink is first painted, by element timing, with minus without, against the run-to-run spread. A page that paints its first screen in two ways from load to load is compared group by group, and every group is published.                                                                                                                                                                                              |
| Ink visible within 50 ms of its content existing              | Seed records, load cold and warm, timestamp from anchor node insertion to SVG insert. Reported beside it: the same ink counted from the content's first paint, which is what a reader sees. That must be the same frame or the next. Ink cannot be on screen before the page's own first layout of the content, so where that layout takes more than 50 ms the first measure cannot be met, and the results say so with the page's time.                                                                                                   |
| No script during scroll on normal pages                       | Trace a scripted scroll; assert no ink frames in the trace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Pen-to-ink delay as low as the device allows                  | High-speed phone video on the iPad once; then a regression check on sample count and frame times. The bench publishes pen-down to first pixel in Chromium for the first stroke on a page with no ink and for later strokes.                                                                                                                                                                                                                                                                                                                |
| No long task over 50 ms caused by ink on pages with 200 notes | Stress record in `bench/`, loaded cold and warm, with and without the extension. A task is caused by ink when it is over 50 ms and would be within 50 ms without its ink part, or when the ink part alone is over 50 ms. The ink part of any one task must also stay within one frame. Loads with the extension must not have a long task more often than loads with a do-nothing extension, beyond chance; loads without any extension are counted beside them. The page's own longest task without the extension is published beside it. |

The 20 pages: a Wikipedia article, an arXiv HTML paper, MDN, a GitHub README, a news article, a docs site,
a long blog post, a search results page, a video page, a web mail client, a chat app, a shopping page, a map,
a spreadsheet app, a forum thread, a social feed, a Q&A page, a dashboard, a PDF, and a local book-style lesson page.

CI runs a quick version on offline pages as a gate. The published numbers in `docs/RESULTS.md` come
from a full run on one machine, named there.

---

## 12. The anchor test set (public)

**Purpose:** a number for "do notes stay in place", and a regression gate for every anchoring change.

- **Content pairs (version A, version B of the same document):**
  Wikipedia revisions a month apart and a year apart (permanent links), arXiv HTML v1 and v2, docs pages
  across releases, news articles before and after edits and blog posts across time (web archive snapshots).
- **Layout pairs:** the same page at 390, 820 and 1280 px wide, at 100% and 150% zoom, light and dark.
- **Dynamic pages:** a lazy-loading article, an infinite list, a single-page app route change. Saved as
  replayable fixtures.
- **Notes:** generated by script on version A: on words, on a whole line, in the left and right margins,
  between paragraphs, on figures, on tables, on headings. About 20 per page.
- **Truth:** each generated note records what it was written on (the text and element). On version B the
  scorer checks where it landed.
- **Scores:** right place, in the tray and truly gone (correct), in the tray but still present (miss),
  wrong place (the worst outcome).
- **Targets:** 95% or better right place on document pages; 100% accounted for; wrong place under 2%.
- **Size:** 30 pairs for the proof run, 150 or more for the public release.

The set, the generator and the scorer ship in the repo so anyone can rerun the numbers.
