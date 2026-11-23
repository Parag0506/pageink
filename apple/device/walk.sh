#!/bin/bash
# A film of first use, made by the UI test SimTests/J_WalkThrough with the screen recorded:
# open the app, turn the extension on in Settings, write on a web page in Safari, reload it,
# and find the page in the app's Notes.
#
#   apple/device/walk.sh           on the paired iPad (unlocked, awake, on the network)
#   apple/device/walk.sh sim       on a new iPad simulator, to try the walk first
#
# On the iPad it installs the app and the test runner, turns the extension on and sets
# All Websites to Allow, as a reader does by hand, and opens one page in Safari. Signing uses
# apple/Config/Local.xcconfig (see apple/README.md). `apple/build.sh device-remove` takes the
# app and the runner off the iPad again.
#
#   INK_DEVICE=<id or name>   which iPad, when more than one is paired
#   INK_WALK_URL=<address>    the page to write on (default: a Wikipedia article)
#   INK_SIM_ID=<udid>         with sim: use this simulator and keep it
#   INK_WALK_EXTENSION=<dir>  use this build of the Safari extension and do not build one
#   INK_WALK_RESET=1          turn the extension off first, for a second take
#
# Output goes to apple/build/walk/<date and time>: walk.mp4, the screenshots, logs.
# Device names and identifiers stay in that folder and in this terminal. The film shows
# whatever is on the iPad's screen, the Settings sidebar included: watch it before you share it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
apple="$here/.."
root="$apple/.."
where="${1:-device}"
proj="$apple/PageInk.xcodeproj"
out="$apple/build/walk/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"
cd "$root"

say() { printf '\n== %s\n' "$*"; }
stop() {
  printf '\n%s\n' "$*" >&2
  exit 1
}

if [ -n "${INK_WALK_EXTENSION:-}" ]; then
  # A build of the extension made elsewhere, such as the one of a release that is in review.
  [ -f "$INK_WALK_EXTENSION/manifest.json" ] || stop "INK_WALK_EXTENSION has no manifest.json: $INK_WALK_EXTENSION"
  export INK_EXTENSION_DIR="$INK_WALK_EXTENSION"
else
  say "Build the Safari extension"
  corepack pnpm --filter pageink-extension build:safari > "$out/extension.log" 2>&1 || {
    tail -20 "$out/extension.log"
    stop "The extension did not build. See $out/extension.log"
  }
  export INK_EXTENSION_DIR="$root/packages/extension/.output/safari-mv3"
fi

made_sim=""
cleanup() {
  if [ -n "$made_sim" ]; then
    xcrun simctl shutdown "$made_sim" > /dev/null 2>&1 || true
    xcrun simctl delete "$made_sim" > /dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "$where" = sim ]; then
  dd="$apple/build/dd-sim"
  products="Debug-iphonesimulator"
  # Signed to run locally, as in apple/sim/run.sh.
  sign=(CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER=)
  id="${INK_SIM_ID:-}"
  if [ -z "$id" ]; then
    rt="$(xcrun simctl list runtimes available | grep -E '^iOS ' | tail -1 | grep -oE 'com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+' || true)"
    [ -n "$rt" ] || stop "No iOS simulator runtime is installed. Install one in Xcode > Settings > Components."
    for t in iPad-Air-11-inch-M4 iPad-Air-11-inch-M3 iPad-Pro-11-inch-M5-12GB iPad-Pro-11-inch-M4-8GB iPad-A16; do
      id="$(xcrun simctl create "Walk iPad" "com.apple.CoreSimulator.SimDeviceType.$t" "$rt" 2> /dev/null)" && break
    done
    [ -n "$id" ] || stop "Could not make an iPad simulator on $rt."
    made_sim="$id"
  fi
elif [ "$where" = device ]; then
  dd="$apple/build/dd-device"
  products="Debug-iphoneos"
  sign=(-allowProvisioningUpdates -allowProvisioningDeviceRegistration)
  say "Find the iPad"
  xcrun devicectl list devices --json-output "$out/devices.json" > "$out/devicectl-list.log" 2>&1 ||
    stop "Could not list devices. See $out/devicectl-list.log"
  pick="$(node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result.devices;
const want = process.argv[2] || "";
const ipads = d.filter((x) => x.hardwareProperties?.deviceType === "iPad" && x.connectionProperties?.pairingState === "paired");
const hit = want
  ? d.find((x) => [x.identifier, x.hardwareProperties?.udid, x.deviceProperties?.name].includes(want))
  : ipads[0];
if (!hit) process.exit(1);
console.log([hit.identifier, hit.hardwareProperties?.udid, hit.connectionProperties?.tunnelState].join(" "));
' "$out/devices.json" "${INK_DEVICE:-}")" ||
    stop "No paired iPad was found. Connect the iPad to this Mac with a cable, unlock it and tap Trust if it asks."
  read -r dev id tunnel <<< "$pick"
  if [ "$tunnel" = unavailable ]; then
    stop "The iPad is paired, and this Mac cannot reach it now. Unlock the iPad, keep its screen on and
check the cable, then run this command again."
  fi
else
  stop "usage: $0 [device|sim]"
fi

say "Build the app and the UI tests"
# From clean: a build with another extension folder must sign the app again.
xcodebuild -project "$proj" -derivedDataPath "$dd" -scheme SimTests clean > "$out/clean.log" 2>&1 || true
xcodebuild -project "$proj" -derivedDataPath "$dd" -scheme SimTests -destination "id=$id" -destination-timeout 120 "${sign[@]}" \
  build-for-testing > "$out/build.log" 2>&1 || {
  grep -E 'error:' "$out/build.log" | sort -u | head -10
  stop "The build failed. See $out/build.log"
}
app="$(ls -d "$dd/Build/Products/$products"/*.app | grep -v Runner | head -1)"
bash "$apple/check-bundle.sh" "$app"
bid="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"

say "Install the app"
if [ "$where" = sim ]; then
  xcrun simctl boot "$id" 2> /dev/null || true
  xcrun simctl bootstatus "$id" -b > /dev/null
  xcrun simctl install "$id" "$app"
  # A new simulator lists Safari under Settings > Apps only after Safari has run once.
  xcrun simctl launch "$id" com.apple.mobilesafari > /dev/null
  sleep 5
  xcrun simctl terminate "$id" com.apple.mobilesafari || true
else
  xcrun devicectl device install app --device "$dev" "$app" > "$out/install.log" 2>&1 || {
    grep -iE "error|fail" "$out/install.log" | head -10
    stop "The app did not install. See $out/install.log"
  }
fi

# The test run file of the build, with the screen recorded for the whole test and kept.
run="$(ls "$dd"/Build/Products/SimTests_*.xctestrun | head -1)"
film="$(dirname "$run")/walk.xctestrun"
python3 - "$run" "$film" "${INK_WALK_URL:-}" << 'EOF'
import plistlib, sys
src, dst, url = sys.argv[1:4]
with open(src, "rb") as f:
    p = plistlib.load(f)
def targets(x):
    if isinstance(x, dict):
        if "TestBundlePath" in x:
            yield x
        for v in x.values():
            yield from targets(v)
    elif isinstance(x, list):
        for v in x:
            yield from targets(v)
n = 0
for t in targets(p):
    t["PreferredScreenCaptureFormat"] = "screenRecording"
    t["SystemAttachmentLifetime"] = "keepAlways"
    t["UserAttachmentLifetime"] = "keepAlways"
    for key in ("EnvironmentVariables", "TestingEnvironmentVariables"):
        env = t.setdefault(key, {})
        env["INK_WALK"] = "1"
        if url:
            env["INK_WALK_URL"] = url
    n += 1
if not n:
    sys.exit("No test target in " + src)
with open(dst, "wb") as f:
    plistlib.dump(p, f)
EOF

# A test run file matches the iPad once per architecture. The tests are built for arm64.
dest="id=$id"
[ "$where" = device ] && dest="platform=iOS,arch=arm64,id=$id"
if [ "${INK_WALK_RESET:-}" = 1 ]; then
  say "Turn the extension off first"
  xcodebuild -xctestrun "$film" -destination "$dest" -destination-timeout 120 -only-testing:SimTests/J_WalkThrough/test00_ExtensionOff \
    -resultBundlePath "$out/reset.xcresult" -collect-test-diagnostics never test-without-building > "$out/reset.log" 2>&1 ||
    echo "The extension could not be turned off first. See $out/reset.log"
fi

say "Walk, with the screen recorded"
status=0
xcodebuild -xctestrun "$film" -destination "$dest" -destination-timeout 120 -only-testing:SimTests/J_WalkThrough/test01_FirstUse \
  -resultBundlePath "$out/walk.xcresult" -collect-test-diagnostics never test-without-building \
  > "$out/walk.log" 2>&1 || status=1
grep -E "error:|XCTAssert|failed -|Test Case .* (passed|failed)" "$out/walk.log" | sort -u | head -12 || true

raw="$out/attachments"
if [ -d "$out/walk.xcresult" ] &&
  xcrun xcresulttool export attachments --path "$out/walk.xcresult" --output-path "$raw" > /dev/null 2>&1; then
  node -e '
const fs = require("fs"), path = require("path");
const [raw, dst] = process.argv.slice(1);
let films = 0;
for (const t of JSON.parse(fs.readFileSync(path.join(raw, "manifest.json"), "utf8"))) {
  for (const a of t.attachments ?? []) {
    const from = path.join(raw, a.exportedFileName);
    if (/\.(mp4|mov|m4v)$/i.test(a.exportedFileName)) {
      films += 1;
      fs.copyFileSync(from, path.join(dst, `walk${films > 1 ? "-" + films : ""}${path.extname(a.exportedFileName)}`));
    } else if (/\.(png|jpe?g|heic)$/i.test(a.exportedFileName)) {
      const name = (a.suggestedHumanReadableName || a.exportedFileName).replace(/_\d+_[0-9A-F-]{36}/i, "").replace(/[^\w .-]+/g, "-");
      fs.copyFileSync(from, path.join(dst, name + (path.extname(name) ? "" : path.extname(a.exportedFileName))));
    }
  }
}
console.log(films ? `Film: ${path.join(dst, "walk.mp4")}` : "The run kept no film.");
' "$raw" "$out"
else
  echo "Nothing could be read from the test result. See $out/walk.log"
fi
echo "Output: $out"
exit $status
