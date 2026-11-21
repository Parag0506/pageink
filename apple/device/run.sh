#!/bin/bash
# The device check on a real iPad with an Apple Pencil.
#
#   corepack pnpm apple device-check    build, install, open the check page on the iPad, wait
#   corepack pnpm apple device-remove   remove the app and the screenshot runner from the iPad
#
# device-check builds the extension with diagnostics that report to the check page only, builds
# and signs the app for the paired iPad, installs it, serves the check page from this Mac over
# the local network and opens it in Safari on the iPad. The person with the iPad follows the
# steps on screen. The command waits for the results, prints a short summary and exits with 1
# when a check failed. Signing uses apple/Config/Local.xcconfig (see apple/README.md).
#
#   INK_DEVICE=<id or name>   which iPad, when more than one is paired
#   INK_CHECK_PORT=8790       port of the check page
#   INK_CHECK_MINUTES=60      how long to wait for the results
#   INK_DEVICE_SHOTS=0        no screenshots
#
# Output goes to apple/build/device/<date and time>: results.json, summary.txt, logs, shots.
# Device names and identifiers stay in that folder and in this terminal.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
apple="$here/.."
root="$apple/.."
what="${1:-check}"
proj="$apple/PageInk.xcodeproj"
dd="$apple/build/dd-device"
out="$apple/build/device/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"
cd "$root"

say() { printf '\n== %s\n' "$*"; }
stop() {
  printf '\n%s\n' "$*" >&2
  exit "${code:-1}"
}

# A setting from Local.xcconfig, else from PageInk.xcconfig.
setting() {
  local v=""
  [ -f "$apple/Config/Local.xcconfig" ] && v="$(sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" "$apple/Config/Local.xcconfig" | tail -1)"
  [ -n "$v" ] || v="$(sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" "$apple/Config/PageInk.xcconfig" | head -1)"
  printf '%s' "$v" | sed 's/[[:space:]]*$//'
}

# Explains the usual signing and install errors in plain words.
explain() {
  local log="$1"
  if grep -q "No Accounts" "$log"; then
    echo "Xcode has no Apple Account, so it cannot make a signing profile for the iPad."
    echo "Open Xcode > Settings > Accounts and add the Apple Account of the team in"
    echo "apple/Config/Local.xcconfig. Then run this command again."
  elif grep -qi "developer mode" "$log"; then
    echo "Developer Mode is off on the iPad: Settings > Privacy & Security > Developer Mode."
  elif grep -qiE "not supported|unsupported|newer than|DeveloperDiskImage|ddi" "$log"; then
    echo "This Xcode cannot install on iPadOS $os. Update Xcode, then run this command again."
  elif grep -qiE "locked|passcode" "$log"; then
    echo "Unlock the iPad and keep it awake, then run this command again."
  elif grep -qiE "untrusted|not trusted|verify" "$log"; then
    echo "On the iPad: Settings > General > VPN & Device Management, tap the developer app, tap Trust."
  fi
}

# ---- the iPad -------------------------------------------------------------------------------

say "Find the iPad"
xcrun devicectl list devices --json-output "$out/devices.json" > "$out/devicectl-list.log" 2>&1 ||
  stop "Could not list devices. See $out/devicectl-list.log"
# Prints: coredevice-id udid developer-mode os-version, for the chosen iPad.
pick="$(node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result.devices;
const want = process.argv[2] || "";
const ipads = d.filter((x) => x.hardwareProperties?.deviceType === "iPad" && x.connectionProperties?.pairingState === "paired");
const hit = want
  ? d.find((x) => [x.identifier, x.hardwareProperties?.udid, x.deviceProperties?.name].includes(want))
  : ipads[0];
if (!hit) process.exit(1);
console.log([hit.identifier, hit.hardwareProperties?.udid, hit.deviceProperties?.developerModeStatus, hit.deviceProperties?.osVersionNumber].join(" "));
' "$out/devices.json" "${INK_DEVICE:-}")" ||
  stop "No paired iPad was found. Connect the iPad to this Mac with a cable, unlock it and tap Trust if it asks."
read -r dev udid devmode os <<< "$pick"

base="$(setting INK_BUNDLE_ID_BASE)"
bid="$base"
runner="$base.simtests.xctrunner"

if [ "$what" = remove ]; then
  say "Remove the app from the iPad"
  removed=0
  for b in "$bid" "$runner"; do
    if xcrun devicectl device uninstall app --device "$dev" "$b" >> "$out/uninstall.log" 2>&1; then
      echo "Removed $b"
      removed=$((removed + 1))
    else
      echo "Not removed: $b (it may not be installed). See $out/uninstall.log"
    fi
  done
  [ $removed -gt 0 ] || exit 1
  exit 0
fi
[ "$what" = check ] || stop "usage: $0 [check|remove]"

echo "An iPad on iPadOS $os."
# Everything that stops an install, said at once, so one round of fixes is enough.
blockers=()
if [ "$devmode" != enabled ]; then
  blockers+=("Developer Mode is off on the iPad, so nothing can be installed on it yet.
   On the iPad: Settings > Privacy & Security > Developer Mode. Switch it on, restart the
   iPad when asked, and tap Turn On after the restart.")
fi
# An empty list reads as {"IDE.Identifiers.Prod"=();}.
accounts="$(defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists 2>/dev/null | tr -d ' \n\t' || true)"
if [ -z "$accounts" ] || printf '%s' "$accounts" | grep -qE '^\{("[^"]*"=\(\);)*\}$'; then
  blockers+=("Xcode has no Apple Account, so it cannot make a signing profile for the iPad.
   Open Xcode > Settings > Accounts and add the Apple Account of the team in
   apple/Config/Local.xcconfig.")
fi
if [ ${#blockers[@]} -gt 0 ]; then
  printf '\nBefore this can install on the iPad:\n\n'
  for i in "${!blockers[@]}"; do printf '%s. %s\n\n' "$((i + 1))" "${blockers[$i]}"; done
  code=2 stop "Then run this command again."
fi
sdk="$(xcrun --sdk iphoneos --show-sdk-version 2>/dev/null || echo 0)"
if [ "${os%%.*}" -gt "${sdk%%.*}" ] 2>/dev/null; then
  echo "Note: the iPad runs iPadOS $os and this Xcode has the iOS $sdk SDK. If installing fails"
  echo "with an unsupported version error, update Xcode."
fi

team="$(setting DEVELOPMENT_TEAM)"
default_base="$(sed -n "s/^INK_BUNDLE_ID_BASE[[:space:]]*=[[:space:]]*//p" "$apple/Config/PageInk.xcconfig" | head -1)"
if [ -z "$team" ] || [ "$base" = "$default_base" ]; then
  stop "Signing is not set up. Copy apple/Config/Local.xcconfig.example to apple/Config/Local.xcconfig
and set DEVELOPMENT_TEAM and INK_BUNDLE_ID_BASE (see apple/README.md, section b)."
fi

# ---- the address of this Mac -----------------------------------------------------------------

iface="$(route -n get default 2>/dev/null | awk '/interface:/ { print $2 }')"
ip=""
for i in $iface en0 en1; do
  ip="$(ipconfig getifaddr "$i" 2>/dev/null || true)"
  [ -n "$ip" ] && break
done
[ -n "$ip" ] || stop "This Mac has no address on the local network. Join the same Wi-Fi as the iPad."
port="${INK_CHECK_PORT:-8790}"
if lsof -nP -iTCP:"$port" -sTCP:LISTEN > /dev/null 2>&1; then
  stop "Port $port is in use. Set INK_CHECK_PORT to a free port."
fi
origin="http://$ip:$port"
url="$origin/s/start"

# ---- build and install ---------------------------------------------------------------------

say "Build the extension with diagnostics for $origin"
INK_DIAG_ORIGIN="$origin" corepack pnpm --filter pageink-extension build:safari > "$out/extension.log" 2>&1 || {
  tail -20 "$out/extension.log"
  stop "The extension did not build. See $out/extension.log"
}
ext="$root/packages/extension/.output/diag/safari-mv3"

say "Build and sign the app for the iPad"
sign=(-allowProvisioningUpdates -allowProvisioningDeviceRegistration)
build_app() {
  xcodebuild -project "$proj" -derivedDataPath "$dd" -scheme "App (iOS)" -destination "id=$udid" "${sign[@]}" \
    INK_EXTENSION_DIR="$ext" "$@" build > "$out/build.log" 2>&1
}
if ! build_app && grep -qiE "app group|application-groups" "$out/build.log"; then
  # A team that cannot have App Groups, such as some free personal teams. The iOS
  # entitlements hold only the App Group, so the app is signed with none. Safari keeps the
  # notes in the extension's own storage; the app's Notes list and folder stay empty.
  echo "The team cannot use the App Group. Signing without it: the check still works, the app's"
  echo "Notes list stays empty. See $out/build.log"
  sign+=(CODE_SIGN_ENTITLEMENTS=)
  cp "$out/build.log" "$out/build-with-group.log"
  build_app || true
fi
[ -d "$dd/Build/Products/Debug-iphoneos" ] && grep -q "BUILD SUCCEEDED" "$out/build.log" || {
  grep -E "error:" "$out/build.log" | sort -u | head -10
  explain "$out/build.log"
  stop "The app did not build. See $out/build.log"
}
app="$(ls -d "$dd"/Build/Products/Debug-iphoneos/*.app | grep -v Runner | head -1)"
INK_EXTENSION_DIR="$ext" bash "$apple/check-bundle.sh" "$app"

shots="${INK_DEVICE_SHOTS:-1}"
if [ "$shots" = 1 ]; then
  say "Build the screenshot runner"
  if ! xcodebuild -project "$proj" -derivedDataPath "$dd" -scheme SimTests -destination "id=$udid" "${sign[@]}" \
    INK_EXTENSION_DIR="$ext" build-for-testing > "$out/build-shots.log" 2>&1; then
    echo "No screenshots this time: the runner did not build. See $out/build-shots.log"
    shots=0
  fi
fi

say "Install the app on the iPad"
xcrun devicectl device install app --device "$dev" "$app" > "$out/install.log" 2>&1 || {
  grep -iE "error|fail" "$out/install.log" | head -10
  explain "$out/install.log"
  stop "The app did not install. See $out/install.log"
}
echo "Installed."
# Opening the app once makes Safari list its extension.
if ! xcrun devicectl device process launch --device "$dev" --terminate-existing "$bid" > "$out/launch-app.log" 2>&1; then
  grep -iE "error" "$out/launch-app.log" | head -5
  explain "$out/launch-app.log"
  echo "The app did not open by itself. Open it on the iPad once, by hand."
fi

# ---- the check page ------------------------------------------------------------------------------

say "Serve the check page"
server=""
shotpid=""
cleanup() {
  [ -n "$server" ] && kill "$server" 2>/dev/null || true
  [ -n "$shotpid" ] && kill "$shotpid" 2>/dev/null || true
}
trap cleanup EXIT
corepack pnpm exec tsx "$here/serve.ts" --port "$port" --out "$out" --minutes "${INK_CHECK_MINUTES:-60}" \
  --name "$(setting INK_DISPLAY_NAME)" &
server=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$port/s/start" > /dev/null && break
  sleep 0.2
done

say "Open the check page in Safari on the iPad"
opened() { curl -sf "http://127.0.0.1:$port/api/state" | grep -q '"opened":true'; }
if [ "$shots" = 1 ]; then
  # The screenshot runner opens the page itself, so that it can read Safari's screen.
  TEST_RUNNER_INK_CHECK_URL="$url" TEST_RUNNER_INK_CHECK_MINUTES="${INK_CHECK_MINUTES:-60}" \
    xcodebuild -project "$proj" -derivedDataPath "$dd" -scheme SimTests \
    -destination "id=$udid" -only-testing:SimTests/D_DeviceShots -resultBundlePath "$out/shots.xcresult" \
    -collect-test-diagnostics never test-without-building > "$out/shots.log" 2>&1 &
  shotpid=$!
  for _ in $(seq 1 90); do
    opened && break
    kill -0 "$shotpid" 2>/dev/null || break
    sleep 1
  done
fi
if opened; then
  echo "Safari is open at the check page on the iPad."
elif xcrun devicectl device process launch --device "$dev" --payload-url "$url" com.apple.mobilesafari \
  > "$out/launch-safari.log" 2>&1; then
  echo "Safari is open at the check page on the iPad."
else
  echo "Safari could not be opened from here. Open the address below on the iPad."
fi
corepack pnpm exec tsx "$here/qr.ts" "$url"

say "Waiting for the person with the iPad. Results go to $out"
set +e
wait "$server"
status=$?
set -e
server=""

if [ -n "$shotpid" ]; then
  # The runner stops by itself when the page says it is done. Give it a moment, then stop it.
  for _ in $(seq 1 60); do
    kill -0 "$shotpid" 2>/dev/null || break
    sleep 1
  done
  kill "$shotpid" 2>/dev/null || true
  wait "$shotpid" 2>/dev/null || true
  shotpid=""
  raw="$out/shots-export"
  if [ -d "$out/shots.xcresult" ] &&
    xcrun xcresulttool export attachments --path "$out/shots.xcresult" --output-path "$raw" > /dev/null 2>&1; then
    # Name each screenshot by the step it shows.
    node -e '
const fs = require("fs"), path = require("path");
const [raw, dst] = process.argv.slice(1);
fs.mkdirSync(dst, { recursive: true });
for (const t of JSON.parse(fs.readFileSync(path.join(raw, "manifest.json"), "utf8"))) {
  for (const a of t.attachments ?? []) {
    if (!/\.(png|jpe?g|heic)$/i.test(a.exportedFileName)) continue;
    const name = a.suggestedHumanReadableName.replace(/_\d+_[0-9A-F-]{36}/i, "").replace(/[^\w .-]+/g, "-");
    const ext = path.extname(name) ? "" : path.extname(a.exportedFileName);
    fs.copyFileSync(path.join(raw, a.exportedFileName), path.join(dst, name + ext));
  }
}' "$raw" "$out/shots"
    echo "Screenshots: $out/shots"
  else
    echo "No screenshots were saved. See $out/shots.log"
  fi
fi
exit $status
