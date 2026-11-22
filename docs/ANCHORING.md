# Anchoring

How PageInk keeps a handwritten note on the content it was written on, when the page reflows or its text
changes. This page describes what the code does. [DESIGN.md](DESIGN.md) section 7 states the intent,
[FORMAT.md](FORMAT.md) the stored shape, and [CONTRACT.md](CONTRACT.md) section 3 the module boundaries.
The code is in `packages/core/src/anchor/`, `place/` and `notes/`.

The measured numbers are in one place: the table under [Results](#results), which
`corepack pnpm results` rewrites from the latest test set run. The prose below does not repeat them.

## The problem

A web page is not a fixed sheet. The same article is laid out differently at each window width, zoom and
font size. Its text is edited, sections move, ids and classes are renamed, and some pages build their
content late or recycle it. Ink written on a page must find the same content again under all of these,
or say plainly that it cannot. Placing a note on the wrong words is worse than not placing it.

## 1. Grouping strokes into notes

Strokes written together form one note, which moves as one rigid piece (`notes/group.ts`).
A stroke joins an existing note when it starts within 1.5 s of that note's last stroke ending, its box is
within 40 px of the note's box, and it was made with the same tool. When several notes qualify, the
nearest wins, then the most recent. Otherwise the stroke starts a new note. The lasso can split and join
notes; a stroke counts as selected when more than half of its points are inside the lasso.

## 2. Choosing an anchor

When a note is finished, `describe` looks at what lies under it (`anchor/describe.ts`). It samples the
note's box: the centre point plus a grid of 3 to 7 points each way, looking through the ink overlay with
the caret and element hit tests.

- **Media.** If at least half the samples in view land on an image, figure, table, video, canvas or an
  element marked `data-ink-media`, the anchor is `media`. The centre sample counts twice. The nearest
  ancestor with `data-ink-media` always wins; host pages and the PDF viewer use it to mark fixed surfaces.
  One case on a table is text instead: a shape drawn round the words of one cell, such as a circle
  round a value. It is taken as that when the words under the note, in the cell with the most samples
  on text, fit in one quote, at least three quarters of them lie inside the note's box, and the box
  reaches no more than two line heights past them. Such a note follows its words when rows grow or a
  label wraps. A mark over several cells, or over part of a long cell, is on the table. So is the caption.
- **Text.** If the centre lands on a glyph, or at least 15% of the samples in view do, the anchor is
  `text`. The quote is the text under the note, widened to whole words and capped at 200 characters.
- **Block.** Otherwise the note sits beside text: in a margin or between paragraphs. It is tied to the
  nearest block, scored by horizontal and vertical gap and overlap. Blocks more than 160 px away
  vertically are not considered. `place` records the side (`left`, `right`, `on`, `above`, `below`). The
  quote is the line the note is level with, or the first or last line for notes above or below.
- **Viewport.** If nothing usable is near, the note is tied to the nearest element with a stable id or a
  landmark role, or else only to its fraction of the document, and a small thumbnail is kept.

Every anchor stores all the locators that exist, so later steps have several independent ways back:

| Locator             | What it is                                                              |
| ------------------- | ----------------------------------------------------------------------- |
| `quote`             | The exact words, plus 32 characters of prefix and suffix                |
| `path`              | A stable id when there is one, a CSS path and an XPath to the element   |
| `pos`               | Start and end offsets in the document text (FORMAT.md, "Document text") |
| `hash`              | A hash of the block's normalised text                                   |
| `media`             | Source address, alt text and caption, for media anchors                 |
| `link`              | The address of the link the anchor sits in or contains                  |
| `frac`              | The note's position as a fraction of the document when it was written   |
| `scroller`, `frame` | The inner scrolling area or the embedded frame the anchor lives in      |

The note's strokes are stored relative to the anchor's origin (FORMAT.md, "Units"), never relative to the
page. `describe` and `resolve` are two halves of one mapping: on an unchanged page, resolving a fresh
anchor gives back the origin `describe` measured.

## 3. Finding anchors again: the ladder

`resolve` tries each method in order and stops at the first that passes its check
(`anchor/resolve.ts`, `anchor/search.ts`). Every step checks the quote; no step trusts an element just
because it was found.

1. **Structural path.** Find the element by id, then CSS path, then XPath. Search for the quote inside
   it. Accept when the prefix and suffix agree well (context score 0.8 or more), or fairly well (0.5 or
   more) and the block hash matches. A block anchor with an empty quote is accepted only on a hash match.
2. **Exact quote search** over the whole document text. Each match is scored from how well its prefix
   and suffix agree. Ties go to the match nearest the stored text position. A quote with no context to
   compare must be at least 8 characters and appear once. Otherwise a match needs a context score of 0.5,
   or must be the only match and at least 32 characters long, or the only match, at least 24 characters
   and with a context score of 0.25.
3. **Approximate quote search** with `approx-string-match`, which tolerates edits inside and around the
   passage. It allows up to one error per five characters, at most 48. Quotes under 4 characters are not
   searched this way. On long pages it first looks near the stored position and accepts a match there
   only at a high score.
4. **Tray.** If nothing passes, the note goes to the moved notes tray (section 7).

A note beside a block is measured from that block's box, so every step must end at the block that was
described. That block can be built from smaller blocks, as a formula is built from its symbols, and
the quote can start inside one of them. In step 1 the twin check therefore looks at the block the path
names, not at the small block where the quote starts. In steps 2 and 3 the search climbs from the
match to the block with the stored hash, else to the nearest block of the same tag that holds text
itself. Without this, a note beside a centred formula was measured from one symbol and landed on the
other side of the formula.

Media anchors have their own steps: the path if the tag and a source, file name, caption or alt still
match; then the same source address; the same file name; the same caption; the same alt text; and last,
the same kind of element with matching text around it. Repeats are separated by their surrounding text.

Viewport anchors use the path with a tag check, then the stored page fraction.

If the page changed while resolving, the document text is rebuilt once and the note tried again.
The resolver caches the document text, so resolving many notes costs one text build.

**Before the document text exists.** Building the text of a long page takes tens of milliseconds, too
long for the first paint. So the first placement uses step 1 alone, on a text model of the anchor's own
block (`quick` in `anchor/resolve.ts`). That model is widened by neighbouring blocks, then by a parent,
only as far as the stored prefix and suffix need, and its text is exactly the full text over those
nodes, so the quote and context checks give the same answers. It skips the one check that needs the
whole page: whether the block has an identical twin elsewhere. Notes it cannot decide wait. Meanwhile
the document text is built in slices of about 6 ms. Once it is ready, every note is resolved by the full
ladder: waiting notes are placed, and quick placements are checked and moved if the ladder disagrees.
On the test set pairs, quick placements agree with the full ladder on every note they decide. On a page
that keeps changing, the text may never finish in slices; a note that has waited a second is then
resolved by the full ladder in a normal pass.

## 4. The similarity bar

The approximate step is where a wrong place can come from, so its bar is strict and was set on the test
set with the goal of keeping wrong places under 2%. A candidate's score is 0.6 times the quote similarity
(one minus errors over length) plus 0.4 times the context similarity (a length-weighted edit similarity
of the prefix and suffix). A match must have a quote similarity of at least 0.8 and a combined score of
at least 0.78. Quotes under 24 characters also need a context similarity of at least 0.6, because short
quotes match too many places.

Below the bar, the note goes to the tray. A miss is recoverable with one tap; a wrong place misleads.

## 5. Placement and docking

Once an anchor is found, the note is placed at the anchor's origin plus its stored offset, times one
scale factor (`place/`). For text and block anchors the factor is the anchor element's font size now
over its size when the note was written, so notes grow with zoom and reader font size. For media it is
the element's width now over then. Viewport notes are not scaled.

Layout reads are done for all notes in one pass and writes in the next, so placement never makes the page
lay out twice. A pass runs right after the browser's own layout, from a resize observation, so its reads
never force a layout and its ink is painted in the same frame. Each pass stops reading after about 6 ms;
the rest follow in idle time. Notes near the screen are placed first, judged by the box of the element
their path points at.

**Docking.** A margin note stays where it was written while that spot is inside the page and on no
content. When it is not, it docks into free space near its block, in this order: the same side, when
the gutter beside the text is wide enough for at least three quarters of the ink's size; the other
side; the gap above the block; the gap below it; the nearest gap between blocks further away, within
about a screen; then either side down to half size. Free means no line of text, image, control or
other ink under the note. The placer reads this only for a note whose spot is taken: the boxes of the
blocks around it first, then the text pieces of those blocks, all in the read phase and kept for the
pass, so wide layouts cost nothing more. The note is scaled down to fit, never below half size.

With no free space, as in a phone-width column of tight paragraphs, the note folds into a small marker
in the nearest free sliver: at the end of its line, at the block's top corner, or at the page edge
beside the line. Hover with a pen or a mouse, a tap, or Enter on the focused marker shows the ink at
reading size in a popover; leaving, a tap elsewhere or Escape hides it. The note unfolds by itself when
the layout has room again.

A thin leader with a dot joins a docked note to the nearest edge of its line. It goes round the text
through the gutter when a straight line would cross words, and it is left out when the note sits right
next to its line. A docked note keeps its place on small layout changes: it holds that place down to
nine tenths of the usual limit, and an earlier place in the order must clear its limit by as much to
take over. Docked notes never overlap each other or other ink. Docking changes where a note is drawn,
never its anchor, so a note docked on a narrow window is back where it was written when the window is
wide again. Text marks, notes written on the content itself, notes in inner scrolling areas and notes
on fixed or sticky elements do not dock.

**Collapsed and hidden content.** A note is painted only where its content is. The resolver lists
the ancestors that clip the anchor (overflow other than visible on an axis, or paint containment;
an absolutely positioned anchor escapes those below its containing block, a fixed one all but
transformed ones). An ancestor cuts the note only on an axis where it is cutting its own content
right now, so a wrapper that clips nothing, such as a float clearfix, never cuts a margin note. The
layer cuts each note to the box they leave, and the placer follows their size from its
`ResizeObserver`, in the callback itself, so an accordion closing over a note cuts the ink at the same
line as the text in every frame. Content that is closed, hidden or transparent (a closed `<details>`,
`hidden`, `hidden="until-found"`, display none, visibility hidden, opacity 0, a closed popover or
dialog, a clip with nothing left) hides its notes. Such a note is hidden with its content: not
waiting, not missing, never in the tray, the badge or a marker, and it returns in place when the
content shows. It stays hidden only while the element its path points at still holds the quote;
otherwise it is missing, so a section deleted while closed sends its notes to the tray. Writing
follows the same rules: describe never anchors to content that is transparent or clipped away under
the pen, and ink written on a menu or panel open over the page anchors to it, not to the page behind.
One limit remains: `clip-path` is followed only as a box. A simple shape cuts to its own box, a
circle or ellipse to the box around it, and any other shape to the element's box. Ink on an open
popover or a modal dialog is drawn in hosts of its own in the top layer, above it: one for the
highlighter, which blends with the dialog under it, and one for the pen. In a browser without
the popover top layer, ink on a modal dialog is drawn under it.

**When placement runs again:** window resizes, a `ResizeObserver` on anchor elements, web fonts
finishing, images loading, a `MutationObserver` (debounced 25 ms, at most 100 ms) for content and for
the attributes that open and close things (`class`, `style`, `hidden`, `open`, `aria-expanded`,
`aria-hidden`), `toggle`, `close`, `transitionend` and `animationend` events, a `ResizeObserver` on
`<body>` and on clipping ancestors, theme attribute
changes, orientation and visual viewport changes, and in-page navigation (Navigation API, `popstate`,
`hashchange`, and an address check after DOM changes). Notes inside inner scrolling areas follow their
area through one passive scroll listener. Nothing runs on scroll for normal pages.

## 6. Text marks

Highlights, underlines and strike-throughs follow the words, not the pixels (`anchor/mark.ts`). A
highlighter or pen stroke becomes a text mark when it is close to straight (at least 12 px wide, slope
under 0.3, path no longer than 1.35 times its chord, little deviation), its height is under 1.5 times
the line height, and at least 60% of probe points along it land on one line of text. A pen line under
the middle of the line is an underline, through the middle a strike-through. The highlighter always
makes a highlight. A circle or bracket around words stays as ink, anchored `text`.

The mark covers whole words. A word at either end of the stroke is part of the mark only when the
stroke runs along at least 60% of its width. A narrow word, such as "a" or "I", needs more: a quarter
of the line height, or four fifths of the word when it is narrower than that. So a stroke that runs
a little past the last word, or starts a little before the first, does not take in the neighbour.
The stop or comma after the last word is marked when the stroke reaches it.

A text mark stores the covered text range and a style, with no strokes. On every placement it is drawn
fresh from the range's line boxes, with a slight hand-drawn wobble that is seeded from the note id so it
looks the same every time. It rewraps with the text at any width or zoom.

Marks are recognised on one line at a time. A highlight drawn across two lines stays as ink.

## 7. The moved notes tray

Nothing is lost silently. A note whose anchor is not found waits in the tray on that page
(`ui/ui.ts`). The tray lists notes in page order by their stored height, each with a small drawing of
the ink, the saved words, a status ("Waiting for the page" while the page may still be building, else
"Passage not found") and where on the page it was (near the top, middle or end). A link is shown when
the anchor had one; it is clickable only for `http` and `https` addresses.

**Place** closes the tray and waits for one tap on the page. The note is anchored again where the tap
lands, with the same `describe` used for new ink. Notes that wait for late content are retried every time
the page changes, and leave the tray by themselves when their passage appears.

## 8. Page identity

A note belongs to a page record, found by a key made from the address (`anchor/identity.ts`):

- The fragment is dropped, unless it is a route (`#/` or `#!`).
- Tracking parameters are dropped: a fixed list (`fbclid`, `gclid` and similar) and any parameter
  starting with `utm_`, `pk_`, `mtm_` or `stm_`. The remaining query is sorted. Repeated slashes collapse.
- A `rel=canonical` address on the same site is stored as an alias.
- Known families map to one record, with the version noted: arXiv `abs`, `html` and `pdf` addresses and
  their `vN` versions; Wikipedia articles, their mobile hosts and `oldid` permanent links; MDN by locale;
  and docs sites with a version segment such as `latest`, `stable` or a number.

When a record is opened at another version of the same document, the ladder does the re-anchoring.

## 9. The test set

The test set (`testset/`) gives a number for "do notes stay in place" and is the regression gate for
every anchoring change. [testset/README.md](../testset/README.md) has the full method and
[testset/SOURCES.md](../testset/SOURCES.md) every pair.

**What it is.** Pairs of the same document at two times: Wikipedia revisions a month and a year apart,
arXiv HTML v1 and v2, documentation across releases, and blog and news pages across web archive
snapshots. Hand-made synthetic pairs each make one kind of change. Layout pairs show the same page at
390, 820 and 1280 px, at 150% zoom, and in dark themes. Dynamic pages cover lazy loading, an infinite
list and a page app route change. About 20 notes per page are written by script on version A, of every
kind: on words, on lines, in both margins, between paragraphs, on headings, figures and tables. Each
records its truth, the content it was written on. On version B the scorer finds that content with its
own text search, not the module's, and classifies each note as right place, in the tray and truly gone,
in the tray after its words were edited, a miss (in the tray but the content is still there), or wrong
place. Runs are offline: pages are served from frozen copies and every other request is blocked.

**What it is not.** The notes are generated boxes, not real handwriting, so the set does not measure how
people actually write. The truth is decided by a rule about what the note was on, which can disagree
with what a reader meant. Pages are frozen without their scripts, so live page behaviour is covered only
by the dynamic fixtures and by the extension's end-to-end tests. The set is weighted towards text-heavy
documents in English. The score of a pair depends on how much its page changed, so totals move when
pairs are added. It does not measure speed on real devices; the bench and the device checks do.

## Results

<!-- results:anchoring:start -->
| measure                                                           | result | target          | status |
| ----------------------------------------------------------------- | -----: | --------------- | ------ |
| Right place, of notes whose content still exists (document pages) |  99.4% | 95.0% or better | pass   |
| Accounted for, placed or in the tray (all runs)                   | 100.0% | 100.0%          | pass   |
| Wrong place (document pages)                                      |   0.3% | under 2.0%      | pass   |

| note kind    | notes | right | tray, correct | miss | wrong | right of present | wrong |
| ------------ | ----: | ----: | ------------: | ---: | ----: | ---------------: | ----: |
| figure       |   262 |   254 |             6 |    0 |     0 |           100.0% |  0.0% |
| gap          |   215 |   209 |             4 |    2 |     0 |            99.1% |  0.0% |
| heading      |   791 |   755 |            32 |    1 |     3 |            99.7% |  0.4% |
| line         |   617 |   589 |            26 |    0 |     0 |            99.3% |  0.0% |
| margin-left  |   401 |   382 |            15 |    2 |     0 |            99.2% |  0.0% |
| margin-right |   338 |   324 |            11 |    0 |     1 |            99.7% |  0.3% |
| table        |   136 |   123 |             2 |    2 |     6 |            94.6% |  4.4% |
| word         |  1203 |  1154 |            38 |    4 |     3 |            99.6% |  0.2% |

| ladder step | notes | right | tray, correct | miss | wrong | right of present | wrong |
| ----------- | ----: | ----: | ------------: | ---: | ----: | ---------------: | ----: |
| exact       |   703 |   698 |             0 |    0 |     5 |            99.4% |  0.7% |
| fuzzy       |    34 |    31 |             0 |    0 |     3 |           100.0% |  8.8% |
| hidden      |     7 |     0 |             0 |    0 |     0 |           100.0% |  0.0% |
| media       |    39 |    38 |             0 |    0 |     1 |           100.0% |  2.6% |
| path        |  3035 |  3023 |             0 |    0 |     4 |            99.9% |  0.1% |
| tray        |   145 |     0 |           134 |   11 |     0 |             0.0% |  0.0% |

Source: `testset/results/latest.json`, anchor module `packages/core/src/anchor/index.ts`, run of 2026-11-18, 3,963 notes. Per category of change: [RESULTS.md](RESULTS.md).
<!-- results:anchoring:end -->

## Failure classes that remain

The per-failure list with causes is in `testset/results/` (`latest.md` or `core.md`, "Misses and wrong
places"). The latest run of the shipped module has 24 such notes out of 3,963: 13 in the wrong place
and 11 misses. They fall into these classes:

- **Repeated or short quotes.** When the quote occurs many times on version B and its prefix and
  suffix changed, the exact step can choose the wrong occurrence. Examples: a heading word that is
  also used 10 more times on the page, and a two-word quote such as "of the".
- **Approximate matches for content that is gone.** When a heading or a short phrase was removed or
  rewritten, the approximate step can still find a similar passage and place the note there instead
  of sending it to the tray.
- **Tables and figures in narrow layouts.** At 390 px a table or figure found by its path can be drawn
  16 to 22 px from where the truth puts it.
- **Misses where the surrounding text repeats.** When the words around a quote repeat on version B,
  the ladder declines to choose and the note goes to the tray although its content is still there.
  Some tables and left-margin notes miss for the same reason.

Each class has a fixture in the test set that shows it. Fixes are judged by the gate: right place up,
wrong place under its target, and nothing unaccounted for.
