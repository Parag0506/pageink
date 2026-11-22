# Results

This page is written by `scripts/results.mjs` from the latest runs. Do not edit it by hand.
DESIGN.md sections 11 and 12 say what each number means and how it is measured.

## Speed budgets

Source: `bench/results/latest.json`, extension `bench/cache/ext-real` (PageInk 0.1.1), a copy of the Chrome bench build: the release code plus the performance marks the bench reads, run of 2026-11-22. 20 pages (11 replayed, 8 live, 1 local), 10 loads per arm on replayed and local pages and 20 on live pages, with and without the extension. Chrome/159.0.8154.6 headless on Apple M3 Pro, 11 cores, 18 GB, macOS kernel 25.3.0. Overall: **pass**.

| budget                                                                                 | result                                                                                                                                                                                                                                                                                                                                                                                                                   | target                                                                                                                                                                                            | status   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Extension time on the page's main thread, page with no ink                             | worst page median 4.27 ms (arxiv-html); highest single load 10.47 ms; stub self-timing worst median 1.25 ms                                                                                                                                                                                                                                                                                                              | under 5 ms                                                                                                                                                                                        | pass     |
| First and largest paint, page with no ink                                              | no difference beyond noise that repeats, on all 20 pages                                                                                                                                                                                                                                                                                                                                                                 | no change beyond noise                                                                                                                                                                            | pass     |
| First paint of content under ink, held back by the extension                           | cold / warm: seed-lesson 9.5 ms (noise 10.4 ms) / 16.1 ms (noise 10.7 ms); seed-article 14.8 ms (noise 1.6 ms) / 10.8 ms (noise 10.8 ms); seed-lazy 13.6 ms (noise 7.1 ms) / 11.3 ms (noise 5.2 ms). Stress page, reported: cold 6.5 ms (noise 3.7 ms), loads without / with the extension 5 at 129.5 ms / 5 at 137.2 ms; warm 24.2 ms (noise 12.8 ms), loads without / with the extension 8 at 115.3 ms / 8 at 138.6 ms | at most 16.7 ms (one frame) on every seeded page, cold and warm                                                                                                                                   | pass     |
| Ink visible within 50 ms of its anchor content existing, cold browser                  | not met on stress-wikipedia 60.5 ms, the page first painted that content 60.9 ms after inserting it with the extension and 58.5 ms without it. Met on 3 of 4 seeded pages                                                                                                                                                                                                                                                | within 50 ms                                                                                                                                                                                      | fail     |
| Ink visible within 50 ms of its anchor content existing, warm browser                  | not met on stress-wikipedia 57.5 ms, the page first painted that content 57.8 ms after inserting it with the extension and 50.9 ms without it. Met on 3 of 4 seeded pages                                                                                                                                                                                                                                                | within 50 ms                                                                                                                                                                                      | fail     |
| Ink on screen with its content's first paint, cold browser                             | same frame in 20 of 20 loads; more than one frame late in 0 (none); worst 0.0 ms (seed-lesson). Medians per page: all within one frame                                                                                                                                                                                                                                                                                   | same frame, or within one frame (16.7 ms), every load                                                                                                                                             | pass     |
| Ink on screen with its content's first paint, warm browser                             | same frame in 32 of 32 loads; more than one frame late in 0 (none); worst 0.0 ms (seed-lesson). Medians per page: all within one frame                                                                                                                                                                                                                                                                                   | same frame, or within one frame (16.7 ms), every load                                                                                                                                             | pass     |
| Ink script during a scripted scroll                                                    | 0 events                                                                                                                                                                                                                                                                                                                                                                                                                 | none                                                                                                                                                                                              | pass     |
| Long tasks caused by ink, 200 notes                                                    | 0 caused by ink; loads with a task over 50 ms: cold 2 of 20 with the extension, 14 of 20 alone, 11 of 20 with a do-nothing extension; warm 4 of 20 with the extension, 4 of 20 alone, 5 of 20 with a do-nothing extension. Longest task that ran ink script 40.0 ms, 3.6 ms of it ink; 0 such tasks over 50 ms. Longest page task with / without the extension: cold 44.0 ms / 73.1 ms, warm 52.1 ms / 70.3 ms           | no task over 50 ms that would be within it without its ink part, or with over 50 ms of ink; loads with a long task no more often than with a do-nothing extension, beyond chance, in two measures | pass     |
| Ink's part of any one task, 200 notes                                                  | at most 9.4 ms, over 6 loads cold and warm                                                                                                                                                                                                                                                                                                                                                                               | at most one frame (16.7 ms), every load                                                                                                                                                           | pass     |
| Pointer listeners: extension script while the mouse moves and the page scrolls, no ink | lesson: 7.51 ms for 400 pointer moves and 20 scrolls; wikipedia: 6.76 ms for 400 pointer moves and 20 scrolls                                                                                                                                                                                                                                                                                                            | no budget, published                                                                                                                                                                              | measured |
| Pen-down to first pixel, first stroke on a page with no ink, background stopped        | median 16.0 ms (IQR 1.9 ms, max 21.3 ms, 10 loads)                                                                                                                                                                                                                                                                                                                                                                       | no budget, published                                                                                                                                                                              | measured |
| Pen-down to first pixel, first stroke on a page with no ink, background running        | median 29.1 ms (IQR 4.2 ms, max 39.9 ms, 10 loads)                                                                                                                                                                                                                                                                                                                                                                       | no budget, published                                                                                                                                                                              | measured |
| Pen-down to first pixel, later strokes                                                 | median 0.9 ms (IQR 1.0 ms, max 1.7 ms, 20 loads)                                                                                                                                                                                                                                                                                                                                                                         | no budget, published                                                                                                                                                                              | measured |

How each number is taken:

- Public pages are recorded once and replayed from the recording in both arms, so the runs with and
  without the extension get the same bytes. Replay goes through request routing, which turns off the
  HTTP cache in both arms alike. A page that cannot be replayed faithfully (a service worker, requests
  that change on every load, an anti-bot answer) is loaded live, with more loads, in both arms with
  the HTTP cache on. Local pages are served by the bench.
- The arms are interleaved, the first load of each arm is discarded, and paint times are compared by
  median, with the larger interquartile range of the two arms as the noise. A slower paint counts only
  when the difference is larger than the noise and than one frame (16.7 ms), and the same holds in a
  second, separate run of that page.
- Extension main-thread time comes from traced loads. It is everything tagged with the extension:
  injecting the stub (creating its script world included), the stub's own code, and its storage read.
  The budget is about the page's own main thread. The stub also runs in every frame, and frames from
  other sites have their own processes and main threads; their time is shown beside it.
- The extension measured is the bench build, which the bench builds itself: the release code plus
  the performance marks the bench reads. Release builds carry no marks.
- Ink visible: a probe extension, loaded only for these runs, records when each note's ink is inserted
  into the PageInk layer. The page records when each anchor element is inserted, and when the browser
  first painted it (element timing, else the later of the insert and the first contentful paint, which
  can only make the lag look longer). The lag is the worst note whose anchor is in the first screen.
  It is reported two ways: from the anchor content being inserted (the design's measure, 50 ms), and
  from that content's first paint, which is what a reader sees (same frame, or within one frame). Ink
  cannot be on screen before the page's own first layout and paint of its content. Cold is a returning
  reader: a new browser on a profile whose record and viewer registration are already stored, with no
  page loaded before. Warm is the same browser after one discarded load.
- First paint of content under ink: each seeded page is loaded with the extension (no probe) and with
  no extension, cold and warm, the two arms taken in pairs back to back. Per load, the time from
  navigation to the first paint of the last first-screen anchor that element timing reports, the same
  anchors in both arms. Held back is the median of the differences within the pairs, which takes out
  drift of the machine, with their interquartile range as the noise. It counts everything the extension
  does before that paint: its scripts while the page parses, the viewer's start and the first placement.
  An arm whose loads fall into groups more than a frame apart, each with at least a third of the
  loads and three, is compared group by group, the largest difference counts, and the groups are listed. The
  budget is one frame (16.7 ms): ink comes in the same frame as its content, so a frame is the most a
  reader can be made to wait for the page to show it.

Pages with no ink. FCP and LCP: difference in median ms with the extension minus without, and the
noise. Extension ms: median time in the extension per load on the page's own main thread, which the
budget is about. All frames: the same plus the main threads of frames from other sites, which run in
their own processes beside the page, and in brackets how many such frames got the stub.

| page          | type                           | mode   |    FCP difference |    LCP difference | extension ms | all frames ms (frames) | stub ms |
| ------------- | ------------------------------ | ------ | ----------------: | ----------------: | -----------: | ---------------------: | ------: |
| wikipedia     | Wikipedia article              | replay |     +8 (noise 15) |     +8 (noise 15) |         1.62 |               1.62 (0) |    0.45 |
| arxiv-html    | arXiv HTML paper               | replay |     +8 (noise 46) |    +30 (noise 56) |         4.27 |               4.27 (0) |    0.40 |
| mdn           | MDN reference                  | live   |    -12 (noise 32) |    -12 (noise 32) |         1.88 |               6.13 (3) |    0.50 |
| github-readme | GitHub README                  | replay |    -46 (noise 46) |    -46 (noise 46) |         1.72 |               1.72 (0) |    0.50 |
| news          | News article                   | live   |  +68 (noise 1827) |  +78 (noise 1868) |         3.97 |              10.98 (4) |    0.85 |
| docs          | Docs site                      | replay |     -6 (noise 19) |     -6 (noise 19) |         1.60 |               1.60 (0) |    0.70 |
| blog          | Long blog post                 | replay |       0 (noise 7) |       0 (noise 7) |         1.62 |               1.62 (0) |    0.50 |
| search        | Search results                 | replay |     -4 (noise 17) |     -4 (noise 18) |         1.80 |               1.84 (0) |    0.20 |
| video         | Video page                     | live   |   -18 (noise 257) |    +2 (noise 301) |         1.07 |               1.07 (0) |    0.30 |
| mail          | Web mail (public inbox)        | live   |    +6 (noise 114) |    +6 (noise 114) |         2.98 |               2.98 (0) |    1.00 |
| chat          | Chat app (web-public)          | replay |     +8 (noise 19) |               n/a |         1.61 |               1.65 (0) |    0.45 |
| shopping      | Shopping page                  | live   |   +24 (noise 850) |   +64 (noise 286) |         4.19 |               4.19 (0) |    0.90 |
| map           | Map                            | replay |     -4 (noise 13) |    -20 (noise 40) |         0.00 |               0.04 (0) |    0.55 |
| spreadsheet   | Spreadsheet app (public sheet) | live   |   -18 (noise 551) |   -22 (noise 552) |         3.63 |               5.41 (1) |    1.00 |
| forum         | Forum thread                   | replay |    -12 (noise 15) |    -12 (noise 15) |         1.52 |               1.52 (0) |    0.40 |
| social        | Social feed                    | replay |     -4 (noise 23) |    -12 (noise 39) |         1.75 |               1.75 (0) |    0.45 |
| qa            | Q&A page                       | live   | +29.8 (noise 228) | +29.8 (noise 228) |         2.81 |               4.76 (1) |    0.86 |
| dashboard     | Dashboard (public demo)        | live   |   +90 (noise 495) |               n/a |         2.73 |               2.73 (0) |    1.25 |
| pdf           | PDF                            | replay |               n/a |               n/a |         2.20 |               2.27 (0) |    0.70 |
| lesson        | Book lesson (local stand-in)   | local  |      +4 (noise 4) |      +4 (noise 4) |         1.55 |               1.55 (0) |    0.50 |

Pages measured live, and why:

- mdn: 8 of 133 requests not in the recording
- news: replay did not load
- video: registers a service worker; 21 of 174 requests not in the recording; replay shows 2413 of 5823 characters
- mail: 4 of 31 requests not in the recording
- shopping: 49 of 255 requests not in the recording
- spreadsheet: replay did not load
- qa: replay did not load; live status 403 (anti-bot answer)
- dashboard: 38 of 251 requests not in the recording

Seeded pages. Medians over loads in ms, for the worst note whose anchor is in the first screen.
Cold and warm: from the anchor content being inserted to its ink being inserted, the design's measure
(within 50 ms). Content waits: how long the page took to first paint that content after inserting
it, with the extension, and beside it with no extension at all (page alone, the same element timing on
the same loads). The difference is what the extension adds before that paint. After first
paint: ink insert minus the content's first paint; below zero, the ink was already in the page. Seen:
what a reader sees, "same frame" when the ink was painted with its content, else how much later.
Same-frame loads counts cold and warm loads where every first-screen note was in the same frame. A
page with no note in the first screen shows the worst lag over all its notes instead; those are drawn
in idle time below the screen and are not timed against the budget. The warm timeline is ms from
navigation: last anchor inserted, first contentful paint, stub start, viewer start (after the stub's
storage read), first ink mark.

| page             | notes |                                   cold |                                   warm | content waits with the extension, cold / warm; page alone | after first paint, cold / warm |       seen, cold / warm | same-frame loads | warm timeline        | ink events in scroll |
| ---------------- | ----: | -------------------------------------: | -------------------------------------: | --------------------------------------------------------: | -----------------------------: | ----------------------: | ---------------: | -------------------- | -------------------: |
| seed-lesson      |    17 |                                   16.3 |                                   18.8 |                             34.4 / 31.4; alone 10.4 / 9.3 |                    -0.3 / -0.4 | same frame / same frame |         13 of 13 | 14, 44, 8, 16, 33    |                    0 |
| seed-article     |    19 |                                   17.8 |                                   17.5 |                            18.1 / 17.9; alone 10.8 / 15.7 |                    -0.3 / -0.4 | same frame / same frame |         13 of 13 | 13, 48, 7, 17, 31    |                    0 |
| seed-wikipedia   |    20 | none in first screen (all notes 199.0) | none in first screen (all notes 192.1) |                                n/a / n/a; alone n/a / n/a |                      n/a / n/a |                     n/a |              n/a | 49, 118, 12, 36, 112 |                    0 |
| seed-lazy        |    20 |                                   17.6 |                                   17.6 |                             18.0 / 18.2; alone 9.0 / 16.1 |                    -0.4 / -0.7 | same frame / same frame |         13 of 13 | 817, 48, 7, 17, 31   |                    0 |
| stress-wikipedia |   200 |                                   60.5 |                                   57.5 |                            60.9 / 57.8; alone 58.5 / 50.9 |                    -0.2 / -0.2 | same frame / same frame |         13 of 13 | 150, 102, 13, 46, 81 |           see stress |

Stress: 200 notes on `fixture:wiki-mars-month/a.html`. 3 traced loads per arm: cold (a new browser on a stored profile) and warm (one browser, after one discarded load), each with and without the extension. A task counts against the budget when it is over 50 ms and would have been within it without its ink part, or when its ink part alone is over 50 ms. The ink part is the time inside ink calls, layout they forced included. It must also be at most one frame in every task. A long task that ran ink script counts too in an arm where the page without the extension never had a long task. Longest task per load, with the extension: cold 44.0 ms, 37.8 ms, 39.9 ms, warm 40.0 ms, 52.1 ms, 48.9 ms. Without it: cold 73.1 ms, 72.7 ms, 42.8 ms, warm 70.3 ms, 42.8 ms, 42.3 ms. Longest main-thread task that ran ink script: 40.0 ms, of which 3.6 ms was inside ink calls (layout they forced included) and the rest the page's own work. Ink script events while scrolling it: 0.

Pointer listeners. The stub listens for pointerdown, pointermove, pointerup, pointercancel and click
on window in the capture phase, so it runs on every pointer move. Each run moves the mouse 400 times
and scrolls 20 times on a page with no ink. Extension ms is from a trace, which slows each call, so it
is an upper bound. Script ms is all script on the page over the same activity, untraced, without and
with the extension.

| page      | mode   | pointer moves | extension ms | per move | script ms, without / with      |
| --------- | ------ | ------------: | -----------: | -------: | ------------------------------ |
| lesson    | local  |           400 |      7.51 ms | 18.77 µs | 2.2 / 4.4 ms (+2.1, noise 0.4) |
| wikipedia | replay |           400 |      6.76 ms |  16.9 µs | 2.4 / 4.5 ms (+2.1, noise 0.2) |

Pen-down to first pixel. A pen stroke on `local:lesson.html`, a page with no ink, so the
tools are not in the page yet. Time from the pen-down event to the call that paints the stroke's first
pixel; the pixel reaches the screen with the next frame. Background stopped: a fresh browser whose
extension background was stopped after the page loaded, so the pen-down wakes it before it can inject
the viewer and the tools. Background running: the same browser, a new load of the page. Later strokes:
the second and third strokes on the first page. The first load of each arm is discarded.

| stroke                                         | median ms | IQR ms | max ms | loads |
| ---------------------------------------------- | --------: | -----: | -----: | ----: |
| first stroke, background stopped               |      16.0 |    1.9 |   21.3 |    10 |
| first stroke, background running               |      29.1 |    4.2 |   39.9 |    10 |
| later strokes                                  |       0.9 |    1.0 |    1.7 |    20 |
| injecting viewer and tools, background stopped |       8.3 |    0.6 |   13.3 |    10 |
| injecting viewer and tools, background running |      14.1 |    2.0 |   23.2 |    10 |

Code that runs in pages, minified, in the bench build measured here (its performance marks included): stub 3,366 B (every page), first read 7,198 B and viewer 119,225 B (registered on sites with ink), tools 84,997 B (injected on the first pen-down or the draw toggle). Release sizes are in [CONTRACT.md](CONTRACT.md) section 5.

Notes from the run:

- mdn: the stub was also injected into 3 frames in other processes; 6.13 ms over all renderer main threads
- news: the stub was also injected into 4 frames in other processes; 10.98 ms over all renderer main threads
- spreadsheet: the stub was also injected into 1 frame in other processes; 5.41 ms over all renderer main threads
- qa: the stub was also injected into 1 frame in other processes; 4.76 ms over all renderer main threads
- seed-wikipedia: no note has its anchor in the first screen, so the budget has nothing to time (cold). Worst lag over all notes, drawn in idle time below the screen: 199 ms (median)
- seed-wikipedia: no note has its anchor in the first screen, so the budget has nothing to time (warm). Worst lag over all notes, drawn in idle time below the screen: 192.1 ms (median)
- stress-wikipedia: first paint of the content under ink held back 6.5 ms by the extension (cold, pairs, noise 3.7 ms); reported, not judged
- stress-wikipedia: first paint of the content under ink held back 24.2 ms by the extension (warm, pairs, noise 12.8 ms); reported, not judged

## Anchor test set

Source: `testset/results/latest.json`, anchor module `packages/core/src/anchor/index.ts`, run of 2026-11-22. 3,963 notes. Overall: **pass**.

| measure                                                           | result | target          | status |
| ----------------------------------------------------------------- | -----: | --------------- | ------ |
| Right place, of notes whose content still exists (document pages) |  99.4% | 95.0% or better | pass   |
| Accounted for, placed or in the tray (all runs)                   | 100.0% | 100.0%          | pass   |
| Wrong place (document pages)                                      |   0.3% | under 2.0%      | pass   |

Notes in the tray because their content is truly gone: 92 on document pages.
In the tray after their words were edited: 3. In the tray although the content is still
there (misses): 11. Slowest page to resolve all its notes: 38.8 ms (py-stdtypes-311-313).

### By category of change

| category                 | notes | right | tray, correct | miss | wrong | right of present | wrong |
| ------------------------ | ----: | ----: | ------------: | ---: | ----: | ---------------: | ----: |
| arxiv-version            |    80 |    80 |             0 |    0 |     0 |           100.0% |  0.0% |
| blog-time                |    94 |    90 |             4 |    0 |     0 |           100.0% |  0.0% |
| docs-archive-time        |    80 |    60 |            19 |    1 |     0 |            98.4% |  0.0% |
| docs-release             |   472 |   447 |            17 |    5 |     3 |            98.7% |  0.6% |
| dyn-infinite-list        |    40 |    28 |            12 |    0 |     0 |            93.3% |  0.0% |
| dyn-lazy-article         |    38 |    31 |             7 |    0 |     0 |           100.0% |  0.0% |
| dyn-spa-route            |    40 |    20 |            20 |    0 |     0 |           100.0% |  0.0% |
| layout-dark              |   312 |   312 |             0 |    0 |     0 |           100.0% |  0.0% |
| layout-darkcss           |   312 |   312 |             0 |    0 |     0 |           100.0% |  0.0% |
| layout-w1280z150         |   312 |   312 |             0 |    0 |     0 |           100.0% |  0.0% |
| layout-w390              |   312 |   310 |             0 |    0 |     2 |            99.4% |  0.6% |
| layout-w390z150          |   312 |   310 |             0 |    0 |     2 |            99.4% |  0.6% |
| layout-w820              |   312 |   312 |             0 |    0 |     0 |           100.0% |  0.0% |
| news-edit                |    19 |     9 |            10 |    0 |     0 |           100.0% |  0.0% |
| news-front               |    14 |     1 |            13 |    0 |     0 |           100.0% |  0.0% |
| syn-collapse-accordion   |    20 |    15 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-collapse-details     |    19 |    14 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-collapse-menu        |    20 |    19 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-collapse-tabs        |    20 |    16 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-footnotes-renumbered |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-heading-renamed      |    19 |    19 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-ids-classes-renamed  |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-image-replaced       |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-list-reordered       |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-opening-rewritten    |    20 |    19 |             1 |    0 |     0 |            95.0% |  0.0% |
| syn-para-inserted        |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-quote-repeated       |    19 |    19 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-reopen-accordion     |    19 |    19 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-reopen-details       |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-reopen-menu          |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-reopen-tabs          |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-same                 |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-section-deleted      |    20 |    15 |             5 |    0 |     0 |           100.0% |  0.0% |
| syn-section-moved        |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-sentence-edited      |    19 |    17 |             1 |    1 |     0 |            89.5% |  0.0% |
| syn-sticky-sidebar       |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-table-column-removed |    19 |    19 |             0 |    0 |     0 |           100.0% |  0.0% |
| syn-twin-notes           |    20 |    20 |             0 |    0 |     0 |           100.0% |  0.0% |
| wiki-2year               |    60 |    57 |             3 |    0 |     0 |           100.0% |  0.0% |
| wiki-month               |   360 |   356 |             2 |    0 |     2 |            99.7% |  0.6% |
| wiki-year                |   340 |   312 |            20 |    4 |     4 |            97.8% |  1.2% |

### By page kind

| page kind | notes | right | tray, correct | miss | wrong | right of present | wrong |
| --------- | ----: | ----: | ------------: | ---: | ----: | ---------------: | ----: |
| arxiv     |    80 |    80 |             0 |    0 |     0 |           100.0% |  0.0% |
| docs      |   552 |   507 |            36 |    6 |     3 |            98.6% |  0.5% |
| dynamic   |   118 |    79 |            39 |    0 |     0 |            97.5% |  0.0% |
| layout    |  1872 |  1868 |             0 |    0 |     4 |            99.8% |  0.2% |
| synthetic |   454 |   431 |             7 |    1 |     0 |            99.3% |  0.0% |
| wayback   |   127 |   100 |            27 |    0 |     0 |           100.0% |  0.0% |
| wikipedia |   760 |   725 |            25 |    4 |     6 |            98.9% |  0.8% |

### By anchor type

| anchor type | notes | right | tray, correct | miss | wrong | right of present | wrong |
| ----------- | ----: | ----: | ------------: | ---: | ----: | ---------------: | ----: |
| block       |   980 |   939 |            32 |    4 |     1 |            99.4% |  0.1% |
| media       |   374 |   354 |             8 |    2 |     5 |            98.3% |  1.3% |
| text        |  2609 |  2497 |            94 |    5 |     7 |            99.5% |  0.3% |

## How to rerun

From the repository root:

```
corepack pnpm --filter pageink-testset run score --anchor core
corepack pnpm --filter pageink-bench run bench --ext real --anchor core --har record --skip-overhead --skip-ink --skip-pen
corepack pnpm --filter pageink-bench run bench --ext real --anchor core
corepack pnpm results
```

`score` writes `testset/results/latest.json`. `bench` builds the bench variant of the extension
itself and writes `bench/results/latest.json`. Run it on a quiet machine. Record the
public pages first with `--har record` (see `bench/README.md`). Live pages still vary with the network.
`corepack pnpm results` rewrites this page and
the tables in `README.md` and `docs/ANCHORING.md`. When the latest test set run scored a module other
than the one that ships, the script uses `testset/results/core.json` if that holds a run of the shipped
module.
