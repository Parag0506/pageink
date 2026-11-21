# Native folder protocol, version 1

The Safari build keeps the reader's notes in a folder through the wrapper app.
The extension sends messages with `browser.runtime.sendNativeMessage`. Safari ignores the
application id and delivers them to the app that contains the extension, which answers in its
`SafariWebExtensionHandler` (`NSExtensionRequestHandling`). The extension side is
`src/adapters/folder-native.ts`.

The app owns the folder. The reader picks it in the app, and the app keeps the security-scoped
bookmark. The extension never sees paths outside the folder.

## Requests

Every request has `v: 1` and an `op`.

| op       | fields                       | does                                         |
| -------- | ---------------------------- | -------------------------------------------- |
| `status` | none                         | says whether a folder is connected           |
| `list`   | `dir`, for example `"pages"` | lists the files directly inside `dir`        |
| `read`   | `name`                       | returns the text of one file                 |
| `write`  | `name`, `text`               | creates or replaces one file, creating `dir` |
| `remove` | `name`                       | deletes one file                             |

```json
{ "v": 1, "op": "status" }
{ "v": 1, "op": "list", "dir": "pages" }
{ "v": 1, "op": "read", "name": "pages/3k9x2a.ink.json" }
{ "v": 1, "op": "write", "name": "pages/3k9x2a.ink.json", "text": "{\n  \"v\": 1, ... }" }
{ "v": 1, "op": "remove", "name": "pages/3k9x2a.ink.json" }
```

## Replies

Success always has `ok: true`. Failure has `ok: false` and an `error` code.

| op       | success reply                                                   |
| -------- | --------------------------------------------------------------- |
| `status` | `{ "ok": true, "folder": "PageInk Notes" }` or `"folder": null` |
| `list`   | `{ "ok": true, "files": [{ "name", "mtime", "size" }] }`        |
| `read`   | `{ "ok": true, "text": "..." }`                                 |
| `write`  | `{ "ok": true }`                                                |
| `remove` | `{ "ok": true }`                                                |

Error codes:

| error       | meaning                                                          |
| ----------- | ---------------------------------------------------------------- |
| `no-folder` | the reader has not picked a folder yet                           |
| `not-found` | `read` or `remove` of a file that does not exist                 |
| `denied`    | the app lost access to the folder; the reader must pick it again |
| other text  | any other failure, as a short message                            |

## Rules

- Names are relative to the folder root, use `/`, never start with `/` and never contain `..`.
  The extension refuses such names before sending. The app must refuse them too.
- `list` returns full relative names, such as `pages/3k9x2a.ink.json`, not bare file names.
- `list` of a directory that does not exist is an empty list, not an error.
- `mtime` is the modification time in epoch milliseconds. `size` is in bytes.
- `text` is UTF-8. Files are written whole. Write to a temporary file and rename, so a sync
  service never sees half a file.
- Files that a sync service renamed on conflict (`name (1).ink.json`) are listed like any other.
  The extension merges and removes them (FORMAT.md, "Backup folder").
- Replies arrive in the order of requests per message. The extension sends one request at a time.
- A missing reply counts as an error (`no-reply`) on the extension side.

## Folder layout

The same as FORMAT.md, "Backup folder": one `pages/<hash of key>.ink.json` per page.

## Site access

With Safari's "All Websites" left on Ask, the extension does not run on a page until the reader taps
its toolbar button, so the Pencil seems not to work. The background tells the app whether it may run
on every website, so the app's setup screen can show that step as done or not. It sends this when it
starts, when the browser reports a change, and when the popup opens, and only when the value changed
since the last answer. It needs no folder.

```json
{ "v": 1, "op": "access", "all": false }
```

The reply is `{ "ok": true }`. `all` must be `true` or `false`; anything else is `bad-request`. The
app keeps the value with the time it arrived and shows it on its setup screen.

## Clouds through the app

Safari has no `identity` API, so the extension cannot open a sign-in window. The app does the
whole cloud job: it signs in, keeps the tokens, and makes the provider calls. The extension sends
the same `list`, `read`, `write` and `remove` as for a folder, and the app sends them on to the
cloud the reader chose. Of the two possible designs (the app does the cloud work, or the app
hands the extension a token) this is the simpler and the safer one: the extension never holds a
token, so none can leak through extension storage, and the Safari build keeps
`connect-src 'none'` and has no cloud code at all.

### Requests

| op           | fields                              | does                                                 |
| ------------ | ----------------------------------- | ---------------------------------------------------- |
| `connect`    | `place`: `"google"` or `"onedrive"` | signs in to that cloud and makes it the place        |
| `disconnect` | `removeFiles`: `true` or `false`    | stops using the cloud or the folder (see Disconnect) |

```json
{ "v": 1, "op": "connect", "place": "google" }
{ "v": 1, "op": "disconnect", "removeFiles": false }
```

### Replies

| op           | success reply                                                                     |
| ------------ | --------------------------------------------------------------------------------- |
| `status`     | `{ "ok": true, "folder": "Google Drive", "place": "google", "account": "a@b.c" }` |
| `connect`    | `{ "ok": true, "account": "a@b.c" }` when the sign-in finished                    |
| `connect`    | `{ "ok": true, "pending": true, "open": "<app link>" }` when the app finishes it  |
| `disconnect` | `{ "ok": true }`                                                                  |

`status` gains two fields. `place` is `"folder"`, `"google"`, `"onedrive"` or `null`. `account`
is the address to show, for a cloud. The app reads it from the keychain, with the tokens, and
keeps it in no App Group file. The extension shows it and stores it nowhere. A reply with neither is read as an app that knows only
folders. `folder` stays the name to show: the folder's name, or the cloud's name. With no folder
and no cloud, the app answers `"place": "folder"` with its own container's name, as before.

`open`, with `pending`, is the app's own address,
`<bundle id base>://connect?place=google&request=<32 hex digits>`. The request id is random and
is also kept in the shared container; the app acts only on a link that carries it, and then asks
the reader before it signs in. The extension shows "Finish connecting in the app" and a button
that opens it. The extension passes on only an address of that form.

A `write` the app could not send because the cloud did not answer (`offline`, `throttled`,
`server`) is kept in the app and answered `{ "ok": true, "queued": true }`. The extension may
ignore `queued`.

More error codes. They are the same words the extension shows the reader
(`src/connect/dest.ts`), each with one next step:

| error        | meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `cancelled`  | the reader closed the sign-in window                           |
| `denied`     | the provider refused access, or the reader said no             |
| `offline`    | no network                                                     |
| `full`       | the cloud storage is full                                      |
| `expired`    | the sign-in ran out and a silent renewal failed: connect again |
| `not-set-up` | this build of the app has no client id for that provider       |
| `throttled`  | the provider kept asking to slow down                          |
| `server`     | the provider failed                                            |
| `conflict`   | a `write` met a newer version that another device wrote        |

### Sign-in

- The app opens the provider's page with `ASWebAuthenticationSession`: the code flow with PKCE,
  back to the app's own scheme, and no client secret. The scopes are the extension's: Google
  `drive.file`; Microsoft `Files.ReadWrite.AppFolder offline_access`. No other scope is asked for.
- The extension's handler cannot show a window, on iPadOS or on macOS. So `connect` signs in
  only when the app already holds tokens for that cloud (the reader connected it in the app).
  Otherwise it notes the request in the shared container and answers `pending: true` with
  `open`. On macOS the handler also opens the app itself. On iPadOS an extension cannot open an
  app, so the extension's button does it (Safari asks "Open in the app?"). The app starts the
  sign-in as soon as it opens, from the link or from the noted request (kept 30 minutes). The
  extension reads `status` again on its next sync.
- Redirects: Google uses an "iOS" client (for the iPad and the Mac) and returns to
  `com.googleusercontent.apps.<id>:/oauthredirect`; Microsoft returns to
  `msauth.<bundle id base>://auth`. See docs/CLOUD_SETUP.md, "The Apple app".
- Tokens live in the keychain only, in the App Group's access group, so the app and its
  extension's handler (one product, two processes) read the same items. They are never sent to
  the extension's JavaScript, never written into the notes or the container, and never logged.
  A refresh that fails answers `expired`, and the reader signs in again in the app.

### What runs where

- The handler (the app's extension process) does the file requests itself: it renews the
  token, calls the provider, and keeps the name list in the shared container. It waits less on
  a busy provider than the app (three tries), because Safari waits for its answer.
- Every `write` and `remove` goes to the container first, so the device always has every
  note. A change the cloud does not take now waits in a queue in the container. The handler
  sends what waits before a `list` of `pages`, for up to five seconds; the app sends all of it
  when it opens or comes to the front, and when iPadOS wakes it for a background refresh.
- A waiting change whose file was changed elsewhere meanwhile is not written over it. It goes
  up as `<name> (conflicted copy <date>).ink.json`, which the extension merges and removes.
- The app also copies new files from the cloud into the container, so its library shows notes
  from every device. It opens sealed files with the key it keeps, when the reader gave it the
  password.

### Files in a cloud

- The layout is the folder's: `pages/<hash>.ink.json` in a visible folder named after the
  product (Google Drive) or in the app folder (OneDrive), and `pageink.lock.json` at the top
  when the reader turned the lock on. Request names are the same relative names.
- `list` returns every file in `dir` with the provider's `mtime`. The app may keep a name to id
  list and use the provider's change check (Drive: a `modifiedTime` query; Graph: a delta
  link), as the extension does in `src/cloud/folder.ts`.
- `write` never replaces another device's newer write unseen. It sends the version the last
  `list` or `read` saw: Drive's `version` checked just before, Graph's `eTag` in `If-Match`,
  and `@microsoft.graph.conflictBehavior=fail` for a new name. On a mismatch it replies
  `{ "ok": false, "error": "conflict" }`, and the extension lists, reads, merges and writes again.
- Slow-down answers (429, 503, and Drive's rate 403s) are waited out in the app, up to five tries.

### The lock

The extension seals and opens files itself (FORMAT.md, "Password lock"). To the handler a sealed
file is a file like any other. The app follows the same format for its own steps (its lock switch,
finishing a lock that was turning on or off, and the library) and checks itself against
`docs/lock-vectors.json`. The app keeps its own copy of the key in the keychain; the extension
keeps its own in its background's IndexedDB. Each asks for the password once, and each follows the
same rules: neither turns the lock off because of what it finds in the place.

### Disconnect

- `removeFiles: false`, which is what the extension sends unless the reader said yes twice: the
  app deletes the tokens from its keychain, gives the Google token back at
  `https://oauth2.googleapis.com/revoke`, and forgets the place, its name list and its queue.
  The files stay, in the cloud and in the container. Microsoft has no address to give a public
  client's token back.
- `removeFiles: true`: the app first moves the cloud folder and its files to the provider's bin,
  then does the same as above. If moving fails, it replies with the error and keeps the
  sign-in, so the reader can try again.
- For a folder, `disconnect` forgets the folder. Files on disk are never removed.
