# Privacy

Last updated: 21 November 2026.

**The extension talks to nobody unless you connect a cloud. Then it talks only to that provider,
and only to its sign-in and file addresses.** The one exception is a PDF you open: the extension
reads it once more from the same address, for its viewer ("The one other request", below).

There is no account with us, no server of ours, no analytics and no crash reports. We never see or
keep your notes. They live in the browser's storage for the extension and, if you choose, in one
place you own: your Google Drive, your OneDrive, or a folder on your device. You can switch or
disconnect at any time, from any browser, and the files stay yours.

The Safari app for Mac and iPad keeps the same promise. It talks to nobody unless you connect a
cloud in it. Then it talks only to that provider's sign-in and file addresses, the same hosts as
the extension (below). It keeps notes in its own container on your device and in the place you
choose. For a cloud, the app does the sign-in and the file work itself, because Safari cannot
open a sign-in window for an extension (`packages/extension/NATIVE_PROTOCOL.md`). If your folder
is synced by a service such as iCloud Drive or Dropbox, that service copies the files under its
own terms; PageInk does not contact it.

The facts below can each be checked in the source.

## Checkable facts

| Fact                                                                                                                                                      | Where to check                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Permissions are `storage`, `unlimitedStorage` and `scripting` on every browser, plus `nativeMessaging` on Safari                                          | `packages/extension/build/targets.ts`, and `manifest.json` in each build                                                        |
| `scripting` only puts the drawing code into pages with your ink or a pen on them, Safari included                                                         | `permissionsFor` in `packages/extension/build/targets.ts`                                                                       |
| `identity` (the sign-in window) is asked for only when you click a cloud, on Chrome and Edge                                                              | `optional_permissions` in the manifest; `src/ui/connect.ts`                                                                     |
| Firefox lists `identity` up front because it cannot be optional there. It shows no warning                                                                | the Firefox manifest                                                                                                            |
| Host access to all sites, used only so ink reappears by itself when you return                                                                            | `host_permissions` in the manifest; DESIGN.md section 9                                                                         |
| Extension pages may connect only to the cloud hosts below, and Safari's to nothing                                                                        | `connect-src` in `content_security_policy` in the manifest                                                                      |
| No content script file can be loaded by a web page; only the PDF page is web accessible                                                                   | `web_accessible_resources` in the manifest                                                                                      |
| Every network call for sync is in one file, `cloud.js`, built from `src/cloud/`                                                                           | `packages/extension/network-allow.json`                                                                                         |
| A test parses every built file and fails on any other network call or any other address                                                                   | `packages/extension/test/no-network.test.ts`, run on every build target                                                         |
| The cloud code names only the five hosts listed below; OneDrive's download hosts are allowed too                                                          | the same test, "names only the pinned hosts"; `connect-src` in the manifest                                                     |
| No request started by the extension during the browser tests, except the PDF read                                                                         | `packages/extension/e2e/netlog.ts`                                                                                              |
| In the cloud tests, only requests to the local fake provider                                                                                              | `packages/extension/e2e/cloud.spec.ts`                                                                                          |
| The test build that talks to the fake cannot be packed for a store, and no release build holds a trace                                                    | `packages/extension/wxt.config.ts`; `no-network.test.ts`                                                                        |
| The same rule for the library and the embed script                                                                                                        | `packages/embed/src/no-network.test.ts`; CONTRACT.md section 2                                                                  |
| Firefox: nothing is sent unless you connect a cloud; then you are asked to agree that page addresses and the words your notes sit on go to your own cloud | `data_collection_permissions` in the Firefox manifest: `required: ["none"]`, `optional: ["browsingActivity", "websiteContent"]` |
| Notes are plain JSON files you can read, unless you lock them                                                                                             | FORMAT.md, "Backup folder" and "Password lock"                                                                                  |
| The Safari app makes no network requests unless you connect a cloud there                                                                                 | `apple/Tests/CloudHandlerTests.swift`, "testNoRequestBeforeConnect"                                                             |
| The app's one network type refuses every host not on the pinned list, also on redirects                                                                   | `PinnedNet` in `apple/Shared/CloudNet.swift`; `apple/Tests/NetworkRuleTests.swift`                                              |
| A test scans the app's Swift sources and fails on any other network call                                                                                  | `testNoOtherNetworkCodeInTheSources` in `apple/Tests/NetworkRuleTests.swift`                                                    |
| The app leaves App Transport Security strict: https only                                                                                                  | `apple/Config/*.plist`; `testTransportSecurityIsLeftStrict`                                                                     |

## When you connect a cloud

The extension then talks to these hosts, and to no other. The cloud code names the first five;
OneDrive sends the last three itself, as the place to download a file from.

| Host                              | Why                                                    |
| --------------------------------- | ------------------------------------------------------ |
| `accounts.google.com`             | Google's sign-in page, in the browser's sign-in window |
| `oauth2.googleapis.com`           | gives your Google sign-in back when you disconnect     |
| `www.googleapis.com`              | Google Drive files                                     |
| `login.microsoftonline.com`       | Microsoft's sign-in page and tokens                    |
| `graph.microsoft.com`             | OneDrive files                                         |
| `*.files.1drv.com`                | OneDrive file downloads, personal accounts             |
| `my.microsoftpersonalcontent.com` | OneDrive file downloads, personal accounts             |
| `*.sharepoint.com`                | OneDrive file downloads, work and school accounts      |

The three download hosts are allowed in `connect-src` for that reason alone. The Safari app talks to
the same hosts. It also gets its Google tokens from `oauth2.googleapis.com`.

Only the cloud you connected is contacted. Nothing is sent before you click it. A sync happens
when you write, when the browser starts, when you open the popup or the settings, and when you
open a page with ink. There is no timer that polls.

**What the extension can reach.** Google: only the files it made itself (the `drive.file`
scope, and no other), in one folder you can see in your Drive. OneDrive: only its own app folder
(`Files.ReadWrite.AppFolder`, plus `offline_access` so the sign-in lasts). No profile, email or
other scope is asked for. Nothing else in your Drive or OneDrive.

**Your Google address.** When you connect Google Drive, PageInk reads your account's email
address from Google, to show which account is connected and to renew the sign-in without asking
again. It is kept on this device with the sign-in, where web pages and the scripts in them cannot
read it. Disconnect removes it. No extra scope is asked for to read it.

**The provider's permission screen.** Google or Microsoft shows a screen that says PageInk can
use files in its own folder. PageInk there means this extension on your device. Your notes go
straight from your device to your own Drive or OneDrive. We have no servers and receive nothing.
It cannot see anything else in your Drive or OneDrive.

**Sign-in tokens** stay on this device, in the extension's own IndexedDB, which only the extension
itself can open, not its scripts in web pages. They are never synced
through the browser, never put with your notes, never written to a log, and never sent anywhere
but to the provider they came from. In the Safari app they stay in the keychain on
that device, shared only by the app and its own Safari extension, never in a file, never synced
to your other devices, and never handed to the extension's pages. Disconnect removes them and gives
the Google sign-in back, in the extension and in the app.
Microsoft has no way for an app like this to give a token back: Disconnect removes it from the
device, and the Disconnect screen tells you where to remove the app's access yourself
(account.live.com/consent/Manage, or myapps.microsoft.com for a work or school account; for Google,
myaccount.google.com/connections).

**Disconnect** a cloud and it asks whether to keep the files or delete them. Deleted files go to
the provider's bin, where you can get them back until the provider empties it. A folder's files
always stay. Disconnect also removes the lock's key from this device.

**What the provider can see.** With the lock off, the provider can read every file, page
addresses and the words your notes sit on included, under its own terms. File names are short
hashes of page addresses, and anyone can work out the hash of an address they guess, so the names
alone can show whether a page they guess has notes. Turn on the lock below if that matters to
you. The provider also sees when you sync and from which network address, as with any
service you sign in to.

## The password lock

"Lock my notes with a password" is off by default. When it is on, each file is scrambled on your
device before it leaves (AES-256-GCM with a key made from your password; FORMAT.md, "Password
lock"). The provider then sees only the sizes, the times and the file names, and the names are
made with your key, so they no longer tell which pages you wrote on. Your password never
leaves the device; each device keeps the key it made from it (the app keeps it in the keychain).
Someone who can change files in your Drive or OneDrive cannot switch the lock off or slip notes
into yours: your devices check every file, and stop and ask you if the lock file changes. They
could still put back an older copy of a file. Someone who can write to the folder could also delete
files. Your devices keep their own copies.

Anyone who can read the files can try passwords against the lock file on their own computer. Each
try costs 600,000 rounds of PBKDF2, but a short or common password can still be found. Use a long
password you use nowhere else. SECURITY.md, "The password lock", has the details.

If you forget the password and lose the recovery key, nobody can read the copy in the cloud, us
included. The notes on each of your devices stay readable there.

## What is stored, and where

Without the lock, notes are stored as plain text in the browser's storage for the extension, in
your chosen place, and in any archive you export. Anyone who can read those can read:

- the words your notes sit on: a short quote with a few words around it,
- the page title and the page address. Sign-in tokens and similar parameters are taken out of
  addresses first (FORMAT.md, "Addresses"),
- the addresses of links next to your notes,
- your handwriting, as shapes,
- small pictures of what was under a note written on a blank area, such as an image or a chart. They
  are on by default; turn them off in Settings with "Save a small picture with notes on blank areas".

Ink written in a private window is not kept unless you switch on "Keep ink written in private windows".

Deleting a page's notes removes the ink and the quoted words. A small record with the page address
and title stays, so the deletion reaches your other devices.

## Uninstalling

Removing the extension deletes its storage on that device: your notes, settings and sign-in tokens.
It does not take back the access you gave the cloud, and it does not delete files in your cloud or
folder. So disconnect first. To remove the access afterwards, use the provider's own page: Google
at https://myaccount.google.com/connections, Microsoft at https://account.live.com/consent/Manage
(for a work or school account, https://myapps.microsoft.com).

There is no button that erases everything at once. The Library in the extension's settings deletes
the notes of one page at a time.

Deleting the Safari app removes its container. The system can keep keychain items after an app is
deleted, so disconnect in the app first.

## The embed script

On a site that adds the embed script, ink is kept in that site's storage in your browser, and that
site's own scripts can read it. A site can also give the script its own store. The script itself
makes no network requests.

## What leaves the device when you ask

Syncing with the place you chose sends your notes there. Exporting an image, Markdown or an
archive writes a file where you choose. "Copy for chat" puts text on your clipboard. Opening a
link from a note opens it in your browser like any other link.

## The one other request

To let you write on a PDF, the extension reads the PDF's own address once more and hands the bytes
to its bundled PDF viewer (CONTRACT.md section 6). That read goes to the same address your browser
already loaded, and nothing is sent anywhere else. It is listed in
`packages/extension/network-allow.json`, and the no-network test checks that it is one call whose
address is the page's own.

## Store rules

PageInk's use of your data follows the Chrome Web Store User Data Policy, including its Limited
Use requirements. Your data is used only to show, keep and sync your own notes. It is not sold. It
is not used for advertising. It is not used to decide on credit or loans. Nobody but you reads it:
it goes to nobody else, and we receive none of it.

PageInk's use of information received from Google APIs follows the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including its Limited Use requirements. From Google it receives only the files it made in your Drive
and your account's email address, and it uses them only as said under "When you connect a cloud".

## Contact

Questions about privacy: [open an issue](https://github.com/Parag0506/pageink/issues). Security problems: see [SECURITY.md](SECURITY.md).
