# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org).
The record format has its own version (`v` in each record, see [docs/FORMAT.md](docs/FORMAT.md)).

## 0.1.2 (2026-11-24)

- A note written in free space stays where it was written. Before, a word with a long tail could
  fold into a small dot a moment after it was written, because the box around its ink reached a
  button or a line of text that the ink itself did not touch. Now the ink is measured, not the box,
  and in the layout a note was written in it is never moved. Notes that folded this way show again.

## 0.1.1 (2026-11-22)

Fixes found while the first version was in review.

- The bar no longer covers the last lines of a page: the page gets room at its end, and the bar stays
  on screen.
- The highlighter keeps the words readable in Safari and other WebKit browsers, and blends with a
  modal dialog or popover under it.
- Underlines and highlights: a word at an end of the stroke is marked only when most of the stroke is
  under it.
- A shape drawn round the words of one table cell is anchored to those words.
- A note written beside a block is found again from that same block.
- The first-run guide opens once per install and never over a page in use.
- The small picture of a note on a blank part of a page is asked for again when the browser refuses
  the first try.
- The Safari app's notes list draws highlights and underlines in its small pictures.

## 0.1.0 (2026-11-22)

The first version, in the Chrome Web Store and Microsoft Edge Add-ons.

- Browser extension for Chrome, Edge, Firefox and Safari: write with a pen, or with a mouse or finger
  through the draw toggle (Alt+Shift+D). Pen in two colours, highlighter, eraser, lasso to move, split
  and join notes, undo and redo.
- A stub of under 3 KB is the only code on every page. On sites with ink the viewer is registered with
  `scripting` to load with the page; elsewhere the drawing code is put into the page at the first pen
  touch. No content file is web accessible, only the PDF viewer page. Release builds carry no
  performance marks; the bench uses its own build (`wxt build --mode bench`).
- Notes are anchored to words, blocks, pictures or the page, and found again by a ladder of methods
  when the page reflows or changes. Highlights and underlines rewrap with the text.
- A "Moved notes" tray keeps notes whose passage is gone, with their words, and places them again with
  one tap.
- A bundled PDF viewer: write on a PDF like any page, with ink anchored to the PDF page and highlights
  on its words. In Chrome and Edge a PDF address opens in it by itself; on Firefox and Safari, choose
  **Open a PDF** in the settings.
- Storage in the extension, per-stroke merge, export as image, Markdown and archive, import, print
  with ink, and copy for a chat.
- Connect your own Google Drive or OneDrive, or a folder on your device, from one screen: one click,
  then the provider's own sign-in. No server of ours. One place at a time; switching copies nothing by
  itself and offers to copy your notes. Disconnect keeps the files unless you say yes twice, and says
  where to remove the app's access in your Google or Microsoft account.
- Optional "Lock my notes with a password": files are sealed on the device before they leave, with a
  recovery key you can print. The lock file carries a MAC, and only the reader, on a device with the
  key, can turn the lock off: a device that finds the lock file missing or changed stops syncing and
  asks. Each file is sealed for its own name, file names are made with the key, and plain or foreign
  files are left alone while the lock is on. The format and test vectors are in FORMAT.md and
  docs/lock-vectors.json.
- The privacy promise: the extension talks to nobody unless you connect a cloud, and then only to that
  provider's sign-in and file addresses. The one other request reads an open PDF once more for the
  viewer. All cloud network code is in one file, pinned by the no-network test to five hosts.
- Sign-in tokens, the account name and the lock key live in the background's own storage, out of
  reach of the scripts that run in pages. The background answers settings, place and lock messages
  only from the popup and the options page, and takes a picture of a tab only for the top frame of
  the active tab that asks.
- Credentials are taken out of page addresses before they are stored: sign-in tokens, signed storage
  links, web tokens and random values under secret names.
- Firefox declares that page addresses and the words notes sit on go to your own cloud when you
  connect one, and asks at that click.
- When the extension may not run on every website (Safari's "All Websites" left on Ask, or a browser
  set to some sites only), the popup says so in one line and asks for access from a tap.
- A Safari app for Mac and iPad that holds the notes library, export, import, the folder and the
  clouds. It signs in with the system's own window, and Safari's two cloud choices are routed to it
  (NATIVE_PROTOCOL.md, "Clouds through the app"). It asks before it signs in from a link, and does not
  switch clouds while changes are still waiting. Its setup screen makes "All Websites: Allow" its own
  step and checks it live.
- A guided check on a real iPad with an Apple Pencil: `corepack pnpm apple device-check` and
  `device-remove`. It uses a diagnostics build of the Safari extension that no release can carry.
- The `pageink-core` library and the `pageink-embed` script, which sets `window.PageInk`, for adding
  ink to your own pages.
- An anchor test set and a speed bench, with results in [docs/RESULTS.md](docs/RESULTS.md).
- Record format version 1. Lock file version 2.
