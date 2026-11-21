#!/bin/bash
# Copies the Safari build of the extension into the extension bundle that Xcode is building.
# Xcode runs this as a build phase of both extension targets. The chunk file names carry a
# content hash and change between builds, so the whole folder is copied and stale files go.
#
# Run by hand with a destination folder to check what would be copied:
#   apple/sync-extension.sh /tmp/out
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="${INK_EXTENSION_DIR:-$here/../packages/extension/.output/safari-mv3}"

if [ $# -ge 1 ]; then
  dst="$1"
elif [ -n "${TARGET_BUILD_DIR:-}" ] && [ -n "${UNLOCALIZED_RESOURCES_FOLDER_PATH:-}" ]; then
  dst="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
else
  echo "usage: $0 <destination folder>" >&2
  exit 2
fi

if [ ! -f "$src/manifest.json" ]; then
  echo "error: The Safari build of the extension is missing at $src." >&2
  echo "error: Run: corepack pnpm --filter pageink-extension build:safari" >&2
  exit 1
fi

# A diagnostics build for the device check (apple/device) must never ship. The Release
# configuration, which archives and store uploads use, refuses it.
if [ "${CONFIGURATION:-}" = Release ]; then
  if [ -f "$src/DIAGNOSTICS.txt" ] || grep -rqs --include='*.js' -e 'ink-diag' "$src"; then
    echo "error: $src is a diagnostics build. Build the extension without INK_DIAG_ORIGIN." >&2
    exit 1
  fi
fi

mkdir -p "$dst"
# On iOS the destination is the bundle root, next to the executable and Info.plist, so only
# the entries that come from the extension build are mirrored. Folders are mirrored with
# deletion. Top-level entries that an earlier build copied and the current build no longer
# has are removed, using the list of names that the last run wrote.
list="${TARGET_TEMP_DIR:-$dst}/.pageink-extension-files"
if [ -f "$list" ]; then
  while IFS= read -r name; do
    case "$name" in "" | */* | . | ..) continue ;; esac
    if [ ! -e "$src/$name" ] && [ -e "$dst/$name" ]; then
      rm -rf "${dst:?}/$name"
      echo "Removed stale $name"
    fi
  done < "$list"
fi
mkdir -p "$(dirname "$list")"
: > "$list"
for entry in "$src"/*; do
  name="$(basename "$entry")"
  if [ -d "$entry" ]; then
    rsync -a --delete "$entry/" "$dst/$name/"
  else
    rsync -a "$entry" "$dst/$name"
  fi
  echo "$name" >> "$list"
done

echo "Copied the extension from $src"
