# Contributing to PageInk

Thank you for helping. This page says how to set up, how the code is divided, and the rules every change
follows. Small fixes can go straight to a pull request. For a larger change, open an issue first so we can
agree on the approach.

## Set up

You need Node.js 22.12 or later on the 22 line, Node 24, or Node 26 or later, and Git. CI uses Node 24.
On a Mac, Xcode 16 or later is needed only for the Safari app.

```
corepack enable
corepack pnpm install
corepack pnpm exec playwright install chromium firefox webkit
```

On Linux, add `--with-deps` to the last line.

`corepack enable` puts the pinned pnpm on your path, so a plain `pnpm` uses the same version. In the docs
every command is written as `corepack pnpm ...`, which works either way.

Check that everything runs:

```
corepack pnpm exec biome check .
corepack pnpm -r --if-present typecheck
corepack pnpm --filter pageink-core test
corepack pnpm --filter pageink-extension test
corepack pnpm --filter pageink-extension test:e2e
```

The README has the full list of commands.

## How the code is divided

[docs/CONTRACT.md](docs/CONTRACT.md) is the architecture and module contract. In short:

- Each folder has one job and a small public API, listed in CONTRACT section 3. The types in
  `packages/core/src/types.ts` are the source of truth for those APIs.
- A folder imports only the folders named for it in the contract. For example, `anchor/` imports nothing
  else from pageink-core, and `view.ts` must not load the drawing tools statically, because that split is what
  keeps pages without ink fast.
- The shared files (`types.ts`, `hash.ts`, `index.ts`, the docs and the root config) change rarely and with
  care, because every folder depends on them. A change to them goes in its own pull request with the reason.
- Keep a pull request inside one folder when you can. If you need a change elsewhere, say so in the
  description.

## Rules for every change

- TypeScript in strict mode. No `any` in exported signatures. No default exports in pageink-core.
- pageink-core uses no extension APIs, so it runs in any page.
- No network calls in pageink-core, the extension or the embed script: no `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `sendBeacon`, remote imports, remote fonts or images. The tests check every
  build for this. The only exceptions are the PDF read and the cloud code in
  `packages/extension/src/cloud/`, pinned to its hosts in `packages/extension/network-allow.json`.
- The cloud tests run against local fakes of Google Drive and OneDrive, with a test build made by
  `INK_CLOUD_FAKE=1` (`corepack pnpm --filter pageink-extension build:test`). That build goes to
  `.output/test-<browser>-mv3` and cannot be zipped. Real client ids: [docs/CLOUD_SETUP.md](docs/CLOUD_SETUP.md).
- Nothing runs on scroll for normal pages, no timers poll, and pages without ink get only the stub.
- Layout reads and writes are never interleaved in a loop: read everything, then write everything.
- Dependencies: only MIT, BSD, ISC or Apache 2.0 licences in anything that ships. Read the licence file
  before adding one. Add it with `corepack pnpm --filter <workspace package> add <dep>`, then add an
  entry to [NOTICE](NOTICE) and run `node scripts/check-notice.mjs`.

## Tests

- Tests sit next to the code. Pure logic: `*.test.ts`, run in Node. Anything that needs a DOM or layout:
  `*.browser.test.ts`, run in real Chromium, WebKit and Firefox. Extension flows: Playwright specs in
  `packages/extension/e2e/`.
- Every public function has a test. Every mechanism in DESIGN that a folder owns has a test that would fail
  if the mechanism were removed.
- A test that measures time hands the measure to `withinBudget()` in `packages/core/src/testkit.ts` and
  has `budget: ` in its name. The library test script runs those tests on their own after the others,
  one file at a time, so no other test shares the machine while they measure. The rule is in
  `packages/core/src/budget-rule.ts`: a limit grows with work timed right before and after the measure, a
  measure taken while the machine changed pace is not judged, and a measure over its limit is taken again,
  up to three times. Slower code fails every time. Other work on the machine does not fail the test.
- A test never waits a fixed time for something to happen and never compares two readings of the clock
  outside `withinBudget()`. It waits on the condition (`until`, `quiet`, `expect.poll`), counts, or uses a
  clock it moves by hand. Pen, mouse and touch input in tests carries its own event times (the input
  clock in `packages/core/src/capture/testkit.ts` and `packages/extension/e2e/fixtures.ts`).
- `node scripts/soak.mjs` runs a suite many times, part of the runs under CPU load, and lists every test
  that failed at least once. Run it on a new or changed test that waits, times or draws.
- A test that depends on layout must not depend on the font. Fonts differ between macOS, Linux and
  Windows, so measure the text in the test and derive sizes from it.
- A change to anchoring must not lower the test set result. Run
  `corepack pnpm --filter pageink-testset run score --anchor core --out /tmp/testset` and compare with the table in
  [docs/RESULTS.md](docs/RESULTS.md). The gate fails when right place drops under its target, wrong place
  goes over its target, or a note is unaccounted for.
- A change to the stub or the loader must keep the speed budgets. Run the bench with the real extension.

## Style

- Format and lint with Biome: `corepack pnpm exec biome check --write <path>`.
- Docs, comments and UI text: short plain sentences. No em dashes. Comments say why, not what.
- No hype and no comparisons that run other products down.
- State measured numbers only with how they were measured, and keep them in the generated tables
  (`corepack pnpm results`) rather than in prose.

## Add a test set pair

From the repository root, with one of:

```
corepack pnpm --filter pageink-testset run add wiki "Article title" 2025-09-01 2026-09-01 --change year --shape prose
corepack pnpm --filter pageink-testset run add arxiv 2404.19756
corepack pnpm --filter pageink-testset run add url my-id https://a.example/v1 https://a.example/v2 --kind docs --change docs-release --license "MIT" --commit
```

Then freeze it with `corepack pnpm --filter pageink-testset run fetch --only <id>` and score it.
Pass `--commit` only when the page's licence allows redistribution, and fill in `--license` and
`--attribution`. Pages that may not be redistributed stay in `testset/cache/`, which is never committed.
[testset/README.md](testset/README.md) has every option, and how to add layout sets and synthetic changes.

## Add a bench page

Add an entry to `pages` in [bench/pages.json](bench/pages.json) with an `id`, a `type` and a public `url`
that needs no sign-in. For a page that should carry ink, add an entry to `seeded`. Run
`corepack pnpm --filter pageink-bench run bench --pages <id>` to check it. [bench/README.md](bench/README.md)
has the details.

## Pull requests

- Describe what changed and why, and how you tested it. The template asks for this.
- CI runs lint, typecheck, all tests, the end-to-end tests, the quick test set gate, the quick bench, and
  the NOTICE check. A pull request is merged when CI passes and a maintainer has reviewed it. The quick
  bench judges fixed time budgets only on a machine fit to judge them (at least 4 cores, and at most
  1.25 times slower than the reference machine at the calibration work) and compares the extension
  with a do-nothing control extension everywhere; [bench/README.md](bench/README.md) says how.
- By contributing you agree that your work is released under the MIT licence of this repository.

## Security

Do not open public issues for security problems. See [SECURITY.md](SECURITY.md).
