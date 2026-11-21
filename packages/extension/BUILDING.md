# Building the PageInk add-on from source

This folder is part of a pnpm workspace. The add-on is built from `packages/extension`,
with `packages/core` as a workspace dependency.

Needs Node 22.12 or later on the 22 line, Node 24, or Node 26 or later. pnpm comes through corepack, at the version named in the root `package.json`.

```
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --filter pageink-extension build:firefox
```

The add-on is then in `packages/extension/.output/firefox-mv3`. The build is the same on
macOS, Linux and Windows. No step downloads anything besides the npm packages in the lockfile.

The cloud client ids come from `cloud-ids.json`, which holds the release ids (empty in development), and from
`cloud-ids.local.json` when it exists (it is not in the repository). With empty ids the
Google Drive and OneDrive buttons show "Not set up in this build." To build with ids, put the
same `cloud-ids.local.json` next to `cloud-ids.json` first. Builds for the tests leave the
local file out: `INK_NO_LOCAL_IDS=1` does that, `test:e2e` sets it, and the fake cloud build
(`INK_CLOUD_FAKE=1`) always does it. So the tests give the same result on every machine.
`test` makes the release builds, the bench build (`wxt build --mode bench`, with
`INK_NO_LOCAL_IDS=1`) and the fake cloud build, because its no-network scan checks all of them.
