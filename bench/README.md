# Bench

Measures the speed budgets of DESIGN 11 in Playwright Chromium with an unpacked extension.

## What it measures

| budget                                                        | how                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stub under 5 ms of main-thread time on a page with no ink     | Traced loads. Everything on the main thread tagged with the extension: injecting the stub (its script world included), the stub's code and its storage read. The stub's own `ink:stub` measure is reported too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| No change in first paint and largest paint                    | N loads per page with and without the extension, interleaved, first load of each arm discarded. Medians and interquartile ranges. A slower paint counts only when it is beyond the noise and one frame, and repeats in a second, separate run of that page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| First paint of content under ink, held back at most one frame | Each seeded page loaded with the extension (no probe) and with no extension, interleaved, cold and warm, the first load of each warm arm discarded. Per load, when the last first-screen anchor that element timing reports was first painted, from navigation; the same anchors in both arms. Held back: the median of the differences within pairs of loads taken back to back, one per arm, which takes out drift of the machine; noise is the interquartile range of those differences. An arm whose loads fall into groups more than a frame apart, each with at least a third of the loads and three, is compared group by group and the largest difference counts; every group is reported. Judged on the seeded pages at 16.7 ms; the stress page is reported. The rule is in `src/judge.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Ink visible within 50 ms of its anchor content                | A record is seeded into extension storage, and the bench waits until the extension has registered its viewer for that host, as after the visit that wrote the ink. The page records when each anchor element is inserted and when the browser first painted it (element timing). A probe extension records when each note's ink is inserted into the layer. Worst note in the first screen, cold and warm, reported two ways: from the anchor being inserted (the 50 ms budget), and from the content's first paint, what a reader sees (same frame, or within one frame). The 50 ms holds when the page painted the content soon enough to allow it; how long the page took is reported. Every timed load must show the registered viewer's `ink:boot` mark, or the run stops                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| No script during scroll                                       | A scripted wheel scroll with tracing on, on every seeded page and the stress page. Any extension script event during it fails the run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| No long task over 50 ms caused by ink, 200 notes              | A 200-note record on a long page, traced from navigation, cold (a new browser on a stored profile) and warm (one browser, after one discarded load), and the same page as often without the extension. A task counts when it is over 50 ms and would have been within 50 ms without its ink part (time inside ink calls, layout they forced included), or when the ink part alone is over 50 ms. Whether the extension makes long tasks more common: the page runs its first update as one long task in some loads and as two shorter ones in others, so a few traced loads cannot tell. The page is also loaded 20 times per arm, cold and warm, interleaved, with the extension, alone and with the control extension, traced with tasks only, which barely slows it, and each load counts when its longest renderer task is over 50 ms. It fails when loads with the extension have one more often than loads with the control extension beyond chance (one-sided Fisher test under 0.05), in a first measure and again in a second one from scratch (`src/judge.ts` judgeOften). The page alone is counted and reported but is no baseline: with no extension the parser runs its chunks differently, and on a loaded machine the page alone was long more often than with the control extension. A long task with ink script in a traced arm where the page alone had none is reported. A second check: the ink part of any one task is at most one frame (16.7 ms). The longest task that ran extension script, its ink part and the count over 50 ms are reported as well, with the page's longest task without the extension beside them. The rule is in `src/verdict.ts`, tested by `corepack pnpm --filter pageink-bench test` |

It also times pen-down to first pixel on a page with no ink (`ink:pen-first-pixel`): the first stroke
with the extension's background stopped in a fresh browser, the first stroke with it running, and later
strokes. No budget; the numbers are published.

It also publishes the cost of the stub's pointer listeners: on a page with no ink the mouse moves 400
times and the page scrolls 20 times. The extension's script time over that activity is taken from a
trace, and all script time on the page is compared with and without the extension, untraced.

Per load it collects first paint, first contentful paint, largest contentful paint, total main-thread task
time (DevTools `TaskDuration`), long tasks, the stub measure and every `ink:` mark and measure.

## Pages

Pages are in `pages.json`: the 20 page types of DESIGN 11 with public addresses that need no sign-in,
plus local pages. `local:` addresses are served from `pages/`, `fixture:` addresses from the test set
fixtures (offline, so the ink measurements repeat exactly). `offline` pages are fixtures used by quick
mode, so CI does not need the network. Seeded records use real anchors: the notes are written on the
page with the test set note generator and `describe`.

Public pages are replayed from a recording so both arms get the same bytes. Record them first:

```
corepack pnpm --filter pageink-bench run bench --ext real --har record --skip-overhead --skip-ink
```

This loads each page live, saves it to `cache/har/<id>.har`, replays it once and compares. A page is
replayed only when the replay is faithful: no service worker, at most 5% of requests missing from the
recording, a first paint when the live page had one, and at least 80% of its text. The verdict and the
reason are in `cache/har/index.json`. Other pages are loaded live, with more loads, and labelled live in
the results. Replay goes through request routing, which turns off the HTTP cache. Live loads keep it on.
Both arms of a page always load it the same way.

## Probe

`probe-ext/` is a tiny extension loaded next to the measured one, only for the latency runs. It opens
the PageInk layer's closed shadow root with `chrome.dom.openOrClosedShadowRoot` and records when each note's
first stroke is inserted, without writing to the page. Scroll and stress runs load the measured
extension alone.

## Cold and warm

Cold is a returning reader. Per load, a fresh profile gets the record and the extension registers its
viewer for the host. That browser closes without loading a page, a new browser starts on the same
profile, and the page is loaded once the registration is in place. Chrome counts an extension loaded
with `--load-extension` as updated on every start, which clears its registered scripts; the background
registers them again from storage within about 50 ms of the start. A store install keeps them across
restarts, so the bench waits for that before the timed load. Warm is one browser after one discarded
load of each page.

## How to run

From the repo root:

```
corepack pnpm --filter pageink-bench run bench                                # dummy extension, 10 loads
corepack pnpm --filter pageink-bench run bench --ext real --anchor core       # the real extension
corepack pnpm --filter pageink-bench run bench --ext real --anchor core --quick --gate --out /tmp/bench   # CI
```

| flag                                          | meaning                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--ext dummy\|real\|<dir>`                    | unpacked extension. `real` builds the bench variant (`wxt build --mode bench`, the release code plus performance marks), copies `packages/extension/.output/chrome-mv3-bench` to `cache/ext-real` and measures the copy                                                                                                                               |
| `--pages id,id`                               | subset of pages (from `pages` and `offline`)                                                                                                                                                                                                                                                                                                          |
| `--loads 10`                                  | loads per page and arm on replayed and local pages                                                                                                                                                                                                                                                                                                    |
| `--live-loads 20`                             | loads per page and arm on live pages. Default twice `--loads`, at least 20                                                                                                                                                                                                                                                                            |
| `--har replay\|record\|off`                   | `replay` (default) uses recordings judged faithful. `record` records first. `off` loads every public page live                                                                                                                                                                                                                                        |
| `--anchor baseline\|core\|<path>`             | module used to write the seeded notes                                                                                                                                                                                                                                                                                                                 |
| `--settle 1500`                               | ms to wait after load before reading metrics                                                                                                                                                                                                                                                                                                          |
| `--skip-overhead`, `--skip-ink`, `--skip-pen` | skip the overhead, ink or pen part                                                                                                                                                                                                                                                                                                                    |
| `--seeded id,id\|none`                        | only these seeded pages in the ink part; `none` keeps only the stress page                                                                                                                                                                                                                                                                            |
| `--cold-loads 5`                              | cold loads per timed page                                                                                                                                                                                                                                                                                                                             |
| `--warm-loads 8`                              | warm loads per timed page, after the discarded one. Quick mode takes three                                                                                                                                                                                                                                                                            |
| `--long-loads 20`                             | loads per arm, cold and warm, traced with tasks only, for how often the stress page has a long task. Quick mode takes six                                                                                                                                                                                                                             |
| `--compare-ext <dir>`                         | another built extension as a fourth arm of that count, for study. Not judged                                                                                                                                                                                                                                                                          |
| `--explain id,id`                             | load these pages again per arm with a trace of the whole browser and report where the time went before the first paint. A quick run does this by itself for a page that painted later than with the control extension                                                                                                                                 |
| `--quick`                                     | offline pages only: three pages, five loads, two seeded pages (five cold and three warm loads), one stress run, one pointer page, three pen loads                                                                                                                                                                                                     |
| `--gate`                                      | exit 1 when a budget is missed (for CI)                                                                                                                                                                                                                                                                                                               |
| `--headed`                                    | show the browser                                                                                                                                                                                                                                                                                                                                      |
| `--traces <dir>`                              | keep the raw trace of each stress load, with the script stack of each forced layout, to find what a long task ran. The stacks slow the page, so those numbers are not for publishing. Seeded and stress loads of the latency parts are kept too, one file per load                                                                                    |
| `--profile`                                   | with `--traces`, the latency traces also hold sampled script stacks and frames, and each gets a `.cpuprofile` sampled every 25 µs beside it. Open them in the DevTools performance panel. Build with `INK_SOURCEMAP=1` to get `maps/` in the extension folder: the viewer and tools as built before they became plain scripts, with their source maps |
| `--out <path>`                                | where to write, without extension. Default `results/latest`                                                                                                                                                                                                                                                                                           |

### The quick gate in CI

The published budgets are fixed times measured by a full run on the machine named in the results.
That run judges every rule on every load, unscaled. A quick run (`--quick --gate`, what CI runs) is
on whatever machine CI gives it, so it judges in two kinds.

Rules that mean the same on any machine are judged in every quick run:

- no ink script events while scrolling;
- first and largest paint against the control extension (`control-ext/`, PageInk's shape with a
  background and a content script that do nothing), on the same pages in the same run: slower
  beyond the noise and one frame, and again when measured a second time. This takes out what any
  extension costs a page on that machine. The difference with no extension at all is reported;
- the harness itself working.

Fixed time limits (5 ms on the main thread, 50 ms to visible ink, one frame after the content's first
paint, one frame of first paint held back, one frame of ink in a task, 50 ms for a long task caused by
ink, and how often a load has a task over 50 ms) are judged only when the machine is fit to judge them. At the start
the bench measures the machine: the library's calibration work (the layout and script of
`calibrate()` in `packages/core/src/testkit.ts`), median of five in a page of the same Chromium, and
the cores the browser may use. It compares them with the measurement stored in the published
results (`meta.calibrate` in `results/latest.json`, written by every run). A machine with the
reference's operating system and at least 4 cores that is at most 1.25 times slower at that work is
fit: each fixed limit is judged at the limit times the measured ratio (never below 1). The bound is tight because the calibration work understates
a slow machine. On GitHub's 2-core runner it ran about 1.4 to 1.7 times slower than the reference,
while first paint ran 2.6 times slower and script injection about 7 times slower. So scaling a limit
by the calibration ratio is sound only on a machine close to the reference. The operating system
counts because the calibration work measures no painting, and another system paints with other code.
GitHub's 4-core Linux runner ran the calibration work 1.29 times slower than the reference Mac. It
held the first paint back 17 to 23 ms where the Mac measured 4 to 14, and it ran the stress page's
first update as one task of 37 to 50 ms where the Mac ran it in 47 to 73. So GitHub's runners judge
no fixed limit: they report each one. The budgets are judged by a run on the reference machine. Any other machine, or a run with no stored reference, does
not judge them: each such rule is reported as not judged, with the measured value, the published limit
and the reason, and it does not fail the run. `bench.md` opens with the machine, the reference, the
scale and every fixed rule with its value, its verdict at the published limit and its judged verdict,
so a run that judged nothing cannot pass for a pass of the budgets. The rule is in `src/judge.ts`,
tested by `corepack pnpm --filter pageink-bench test`.

A quick run takes few pairs for the first paint held back by the extension (five cold, three warm).
On a fit machine, a figure over its judged limit is measured again from scratch: the same page and
arm, pairs again. It fails only when the second figure is over the judged limit too. Otherwise the
run passes it and notes that it did not repeat, with both figures. A full run judges the median of
its pairs against the published limit, once, unscaled.

When a quick run finds a page painting later with PageInk than with the control extension, beyond
the noise and again in a second run, it loads that page three more times per arm (PageInk, control,
none) with a trace of the whole browser. `bench.md` then gets, per arm, the first contentful paint,
the time each process and thread was running tasks before it, the frames before it, when the first
extension call left the page, and the page's main-thread tasks. The raw traces are written beside
the report as `<out>.explain-<page>-<arm>-<n>.json.gz`, at most 18 MB in all. This changes no
verdict.

The stress page gets one traced load per arm in a quick run. How often a long task occurs is
counted over 6 loads per arm, cold and warm, traced with tasks only. On a fit machine it fails only
when the extension's loads have a long task more often than the control extension's beyond chance
twice. Six loads catch an extension that makes the long task happen in nearly every load. The count
is of loads over a fixed time, so a machine not fit to judge reports it and judges nothing. Ink is
drawn in the same frame as the content. Where the page's own first update runs a few ms under 50 ms,
that puts most loads over it (4 of 6 against 0 of 6 on GitHub's 4-core Linux runner, where the page
alone ran 37 to 47 ms). Where it runs well under or well over, the same ink changes no count. A long task caused by ink or a one-frame-of-ink
finding on a fit machine fails only when it repeats: the extension's side is loaded again, cold and
warm, and the same rule must flag a task there too.

`--cpu-throttle <n>` slows the main thread of every page n times, to study a slow machine. Its numbers
are not for publishing.

It writes `results/latest.json` and `results/latest.md`, over the committed results. Use `--out` to keep them. Exit codes: 0 when the run completes, 1 with
`--gate` when a budget is missed, 2 when the harness fails. Profiles, copies and recordings live in
`cache/` (git-ignored). Then `corepack pnpm results` writes `docs/RESULTS.md` and the tables in the
README and `docs/ANCHORING.md`.

The dummy extension in `dummy-ext/` does what an early stub did on a page without ink (one
`storage.local.get` of the site index and settings at `document_start`, one passive pen listener, the
`ink:stub` measure). When the index lists the page it draws the stored strokes into a closed shadow root
and marks `ink:svg`, so the overhead half of the harness can be checked without the real extension.
Its strokes are not in an `ink-layer` element, so the probe does not see them.

## Adding a page

Add an entry to `pages` in `pages.json` with an `id`, a `type` and a public `url` that needs no sign-in,
then record it with `--har record --pages <id>`. Set `live` to a reason to always load it live. For a
page that should carry ink, add an entry to `seeded` (`url`, optional `write` for a page whose content
arrives late, and the number of notes). The stress page is `stress`.
