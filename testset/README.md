# Anchor test set

A public, rerunnable number for "do notes stay in place" (DESIGN 12).
Notes are written by script on version A of a page. The same notes are then found again on version B,
and each one is checked against the truth: the content it was written on.

## What it measures

- **Content pairs.** Wikipedia revisions a month, a year and two years apart, arXiv HTML v1 and v2, docs pages across
  releases (Python, Rust book, Django, Node, MDN through web archive snapshots), blog posts and news
  articles across time. All addresses are permanent (`oldid` links, versioned docs, snapshot addresses).
- **Synthetic pairs.** One hand-made article with one change each: paragraph inserted, sentence edited,
  quote repeated, section moved, section deleted, ids and classes renamed, list reordered, image replaced,
  a sticky sidebar beside the article, a note repeated word for word in every section, headings lengthened,
  footnote markers renumbered, a table column removed, paragraph openings rewritten, and an unchanged control.
- **Collapsed content.** The same article with one part that can close: a `<details>` section, an accordion
  that animates its height to zero, a tab panel and a menu list. In the collapse pairs B has that part
  closed, so notes on it must hide with it. In the reopen pairs B is served closed and opens it at load, so
  every note must be back in place.
- **Layout pairs.** Version A again at 390 and 820 px, at 150% zoom (1280 and 390 px), in dark (emulated
  colour scheme, and a dark stylesheet laid over the page), for 16 fixtures across every kind of page.
- **Dynamic pages.** A lazy-loading article, an infinite list and a page app whose route change recycles
  nodes. Scored twice: right after load and after the page settles.

About 20 notes per page: on words, on a whole line, in the left and right margins, between paragraphs,
on figures, on tables and on headings. Each note is a box in document space passed to `describe`.

Each note records its truth: the words, the line, the paragraph, the picture or the table it was written
on. On version B the scorer finds that content with its own text search (not the module's), computes the
origin FORMAT "Units" asks for, and classifies the result of `resolve`:

| outcome      | meaning                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------- |
| right        | placed within tolerance of where the same anchor belongs on the content (max of 8 px and 0.75 em) |
| tray, gone   | in the tray and the content is truly gone (correct)                                               |
| tray, edited | in the tray and the words were reworded (counted as accounted, not as right)                      |
| miss         | in the tray but the content is still there                                                        |
| wrong        | placed, but not on the content, or placed when the content is gone or hidden (the worst outcome)  |
| hidden       | hidden with its content: the note is hidden and its content is there but closed on B (correct)    |

A note counts as hidden the way the viewer hides it: its anchor is found but not painted (not visible,
transparent with no fade running, or cut away by the ancestors that clip it), or not found while its element
still holds the quote unseen. A hidden note whose content is visible on B is a miss. Only content that was
painted on A can be closed on B, so text that is never shown (kept for screen readers, say) is scored as
before. Hidden notes are not counted as present when the right place rate is worked out.

Targets: 95% or better right place on document pages (of notes whose content still exists), 100% accounted
for, wrong place under 2%. When `describe` on version A puts the origin somewhere else than the truth rule
does, the scorer carries that offset to B and counts the note in `describeOff`, so describe problems show
up in the failure list.

### Truth rules

The truth looks for the content in this order, and stops at the first rule that finds it:

1. The words with their whole context on both sides (32 characters each), then with 12 characters each side.
2. The words with one whole side of their context: the text on the other side was edited, the words are at
   the same place.
3. The words in a block like the one they were written in (a loose match for a long quote found once).
4. The words were edited: the block is still there, and the place is found from what is left around them.

Context search ignores white space and footnote markers such as `[12]`, which are renumbered whenever a
reference is added above them. When the same context occurs more than once, the occurrence nearest the old
relative position wins. A gap note's neighbour above is also found by its last characters, since that end
borders the gap. A table is found by its caption, then by its place in the text with nearly the same header
row (a column added or removed), then by its header row and first column, then by a lightly edited header row
that no other table comes close to. When the anchor's own quote was edited away, its start is taken at the
same distance from the truth's words as it had on version A.

Each note is written in the layout the page has once the note is in view. Some pages lay out lazily
(`content-visibility`), so the harness scrolls to the note, waits for the page to render, and takes the note's
box again from the element it was drawn beside, until the layout stops moving. The truth on version A is
taken in that same layout. `corepack pnpm --filter pageink-testset run test` runs the tests of these rules.

## Tuning and held-out pairs

About a third of the real-content pairs (Wikipedia, docs, arXiv, blogs and news) carry `"heldout": true`
in `sources.json`. They were chosen once, by rule and before any tuning: a pair is held out when the
SHA-1 of its id, read as a number, is divisible by 3. New pairs follow the same rule. Work on the anchor
module uses `--split tuning`; the held-out numbers are reported separately and are never used to choose
a change. Layout runs take the split of the pair they reuse.

## How to run

From the repo root:

```
corepack pnpm --filter pageink-testset run fetch            # download and freeze every pair not yet frozen
corepack pnpm --filter pageink-testset run score            # score the baseline anchor
corepack pnpm --filter pageink-testset run score --anchor core   # score packages/core/src/anchor
```

`score` writes to `results/latest`. Use `--out` to keep the committed results.

Flags for `score`:

| flag                                     | meaning                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `--anchor baseline\|core\|<path>`        | module that exports `describe` and `createResolver`. Default `baseline`. |
| `--only id,id` / `--kind wikipedia,docs` | subset of pairs                                                          |
| `--widths 390,820,1280`                  | also resolve every content pair at these widths                          |
| `--no-layout`                            | skip the layout pairs                                                    |
| `--notes 20`                             | notes per page                                                           |
| `--quick`                                | synthetic, dynamic and three real pairs, two layout conditions each      |
| `--gate`                                 | exit 1 when a target is missed (for CI)                                  |
| `--split all\|tuning\|heldout`           | only the tuning pairs or only the held-out pairs. Default `all`          |
| `--out <path>`                           | output path without extension. Default `results/latest`                  |
| `--headed`                               | show the browser                                                         |

`score` runs headless Chromium fully offline: fixtures are served from disk, images are answered with
blank pictures of the recorded size, and every other request is blocked (the count is in the report).
It writes `results/latest.json` (every note, every failure with its cause fields) and `results/latest.md`.
Exit codes: 0 when the run completes, 1 with `--gate` when a target is missed, 2 when the harness fails.

`--anchor testset/baseline/faulty.ts` runs the baseline with known faults (every third note moved 60 px,
every fifth sent to the tray). The scorer must report them as wrong places and misses. Use it to check the
scorer after changing it.

Flags for `fetch`: `--only`, `--kind`, `--refresh` (freeze again), `--verify` (compare files with the
recorded checksums), `--concurrency`.

## Files

| path           | holds                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `sources.json` | every pair with its two addresses, licence and attribution; the layout sets and conditions       |
| `SOURCES.md`   | the same, for people, written by `fetch`                                                         |
| `fixtures/`    | frozen copies that may be redistributed, plus `synthetic/` and `dynamic/`                        |
| `cache/`       | frozen copies of everything else. Git-ignored, rebuilt by `fetch`                                |
| `src/`         | `fetch`, `add`, `score`, `probe`, the scorer tests, the freezer, the synthetic pages, the report |
| `page/`        | code that runs in the page: document text, note generator, truth and classifier                  |
| `baseline/`    | the baseline anchor: exact quote match plus element path                                         |
| `results/`     | the latest run                                                                                   |

A frozen page keeps its text, structure and stylesheets. Scripts, frames and fonts are removed. Images keep
their address and size. Each pair has a `meta.json` with the source address and a sha256 of each version.
Pairs that share a version share one frozen copy: the first pair keeps the file and the others name it in
their `meta.json`. Stylesheets are stored once in `_css/` by content hash.

## Looking into a failure

```
corepack pnpm --filter pageink-testset run probe <pair id> a|b <script.js> [--args ...] [--cond w390]
```

opens one version with the harness loaded and runs the script in the page. The script sees `T` (the harness),
`notes` (the notes written on version A, with what describe returned) and `args`. The anchor module's inner
functions are on `window.__inkInner`. Look into tuning pairs only; held-out pairs are for the final numbers.

## Adding a pair

```
corepack pnpm --filter pageink-testset run add wiki "Article title" 2025-09-01 2026-09-01 --change year --shape prose
corepack pnpm --filter pageink-testset run add wayback https://example.org/post 2023-01-01 2024-06-01 --kind wayback --shape article
corepack pnpm --filter pageink-testset run add arxiv 2404.19756
corepack pnpm --filter pageink-testset run add url my-id https://a.example/v1 https://a.example/v2 --kind docs --change docs-release --license "MIT" --commit
corepack pnpm --filter pageink-testset run fetch --only <new id>
```

`wiki` picks the last revision at or before each date. `wayback` picks the nearest snapshots with different
content. `arxiv` checks that HTML exists for v1 and v2 and commits the frozen copy only for CC BY and
CC BY-SA papers. Pass `--commit` only when the licence allows redistribution, and fill in `--license` and
`--attribution`. Everything else stays in `cache/`.

To add a layout set, add the pair id to `layouts` in `sources.json`. To add a synthetic change, add an
entry to `CHANGES` in `src/synthetic.ts`; `fetch` and `synthetic` rewrite the files.
