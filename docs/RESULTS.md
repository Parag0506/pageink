# Results

This page is written by `scripts/results.mjs` from the latest runs. Do not edit it by hand.
DESIGN.md sections 11 and 12 say what each number means and how it is measured.

## Speed budgets

Source: `bench/results/latest.json`, extension `bench/cache/ext-real` (PageInk 0.1.0), a copy of the Chrome bench build: the release code plus the performance marks the bench reads, run of 2026-11-20. 20 pages (11 replayed, 8 live, 1 local), 10 loads per arm on replayed and local pages and 20 on live pages, with and without the extension. Chrome/159.0.8154.6 headless on Apple M3 Pro, 11 cores, 18 GB, macOS kernel 25.3.0. Overall: **pass**.

| budget                                                                                 | result                                                                                                                                                                                                                                                                                                                                                                                                                                  | target                                                                                                                                                                                            | status   |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Extension time on the page's main thread, page with no ink                             | worst page median 4.13 ms (arxiv-html); highest single load 4.21 ms; stub self-timing worst median 0.75 ms                                                                                                                                                                                                                                                                                                                              | under 5 ms                                                                                                                                                                                        | pass     |
| First and largest paint, page with no ink                                              | no difference beyond noise that repeats, on all 20 pages                                                                                                                                                                                                                                                                                                                                                                                | no change beyond noise                                                                                                                                                                            | pass     |
| First paint of content under ink, held back by the extension                           | cold / warm: seed-lesson 4.2 ms (noise 14.8 ms) / 13.6 ms (noise 14.4 ms); seed-article 12.9 ms (noise 4.5 ms) / 10.5 ms (noise 8.1 ms); seed-lazy 12.5 ms (noise 7.7 ms) / 14.1 ms (noise 8.1 ms). Stress page, reported: cold 29.2 ms (noise 25.4 ms), loads without / with the extension 5 at 125.3 ms / 5 at 145.3 ms; warm 20.7 ms (noise 3.5 ms), loads without / with the extension 8 at 115.9 ms / 7 at 136.8 ms, 1 at 205.2 ms | at most 16.7 ms (one frame) on every seeded page, cold and warm                                                                                                                                   | pass     |
| Ink visible within 50 ms of its anchor content existing, cold browser                  | not met on stress-wikipedia 63.1 ms, the page first painted that content 63.3 ms after inserting it with the extension and 61.7 ms without it. Met on 3 of 4 seeded pages                                                                                                                                                                                                                                                               | within 50 ms                                                                                                                                                                                      | fail     |
| Ink visible within 50 ms of its anchor content existing, warm browser                  | not met on stress-wikipedia 57.1 ms, the page first painted that content 57.4 ms after inserting it with the extension and 51.6 ms without it. Met on 3 of 4 seeded pages                                                                                                                                                                                                                                                               | within 50 ms                                                                                                                                                                                      | fail     |
| Ink on screen with its content's first paint, cold browser                             | same frame in 19 of 20 loads; more than one frame late in 1 (stress-wikipedia 1 of 5); worst 17.0 ms (stress-wikipedia). Medians per page: all within one frame                                                                                                                                                                                                                                                                         | same frame, or within one frame (16.7 ms), every load                                                                                                                                             | fail     |
| Ink on screen with its content's first paint, warm browser                             | same frame in 32 of 32 loads; more than one frame late in 0 (none); worst 0.0 ms (seed-lesson). Medians per page: all within one frame                                                                                                                                                                                                                                                                                                  | same frame, or within one frame (16.7 ms), every load                                                                                                                                             | pass     |
| Ink script during a scripted scroll                                                    | 0 events                                                                                                                                                                                                                                                                                                                                                                                                                                | none                                                                                                                                                                                              | pass     |
| Long tasks caused by ink, 200 notes                                                    | 0 caused by ink; loads with a task over 50 ms: cold 1 of 20 with the extension, 12 of 20 alone, 10 of 20 with a do-nothing extension; warm 7 of 20 with the extension, 4 of 20 alone, 11 of 20 with a do-nothing extension. Longest task that ran ink script 40.6 ms, 3.5 ms of it ink; 0 such tasks over 50 ms. Longest page task with / without the extension: cold 46.8 ms / 73.0 ms, warm 49.9 ms / 48.0 ms                         | no task over 50 ms that would be within it without its ink part, or with over 50 ms of ink; loads with a long task no more often than with a do-nothing extension, beyond chance, in two measures | pass     |
| Ink's part of any one task, 200 notes                                                  | at most 9.5 ms, over 6 loads cold and warm                                                                                                                                                                                                                                                                                                                                                                                              | at most one frame (16.7 ms), every load                                                                                                                                                           | pass     |
| Pointer listeners: extension script while the mouse moves and the page scrolls, no ink | lesson: 6.72 ms for 400 pointer moves and 20 scrolls; wikipedia: 6.29 ms for 400 pointer moves and 20 scrolls                                                                                                                                                                                                                                                                                                                           | no budget, published                                                                                                                                                                              | measured |
| Pen-down to first pixel, first stroke on a page with no ink, background stopped        | median 23.4 ms (IQR 8.2 ms, max 30.3 ms, 10 loads)                                                                                                                                                                                                                                                                                                                                                                                      | no budget, published                                                                                                                                                                              | measured |
| Pen-down to first pixel, first stroke on a page with no ink, background running        | median 28.9 ms (IQR 2.4 ms, max 32.7 ms, 10 loads)                                                                                                                                                                                                                                                                                                                                                                                      | no budget, published                                                                                                                                                                              | measured |
| Pen-down to first pixel, later strokes                                                 | median 0.8 ms (IQR 0.6 ms, max 1.7 ms, 20 loads)                                                                                                                                                                                                                                                                                                                                                                                        | no budget, published                                                                                                                                                                              | measured |

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

| page          | type                           | mode   |   FCP difference |   LCP difference | extension ms | all frames ms (frames) | stub ms |
| ------------- | ------------------------------ | ------ | ---------------: | ---------------: | -----------: | ---------------------: | ------: |
| wikipedia     | Wikipedia article              | replay |    +8 (noise 11) |    +8 (noise 11) |         1.48 |               1.48 (0) |    0.40 |
| arxiv-html    | arXiv HTML paper               | replay |   +12 (noise 27) |   +40 (noise 43) |         4.13 |               4.13 (0) |    0.40 |
| mdn           | MDN reference                  | live   |     +2 (noise 8) |     +2 (noise 8) |         1.66 |               4.24 (3) |    0.50 |
| github-readme | GitHub README                  | replay |    +2 (noise 51) |    +2 (noise 51) |         1.78 |               1.78 (0) |    0.50 |
| news          | News article                   | live   | -18 (noise 1393) | -16 (noise 1393) |         2.73 |             15.54 (10) |    0.75 |
| docs          | Docs site                      | replay |    -4 (noise 27) |    -4 (noise 27) |         1.63 |               1.63 (0) |    0.50 |
| blog          | Long blog post                 | replay |      0 (noise 8) |      0 (noise 8) |         1.59 |               1.59 (0) |    0.50 |
| search        | Search results                 | replay |    +4 (noise 14) |   +2 (noise 155) |         1.82 |               1.86 (0) |    0.20 |
| video         | Video page                     | live   |  -66 (noise 258) |  +14 (noise 279) |         0.66 |               0.66 (0) |    0.20 |
| mail          | Web mail (public inbox)        | live   |   +12 (noise 67) |   +18 (noise 66) |         1.72 |               1.72 (0) |    0.60 |
| chat          | Chat app (web-public)          | replay |    -4 (noise 14) |              n/a |         1.67 |               1.67 (0) |    0.50 |
| shopping      | Shopping page                  | live   |  +14 (noise 142) |  +20 (noise 132) |         2.45 |               2.45 (0) |    0.75 |
| map           | Map                            | replay |    +2 (noise 15) |   -10 (noise 15) |         0.00 |               0.04 (0) |    0.40 |
| spreadsheet   | Spreadsheet app (public sheet) | live   |     0 (noise 81) |    -2 (noise 72) |         2.71 |               4.18 (1) |    0.75 |
| forum         | Forum thread                   | replay |    -8 (noise 10) |    -8 (noise 10) |         1.69 |               1.69 (0) |    0.50 |
| social        | Social feed                    | replay |    +6 (noise 14) |    +4 (noise 27) |         1.57 |               1.57 (0) |    0.45 |
| qa            | Q&A page                       | live   |    +4 (noise 13) |    +4 (noise 22) |         2.05 |               2.05 (0) |    0.60 |
| dashboard     | Dashboard (public demo)        | live   |   +12 (noise 27) |    -2 (noise 44) |         2.34 |               2.34 (0) |    0.55 |
| pdf           | PDF                            | replay |              n/a |              n/a |         2.07 |               2.07 (0) |    0.75 |
| lesson        | Book lesson (local stand-in)   | local  |    +8 (noise 10) |    +8 (noise 10) |         1.64 |               1.64 (0) |    0.55 |

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
| seed-lesson      |    17 |                                   16.0 |                                   15.1 |                             33.6 / 35.7; alone 9.5 / 11.8 |                    -0.4 / -0.3 | same frame / same frame |         13 of 13 | 12, 48, 7, 14, 27    |                    0 |
| seed-article     |    19 |                                   17.4 |                                   16.8 |                            17.8 / 17.1; alone 10.0 / 15.1 |                    -0.3 / -0.3 | same frame / same frame |         13 of 13 | 13, 46, 7, 16, 29    |                    0 |
| seed-wikipedia   |    20 | none in first screen (all notes 202.1) | none in first screen (all notes 189.6) |                                n/a / n/a; alone n/a / n/a |                      n/a / n/a |                     n/a |              n/a | 52, 110, 12, 36, 119 |                    0 |
| seed-lazy        |    20 |                                   18.1 |                                   17.9 |                            18.4 / 18.8; alone 10.0 / 15.3 |                    -0.4 / -0.7 | same frame / same frame |         13 of 13 | 819, 52, 8, 18, 32   |                    0 |
| stress-wikipedia |   200 |                                   63.1 |                                   57.1 |                            63.3 / 57.4; alone 61.7 / 51.6 |                    -0.2 / -0.2 | same frame / same frame |         12 of 13 | 148, 102, 13, 45, 80 |           see stress |

Stress: 200 notes on `fixture:wiki-mars-month/a.html`. 3 traced loads per arm: cold (a new browser on a stored profile) and warm (one browser, after one discarded load), each with and without the extension. A task counts against the budget when it is over 50 ms and would have been within it without its ink part, or when its ink part alone is over 50 ms. The ink part is the time inside ink calls, layout they forced included. It must also be at most one frame in every task. A long task that ran ink script counts too in an arm where the page without the extension never had a long task. Longest task per load, with the extension: cold 46.8 ms, 39.9 ms, 39.8 ms, warm 46.0 ms, 49.9 ms, 40.0 ms. Without it: cold 40.2 ms, 73.0 ms, 71.9 ms, warm 47.3 ms, 43.5 ms, 48.0 ms. Longest main-thread task that ran ink script: 40.6 ms, of which 3.5 ms was inside ink calls (layout they forced included) and the rest the page's own work. Ink script events while scrolling it: 0.

Pointer listeners. The stub listens for pointerdown, pointermove, pointerup, pointercancel and click
on window in the capture phase, so it runs on every pointer move. Each run moves the mouse 400 times
and scrolls 20 times on a page with no ink. Extension ms is from a trace, which slows each call, so it
is an upper bound. Script ms is all script on the page over the same activity, untraced, without and
with the extension.

| page      | mode   | pointer moves | extension ms | per move | script ms, without / with      |
| --------- | ------ | ------------: | -----------: | -------: | ------------------------------ |
| lesson    | local  |           400 |      6.72 ms |  16.8 µs | 1.9 / 3.9 ms (+2, noise 0.5)   |
| wikipedia | replay |           400 |      6.29 ms | 15.73 µs | 2.3 / 3.9 ms (+1.6, noise 0.2) |

Pen-down to first pixel. A pen stroke on `local:lesson.html`, a page with no ink, so the
tools are not in the page yet. Time from the pen-down event to the call that paints the stroke's first
pixel; the pixel reaches the screen with the next frame. Background stopped: a fresh browser whose
extension background was stopped after the page loaded, so the pen-down wakes it before it can inject
the viewer and the tools. Background running: the same browser, a new load of the page. Later strokes:
the second and third strokes on the first page. The first load of each arm is discarded.

| stroke                                         | median ms | IQR ms | max ms | loads |
| ---------------------------------------------- | --------: | -----: | -----: | ----: |
| first stroke, background stopped               |      23.4 |    8.2 |   30.3 |    10 |
| first stroke, background running               |      28.9 |    2.4 |   32.7 |    10 |
| later strokes                                  |       0.8 |    0.6 |    1.7 |    20 |
| injecting viewer and tools, background stopped |      13.0 |    4.8 |   18.5 |    10 |
| injecting viewer and tools, background running |      14.5 |    1.6 |   16.0 |    10 |

Code that runs in pages, minified, in the bench build measured here (its performance marks included): stub 3,366 B (every page), first read 7,198 B and viewer 119,148 B (registered on sites with ink), tools 80,898 B (injected on the first pen-down or the draw toggle). Release sizes are in [CONTRACT.md](CONTRACT.md) section 5.

Findings, from this run and from repeats and traces of the same pages on the same machine:

- The first storage read now starts in a small script of its own (content/boot.js, 7 KB), registered ahead of the viewer, so the reply is on its way while the viewer is compiled. On the seeded lesson, article and lazy pages the ink was in the same frame as its content's first paint in 39 of 39 loads, cold and warm, 15.1 to 18.1 ms after the content was inserted (medians).
- First paint of the content under ink, held back by the extension, cold and warm: seed-lesson 4.2 and 13.6 ms, seed-article 12.9 and 10.5 ms, seed-lazy 12.5 and 14.1 ms. The budget is one frame, 16.7 ms, and every judged page meets it. The lesson page was at 17.1 and 18.9 ms before this build. Three things changed: the first read moved ahead of the viewer, the first placement reads the page's colours only until the page has painted, and a stored record is checked without building the name of each field unless a field fails. The lesson pairs were noisy in this run (14.8 and 14.4 ms), so read its two numbers together with the other pages.
- The 200-note page (stress-wikipedia) is reported and not judged for that measure, because the page alone paints its first screen in two ways from load to load. In this run the extension held its paint back 29.2 ms cold (noise 25.4 ms) and 20.7 ms warm (noise 3.5 ms).
- The 50 ms from anchor insert is not met on stress-wikipedia: its ink is in the page 63.1 ms (cold) and 57.1 ms (warm) after its content. The page alone, with no extension, painted that content 61.7 ms (cold) and 51.6 ms (warm) after inserting it, so the page's own layout takes the 50 ms. The ink was in the same frame as that paint in 12 of 13 loads. In one cold load it came 17.0 ms after the paint, a third of a millisecond over one frame.
- A compile hint for V8 (allFunctionsCalledOnLoad) on the viewer was tried and taken out. With the hint, 30 of 40 cold loads of the stress page ran their first update as one task over 50 ms; without it, 6 of 20; with an extension that does nothing, 24 of 50. Those counts were taken before this run. Every page script is now compiled the browser's usual way, and a test keeps the hint out.
- The stress page runs its first update as one long task in some loads and as two shorter ones in others, with or without an extension. So the long task rule now compares how often: 20 loads per arm, cold and warm, with PageInk, with the page alone, and with an extension that does nothing. It fails when PageInk has a long task more often than the do-nothing extension beyond chance (one-sided Fisher test, under 0.05) in two measures in a row. In this run: cold 1 of 20 with PageInk, 12 of 20 alone, 10 of 20 with the do-nothing extension; warm 7 of 20, 4 of 20 and 11 of 20. A stub with a 40 ms busy loop in it fails this rule every time it was tried.
- No task was made long by ink. The longest task that ran ink script was 40.6 ms, 3.5 ms of it ink. The largest ink part of any one task was 9.5 ms, against a limit of one frame.
- The docking read skips content a closed section hides (content-visibility, until-found, a closed details), which no reader can see, and stops when its slice of time is up. Placements are the same as before: the anchor test set is unchanged at 3,963 notes, 99.4% right and 0.3% wrong.
- Pen-down to first pixel with the background stopped took 15.4 to 30.3 ms over 10 loads, median 23.4 ms. Injecting the viewer and the tools is 13 ms of that at the median and 18.5 ms at most. What makes one load faster than another was not traced, so about 30 ms is the number to plan with.
- arxiv-html has the highest extension time on a page with no ink in this run, 4.13 ms (budget 5 ms), then news at 2.73 ms and spreadsheet at 2.71 ms. On arxiv-html most of it is ScriptInjection::InjectJs, the cost of injecting the stub into the page and the same-site frames it embeds. The stub's own timing was 0.75 ms at worst.
- The quick check that runs on GitHub once showed first paint 40 to 100 ms later with PageInk than with the do-nothing extension. The bench caused it: after seeding, it closed every tab in the PageInk browser only, so that arm loaded its pages in a browser with no other tab. Each arm now keeps one blank tab. On GitHub's 2-core machine the first paint without and with PageInk is then 72 and 76 ms on the lesson page, 92 and 96 ms on the article, and 288 and 284 ms on Wikipedia. When that check fails on a paint it now loads the page again with a full trace and puts the task list in its report.
- Cold loads use a new browser on a profile whose record and registration are stored. Chrome counts an extension loaded with --load-extension as updated on every start, which clears its registered scripts; the background registers the viewer again from storage about 50 ms after the start, and the bench waits for that. A store install keeps the registration across restarts.
- macOS background services and an editor used two to three of the machine's 11 cores during the second half of this run. The pair noise on the lesson page is higher than in earlier runs for that reason.

Notes from the run:

- mdn: the stub was also injected into 3 frames in other processes; 4.24 ms over all renderer main threads
- news: the stub was also injected into 10 frames in other processes; 15.54 ms over all renderer main threads
- spreadsheet: the stub was also injected into 1 frame in other processes; 4.18 ms over all renderer main threads
- seed-wikipedia: no note has its anchor in the first screen, so the budget has nothing to time (cold). Worst lag over all notes, drawn in idle time below the screen: 202.1 ms (median)
- seed-wikipedia: no note has its anchor in the first screen, so the budget has nothing to time (warm). Worst lag over all notes, drawn in idle time below the screen: 189.6 ms (median)
- stress-wikipedia: first paint of the content under ink held back 29.2 ms by the extension (cold, pairs, noise 25.4 ms); reported, not judged
- stress-wikipedia: first paint of the content under ink held back 20.7 ms by the extension (warm, pairs, noise 3.5 ms); reported, not judged

## Anchor test set

Source: `testset/results/latest.json`, anchor module `packages/core/src/anchor/index.ts`, run of 2026-11-18. 3,963 notes. Overall: **pass**.

| measure                                                           | result | target          | status |
| ----------------------------------------------------------------- | -----: | --------------- | ------ |
| Right place, of notes whose content still exists (document pages) |  99.4% | 95.0% or better | pass   |
| Accounted for, placed or in the tray (all runs)                   | 100.0% | 100.0%          | pass   |
| Wrong place (document pages)                                      |   0.3% | under 2.0%      | pass   |

Notes in the tray because their content is truly gone: 92 on document pages.
In the tray after their words were edited: 3. In the tray although the content is still
there (misses): 11. Slowest page to resolve all its notes: 34.5 ms (py-stdtypes-311-313).

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
| media       |   381 |   361 |             8 |    2 |     5 |            98.4% |  1.3% |
| text        |  2602 |  2490 |            94 |    5 |     7 |            99.5% |  0.3% |

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
