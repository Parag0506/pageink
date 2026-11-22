#!/bin/bash
# Checks the extension inside built app bundles.
#
#   apple/check-bundle.sh                 every app in apple/build/dd/Build/Products
#   apple/check-bundle.sh path/to/X.app   one app
#
# For each app it finds the Safari extension and checks that:
# - the manifest is the Safari one: nativeMessaging is asked for, and there are no keys or
#   permissions that Safari rejects or that only Chrome or Firefox know;
# - every file that the manifest, the pages and the scripts point to exists;
# - the page scripts are the current layout: a small stub.js, and the viewer, the tools and the
#   first read (boot.js) in content/, which the background registers or injects (scripting permission);
# - LICENSE, NOTICE, the PDF viewer page and its assets are there;
# - the files match the current Safari build exactly, so no file from an earlier build is left,
#   and every chunk is used by something;
# - the app and the extension carry the privacy manifest, and the app's Info.plist gives the
#   export compliance answer, which the App Store asks for.
# build.sh runs it after each build. It exits with 1 when a check fails.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="${INK_EXTENSION_DIR:-$here/../packages/extension/.output/safari-mv3}"

apps=()
if [ $# -ge 1 ]; then
  apps=("$@")
else
  for a in "$here"/build/dd/Build/Products/*/*.app; do
    [ -d "$a" ] && apps+=("$a")
  done
fi
if [ ${#apps[@]} -eq 0 ]; then
  echo "error: No app bundle found. Build first: corepack pnpm apple" >&2
  exit 1
fi

status=0
for app in "${apps[@]}"; do
  # macOS keeps the extension in Contents/Resources of the appex, iOS at the appex root.
  ext=""
  exe=""
  for appex in "$app"/Contents/PlugIns/*.appex "$app"/PlugIns/*.appex; do
    [ -d "$appex" ] || continue
    for d in "$appex/Contents/Resources" "$appex"; do
      if [ -f "$d/manifest.json" ]; then
        ext="$d"
        if [ "$d" = "$appex" ]; then
          exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$appex/Info.plist" 2>/dev/null || true)"
        fi
        break 2
      fi
    done
  done
  if [ -z "$ext" ]; then
    echo "FAIL $app: no Safari extension with a manifest.json inside." >&2
    status=1
    continue
  fi
  plist="$app/Info.plist"
  [ -f "$plist" ] || plist="$app/Contents/Info.plist"
  appName="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$plist" 2>/dev/null || true)"
  # What the App Store asks of the bundle: the privacy manifest in the app and in the extension,
  # and the export compliance answer in the app's Info.plist.
  for b in "$app" "${appex:-}"; do
    [ -n "$b" ] || continue
    if [ ! -f "$b/PrivacyInfo.xcprivacy" ] && [ ! -f "$b/Contents/Resources/PrivacyInfo.xcprivacy" ]; then
      echo "FAIL $b: PrivacyInfo.xcprivacy is missing (apple/Shared/PrivacyInfo.xcprivacy)." >&2
      status=1
    fi
  done
  exempt="$(/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' "$plist" 2>/dev/null || true)"
  if [ "$exempt" != "false" ]; then
    echo "FAIL $app: ITSAppUsesNonExemptEncryption is not NO in Info.plist (Config/PageInk.xcconfig)." >&2
    status=1
  fi
  if ! node - "$ext" "$src" "$app" "$appName" "$exe" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const [ext, src, app, appName, exe] = process.argv.slice(2);
const fails = [];
const warns = [];
const fail = (m) => fails.push(m);

// Files of the appex itself, next to the extension. The privacy manifest is there on both
// platforms. The others are next to the extension on iOS only; exe is set only there.
const bundleOwn = (f) =>
  f === 'PrivacyInfo.xcprivacy' ||
  (!!exe &&
    (f === exe || f === 'Info.plist' || f === 'PkgInfo' || f === 'embedded.mobileprovision' ||
      f.startsWith('_CodeSignature/') || /^[^/]+\.dylib$/.test(f)));

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}
const has = (rel) => fs.existsSync(path.join(ext, rel)) && fs.statSync(path.join(ext, rel)).isFile();

let m;
try {
  m = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
} catch (e) {
  console.error(`FAIL ${app}: manifest.json does not parse: ${e.message}`);
  process.exit(1);
}

// The manifest.
if (m.manifest_version !== 3) fail(`manifest_version is ${m.manifest_version}, expected 3`);
// The App Store refuses the upload when the description is missing or over 112 characters.
if (typeof m.description !== 'string' || m.description.length === 0 || m.description.length > 112) {
  fail(`description must be 1 to 112 characters for the App Store, it has ${String(m.description ?? '').length}`);
}
const perms = m.permissions || [];
if (!perms.includes('nativeMessaging')) fail('nativeMessaging is missing from permissions: this is not the Safari build');
const safariPerms = new Set([
  'activeTab', 'alarms', 'clipboardWrite', 'contextMenus', 'cookies', 'declarativeNetRequest',
  'declarativeNetRequestFeedback', 'declarativeNetRequestWithHostAccess', 'menus', 'nativeMessaging',
  'scripting', 'storage', 'tabs', 'unlimitedStorage', 'webNavigation', 'webRequest',
]);
for (const p of [...perms, ...(m.optional_permissions || [])]) {
  if (!safariPerms.has(p)) fail(`permission "${p}" is not one Safari supports`);
}
const chromeOnly = [
  'key', 'update_url', 'minimum_chrome_version', 'side_panel', 'chrome_url_overrides', 'oauth2',
  'offline_enabled', 'externally_connectable', 'export', 'import', 'host_permissions_optional',
  'browser_url_overrides', 'sidebar_action', 'theme', 'user_scripts', 'incognito',
];
for (const k of chromeOnly) if (k in m) fail(`manifest key "${k}" is not for Safari`);
if (m.browser_specific_settings) {
  for (const k of Object.keys(m.browser_specific_settings)) {
    if (k !== 'safari') fail(`browser_specific_settings.${k} belongs to another browser`);
  }
}
if (m.background?.persistent === true) fail('a persistent background does not load on iOS');
if (m.background?.scripts && m.background?.service_worker) fail('background has both scripts and service_worker');
for (const w of m.web_accessible_resources || []) {
  if ('use_dynamic_url' in w) fail('web_accessible_resources uses use_dynamic_url, which Safari does not know');
  if (!Array.isArray(w.matches)) fail('web_accessible_resources entry without matches');
}
if (appName && m.name !== appName) warns.push(`the extension is named "${m.name}" and the app "${appName}"`);

// Files the manifest points to.
const refs = new Map();
const ref = (file, from) => {
  const clean = file.replace(/[?#].*$/, '').replace(/^\.?\//, '');
  if (!clean) return;
  if (!refs.has(clean)) refs.set(clean, from);
};
const icons = (o, from) => { for (const v of Object.values(o || {})) ref(v, from); };
icons(m.icons, 'icons');
icons(m.action?.default_icon, 'action.default_icon');
if (m.action?.default_popup) ref(m.action.default_popup, 'action.default_popup');
if (m.options_ui?.page) ref(m.options_ui.page, 'options_ui');
if (m.options_page) ref(m.options_page, 'options_page');
if (m.background?.service_worker) ref(m.background.service_worker, 'background');
for (const s of m.background?.scripts || []) ref(s, 'background');
if (m.background?.page) ref(m.background.page, 'background');
for (const cs of m.content_scripts || []) {
  for (const f of [...(cs.js || []), ...(cs.css || [])]) ref(f, 'content_scripts');
}
// The app's cloud client ids (Shared/cloud-ids.json) sit next to the extension's files. They
// are not part of the extension build.
const appOwn = (f) => /^cloud-ids(\.local)?\.json$/.test(f);
const files = walk(ext).filter((f) => !bundleOwn(f) && !appOwn(f));
const globRe = (g) => new RegExp(`^${g.replace(/^\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
for (const w of m.web_accessible_resources || []) {
  for (const r of w.resources || []) {
    if (r.includes('*')) {
      if (!files.some((f) => globRe(r).test(f))) fail(`web_accessible_resources "${r}" matches no file`);
    } else ref(r, 'web_accessible_resources');
  }
}

// Files the pages and scripts point to.
const local = (u) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(u);
for (const f of files) {
  const text = /\.(html|js|css)$/.test(f) && !f.startsWith('pdf/cmaps/') && !f.startsWith('pdf/fonts/')
    ? fs.readFileSync(path.join(ext, f), 'utf8') : '';
  if (!text) continue;
  const dir = path.posix.dirname(f);
  const rel = (u) => (u.startsWith('/') ? u.slice(1) : path.posix.normalize(path.posix.join(dir, u)));
  if (f.endsWith('.html')) {
    for (const [, u] of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(https?:)?\/\//i.test(u)) fail(`${f} loads ${u} from the network`);
      else if (local(u)) ref(rel(u), f);
    }
  } else if (f.endsWith('.js')) {
    for (const [, u] of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) ref(rel(u), f);
    for (const [, u] of text.matchAll(/["'`](\/?(?:chunks|assets|icons|pdf)\/[\w./-]+\.(?:js|css|png|svg|html))["'`]/g)) {
      ref(u.replace(/^\//, ''), f);
    }
    for (const [, u] of text.matchAll(/getURL\(\s*["'`](\/?[\w./-]+\.\w+)/g)) ref(u.replace(/^\//, ''), f);
  } else if (f.endsWith('.css')) {
    for (const [, u] of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      if (/^(https?:)?\/\//i.test(u)) fail(`${f} loads ${u} from the network`);
      else if (local(u) && !u.startsWith('data:')) ref(rel(u), f);
    }
  }
}
for (const [file, from] of refs) if (!has(file)) fail(`${file} is missing (named in ${from})`);

// Licences and the PDF viewer.
for (const f of ['LICENSE', 'NOTICE', 'pdf.html', 'pdf/worker.js', 'pdf/LICENSE-pdfjs.txt',
  'pdf/LICENSE-cmaps.txt', 'pdf/LICENSE-foxit.txt', 'pdf/wasm/openjpeg_nowasm_fallback.js',
  'pdf/wasm/jbig2_nowasm_fallback.js']) {
  if (!has(f)) fail(`${f} is missing`);
}
// The page scripts: a small stub on every page, and the viewer and the tools that the
// background registers or injects. A stub with the viewer inside is an old build.
for (const f of ['stub.js', 'content/loader.js', 'content/tools.js', 'content/boot.js']) {
  if (!has(f)) fail(`${f} is missing`);
}
// The release stub is under 3 KB and a bench or diagnostics stub a little over; 8 KB leaves
// room for those and still catches the old stub with the viewer inside, which was 196 KB.
if (has('stub.js') && fs.statSync(path.join(ext, 'stub.js')).size > 8192) {
  fail('stub.js is over 8 KB: the viewer is bundled into it (an old build)');
}
if (!perms.includes('scripting')) fail('scripting is missing from permissions: the viewer cannot be registered or injected');
for (const f of files) {
  if (f.startsWith('content/') && !['content/loader.js', 'content/tools.js', 'content/boot.js'].includes(f)) {
    fail(`${f} is not a page script of the Safari build`);
  }
}
if (!files.some((f) => /^pdf\/cmaps\/.+\.bcmap\.js$/.test(f))) fail('pdf/cmaps has no cmaps');
if (!files.some((f) => /^pdf\/fonts\/.+\.pfb\.js$/.test(f))) fail('pdf/fonts has no fonts');
if (!(m.web_accessible_resources || []).some((w) => (w.resources || []).includes('pdf.html'))) {
  fail('pdf.html is not web accessible');
}

// Nothing left from an earlier build: the files match the current Safari build, and every
// chunk and stylesheet is used.
if (fs.existsSync(path.join(src, 'manifest.json'))) {
  const want = new Set(walk(src));
  for (const f of files) if (!want.has(f)) fail(`${f} is not in the current Safari build (stale)`);
  for (const f of want) if (!has(f)) fail(`${f} from the Safari build is not in the bundle`);
} else {
  warns.push(`no Safari build at ${src} to compare with`);
}
for (const f of files) {
  if (/^(chunks|assets)\//.test(f) && !refs.has(f)) fail(`${f} is not used by anything (stale)`);
}

for (const w of warns) console.log(`warning: ${app}: ${w}`);
if (fails.length) {
  for (const f of fails) console.error(`FAIL ${app}: ${f}`);
  process.exit(1);
}
console.log(`ok ${app}: ${files.length} files, ${refs.size} references checked`);
EOF
  then
    status=1
  fi
done
exit $status
