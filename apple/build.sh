#!/bin/bash
# Builds the Safari extension, then the app that carries it.
#
#   apple/build.sh            macOS app and iOS Simulator app, signing off
#   apple/build.sh mac        macOS app only
#   apple/build.sh ios        iOS Simulator app only
#   apple/build.sh test       unit tests on macOS and on an iPad simulator. When there is no
#                             iPad simulator, a temporary one is made and removed afterwards.
#   apple/build.sh check      check the extension inside the built apps (check-bundle.sh) and
#                             that names are set only in Config/PageInk.xcconfig (check-names.sh)
#   apple/build.sh mac-local  macOS app signed to run locally, for Safari with unsigned extensions.
#                             Notes are kept in ~/Library/Application Support/<bundle id base>.local
#   apple/build.sh sim-test   the extension end to end in Mobile Safari on a new iPad simulator
#                             (sim/run.sh). It makes the simulator and deletes it afterwards.
#   apple/build.sh device-check   the guided check on a real iPad with an Apple Pencil
#                                 (device/run.sh). Needs signing in Config/Local.xcconfig.
#   apple/build.sh device-remove  remove the app that device-check installed from the iPad
#
# Products go to apple/build.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/.."
what="${1:-all}"
dd="$here/build/dd"
proj="$here/PageInk.xcodeproj"

cd "$root"
if [ "$what" = sim-test ]; then
  exec bash "$here/sim/run.sh"
fi
if [ "$what" = device-check ]; then
  exec bash "$here/device/run.sh" check
fi
if [ "$what" = device-remove ]; then
  exec bash "$here/device/run.sh" remove
fi
if [ "$what" != check ]; then
  corepack pnpm --filter pageink-extension build:safari
fi

xb() { xcodebuild -project "$proj" -derivedDataPath "$dd" "$@"; }

ipad() {
  xcrun simctl list devices available | grep "iPad" | head -1 | grep -oE "[0-9A-F-]{36}" || true
}

# Makes a temporary iPad simulator on the newest iOS runtime and prints its id.
temp_ipad() {
  local rt t
  rt="$(xcrun simctl list runtimes available | grep -E "^iOS " | tail -1 | grep -oE "com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+" || true)"
  [ -n "$rt" ] || return 0
  for t in iPad-Air-11-inch-M3 iPad-A16 iPad-Pro-11-inch-M4-8GB iPad-Air-11-inch-M2; do
    xcrun simctl create "Temporary iPad for tests" "com.apple.CoreSimulator.SimDeviceType.$t" "$rt" 2>/dev/null && return 0
  done
}

check() { bash "$here/check-bundle.sh" "$@"; }
products="$dd/Build/Products"

case "$what" in
  mac) xb -scheme "App (macOS)" -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
    check "$products"/Debug/*.app ;;
  ios) xb -scheme "App (iOS)" -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
    check "$products"/Debug-iphonesimulator/*.app ;;
  mac-local)
    # No team, so no App Group that macOS would share. The app and the extension are both signed
    # with Config/Local-macOS.entitlements, which gives them one folder to keep notes in.
    xb -scheme "App (macOS)" -destination 'platform=macOS' CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- \
      CODE_SIGN_ENTITLEMENTS="$here/Config/Local-macOS.entitlements" build
    check "$products"/Debug/*.app
    echo "App: $(ls -d "$products"/Debug/*.app | head -1)" ;;
  check) check; bash "$here/check-names.sh" ;;
  test)
    bash "$here/check-names.sh"
    xb -scheme Tests -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO test
    id="$(ipad)"
    if [ -z "$id" ]; then
      id="$(temp_ipad)"
      if [ -n "$id" ]; then
        echo "Made a temporary iPad simulator $id. It is removed after the run."
        trap 'xcrun simctl shutdown "$id" >/dev/null 2>&1 || true; xcrun simctl delete "$id" || true' EXIT
      fi
    fi
    if [ -n "$id" ]; then
      xb -scheme Tests -destination "id=$id" CODE_SIGNING_ALLOWED=NO test
    else
      echo "No iPad simulator and no iOS runtime to make one. Skipped the iOS run."
    fi ;;
  all)
    xb -scheme "App (macOS)" -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
    xb -scheme "App (iOS)" -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
    check "$products"/Debug/*.app "$products"/Debug-iphonesimulator/*.app ;;
  *) echo "usage: $0 [all|mac|ios|test|check|mac-local|sim-test|device-check|device-remove]" >&2; exit 2 ;;
esac
