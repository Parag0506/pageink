# Anchor test set results

Anchor module: `packages/core/src/anchor/index.ts`. Run started 2026-11-22T15:12:39.549Z, took 176 s.

**PASS  anchor packages/core/src/anchor/index.ts: right 99.4% of present (document pages, target 95.0%), accounted 100.0%, wrong 0.3% (target under 2.0%), 3963 notes in 203 runs**

| measure | document pages | all runs | target |
| --- | ---: | ---: | ---: |
| notes | 3845 | 3963 | |
| right place, of notes whose content still exists | 99.4% | 99.4% | 95.0% or better |
| accounted for (placed or in the tray) | 100.0% | 100.0% | 100% |
| wrong place | 0.3% | 0.3% | under 2.0% |
| in the tray and truly gone | 92 | 129 | |
| in the tray after the words were edited | 3 | 5 | |
| in the tray but still present (miss) | 11 | 11 | |
| hidden with content that is closed or hidden on B | 15 | 15 | |

Slowest page: 38.8 ms to resolve all its notes. Describe disagreed with the truth rule on A for 57 notes. Blocked network requests during replay: 2.


Held-out pairs were chosen by rule before any tuning (sources.json, `heldout`). Layout runs take the split of their fixture.

### By split

| group | notes | right | tray (correct) | hidden (correct) | miss | wrong | error | right of present | wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| heldout document pages | 1303 | 1245 | 40 | 0 | 5 | 13 | 0 | 99.0% | 1.0% |
| tuning document pages | 2542 | 2466 | 55 | 15 | 6 | 0 | 0 | 99.6% | 0.0% |
| tuning dynamic | 118 | 79 | 39 | 0 | 0 | 0 | 0 | 97.5% | 0.0% |

### By category of change

| group | notes | right | tray (correct) | hidden (correct) | miss | wrong | error | right of present | wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| arxiv-version | 80 | 80 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| blog-time | 94 | 90 | 4 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| docs-archive-time | 80 | 60 | 19 | 0 | 1 | 0 | 0 | 98.4% | 0.0% |
| docs-release | 472 | 447 | 17 | 0 | 5 | 3 | 0 | 98.7% | 0.6% |
| dyn-infinite-list | 40 | 28 | 12 | 0 | 0 | 0 | 0 | 93.3% | 0.0% |
| dyn-lazy-article | 38 | 31 | 7 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| dyn-spa-route | 40 | 20 | 20 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-dark | 312 | 312 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-darkcss | 312 | 312 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-w1280z150 | 312 | 312 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-w390 | 312 | 310 | 0 | 0 | 0 | 2 | 0 | 99.4% | 0.6% |
| layout-w390z150 | 312 | 310 | 0 | 0 | 0 | 2 | 0 | 99.4% | 0.6% |
| layout-w820 | 312 | 312 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| news-edit | 19 | 9 | 10 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| news-front | 14 | 1 | 13 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-accordion | 20 | 15 | 0 | 5 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-details | 19 | 14 | 0 | 5 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-menu | 20 | 19 | 0 | 1 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-tabs | 20 | 16 | 0 | 4 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-footnotes-renumbered | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-heading-renamed | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-ids-classes-renamed | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-image-replaced | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-list-reordered | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-opening-rewritten | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 95.0% | 0.0% |
| syn-para-inserted | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-quote-repeated | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-accordion | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-details | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-menu | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-tabs | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-same | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-section-deleted | 20 | 15 | 5 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-section-moved | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-sentence-edited | 19 | 17 | 1 | 0 | 1 | 0 | 0 | 89.5% | 0.0% |
| syn-sticky-sidebar | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-table-column-removed | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-twin-notes | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-2year | 60 | 57 | 3 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-month | 360 | 356 | 2 | 0 | 0 | 2 | 0 | 99.7% | 0.6% |
| wiki-year | 340 | 312 | 20 | 0 | 4 | 4 | 0 | 97.8% | 1.2% |

### By category of change and split

| group | notes | right | tray (correct) | hidden (correct) | miss | wrong | error | right of present | wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| arxiv-version (tuning) | 80 | 80 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| blog-time (heldout) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| blog-time (tuning) | 74 | 70 | 4 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| docs-archive-time (heldout) | 40 | 26 | 13 | 0 | 1 | 0 | 0 | 96.3% | 0.0% |
| docs-archive-time (tuning) | 40 | 34 | 6 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| docs-release (heldout) | 212 | 201 | 7 | 0 | 1 | 3 | 0 | 99.0% | 1.4% |
| docs-release (tuning) | 260 | 246 | 10 | 0 | 4 | 0 | 0 | 98.4% | 0.0% |
| dyn-infinite-list (tuning) | 40 | 28 | 12 | 0 | 0 | 0 | 0 | 93.3% | 0.0% |
| dyn-lazy-article (tuning) | 38 | 31 | 7 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| dyn-spa-route (tuning) | 40 | 20 | 20 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-dark (heldout) | 112 | 112 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-dark (tuning) | 200 | 200 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-darkcss (heldout) | 112 | 112 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-darkcss (tuning) | 200 | 200 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-w1280z150 (heldout) | 112 | 112 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-w1280z150 (tuning) | 200 | 200 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-w390 (heldout) | 112 | 110 | 0 | 0 | 0 | 2 | 0 | 98.2% | 1.8% |
| layout-w390 (tuning) | 200 | 200 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-w390z150 (heldout) | 112 | 110 | 0 | 0 | 0 | 2 | 0 | 98.2% | 1.8% |
| layout-w390z150 (tuning) | 200 | 200 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-w820 (heldout) | 112 | 112 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| layout-w820 (tuning) | 200 | 200 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| news-edit (heldout) | 19 | 9 | 10 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| news-front (tuning) | 14 | 1 | 13 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-accordion (tuning) | 20 | 15 | 0 | 5 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-details (tuning) | 19 | 14 | 0 | 5 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-menu (tuning) | 20 | 19 | 0 | 1 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-tabs (tuning) | 20 | 16 | 0 | 4 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-footnotes-renumbered (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-heading-renamed (tuning) | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-ids-classes-renamed (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-image-replaced (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-list-reordered (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-opening-rewritten (tuning) | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 95.0% | 0.0% |
| syn-para-inserted (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-quote-repeated (tuning) | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-accordion (tuning) | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-details (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-menu (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-tabs (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-same (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-section-deleted (tuning) | 20 | 15 | 5 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-section-moved (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-sentence-edited (tuning) | 19 | 17 | 1 | 0 | 1 | 0 | 0 | 89.5% | 0.0% |
| syn-sticky-sidebar (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-table-column-removed (tuning) | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-twin-notes (tuning) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-2year (tuning) | 60 | 57 | 3 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-month (heldout) | 160 | 156 | 2 | 0 | 0 | 2 | 0 | 99.4% | 1.3% |
| wiki-month (tuning) | 200 | 200 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-year (heldout) | 180 | 165 | 8 | 0 | 3 | 4 | 0 | 97.1% | 2.2% |
| wiki-year (tuning) | 160 | 147 | 12 | 0 | 1 | 0 | 0 | 98.7% | 0.0% |

### By page kind

| group | notes | right | tray (correct) | hidden (correct) | miss | wrong | error | right of present | wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| arxiv | 80 | 80 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| docs | 552 | 507 | 36 | 0 | 6 | 3 | 0 | 98.6% | 0.5% |
| dynamic | 118 | 79 | 39 | 0 | 0 | 0 | 0 | 97.5% | 0.0% |
| layout | 1872 | 1868 | 0 | 0 | 0 | 4 | 0 | 99.8% | 0.2% |
| synthetic | 454 | 431 | 7 | 15 | 1 | 0 | 0 | 99.3% | 0.0% |
| wayback | 127 | 100 | 27 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wikipedia | 760 | 725 | 25 | 0 | 4 | 6 | 0 | 98.9% | 0.8% |

### By anchor type

| group | notes | right | tray (correct) | hidden (correct) | miss | wrong | error | right of present | wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| block | 980 | 939 | 32 | 4 | 4 | 1 | 0 | 99.4% | 0.1% |
| media | 374 | 354 | 8 | 5 | 2 | 5 | 0 | 98.3% | 1.3% |
| text | 2609 | 2497 | 94 | 6 | 5 | 7 | 0 | 99.5% | 0.3% |

### By ladder method

| group | notes | right | tray (correct) | hidden (correct) | miss | wrong | error | right of present | wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| exact | 703 | 698 | 0 | 0 | 0 | 5 | 0 | 99.4% | 0.7% |
| fuzzy | 34 | 31 | 0 | 0 | 0 | 3 | 0 | 100.0% | 8.8% |
| hidden | 7 | 0 | 0 | 7 | 0 | 0 | 0 | 100.0% | 0.0% |
| media | 39 | 38 | 0 | 0 | 0 | 1 | 0 | 100.0% | 2.6% |
| path | 3035 | 3023 | 0 | 8 | 0 | 4 | 0 | 99.9% | 0.1% |
| tray | 145 | 0 | 134 | 0 | 11 | 0 | 0 | 0.0% | 0.0% |

### By note kind

| group | notes | right | tray (correct) | hidden (correct) | miss | wrong | error | right of present | wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| figure | 262 | 254 | 6 | 2 | 0 | 0 | 0 | 100.0% | 0.0% |
| gap | 215 | 209 | 4 | 0 | 2 | 0 | 0 | 99.1% | 0.0% |
| heading | 791 | 755 | 32 | 0 | 1 | 3 | 0 | 99.7% | 0.4% |
| line | 617 | 589 | 26 | 2 | 0 | 0 | 0 | 99.3% | 0.0% |
| margin-left | 401 | 382 | 15 | 2 | 2 | 0 | 0 | 99.2% | 0.0% |
| margin-right | 338 | 324 | 11 | 2 | 0 | 1 | 0 | 99.7% | 0.3% |
| table | 136 | 123 | 2 | 3 | 2 | 6 | 0 | 94.6% | 4.4% |
| word | 1203 | 1154 | 38 | 4 | 4 | 3 | 0 | 99.6% | 0.2% |

### By condition

| group | notes | right | tray (correct) | hidden (correct) | miss | wrong | error | right of present | wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dark | 312 | 312 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| darkcss | 312 | 312 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| w1280 | 2091 | 1922 | 134 | 15 | 11 | 9 | 0 | 99.0% | 0.4% |
| w1280z150 | 312 | 312 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| w390 | 312 | 310 | 0 | 0 | 0 | 2 | 0 | 99.4% | 0.6% |
| w390z150 | 312 | 310 | 0 | 0 | 0 | 2 | 0 | 99.4% | 0.6% |
| w820 | 312 | 312 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |

### By pair

| group | notes | right | tray (correct) | hidden (correct) | miss | wrong | error | right of present | wrong |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| arxiv-2402-03300 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| arxiv-2404-19756 @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| arxiv-2404-19756 @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| arxiv-2404-19756 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| arxiv-2404-19756 @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| arxiv-2404-19756 @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| arxiv-2404-19756 @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| arxiv-2404-19756 @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| arxiv-2405-04434 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| arxiv-2407-21783 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| blog-fowler-microservices @w1280 | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| blog-joel-test @w1280 | 14 | 14 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| blog-jvns-git @w1280 | 20 | 18 | 2 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| blog-overreacted-useeffect @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| blog-simonw-llm @w1280 | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| django-models-42-52 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| django-tutorial01-42-52 @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| django-tutorial01-42-52 @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| django-tutorial01-42-52 @w1280 | 20 | 13 | 6 | 0 | 1 | 0 | 0 | 92.9% | 0.0% |
| django-tutorial01-42-52 @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| django-tutorial01-42-52 @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| django-tutorial01-42-52 @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| django-tutorial01-42-52 @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| django-tutorial02-42-52 @w1280 | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| dyn-infinite-list @w1280 (early) | 20 | 8 | 12 | 0 | 0 | 0 | 0 | 80.0% | 0.0% |
| dyn-infinite-list @w1280 (settled) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| dyn-lazy-article @w1280 (early) | 19 | 12 | 7 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| dyn-lazy-article @w1280 (settled) | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| dyn-spa-route @w1280 (early) | 20 | 0 | 20 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| dyn-spa-route @w1280 (settled) | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-array-map @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-array-map @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-array-map @w1280 | 20 | 18 | 2 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-array-map @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-array-map @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-array-map @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-array-map @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-css-flex-basis @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-css-flex-basis @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-css-flex-basis @w1280 | 20 | 16 | 4 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-css-flex-basis @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-css-flex-basis @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-css-flex-basis @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-css-flex-basis @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| mdn-html-table @w1280 | 20 | 8 | 11 | 0 | 1 | 0 | 0 | 88.9% | 0.0% |
| mdn-http-cache-control @w1280 | 20 | 18 | 2 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| news-bbc-altman @w1280 | 19 | 9 | 10 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| news-npr-home @w1280 | 14 | 1 | 13 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| node-events-v18-v22 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| node-path-v18-v22 @dark | 12 | 12 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| node-path-v18-v22 @darkcss | 12 | 12 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| node-path-v18-v22 @w1280 | 12 | 11 | 1 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| node-path-v18-v22 @w1280z150 | 12 | 12 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| node-path-v18-v22 @w390 | 12 | 12 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| node-path-v18-v22 @w390z150 | 12 | 12 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| node-path-v18-v22 @w820 | 12 | 12 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| node-url-v18-v22 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-asyncio-task-312-313 @w1280 | 20 | 18 | 0 | 0 | 0 | 2 | 0 | 100.0% | 10.0% |
| py-classes-312-313 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-collections-311-313 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-controlflow-312-313 @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-controlflow-312-313 @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-controlflow-312-313 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-controlflow-312-313 @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-controlflow-312-313 @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-controlflow-312-313 @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-controlflow-312-313 @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-datastructures-312-313 @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-datastructures-312-313 @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-datastructures-312-313 @w1280 | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-datastructures-312-313 @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-datastructures-312-313 @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-datastructures-312-313 @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-datastructures-312-313 @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-errors-311-314 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-functions-312-313 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-itertools-312-313 @w1280 | 20 | 18 | 2 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-json-312-313 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-logging-howto-312-313 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-pathlib-311-314 @w1280 | 20 | 13 | 5 | 0 | 1 | 1 | 0 | 86.7% | 5.0% |
| py-re-312-314 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| py-stdtypes-311-313 @w1280 | 20 | 16 | 1 | 0 | 3 | 0 | 0 | 84.2% | 0.0% |
| rust-book-closures-170-185 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-enums-170-185 @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-enums-170-185 @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-enums-170-185 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-enums-170-185 @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-enums-170-185 @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-enums-170-185 @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-enums-170-185 @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-ownership-170-185 @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-ownership-170-185 @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-ownership-170-185 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-ownership-170-185 @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-ownership-170-185 @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-ownership-170-185 @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-ownership-170-185 @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-result-170-185 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| rust-book-strings-170-185 @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-accordion @w1280 | 20 | 15 | 0 | 5 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-details @w1280 | 19 | 14 | 0 | 5 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-menu @w1280 | 20 | 19 | 0 | 1 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-collapse-tabs @w1280 | 20 | 16 | 0 | 4 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-footnotes-renumbered @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-heading-renamed @w1280 | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-ids-classes-renamed @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-image-replaced @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-list-reordered @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-opening-rewritten @w1280 | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 95.0% | 0.0% |
| syn-para-inserted @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-quote-repeated @w1280 | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-accordion @w1280 | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-details @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-menu @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-reopen-tabs @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-same @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-same @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-same @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-same @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-same @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-same @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-same @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-section-deleted @w1280 | 20 | 15 | 5 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-section-moved @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-sentence-edited @w1280 | 19 | 17 | 1 | 0 | 1 | 0 | 0 | 89.5% | 0.0% |
| syn-sticky-sidebar @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-sticky-sidebar @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-sticky-sidebar @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-sticky-sidebar @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-sticky-sidebar @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-sticky-sidebar @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-sticky-sidebar @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-table-column-removed @w1280 | 19 | 19 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| syn-twin-notes @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-bicycle-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-bread-month @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-bread-month @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-bread-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-bread-month @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-bread-month @w390 | 20 | 19 | 0 | 0 | 0 | 1 | 0 | 95.0% | 5.0% |
| wiki-bread-month @w390z150 | 20 | 19 | 0 | 0 | 0 | 1 | 0 | 95.0% | 5.0% |
| wiki-bread-month @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-chess-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-coffee-month @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-coffee-month @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-coffee-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-coffee-month @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-coffee-month @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-coffee-month @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-coffee-month @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-coffee-year @w1280 | 20 | 18 | 1 | 0 | 0 | 1 | 0 | 94.7% | 5.0% |
| wiki-eiffel-tower-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-glacier-year @w1280 | 20 | 19 | 0 | 0 | 1 | 0 | 0 | 95.0% | 0.0% |
| wiki-honey-month @w1280 | 20 | 19 | 0 | 0 | 0 | 1 | 0 | 95.0% | 5.0% |
| wiki-jazz-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-jazz-year @w1280 | 20 | 18 | 0 | 0 | 1 | 1 | 0 | 94.7% | 5.0% |
| wiki-leonardo-da-vinci-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-leonardo-da-vinci-year @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-lighthouse-2year @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-list-of-tallest-buildings-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-list-of-tallest-buildings-year @w1280 | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-mars-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-mars-year @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-octopus-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-octopus-year @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-origami-2year @w1280 | 20 | 18 | 2 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-pasta-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-pasta-year @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-penguin-year @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-photosynthesis-month @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-photosynthesis-month @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-photosynthesis-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-photosynthesis-month @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-photosynthesis-month @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-photosynthesis-month @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-photosynthesis-month @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-photosynthesis-year @w1280 | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-printing-press-year @w1280 | 20 | 15 | 3 | 0 | 1 | 1 | 0 | 93.8% | 5.0% |
| wiki-pythagorean-theorem-year @w1280 | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-python-programming-language-month @w1280 | 20 | 18 | 1 | 0 | 0 | 1 | 0 | 100.0% | 5.0% |
| wiki-python-programming-language-year @w1280 | 20 | 12 | 8 | 0 | 0 | 0 | 0 | 92.3% | 0.0% |
| wiki-rainbow-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-seven-wonders-of-the-ancient-world-month @w1280 | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-seven-wonders-of-the-ancient-world-year @w1280 | 20 | 15 | 3 | 0 | 1 | 1 | 0 | 88.2% | 5.0% |
| wiki-solar-system-month @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-solar-system-month @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-solar-system-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-solar-system-month @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-solar-system-month @w390 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-solar-system-month @w390z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-solar-system-month @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-solar-system-year @w1280 | 20 | 18 | 2 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-tea-2year @w1280 | 20 | 19 | 1 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-unix-month @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-unix-year @dark | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-unix-year @darkcss | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-unix-year @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-unix-year @w1280z150 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-unix-year @w390 | 20 | 19 | 0 | 0 | 0 | 1 | 0 | 95.0% | 5.0% |
| wiki-unix-year @w390z150 | 20 | 19 | 0 | 0 | 0 | 1 | 0 | 95.0% | 5.0% |
| wiki-unix-year @w820 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |
| wiki-volcano-year @w1280 | 20 | 20 | 0 | 0 | 0 | 0 | 0 | 100.0% | 0.0% |

### Misses and wrong places (24)

Columns: pair, note kind, anchor type and place, outcome, ladder method, how the truth found the content, distance from the expected origin in px, times the quote occurs on B, structural path on B, quote.

| pair | note | anchor | outcome | method | truth | dist | quote count | path | quote |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- |
| wiki-coffee-year (held-out) @w1280 | heading | text/on | wrong | exact | block | 411 | 11 | quote | Caffeine |
| wiki-python-programming-language-month (held-out) @w1280 | word | text/on | wrong | fuzzy | gone |  | 0 | no quote | .7 adding |
| wiki-seven-wonders-of-the-ancient-world-year (held-out) @w1280 | word | text/on | wrong | exact | context-short | 141.2 | 86 | no quote | of the |
| wiki-seven-wonders-of-the-ancient-world-year (held-out) @w1280 | table | media/on | miss |  | place |  | 8 | no quote | The Seven Wonders of the Ancient World |
| wiki-jazz-year (held-out) @w1280 | word | text/on | miss |  | context-repeat |  | 17 | no quote | due |
| wiki-jazz-year (held-out) @w1280 | table | media/on | wrong | media | gone |  | 0 | missing |  |
| py-pathlib-311-314 (held-out) @w1280 | margin-right | block/right | wrong | exact | context-one-side-repeat | 199.9 | 15 | missing | raised. |
| py-pathlib-311-314 (held-out) @w1280 | table | media/on | miss |  | head |  | 0 | missing |  |
| py-asyncio-task-312-313 (held-out) @w1280 | heading | text/on | wrong | fuzzy | gone |  | 0 | no quote | Task Object |
| py-asyncio-task-312-313 (held-out) @w1280 | heading | text/on | wrong | fuzzy | gone |  | 0 | no quote | Coroutines and Tasks |
| py-stdtypes-311-313 @w1280 | word | text/on | miss |  | context-repeat |  | 240 | quote | not |
| py-stdtypes-311-313 @w1280 | word | text/on | miss |  | context-one-side-repeat |  | 2 | missing | find() method should |
| py-stdtypes-311-313 @w1280 | gap | block/above | miss |  | after-context-repeat |  | 2 | no quote | A conversion specifier contains two or more charac |
| django-tutorial01-42-52 @w1280 | word | text/on | miss |  | block |  | 1 | quote | add an import |
| mdn-html-table (held-out) @w1280 | heading | text/on | miss |  | block |  | 7 | quote | Result |
| wiki-printing-press-year (held-out) @w1280 | word | text/on | wrong | exact | gone |  | 5 | no quote | scroll |
| wiki-printing-press-year (held-out) @w1280 | gap | block/above | miss |  | after-context |  | 0 | no quote | Gutenberg adopted the basic design, thereby mechan |
| wiki-honey-month (held-out) @w1280 | table | text/on | wrong | exact | place |  | 0 | missing | 81.4% Good "has a good, normal flavor and aroma fo |
| wiki-glacier-year @w1280 | margin-left | block/left | miss |  | context-repeat |  | 2 | no quote | Environment Programme (UNEP). 2008. Archived from  |
| syn-sentence-edited @w1280 | margin-left | block/left | miss |  | block-similar |  | 0 | no quote | were sold as houses or turned into small museums,  |
| wiki-unix-year (held-out) @w390 | table | media/on | wrong | path | place | 16.1 | 0 | quote |  |
| wiki-unix-year (held-out) @w390z150 | table | media/on | wrong | path | place | 22.1 | 0 | quote |  |
| wiki-bread-month (held-out) @w390 | table | media/on | wrong | path | caption | 22.1 | 0 | no quote | Loaves of bread in a basket |
| wiki-bread-month (held-out) @w390z150 | table | media/on | wrong | path | caption | 22.1 | 0 | no quote | Loaves of bread in a basket |

