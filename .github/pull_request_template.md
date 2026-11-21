## What and why

<!-- What this changes and the reason for it. Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran, devices and browsers you tried. -->

## Checklist

- [ ] Tests cover the change, next to the code.
- [ ] `corepack pnpm exec biome check .` and `corepack pnpm -r --if-present typecheck` pass.
- [ ] Anchoring changes: the test set result is not worse (`corepack pnpm --filter pageink-testset run score --anchor core`).
- [ ] Stub or loader changes: the speed budgets still hold.
- [ ] New dependency: licence is MIT, BSD, ISC or Apache 2.0, NOTICE is updated, `node scripts/check-notice.mjs` passes.
- [ ] Docs and CHANGELOG.md are updated where readers will notice the change.
