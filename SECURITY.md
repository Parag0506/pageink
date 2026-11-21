# PageInk security

## Reporting a problem

Please report security problems privately, not in a public issue.
Use GitHub's private vulnerability reporting for this repository:
https://github.com/Parag0506/pageink/security/advisories/new (the **Security** tab of
https://github.com/Parag0506/pageink, then **Report a vulnerability**).

Include what you found, the browser and version, the steps or a test page that shows it, and what an
attacker could do with it. You will get an answer within seven days. Once a fix is released, the
advisory is published with credit to you if you want it.

Only the latest release is supported with fixes.

## In scope

- The browser extension in `packages/extension` and the code it bundles from `packages/core`.
- The embed script in `packages/embed`.
- The Safari app and its extension handler in `apple/`.
- The record format and the folder sync: a crafted record, backup file or archive that does harm when
  read or imported.
- The cloud sync in `packages/extension/src/cloud/` and in `apple/Shared/`: sign-in, token
  handling, and files a cloud sends back.
- The password lock: a way to read sealed files without the password, to make a device write
  plain files into a locked place or turn the lock off, or to get a file into a reader's notes
  that none of their devices wrote while the lock is on (beyond the limits below).

Out of scope: problems that need a malicious browser or operating system, a folder sync service or
cloud provider reading files while the lock is off (it holds your files; turn on the lock if that
matters to you), the limits of the lock listed below, the test set and bench harnesses, the test build that talks to local fakes, and denial of
service by a page against its own tab.

## Threat model in short

**Page scripts cannot read your ink.** Notes live in extension storage, which page scripts cannot reach.
On the page, ink is drawn inside a closed shadow root on a plain element attached to `<html>`, so page
scripts cannot query into it. The content script reads records from storage directly and does not expose
them to the page.

**What a page can learn about the extension.** Only `pdf.html`, the PDF viewer, is web accessible,
so a page can show it in a frame. On Chrome and Edge its address changes every session; on Firefox the
extension's address is random per install. No content script file is web accessible: the background
registers the viewer as a content script on sites with ink (`scripting.registerContentScripts`) and
injects it and the tools elsewhere into the one frame that asks (`scripting.executeScript`), and only
known file names are injected. So a page cannot find the extension by asking for its files.

**Permissions.** `storage`, `unlimitedStorage`, `scripting` and access to all sites, on every
browser, Safari included. `identity` opens a cloud's sign-in window: optional on Chrome and Edge,
asked for at the click on a cloud; listed on Firefox, which cannot make it optional. Safari adds
`nativeMessaging` and has no `identity`: its app signs in. DESIGN.md section 9 gives the reason for
each.

**Messages to the background.** The place, connect, disconnect, lock, sync, draw and settings
messages are answered only for the popup and the options page themselves, at the top of their
window or tab, checked by the sender's exact address. A content script is refused, and so is
`pdf.html`, the one page a site can show in a frame: it may ask only for the picture of its own tab.
That picture (`captureVisibleTab`) is taken only for the top frame of the active tab that asks, so
a frame inside a page never gets a picture of the page around it.

**One page never sees another page's notes.** Records are stored under a short hash of the page
address, and two addresses with the same hash can be built in minutes. Every read therefore checks
the record's key against the page, and a page whose hash is taken gets its own overflow slot
(FORMAT.md, "Storage keys").

**Records are data and are never executed.** Records come from storage, from the backup folder and from
imported archives, and any of these may have been edited by hand. They are parsed as JSON without keys
that reach a prototype, then checked field by field, with caps on sizes and counts (FORMAT.md, "Reading
stored data"). A bad note is left out alone and a bad file is never written over. Archives are unpacked
with caps on total size, file size and file count, checked while unpacking, so a zip bomb stops early. No field is inserted as HTML or evaluated as code. Text from records is set with
`textContent`. Stroke outlines are set as SVG path data and escaped when written into an exported SVG.

**Colours and links read from records are sanitised.** A colour must be one of the semantic names
(`ink-1`, `ink-2`, `hi-1`, `hi-2`) or a hex colour, or it falls back to the default. A link from a record
is made clickable in the tray only when it starts with `http://` or `https://`, and opens with
`rel="noopener noreferrer"`. Anything else is shown as plain text.

**Addresses keep no credentials.** Sign-in tokens, session ids, signatures, the signing parts of
signed storage links (`X-Amz-*`, `X-Goog-*`) and similar parameters are taken out of every address
before it is stored, and so is any JSON web token and any random looking value under a name with a
secret word in it (FORMAT.md, "Addresses"). What is taken out is not kept anywhere.

**No network unless you connect a cloud.** Apart from reading an open PDF once more for the viewer,
the extension makes no network requests until you connect a cloud. A test parses every shipped script and fails the build on any network call, any remote
address in code, and any remote style or prefetch link, outside two places: the one PDF read, pinned
to its exact call, and `cloud.js`, whose one request function and five host names are pinned by
count. The content security policy of the extension's pages and background allows `connect-src`
only to the cloud hosts (and to nothing on Safari); in Chromium this was checked to govern the
service worker's fetch too. Each request also checks its address against the connected provider's
list before it is sent, so a "next page" or "delta" link from a provider cannot point it elsewhere.
The browser tests record every request the extension starts: none in the ordinary tests, and only
to the local fake in the cloud tests. See [PRIVACY.md](PRIVACY.md).

**Sign-in and tokens.** The provider's own page opens in the browser's sign-in window
(`identity.launchWebAuthFlow`). No client secret exists in the code: an extension cannot keep one.
OneDrive uses the code flow with PKCE and a `state` check; Google uses the token flow with a
`state` check. Tokens and the lock key are kept in the background's own IndexedDB
(`src/background/secrets.ts`), which content scripts cannot open, since they run with the page's
origin. Where the browser lets `storage.session` be closed to content scripts, it holds a copy that
goes when the browser closes. They are never in `storage.local` (which every content script can
read, and whose changes reach every tab) or `storage.sync`, never with the notes, never in a log.
Development builds kept them in `storage.local`; they are moved once and removed there. A unit test and
the cloud browser test check that `storage.local` holds none. Disconnect removes them. For Google it
first renews a token that ran out, then gives it back. Microsoft has no way for an app like this to
give a token back, so Disconnect removes it from the device and tells the reader, in one line,
where to remove the app's access in their Microsoft account (Google's page is named too). Scopes are the narrowest each provider has: Google
`drive.file`, Microsoft `Files.ReadWrite.AppFolder`.

**Files from a cloud are data.** They pass through the same checks as files from a folder (above).
A name that two files share on Google Drive is handled as a sync copy. Writes to OneDrive carry the
eTag they read, and new names fail if taken, so another device's write is never replaced unseen;
on Google Drive the version is checked just before each write.

**The password lock.** Optional. A 32 byte key is made with PBKDF2-HMAC-SHA-256 (600000 rounds,
random 16 byte salt; a lock file with a shorter salt is refused). Three keys are made from it with
HKDF: one seals files, one signs the lock file, one makes file names. What it promises, while it is
on:

- Secrecy. Each page file is sealed with AES-256-GCM and a fresh random nonce. The provider sees
  sizes, times and file names, and the names are an HMAC of the page address under a key it does
  not have, so it cannot test whether a given page has notes.
- The place cannot turn it off. The lock file carries an HMAC over every field, checked before any
  field is trusted. Only the reader, on a device that holds the key, turns the lock off. A device
  that holds the key and finds the lock file missing, changed, or turning off when it did not
  start that, stops syncing that place, keeps its notes, and asks the reader: put the lock back
  from this device, or turn it off here on purpose. It never writes a plain file to a place it
  believes is locked.
- Files are bound to their page. The file's name is bound into each seal, and the page address
  inside must give that name. A plain file, a file sealed for another name or with another key,
  or a swapped file is "not ours": it is never merged, written over or removed, and the reader is
  told.

What it does not do: a writer to the folder can put back an older sealed copy of a whole file, and
no device can tell, because there is no trusted counter. Notes merge, so a device that already has
the newer notes loses nothing, but a device that has not seen them yet gets the older copy. A
writer can also delete files; each device keeps its own copies. A writer can put back an old lock
file that says "turning on"; a device that has seen the lock on treats that as a change and stops.
While the lock is being turned on, plain files found in the place are taken in, as they are the
reader's own until then. Anyone who can read the files can try passwords against the lock file on
their own computer, since it holds the salt and a check value. Each try costs 600,000 rounds of
PBKDF2, but a short or common password can still be found; the settings ask for at least 8
characters. The key sits in the background's IndexedDB on each device that was given the
password, so anyone who can read that device's extension storage can read the notes, as they
already can there. Format and test
vectors: FORMAT.md, "Password lock", and `docs/lock-vectors.json`.

**The Safari app** only reads and writes files inside the folder you chose, its own container, and,
when you connect a cloud there, that cloud's folder for the app. File names from the extension are
checked: relative, no `..`, no leading `/` ([NATIVE_PROTOCOL.md](packages/extension/NATIVE_PROTOCOL.md)).
It signs in with the system sign-in window (`ASWebAuthenticationSession`), the code flow with PKCE
and a `state` check, and no client secret; the scopes are the extension's. Tokens and the lock's key
are kept in the keychain, in the App Group's access group so the app and its own extension process
can read them, readable after the first unlock, and never synced to other devices
(`ThisDeviceOnly`). They are never written to a file, put with the notes, logged, or sent to the
extension's pages. A unit test checks the access group, the `ThisDeviceOnly` setting, that no
item is synced, and that no target asks for another keychain group. Disconnect removes them,
gives Google's back, and names the account pages where the reader can remove the app's access. Every request goes through one
type, `PinnedNet` (`apple/Shared/CloudNet.swift`), which refuses any address that is not https on
a pinned host before it is sent, follows a redirect only to a pinned host, and then drops the token.
No cookies and no cache. App Transport Security is left strict, and the only network entitlement on
the Mac is `network.client`, outgoing only. A unit test scans the app's Swift sources and fails on any other network call, and
another checks that nothing is sent before a cloud is connected. Files from a cloud pass the same
checks as files from a folder. A change the cloud could not take waits in the container and never
overwrites another device's newer write: it goes up as a sync copy, under a name no other copy
has. The app's lock follows FORMAT.md, with the same rules as the extension, and is checked
against `docs/lock-vectors.json`; a file it cannot open is left alone. The app never adds plain
files to a locked place: import and "Copy my notes" send the reader to the extension instead.

**The app's connect link.** Any app or web page can open the app's `connect` address. The app
acts only on a link that carries the random id of the request the extension recorded in the
shared container, for the same cloud, within 30 minutes, and even then it only asks the reader;
the sign-in starts on their yes. A switch to another cloud is refused while changes for the cloud
in use are still waiting, so they are never dropped.
