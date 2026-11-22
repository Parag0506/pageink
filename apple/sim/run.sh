#!/bin/bash
# Runs the Safari extension end to end in Mobile Safari on a new iPad simulator.
#
#   apple/build.sh sim-test          or   corepack pnpm apple sim-test
#
# It builds the extension and the app for the simulator, makes an iPad simulator on the newest
# iOS runtime, turns the extension on through the Settings app, serves the test pages from this
# Mac and drives Safari with the SimTests UI tests. Before phase C it shuts the simulator down
# and boots it again. Phase H times the stub and the first ink from the bench build's marks.
# Phase I turns Safari's "Hide Tab Bar While Scrolling" on, checks that the popup is still
# reached after Safari shrinks its toolbar, and turns it off again. Phase E sets All Websites to
# Ask, checks what the popup and the app say, and sets it back to Allow. At the end it deletes
# the simulator.
#
#   INK_SIM_KEEP=1    keep the simulator afterwards, to look at it
#   INK_SIM_ONLY=B    run only phase A and the named phase (B, C, E, G, H or I), for work on the
#                     tests. INK_SIM_ONLY=A runs the setup alone.
#   INK_SIM_ID=<udid> use this simulator instead of making one, and keep it
#   INK_SIM_DIAG=1    instead of B to E, build the diagnostics variant for the device check and
#                     run phase F: the check page channel and the website check in Mobile Safari
#
# Logs, result bundles and summary.txt go to apple/build/sim.
set -euo pipefail

sim="$(cd "$(dirname "$0")" && pwd)"
apple="$sim/.."
root="$apple/.."
dd="$apple/build/dd-sim"
out="$apple/build/sim"
proj="$apple/PageInk.xcodeproj"
rm -rf "$out"
mkdir -p "$out"
cd "$root"

say() { printf '\n== %s\n' "$*"; }

port="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
say "Build the Safari extension"
if [ "${INK_SIM_DIAG:-}" = 1 ]; then
  # The diagnostics build of the device check, reporting to this run's page server only.
  INK_DIAG_ORIGIN="http://127.0.0.1:$port" corepack pnpm --filter pageink-extension exec wxt build -b safari \
    > "$out/extension.log" 2>&1 || {
    tail -30 "$out/extension.log"
    exit 1
  }
  export INK_EXTENSION_DIR="$root/packages/extension/.output/diag/safari-mv3"
else
  # The bench build: the release code plus the performance marks that the test pages read to see
  # that the stub ran. Release builds carry no marks. The app's build phase copies this folder.
  corepack pnpm --filter pageink-extension exec wxt build -b safari --mode bench > "$out/extension.log" 2>&1 || {
    tail -30 "$out/extension.log"
    exit 1
  }
  export INK_EXTENSION_DIR="$root/packages/extension/.output/safari-mv3-bench"
fi

rt="$(xcrun simctl list runtimes available | grep -E '^iOS ' | tail -1 | grep -oE 'com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+' || true)"
if [ -z "$rt" ]; then
  echo "No iOS simulator runtime is installed. Install one in Xcode > Settings > Components." >&2
  exit 1
fi
id="${INK_SIM_ID:-}"
t="given"
if [ -n "$id" ]; then
  # A simulator you made yourself: it is kept.
  INK_SIM_KEEP=1
else
  for t in iPad-Air-11-inch-M4 iPad-Air-11-inch-M3 iPad-Pro-11-inch-M5-12GB iPad-Pro-11-inch-M4-8GB iPad-A16; do
    id="$(xcrun simctl create "Simulator test iPad" "com.apple.CoreSimulator.SimDeviceType.$t" "$rt" 2>/dev/null)" && break
  done
fi
if [ -z "$id" ]; then
  echo "Could not make an iPad simulator on $rt." >&2
  exit 1
fi
server=""
cleanup() {
  # corepack and tsx each start a child, so stop the server by its command line.
  [ -n "$server" ] && pkill -f "sim/serve.ts $port" 2>/dev/null || true
  if [ "${INK_SIM_KEEP:-}" = 1 ]; then
    echo "Kept the simulator $id."
  else
    xcrun simctl shutdown "$id" >/dev/null 2>&1 || true
    xcrun simctl delete "$id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
echo "Simulator $id ($t, ${rt##*.})" | tee "$out/device.txt"

# Signed to run locally: the simulator then honours the App Group, so the app sees the
# notes the extension's native handler writes. No team and no account are needed.
sign=(CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER=)
say "Build the app and the UI tests for the simulator"
xcodebuild -project "$proj" -derivedDataPath "$dd" -scheme SimTests -destination "id=$id" "${sign[@]}" \
  build-for-testing > "$out/build.log" 2>&1 || {
  grep -E 'error:' "$out/build.log" | head -20
  exit 1
}
app="$(ls -d "$dd"/Build/Products/Debug-iphonesimulator/*.app | grep -v Runner | head -1)"
bash "$apple/check-bundle.sh" "$app"

say "Boot the simulator, install and open the app once"
xcrun simctl boot "$id" 2>/dev/null || true
xcrun simctl bootstatus "$id" -b > /dev/null
xcrun simctl install "$id" "$app"
bid="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
xcrun simctl launch "$id" "$bid" > /dev/null
sleep 3
xcrun simctl terminate "$id" "$bid" || true
# A new simulator lists Safari under Settings > Apps only after Safari has run once.
xcrun simctl launch "$id" com.apple.mobilesafari > /dev/null
sleep 5
xcrun simctl terminate "$id" com.apple.mobilesafari || true

say "Serve the test pages"
corepack pnpm exec tsx "$sim/serve.ts" "$port" > "$out/serve.log" 2>&1 &
server=$!
disown "$server"
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$port/sim.html" > /dev/null && break
  sleep 0.2
done

phase() {
  local name="$1"
  say "Phase $name"
  TEST_RUNNER_INK_PORT="$port" TEST_RUNNER_INK_DIAG="${INK_SIM_DIAG:-0}" TEST_RUNNER_INK_CLOUD_IDS="$cloud_ids" xcodebuild -project "$proj" -derivedDataPath "$dd" -scheme SimTests \
    -destination "id=$id" "${sign[@]}" -only-testing:"SimTests/$name" -resultBundlePath "$out/$name.xcresult" \
    -collect-test-diagnostics never test-without-building > "$out/$name.log" 2>&1
}

# Whether this build carries cloud client ids: the Sync screen test expects "Not set up in
# this build." without them.
cloud_ids=0
if [ -f "$sim/../Shared/cloud-ids.local.json" ] && grep -Eq '"(google|microsoft)"[[:space:]]*:[[:space:]]*"[^"]' "$sim/../Shared/cloud-ids.local.json"; then
  cloud_ids=1
fi

status=0
only="${INK_SIM_ONLY:-}"
phase A_SetupTests || status=1
if [ "${INK_SIM_DIAG:-}" = 1 ]; then
  [ $status -eq 0 ] && { phase F_DiagnosticsTests || status=1; }
elif [ $status -eq 0 ]; then
  if [ -z "$only" ] || [ "$only" = B ]; then phase B_SafariTests || status=1; fi
  if [ -z "$only" ] || [ "$only" = G ]; then phase G_ConnectTests || status=1; fi
  if [ -z "$only" ] || [ "$only" = C ]; then
    say "Reboot the simulator"
    xcrun simctl shutdown "$id"
    xcrun simctl boot "$id"
    xcrun simctl bootstatus "$id" -b > /dev/null
    phase C_AfterRebootTests || status=1
  fi
  if [ -z "$only" ] || [ "$only" = H ]; then phase H_TimingTests || status=1; fi
  # These two change a Safari setting and put it back, so they run after the others.
  if [ -z "$only" ] || [ "$only" = I ]; then phase I_ToolbarTests || status=1; fi
  if [ -z "$only" ] || [ "$only" = E ]; then phase E_SiteAccessTests || status=1; fi
fi

node "$sim/summary.mjs" "$out" | tee "$out/summary.txt"
exit $status
