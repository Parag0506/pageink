# Bench results

Extension: `bench/cache/ext-real` (PageInk 0.1.0, files 0197b75df5de). Browser: Chrome/159.0.8154.6, headless. Machine: Apple M3 Pro, 11 cores, 18 GB, darwin 25.3.0.

10 loads per arm on replayed and local pages, 20 on live pages, after one discarded load per arm. Settle 1500 ms. Started 2026-11-20T20:08:12.749Z, took 2598 s.

**PASS**

## Overhead on pages with no ink

Medians in ms, without / with the extension (difference, noise as the larger interquartile range of the two arms). A star marks a difference larger than the noise and than one frame (16.7 ms). A slower star is measured again; it counts only when it repeats. "Extension ms" is time in the extension on the page's own main thread from traced loads: injecting the stub (world setup included) and every task that ran its code. The budget applies to it. "All frames" adds the main threads of frames from other sites, which run in their own processes beside the page, and how many such frames got the stub.

| page | type | mode | FCP | LCP | stub ms | extension ms, page thread | all frames, other processes | failed loads |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| wikipedia | Wikipedia article | replay | 108 / 116 (+8, noise 11) | 108 / 116 (+8, noise 11) | 0.40 | 1.48 (max 1.89) | 1.48, 0 | 0 |
| arxiv-html | arXiv HTML paper | replay | 248 / 260 (+12, noise 27) | 348 / 388 (+40, noise 43) | 0.40 | 4.13 (max 4.21) | 4.13, 0 | 0 |
| mdn | MDN reference | live | 78 / 80 (+2, noise 8) | 78 / 80 (+2, noise 8) | 0.50 | 1.66 (max 3.20) | 4.24, 3 | 0 |
| github-readme | GitHub README | replay | 252 / 254 (+2, noise 51) | 252 / 254 (+2, noise 51) | 0.50 | 1.78 (max 1.82) | 1.78, 0 | 0 |
| news | News article | live | 2370 / 2352 (-18, noise 1393) | 2370 / 2354 (-16, noise 1393) | 0.75 | 2.73 (max 3.55) | 15.54, 10 | 0 |
| docs | Docs site | replay | 100 / 96 (-4, noise 27) | 100 / 96 (-4, noise 27) | 0.50 | 1.63 (max 1.82) | 1.63, 0 | 0 |
| blog | Long blog post | replay | 42 / 42 (+0, noise 8) | 42 / 42 (+0, noise 8) | 0.50 | 1.59 (max 1.60) | 1.59, 0 | 0 |
| search | Search results | replay | 100 / 104 (+4, noise 14) | 120 / 122 (+2, noise 155) | 0.20 | 1.82 (max 2.09) | 1.86, 0 | 0 |
| video | Video page | live | 884 / 818 (-66, noise 258) | 2074 / 2088 (+14, noise 279) | 0.20 | 0.66 (max 0.94) | 0.66, 0 | 0 |
| mail | Web mail (public inbox) | live | 162 / 174 (+12, noise 67) | 1330 / 1348 (+18, noise 66) | 0.60 | 1.72 (max 2.23) | 1.72, 0 | 0 |
| chat | Chat app (web-public) | replay | 74 / 70 (-4, noise 14) | NaN / NaN (NaN, noise NaN) | 0.50 | 1.67 (max 1.87) | 1.67, 0 | 0 |
| shopping | Shopping page | live | 506 / 520 (+14, noise 142) | 574 / 594 (+20, noise 132) | 0.75 | 2.45 (max 3.43) | 2.45, 0 | 0 |
| map | Map | replay | 122 / 124 (+2, noise 15) | 188 / 178 (-10, noise 15) | 0.40 | 0.00 (max 1.64) | 0.04, 0 | 0 |
| spreadsheet | Spreadsheet app (public sheet) | live | 332 / 332 (+0, noise 81) | 366 / 364 (-2, noise 72) | 0.75 | 2.71 (max 3.14) | 4.18, 1 | 0 |
| forum | Forum thread | replay | 196 / 188 (-8, noise 10) | 196 / 188 (-8, noise 10) | 0.50 | 1.69 (max 1.87) | 1.69, 0 | 0 |
| social | Social feed | replay | 194 / 200 (+6, noise 14) | 354 / 358 (+4, noise 27) | 0.45 | 1.57 (max 1.87) | 1.57, 0 | 0 |
| qa | Q&A page | live | 148 / 152 (+4, noise 13) | 184 / 188 (+4, noise 22) | 0.60 | 2.05 (max 2.19) | 2.05, 0 | 0 |
| dashboard | Dashboard (public demo) | live | 164 / 176 (+12, noise 27) | 1602 / 1600 (-2, noise 44) | 0.55 | 2.34 (max 2.76) | 2.34, 0 | 0 |
| pdf | PDF | replay | NaN / 38 (NaN, noise NaN) | NaN / 38 (NaN, noise NaN) | 0.75 | 2.07 (max 2.77) | 2.07, 0 | 0 |
| lesson | Book lesson (local stand-in) | local | 32 / 40 (+8, noise 10) | 32 / 40 (+8, noise 10) | 0.55 | 1.64 (max 2.23) | 1.64, 0 | 0 |

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
| lesson | local | 400 | 6.72 | 16.8 | 1.9 / 3.9 (+2, noise 0.5) |
| wikipedia | replay | 400 | 6.29 | 15.73 | 2.3 / 3.9 (+1.6, noise 0.2) |

## Ink visible and scroll

Per load, the worst lag over notes whose anchor is in the first screen: when the note's ink was inserted into the layer, minus when its anchor element was inserted into the page (DESIGN 11). Medians over loads in ms (max in brackets). "After first paint" counts from the content's first paint, which the page reports through element timing (else the later of the insert and the first contentful paint, which is no later than the real paint); below zero, the ink was in the page before that paint, so both appear in the same frame. It must be within one frame (16.7 ms) in every case. "Seen" is what a reader sees: 0 when the ink was in the same frame as its content's first paint, else how much later. The first measure must be within 50 ms when the page painted that content soon enough to allow it ("content waits" is how long the page itself took to first paint the content after inserting it). "Next frame" is the same lag to the start of the first frame after the insert. Cold is a returning reader: a new browser on a profile where the viewer's registration for the host is already stored. Warm is the same browser after one discarded load. The timeline is the warm median, ms from navigation: last anchor inserted, first contentful paint, stub start, viewer start (after the storage read), the product's ink:first-ink mark.

| page | notes | cold | warm | cold, after first paint | warm, after first paint | seen, cold / warm | same frame, loads | content waits, cold / warm | warm, next frame | first screen drawn | warm timeline | ink script events during scroll |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| seed-lesson | 17 | 16 (18.4) | 15.1 (19.5) | -0.4 (-0.3) | -0.3 (-0.2) | 0 / 0 | 13 of 13 | 33.6 / 35.7 | 13.9 | 6 of 6 | 12.4, 48, 7.1, 14.4, 27.3 | 0 |
| seed-article | 19 | 17.4 (20.4) | 16.8 (19.1) | -0.3 (-0.3) | -0.3 (-0.2) | 0 / 0 | 13 of 13 | 17.8 / 17.1 | 11.7 | 4 of 4 | 13, 46, 7.4, 16.3, 29.4 | 0 |
| seed-wikipedia | 20 | none in first screen; all notes 202.1 | none in first screen; all notes 189.6 | NaN (NaN) | NaN (NaN) | NaN / NaN | 0 of 13 | NaN / NaN | NaN | 0 of 0 | 51.5, 110, 11.6, 36.3, 119.4 | 0 |
| seed-lazy | 20 | 18.1 (19.8) | 17.9 (21.1) | -0.4 (-0.3) | -0.7 (-0.4) | 0 / 0 | 13 of 13 | 18.4 / 18.8 | 17.8 | 5 of 5 | 819.2, 52, 8.4, 17.9, 31.8 | 0 |
| stress-wikipedia | 200 | 63.1 (132.8) | 57.1 (59) | -0.2 (17) | -0.2 (-0.1) | 0 / 0 | 12 of 13 | 63.3 / 57.4 | 51.1 | 5 of 5 | 148.1, 102, 13.3, 45.2, 80.1 | see stress |

## First paint of content under ink

How long the extension held back the first paint of the content that has ink on it. Loads with the extension (no probe) and with no extension at all, interleaved, cold and warm as above. Per load: when the last first-screen anchor that element timing reports was first painted, ms from navigation; the same anchors in both arms. "Held back" is the median of the differences within pairs of loads taken back to back, one per arm, with the interquartile range of those differences as noise; this takes out drift of the machine over the run. An arm whose loads fall into groups more than a frame apart, each with at least a third of the loads and three, is compared group by group and the largest difference counts (src/judge.ts); every group is listed. "Insert to paint" is the longest wait of one of those anchors from its insert to its first paint, without / with the extension. Budget on the seeded pages: at most 16.7 ms (one frame). The stress page is reported.

| page | arm | without, ms (groups) | with, ms (groups) | held back, ms | noise, ms | compared | insert to paint, without / with | anchors timed |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| seed-lesson | cold | 23.7 (5 loads) | 28.3 (5 loads) | 4.2 | 14.8 | pairs | 9.5 / 15.9 | 25 of 30 |
| seed-lesson | warm | 19.3 (7 at 15.8, 1 at 58) | 30.3 (8 loads) | 13.6 | 14.4 | pairs | 11.8 / 15.9 | 40 of 48 |
| seed-article | cold | 18.5 (5 loads) | 31.4 (5 loads) | 12.9 | 4.5 | pairs | 10 / 18.1 | 20 of 20 |
| seed-article | warm | 22.7 (8 loads) | 30.3 (8 loads) | 10.5 | 8.1 | pairs | 15.1 / 17.3 | 32 of 32 |
| seed-wikipedia | cold | NaN (0 loads) | NaN (0 loads) | NaN | NaN | medians | NaN / NaN | 0 of 0 |
| seed-wikipedia | warm | NaN (0 loads) | NaN (0 loads) | NaN | NaN | medians | NaN / NaN | 0 of 0 |
| seed-lazy | cold | 21 (5 loads) | 31.2 (5 loads) | 12.5 | 7.7 | pairs | 10 / 18.4 | 25 of 25 |
| seed-lazy | warm | 21.7 (8 loads) | 33 (7 at 32.9, 1 at 60.3) | 14.1 | 8.1 | pairs | 15.3 / 18.7 | 40 of 40 |
| stress-wikipedia | cold | 125.3 (5 loads) | 145.3 (5 loads) | 29.2 | 25.4 | pairs | 61.7 / 65.9 | 15 of 15 |
| stress-wikipedia | warm | 115.9 (8 loads) | 137.2 (7 at 136.8, 1 at 205.2) | 20.7 | 3.5 | pairs | 51.6 / 58.7 | 24 of 24 |

## Stress

200 notes on `fixture:wiki-mars-month/a.html`, 3 traced loads per arm: cold (a new browser on a stored profile) and warm (one browser, after one discarded load), each with and without the extension. A task counts against the budget when it is over 50 ms and would have been within it without its ink part (time inside ink calls, layout they forced included), or when the ink part alone is over 50 ms. The ink part of any one task must also be at most one frame (16.7 ms). A long task that ran ink script, in an arm where the page without the extension never had a long task, counts too.

Long tasks caused by ink: 0. Largest ink part of one task: 9.5 ms. Long tasks seen only with the extension in the traced loads: 0. Verdict: pass.

How often a load had a task over 50 ms, 20 loads per arm traced with tasks only, interleaved. The page runs its first update as one long task in some loads and as two shorter ones in others, so the rule asks whether loads with the extension have a long task more often than loads with a do-nothing extension, beyond chance (one-sided Fisher test, under 0.05), in a first measure and again in a second one. The page alone is counted beside them.

| arm | with the extension | page alone | control extension | chance, against alone / control | verdict |
| --- | ---: | ---: | ---: | --- | --- |
| cold | 1 of 20 | 12 of 20 | 10 of 20 | 1.000 / 1.000 | pass |
| warm | 7 of 20 | 4 of 20 | 11 of 20 | 0.240 / 0.945 | pass |

| arm | longest task, with / without the extension | tasks over 50 ms, with / without | longest task that ran ink script (its ink part) |
| --- | --- | --- | --- |
| cold | 46.8, 39.9, 39.8 / 40.2, 73, 71.9 ms | 0 / 2 | 40.6 ms (3.5 ms) |
| warm | 46, 49.9, 40 / 47.3, 43.5, 48 ms | 0 / 0 | 40 ms (3.5 ms) |

Longest main-thread task that ran ink script, over all loads: 40.6 ms, of which 3.5 ms was inside ink calls and the rest the page's own work. Tasks over 50 ms with ink script: 0. Ink script events during a scroll of the page: 0.

## Pen-down to first pixel

A pen stroke on `local:lesson.html`, a page with no ink. Time from the pen-down event to the call that paints the stroke's first pixel (the bench build's ink:pen-first-pixel measure); the pixel reaches the screen with the next frame. Cold: a fresh browser, the extension's background stopped, so the first pen-down wakes it, which then injects the viewer and the tools. Warm: the same browser, background running, a new load of the page. Later: the second and third strokes on the cold page. Medians in ms, interquartile range, max, loads; the first of each arm is discarded.

| stroke | median | IQR | max | n |
| --- | ---: | ---: | ---: | ---: |
| first, cold background | 23.4 | 8.2 | 30.3 | 10 |
| first, warm background | 28.9 | 2.4 | 32.7 | 10 |
| later strokes | 0.8 | 0.6 | 1.7 | 20 |
| injecting viewer and tools, cold | 13 | 4.8 | 18.5 | 10 |
| injecting viewer and tools, warm | 14.5 | 1.6 | 16 | 10 |

## Notes

- mdn: the stub was also injected into 3 frames in other processes; 4.24 ms over all renderer main threads
- news: the stub was also injected into 10 frames in other processes; 15.54 ms over all renderer main threads
- spreadsheet: the stub was also injected into 1 frame in other processes; 4.18 ms over all renderer main threads
- seed-wikipedia: no note has its anchor in the first screen, so the budget has nothing to time (cold). Worst lag over all notes, drawn in idle time below the screen: 202.1 ms (median)
- seed-wikipedia: no note has its anchor in the first screen, so the budget has nothing to time (warm). Worst lag over all notes, drawn in idle time below the screen: 189.6 ms (median)
- stress-wikipedia: first paint of the content under ink held back 29.2 ms by the extension (cold, pairs, noise 25.4 ms); reported, not judged
- stress-wikipedia: first paint of the content under ink held back 20.7 ms by the extension (warm, pairs, noise 3.5 ms); reported, not judged
