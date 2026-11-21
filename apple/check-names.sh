#!/bin/bash
# Checks that the app name, the bundle id base and the App Group are written only in
# Config/PageInk.xcconfig. Everything else must take them from build settings (plists,
# entitlements, project) or from the bundle at run time (Swift).
#
# Allowed elsewhere: README.md, Config/Local.xcconfig.example (a copy of the defaults), and the
# names of files and of the project, such as PageInk.xcconfig and PageInk.xcodeproj.
# It also fails on a former name or bundle id base, so a rename cannot leave the old one behind.
# build.sh runs it with "test" and "check". It exits with 1 when it finds a hard-coded name.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
conf="$here/Config/PageInk.xcconfig"

# Names the product had before. Add the old values here when the name changes again.
former_names=(Ink)
former_bases=(org.example.ink)

value() { sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" "$conf" | head -1 | sed 's/[[:space:]]*$//'; }
name="$(value INK_DISPLAY_NAME)"
base="$(value INK_BUNDLE_ID_BASE)"
if [ -z "$name" ] || [ -z "$base" ]; then
  echo "FAIL: INK_DISPLAY_NAME or INK_BUNDLE_ID_BASE is not set in $conf" >&2
  exit 1
fi

# Source files only: no build products, no per-user Xcode state.
files() {
  find "$here" \
    \( -path "$here/build" -o -name xcuserdata -o -name '*.xcassets' \) -prune -o -type f \
    ! -name README.md ! -name 'PageInk.xcconfig' ! -name 'Local.xcconfig' ! -name 'Local.xcconfig.example' \
    ! -name 'check-names.sh' ! -name '*.png' ! -name '*.xcuserstate' -print
}

bad=0
report() { echo "FAIL: $1" >&2; bad=1; }

# Lines where the name appears as a whole word, after removing the names of the project
# files, which carry the current name (PageInk.xcconfig, PageInk.xcodeproj). A former name in
# a project file name is not removed, so a stale reference fails. The name is matched
# literally, so a name with regex characters still works.
word_hits() {
  NAME="$1" CUR="$name" awk '
    BEGIN { n = ENVIRON["NAME"]; c = ENVIRON["CUR"] }
    {
      line = $0
      gsub(c "\\.xcconfig", "", line); gsub(c "\\.xcodeproj", "", line)
      gsub("PBXProject \"" c "\"", "", line)
      s = line
      while ((i = index(s, n)) > 0) {
        pre = (i > 1) ? substr(s, i - 1, 1) : ""
        post = substr(s, i + length(n), 1)
        if (pre !~ /[A-Za-z0-9_]/ && post !~ /[A-Za-z0-9_]/) { print FNR ": " $0; break }
        s = substr(s, i + length(n))
      }
    }' "$2"
}

# A bundle id base as a whole id: "org.example.ink" but not "org.example.ink2" or "org.example.inkwell".
base_hits() {
  grep -nE -- "(^|[^A-Za-z0-9.-])$(printf '%s' "$1" | sed 's/[.]/\\./g')([^A-Za-z0-9-]|$)" "$2" || true
}

while IFS= read -r f; do
  rel="${f#"$here"/}"
  hits="$(word_hits "$name" "$f")"
  if [ -n "$hits" ]; then
    while IFS= read -r h; do report "$rel:$h: the name \"$name\" is written here"; done <<< "$hits"
  fi
  for old in "${former_names[@]}"; do
    [ "$old" = "$name" ] && continue
    hits="$(word_hits "$old" "$f")"
    if [ -n "$hits" ]; then
      while IFS= read -r h; do report "$rel:$h: the former name \"$old\" is written here"; done <<< "$hits"
    fi
  done
  if grep -nF -- "$base" "$f" > /dev/null; then
    grep -nF -- "$base" "$f" | while IFS= read -r h; do echo "FAIL: $rel:$h: the bundle id base is written here" >&2; done
    bad=1
  fi
  for old in "${former_bases[@]}"; do
    [ "$old" = "$base" ] && continue
    hits="$(base_hits "$old" "$f")"
    if [ -n "$hits" ]; then
      while IFS= read -r h; do report "$rel:$h: the former bundle id base $old is written here"; done <<< "$hits"
    fi
  done
  # A literal App Group, rather than $(INK_APP_GROUP) or the InkAppGroup Info.plist key.
  if grep -nE 'group\.[A-Za-z0-9-]+\.' "$f" > /dev/null; then
    grep -nE 'group\.[A-Za-z0-9-]+\.' "$f" | while IFS= read -r h; do echo "FAIL: $rel:$h: an App Group id is written here" >&2; done
    bad=1
  fi
done < <(files)

if [ $bad -ne 0 ]; then
  echo "Take names from Config/PageInk.xcconfig: \$(INK_DISPLAY_NAME), \$(INK_BUNDLE_ID_BASE) and \$(INK_APP_GROUP) in plists and settings, Bundle.main in Swift." >&2
  exit 1
fi
echo "ok: \"$name\", $base and the App Group are only set in Config/PageInk.xcconfig."
