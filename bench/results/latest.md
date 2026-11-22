# Bench results

Extension: `bench/cache/ext-real` (PageInk 0.1.1, files 0dc6c5022a5b). Browser: Chrome/159.0.8154.6, headless. Machine: Apple M3 Pro, 11 cores, 18 GB, darwin 25.3.0.

10 loads per arm on replayed and local pages, 20 on live pages, after one discarded load per arm. Settle 1500 ms. Started 2026-11-22T18:55:54.599Z, took 3413 s.

**PASS**

## Overhead on pages with no ink

Medians in ms, without / with the extension (difference, noise as the larger interquartile range of the two arms). A star marks a difference larger than the noise and than one frame (16.7 ms). A slower star is measured again; it counts only when it repeats. "Extension ms" is time in the extension on the page's own main thread from traced loads: injecting the stub (world setup included) and every task that ran its code. The budget applies to it. "All frames" adds the main threads of frames from other sites, which run in their own processes beside the page, and how many such frames got the stub.

| page | type | mode | FCP | LCP | stub ms | extension ms, page thread | all frames, other processes | failed loads |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| wikipedia | Wikipedia article | replay | 114 / 122 (+8, noise 15) | 114 / 122 (+8, noise 15) | 0.45 | 1.62 (max 2.27) | 1.62, 0 | 0 |
| arxiv-html | arXiv HTML paper | replay | 270 / 278 (+8, noise 46) | 368 / 398 (+30, noise 56) | 0.40 | 4.27 (max 5.22) | 4.27, 0 | 0 |
| mdn | MDN reference | live | 92 / 80 (-12, noise 32) | 92 / 80 (-12, noise 32) | 0.50 | 1.88 (max 1.94) | 6.13, 3 | 0 |
| github-readme | GitHub README | replay | 270 / 224 (-46, noise 46) | 270 / 224 (-46, noise 46) | 0.50 | 1.72 (max 1.74) | 1.72, 0 | 0 |
| news | News article | live | 3236 / 3304 (+68, noise 1827) | 3342 / 3420 (+78, noise 1868) | 0.85 | 3.97 (max 10.47) | 10.98, 4 | 0 |
| docs | Docs site | replay | 106 / 100 (-6, noise 19) | 106 / 100 (-6, noise 19) | 0.70 | 1.60 (max 1.85) | 1.60, 0 | 0 |
| blog | Long blog post | replay | 40 / 40 (+0, noise 7) | 40 / 40 (+0, noise 7) | 0.50 | 1.62 (max 1.72) | 1.62, 0 | 0 |
| search | Search results | replay | 106 / 102 (-4, noise 17) | 124 / 120 (-4, noise 18) | 0.20 | 1.80 (max 2.19) | 1.84, 0 | 0 |
| video | Video page | live | 1378 / 1360 (-18, noise 257) | 1836 / 1838 (+2, noise 301) | 0.30 | 1.07 (max 1.89) | 1.07, 0 | 0 |
| mail | Web mail (public inbox) | live | 1056 / 1062 (+6, noise 114) | 1056 / 1062 (+6, noise 114) | 1.00 | 2.98 (max 4.27) | 2.98, 0 | 0 |
| chat | Chat app (web-public) | replay | 78 / 86 (+8, noise 19) | NaN / NaN (NaN, noise NaN) | 0.45 | 1.61 (max 1.62) | 1.65, 0 | 0 |
| shopping | Shopping page | live | 2566 / 2590 (+24, noise 850) | 3114 / 3178 (+64, noise 286) | 0.90 | 4.19 (max 4.65) | 4.19, 0 | 0 |
| map | Map | replay | 128 / 124 (-4, noise 13) | 208 / 188 (-20, noise 40) | 0.55 | 0.00 (max 1.65) | 0.04, 0 | 0 |
| spreadsheet | Spreadsheet app (public sheet) | live | 1548 / 1530 (-18, noise 551) | 1580 / 1558 (-22, noise 552) | 1.00 | 3.63 (max 5.10) | 5.41, 1 | 0 |
| forum | Forum thread | replay | 204 / 192 (-12, noise 15) | 204 / 192 (-12, noise 15) | 0.40 | 1.52 (max 1.63) | 1.52, 0 | 0 |
| social | Social feed | replay | 204 / 200 (-4, noise 23) | 380 / 368 (-12, noise 39) | 0.45 | 1.75 (max 1.86) | 1.75, 0 | 0 |
| qa | Q&A page | live | 1986.6 / 2016.4 (+29.8, noise 228) | 1986.6 / 2016.4 (+29.8, noise 228) | 0.86 | 2.81 (max 3.98) | 4.76, 1 | 0 |
| dashboard | Dashboard (public demo) | live | 1204 / 1294 (+90, noise 495) | NaN / NaN (NaN, noise NaN) | 1.25 | 2.73 (max 3.26) | 2.73, 0 | 0 |
| pdf | PDF | replay | NaN / 42 (NaN, noise NaN) | NaN / 42 (NaN, noise NaN) | 0.70 | 2.20 (max 5.35) | 2.27, 0 | 0 |
| lesson | Book lesson (local stand-in) | local | 36 / 40 (+4, noise 4) | 36 / 40 (+4, noise 4) | 0.50 | 1.55 (max 1.60) | 1.55, 0 | 0 |

Live pages and why:

- mdn: 8 of 133 requests not in the recording
- news: replay did not load
- video: registers a service worker; 21 of 174 requests not in the recording; replay shows 2413 of 5823 characters
- mail: 4 of 31 requests not in the recording
- shopping: 49 of 255 requests not in the recording
- spreadsheet: replay did not load
- qa: replay did not load; live status 403 (anti-bot answer)
- dashboard: 38 of 251 requests not in the recording

## Pointer listeners

The stub listens for pointerdown, pointermove, pointerup, pointercancel and click on window in the capture phase. Each run moves the mouse 400 times and scrolls 20 times on a page with no ink. "Extension ms" is main-thread time in the extension's scripts over the whole activity, from a trace (median of 3 runs; tracing itself makes each call slower, so this is an upper bound). "Script ms" is all script time on the page over the same activity without tracing, without / with the extension (medians, difference, noise).

| page | mode | pointer events | extension ms (traced) | µs per event | script ms, without / with |
| --- | --- | ---: | ---: | ---: | --- |
| lesson | local | 400 | 7.51 | 18.77 | 2.2 / 4.4 (+2.1, noise 0.4) |
| wikipedia | replay | 400 | 6.76 | 16.9 | 2.4 / 4.5 (+2.1, noise 0.2) |

## Ink visible and scroll

Per load, the worst lag over notes whose anchor is in the first screen: when the note's ink was inserted into the layer, minus when its anchor element was inserted into the page (DESIGN 11). Medians over loads in ms (max in brackets). "After first paint" counts from the content's first paint, which the page reports through element timing (else the later of the insert and the first contentful paint, which is no later than the real paint); below zero, the ink was in the page before that paint, so both appear in the same frame. It must be within one frame (16.7 ms) in every case. "Seen" is what a reader sees: 0 when the ink was in the same frame as its content's first paint, else how much later. The first measure must be within 50 ms when the page painted that content soon enough to allow it ("content waits" is how long the page itself took to first paint the content after inserting it). "Next frame" is the same lag to the start of the first frame after the insert. Cold is a returning reader: a new browser on a profile where the viewer's registration for the host is already stored. Warm is the same browser after one discarded load. The timeline is the warm median, ms from navigation: last anchor inserted, first contentful paint, stub start, viewer start (after the storage read), the product's ink:first-ink mark.

| page | notes | cold | warm | cold, after first paint | warm, after first paint | seen, cold / warm | same frame, loads | content waits, cold / warm | warm, next frame | first screen drawn | warm timeline | ink script events during scroll |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| seed-lesson | 17 | 16.3 (16.5) | 18.8 (20.2) | -0.3 (-0.3) | -0.4 (-0.3) | 0 / 0 | 13 of 13 | 34.4 / 31.4 | 10.8 | 6 of 6 | 13.5, 44, 7.5, 15.6, 33.1 | 0 |
| seed-article | 19 | 17.8 (21.5) | 17.5 (21.5) | -0.3 (-0.3) | -0.4 (-0.3) | 0 / 0 | 13 of 13 | 18.1 / 17.9 | 13 | 4 of 4 | 13.1, 48, 7.4, 16.6, 30.6 | 0 |
| seed-wikipedia | 20 | none in first screen; all notes 199 | none in first screen; all notes 192.1 | NaN (NaN) | NaN (NaN) | NaN / NaN | 0 of 13 | NaN / NaN | NaN | 0 of 0 | 48.5, 118, 12.2, 35.8, 112.1 | 0 |
| seed-lazy | 20 | 17.6 (19.6) | 17.6 (21.5) | -0.4 (-0.3) | -0.7 (-0.3) | 0 / 0 | 13 of 13 | 18 / 18.2 | 18.4 | 5 of 5 | 816.9, 48, 7.2, 16.7, 30.6 | 0 |
| stress-wikipedia | 200 | 60.5 (114) | 57.5 (113.4) | -0.2 (-0.2) | -0.2 (-0.2) | 0 / 0 | 13 of 13 | 60.9 / 57.8 | 52.7 | 5 of 5 | 150, 102, 12.6, 45.7, 81.1 | see stress |

## First paint of content under ink

How long the extension held back the first paint of the content that has ink on it. Loads with the extension (no probe) and with no extension at all, interleaved, cold and warm as above. Per load: when the last first-screen anchor that element timing reports was first painted, ms from navigation; the same anchors in both arms. "Held back" is the median of the differences within pairs of loads taken back to back, one per arm, with the interquartile range of those differences as noise; this takes out drift of the machine over the run. An arm whose loads fall into groups more than a frame apart, each with at least a third of the loads and three, is compared group by group and the largest difference counts (src/judge.ts); every group is listed. "Insert to paint" is the longest wait of one of those anchors from its insert to its first paint, without / with the extension. Budget on the seeded pages: at most 16.7 ms (one frame). The stress page is reported.

| page | arm | without, ms (groups) | with, ms (groups) | held back, ms | noise, ms | compared | insert to paint, without / with | anchors timed |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| seed-lesson | cold | 23.9 (5 loads) | 33.4 (5 loads) | 9.5 | 10.4 | pairs | 10.4 / 16.6 | 25 of 30 |
| seed-lesson | warm | 17.6 (7 at 16.9, 1 at 43.3) | 33.4 (8 loads) | 16.1 | 10.7 | pairs | 9.3 / 18.6 | 40 of 48 |
| seed-article | cold | 20.3 (5 loads) | 35.1 (5 loads) | 14.8 | 1.6 | pairs | 10.8 / 19.2 | 20 of 20 |
| seed-article | warm | 22.9 (8 loads) | 32.9 (8 loads) | 10.8 | 10.8 | pairs | 15.7 / 18.4 | 32 of 32 |
| seed-wikipedia | cold | NaN (0 loads) | NaN (0 loads) | NaN | NaN | medians | NaN / NaN | 0 of 0 |
| seed-wikipedia | warm | NaN (0 loads) | NaN (0 loads) | NaN | NaN | medians | NaN / NaN | 0 of 0 |
| seed-lazy | cold | 21.5 (5 loads) | 35.4 (5 loads) | 13.6 | 7.1 | pairs | 9 / 19.5 | 25 of 25 |
| seed-lazy | warm | 21.9 (8 loads) | 31.9 (8 loads) | 11.3 | 5.2 | pairs | 16.1 / 19.1 | 40 of 40 |
| stress-wikipedia | cold | 129.5 (5 loads) | 137.2 (5 loads) | 6.5 | 3.7 | pairs | 58.5 / 107.4 | 15 of 15 |
| stress-wikipedia | warm | 115.3 (8 loads) | 138.6 (8 loads) | 24.2 | 12.8 | pairs | 50.9 / 60.2 | 24 of 24 |

## Stress

200 notes on `fixture:wiki-mars-month/a.html`, 3 traced loads per arm: cold (a new browser on a stored profile) and warm (one browser, after one discarded load), each with and without the extension. A task counts against the budget when it is over 50 ms and would have been within it without its ink part (time inside ink calls, layout they forced included), or when the ink part alone is over 50 ms. The ink part of any one task must also be at most one frame (16.7 ms). A long task that ran ink script, in an arm where the page without the extension never had a long task, counts too.

Long tasks caused by ink: 0. Largest ink part of one task: 9.4 ms. Long tasks seen only with the extension in the traced loads: 0. Verdict: pass.

How often a load had a task over 50 ms, 20 loads per arm traced with tasks only, interleaved. The page runs its first update as one long task in some loads and as two shorter ones in others, so the rule asks whether loads with the extension have a long task more often than loads with a do-nothing extension, beyond chance (one-sided Fisher test, under 0.05), in a first measure and again in a second one. The page alone is counted beside them.

| arm | with the extension | page alone | control extension | chance, against alone / control | verdict |
| --- | ---: | ---: | ---: | --- | --- |
| cold | 2 of 20 | 14 of 20 | 11 of 20 | 1.000 / 1.000 | pass |
| warm | 4 of 20 | 4 of 20 | 5 of 20 | 0.653 / 0.775 | pass |

| arm | longest task, with / without the extension | tasks over 50 ms, with / without | longest task that ran ink script (its ink part) |
| --- | --- | --- | --- |
| cold | 44, 37.8, 39.9 / 73.1, 72.7, 42.8 ms | 0 / 2 | 39.9 ms (3.4 ms) |
| warm | 40, 52.1, 48.9 / 70.3, 42.8, 42.3 ms | 1 / 1 | 40 ms (3.6 ms) |

Longest main-thread task that ran ink script, over all loads: 40 ms, of which 3.6 ms was inside ink calls and the rest the page's own work. Tasks over 50 ms with ink script: 0. Ink script events during a scroll of the page: 0.

## Pen-down to first pixel

A pen stroke on `local:lesson.html`, a page with no ink. Time from the pen-down event to the call that paints the stroke's first pixel (the bench build's ink:pen-first-pixel measure); the pixel reaches the screen with the next frame. Cold: a fresh browser, the extension's background stopped, so the first pen-down wakes it, which then injects the viewer and the tools. Warm: the same browser, background running, a new load of the page. Later: the second and third strokes on the cold page. Medians in ms, interquartile range, max, loads; the first of each arm is discarded.

| stroke | median | IQR | max | n |
| --- | ---: | ---: | ---: | ---: |
| first, cold background | 16 | 1.9 | 21.3 | 10 |
| first, warm background | 29.1 | 4.2 | 39.9 | 10 |
| later strokes | 0.9 | 1 | 1.7 | 20 |
| injecting viewer and tools, cold | 8.3 | 0.6 | 13.3 | 10 |
| injecting viewer and tools, warm | 14.1 | 2 | 23.2 | 10 |

## Notes

- mdn: the stub was also injected into 3 frames in other processes; 6.13 ms over all renderer main threads
- news: the stub was also injected into 4 frames in other processes; 10.98 ms over all renderer main threads
- spreadsheet: the stub was also injected into 1 frame in other processes; 5.41 ms over all renderer main threads
- qa: the stub was also injected into 1 frame in other processes; 4.76 ms over all renderer main threads
- seed-wikipedia: no note has its anchor in the first screen, so the budget has nothing to time (cold). Worst lag over all notes, drawn in idle time below the screen: 199 ms (median)
- seed-wikipedia: no note has its anchor in the first screen, so the budget has nothing to time (warm). Worst lag over all notes, drawn in idle time below the screen: 192.1 ms (median)
- stress-wikipedia: first paint of the content under ink held back 6.5 ms by the extension (cold, pairs, noise 3.7 ms); reported, not judged
- stress-wikipedia: first paint of the content under ink held back 24.2 ms by the extension (warm, pairs, noise 12.8 ms); reported, not judged
