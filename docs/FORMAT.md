# PageInk record format, version 1

One JSON shape is used everywhere: in extension storage, in the backup folder or cloud, and by the
embed script.
The TypeScript types are in `packages/core/src/types.ts`.

## Records

```
PageRecord {
  v: 1
  key:        string        // page identity (DESIGN 7.6)
  urls:       string[]      // every address seen for this document, plus "host:<name>" entries
  title:      string
  updatedAt:  number        // epoch ms
  notes:      Note[]
  deleted:    { id: string, t: number }[]   // removed note ids and stroke ids
  snapshot?:  { ref: string, t: number }    // reserved; nothing writes it yet
}

Note {
  id, createdAt, updatedAt, device
  kind:    "ink" | "textmark"
  anchor:  Anchor
  frame:   { w, h, fontPx, viewportW }   // anchor box and text size when written
  strokes: Stroke[]                      // kind "ink". Empty for "textmark".
  mark?:   { style: "highlight" | "underline" | "strike", color }   // kind "textmark"
  thumb?:  string                        // small image data URL, viewport anchors only, at most 8 KB
}

Anchor {
  type:   "text" | "block" | "media" | "viewport"
  quote:  { exact, prefix, suffix }      // about 32 characters each side
  path:   { id?, css, xpath }            // structural address of the element
  pos:    { start, end }                 // offsets in the document's text
  hash:   string                         // hash of the block's normalised text
  media?: { src, alt, caption }
  place:  "on" | "left" | "right" | "above" | "below"
  scroller?: path                        // the anchor lives in an inner scrolling area
  frame?: { url, path }                  // the anchor lives in an embedded frame
  frac?:  { x, y }                       // note position as a fraction of the document when written
  link?:  string                         // address of the link the anchor block contains or sits in
}

Stroke {
  id, t
  tool:  "pen" | "hi"
  color: string             // semantic name: "ink-1", "ink-2", "hi-1", "hi-2"
  w:     number             // base width, note-local units
  pts:   number[]           // delta-encoded integer triples
  d:     string             // finished outline path, note-local units
}
```

## Units

**Note-local units.** CSS pixels at the time of writing, measured from the note's origin.
The origin depends on the anchor:

| Anchor                               | Origin x                                                       | Origin y                                                       |
| ------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- |
| `text`                               | left of the first line box of the quote                        | top of the first line box of the quote                         |
| `block`, place `on`, `left`, `above` | left edge of the block                                         | top of the quote line (block top when the quote is empty)      |
| `block`, place `right`               | right edge of the block                                        | top of the quote line                                          |
| `block`, place `below`               | left edge of the block                                         | bottom edge of the block                                       |
| `media`                              | left edge of the element                                       | top edge of the element                                        |
| `viewport`                           | left of the tied element, or `frac.x` times the document width | top of the tied element, or `frac.y` times the document height |

**Scale on placement.** One factor for the whole note.
`text` and `block`: current font size of the anchor element over `frame.fontPx`.
`media`: current element width over `frame.w`. `viewport`: 1.

**Document text.** `pos` and `quote` use the document's text as built by `anchor/`: the text nodes of
`<body>` in document order, shadow trees included, with `script`, `style`, `noscript`, `template` and
hidden elements skipped, and every run of white space folded to one space. A space is added at block
boundaries and at `<br>`, so words in neighbouring blocks never run together.

## Stroke points

`pts` is a flat list of integers, three per sample: x, y, pressure.
x and y are in tenths of a note-local unit. Pressure runs from 0 to 100.
The first triple is absolute. Every later triple is the difference from the one before.

```
samples (1.0, 2.0, 0.5) (1.4, 2.5, 0.6)   ->   pts [10, 20, 50, 4, 5, 10]
```

`d` is the outline of the stroke as an SVG path, filled, not stroked. It is what gets painted.
Coordinates carry at most one decimal.

## Ids and changes

- Ids are unique strings of letters, digits and `_ . : ~ -`, at most 160 characters. An id is never
  used twice. `~` appears only in the id of a note that outlived a deletion (see "Merge").
- A stroke never changes after it is written.
- Removing a note or a stroke adds its id to `deleted`. A note's tombstone time is never older than
  the newest stroke in it.
- Removing all ink on a page for good (the library's Delete, the toolbar's Clear page) writes a
  tombstone for every note and every stroke and keeps the record. A record with tombstones and no
  notes is how a deleted page is remembered, so a copy in the folder or on another device cannot
  bring the ink back. It is not listed in the library.
- Moving, splitting or joining notes, and undoing a removal, write copies under new ids and add the old
  ids to `deleted`.

## Merge

Given two copies of a record with the same `key`:

1. `deleted` is the union by id. The later `t` is kept.
2. Notes are grouped by the id they were first written under: the part of the id before any `~`.
3. A group with no tombstone on any of its ids: notes are the union by id. For a note present in
   both copies, fields other than `strokes` come from the copy with the newer time, and `strokes` is
   the union by id, minus ids in `deleted`, ordered by `t`. A copy's time is the larger of its
   `updatedAt` and the `t` of its newest stroke.
4. A group with a tombstone on any of its ids, the latest at time T: the note and every stroke in
   the group written at or before T are gone. Strokes written after T, on any device, survive
   together as one note with the id `<first id>~<T in base 36>`. Its fields come from the newest
   copy whose time is after T. When no copy in the group is newer than T, nothing is left.
   A copy edited after T with no stroke left keeps a note with no strokes. It shows nothing and
   is not counted.
5. `urls` is the union. `title` and `snapshot` come from the copy with the newer `updatedAt`.
6. `updatedAt` is the larger of the two.

Merge is commutative, associative and idempotent, so devices can sync in any order and the
survivors of a deletion get the same id everywhere. T only grows as copies meet, so a stroke that
is gone stays gone.

Example: device A deletes note `n` at 12:00. Device B, offline, adds a stroke to `n` at 12:05.
After both sync, the strokes `n` had at 12:00 are gone, and the 12:05 stroke is in note `n~` plus
the deletion time in base 36, at the place `n` had.

**Clocks.** Times come from each device's own clock, and devices do not agree on the time. A
device whose clock runs behind can write strokes that look older than a deletion made elsewhere;
those strokes are removed with the note. A device whose clock runs ahead can write strokes that
look newer than a later deletion; those survive as a new note. Within one device, a note's
tombstone is never older than the strokes it had, so a clock that runs ahead cannot make a
deleted stroke come back.

## Storage keys

| Key                   | Value                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `p:<hash of key>`     | `PageRecord`                                                                                                                           |
| `p:<hash of key>.<n>` | `PageRecord` of a page whose hash another page already uses                                                                            |
| `idx:<hash of host>`  | `{ v: 1, m: { [hash of address key]: slot } }`                                                                                         |
| `cfg`                 | settings                                                                                                                               |
| `sync`                | sync status: `{ lastSync?, lastFull?, error?, problem?, locked? }`                                                                     |
| `nudge`               | the backup prompt: `{ dismissed?, at?, chosen? }`                                                                                      |
| `dest`                | the place notes are kept: `{ kind: "folder" }` or `{ kind: "cloud", provider }`, plus `since?` after a switch                          |
| `welcomed`            | the first-run guide was shown, or was not needed: `{ at }`. Extension only, never synced                                               |
| `tok:<provider>`      | that cloud's tokens, folder ids and the account name to show. Extension only, never synced, removed on Disconnect. In the secret store |
| `names:<provider>`    | that cloud's name to file id list and change cursor                                                                                    |
| `seen:<provider>`     | per file: version, page key and a hash of the text, to skip unchanged downloads                                                        |
| `lockKey`             | the password lock's key on this device: `{ key, check, kdf?, state? }`. In the secret store                                            |

All of these are in `storage.local`, except `tok:<provider>` and `lockKey`. Those are in the
background's secret store: its own IndexedDB database `pageink-secrets`, which content scripts
cannot open (`src/background/secrets.ts`). Development builds kept them in `storage.local`; they
are moved once and removed there. Nothing is ever put in `storage.sync`.

The hash is `hashKey` in `packages/core/src/hash.ts`. It is 53 bits and not collision proof:
two addresses with the same hash can be found in minutes. So a record slot is only a place to
look. Every read checks that the record's `key` is the page's key, or that the record lists the
address it was found under. A record that fails the check is treated as no record. A page whose
main slot `p:<hash>` holds another page's record is written to the first free overflow slot
`p:<hash>.1` up to `p:<hash>.7`. When a main slot empties, its first overflow record moves into it.

A slot in the index is `<hash>` or `<hash>.<n>`, the exact slot of the record. Two records can
claim one address hash. A record's claim on its own key's hash wins over another record's alias;
otherwise the first claim stays, and the other page is found by its key.
A host has an index entry only while it has at least one page with ink.
A record is listed under every host its document can appear on, and under each of its alias addresses.

`urls` also holds one `host:<name>` entry for every host the document can appear on. The site index
is rebuilt from these when records arrive from the folder.

## Addresses

Page keys and the addresses in `urls` never hold credentials. User names and passwords in an
address are dropped, and so are these query and fragment parameters, matched without regard to
case: the names in `CREDENTIAL_PARAMS` in `hash.ts` (among them `token`, `access_token`, `auth`,
`key`, `apikey`, `session`, `sid`, `sig`, `signature`, `jwt`, `otp`, `password`, `secret`), every
name that starts with `x-amz-` or `x-goog-` (the parts of a signed storage link), and `code` and
`state` when both are present. A value is dropped whatever its name when it is a JSON web token,
and when it is a random looking run of 16 or more letters and digits under a name with a secret
word in it (`authToken`, `sharing_token`, `X-Sig`). A long random value under any other name
stays, since some sites name their pages that way. Other parameters stay, so pages told apart by
them stay apart. What is dropped is not kept anywhere.

A fragment is part of the key when it is a route: it starts with `/` or `!`, or it holds a `/` or
`=` and no element in the document has it as its id or name (`#inbox/abc` in a mail app). Other
fragments are dropped. Text fragments (`#:~:text=`) are never part of the key.

## Reading stored data

Records from storage, the folder and archives are checked field by field before use. Only the
fields in this file are kept. Strings, numbers and arrays have generous caps: 5000 notes per record,
5000 strokes per note, 20000 points per stroke, 200000 tombstones, 256 addresses. Numbers must be
finite and in range, `pts` must be integer triples, `d` may hold only the commands M, L, Q, C and Z
and numbers, colours are the semantic names or hex, and a thumbnail must be a `data:image/png`,
`jpeg` or `webp` address of at most 8 KB or it is left out. A note that fails is left out alone and
reported once. A record whose own fields fail is ignored. A stored record or file that had anything
left out is never written over. JSON is parsed without `__proto__`, `constructor` or `prototype`
keys.

## Backup folder

```
<folder>/pages/<hash of key>.ink.json       one PageRecord, pretty JSON
<folder>/pages/<hash of key>.<n>.ink.json   a page whose hash another page's file already uses
```

A file's record key, not its name, says which page it holds. While the password lock is on, the
hash in the name is made with the lock's key (see "Password lock").

There is no shared index file. The index is rebuilt by listing the folder.
Files that a sync service renames on conflict (`name (1).ink.json`, `name (conflicted copy).ink.json`
and similar) are read, merged into the record with the same `key`, and removed.
An archive export is a zip with the same layout. An import reads only entries named
`pages/<file>.ink.json` with no folders, `..` or control characters, and stops with an error when
the archive is over 256 MB, unpacks to over 1 GB in all or 32 MB for one file, or holds over 50000
entries. The caps are checked while the archive is unpacked.

## Cloud places

A cloud holds the same layout as the backup folder.

| Provider     | Where                                                                            |
| ------------ | -------------------------------------------------------------------------------- |
| Google Drive | a folder named after the product in My Drive, holding `pages/` and the lock file |
| OneDrive     | the app folder (`Apps/<app name>`), holding `pages/` and the lock file           |

Google Drive can hold two files with one name. The one with the lowest file id keeps the name.
Each other one is treated as a sync copy (`<hash> (copy <id>).ink.json`): read, merged and removed,
as above.

## Password lock

Optional. When it is on, every page file is sealed on the device before it leaves, for a folder
and for a cloud alike, and file names are made with the key. Known answers for every step are in
`docs/lock-vectors.json`. Version 2 is the current version, and the only one a device writes.
Version 1 (below) is from development builds only; readers still accept it, to move a place to
version 2.

**Key.** PBKDF2-HMAC-SHA-256 over the password, taken as Unicode NFC and then UTF-8, with the
salt and the count in the lock file. Output: 32 bytes. The count is 600000 for new locks; a
reader accepts 100000 to 10000000. The salt is 16 random bytes; a reader refuses a lock file
whose salt is shorter.

**Key check.** HMAC-SHA-256 of the ASCII text `lock-check-v1`, keyed with the 32 key bytes. A
password is right when its check equals the lock file's.

**Keys made from the key.** HKDF-SHA-256 with the key as input, an empty salt, and one of these
ASCII texts as info, 32 bytes each: `pageink lock v2 seal` (seals files), `pageink lock v2 lock
file` (the lock file's MAC), `pageink lock v2 names` (file names).

**File names.** While the lock is on, a page's hash in its file name is the first 10 bytes of
HMAC-SHA-256 of the page key (UTF-8) under the names key, in lower case base32 (`a` to `z`, `2` to
`7`, no padding): 16 characters. Overflow names add `.<n>` as usual. While the lock is off, names
use the plain `hashKey`. Turning the lock on or off renames every file.

**Lock file.** `pageink.lock.json` at the top of the place, next to `pages/`. It never holds the key.

```
{
  "v": 2,
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<16 bytes, base64>" },
  "check": "<32 bytes, base64>",
  "state": "on" | "turning-on" | "turning-off",
  "mac": "<32 bytes, base64>"
}
```

`mac` is HMAC-SHA-256 under the lock file key of this ASCII text, each line ending in a newline:

```
pageink-lock-file-v2
kdf=PBKDF2,SHA-256,<iterations>,<salt as written>
check=<check as written>
state=<state>
```

A device checks the MAC before it trusts any field.

**Sealed file.** The file's text is one line of JSON and a newline:

```
{"lock":2,"alg":"A256GCM","f":"<name>","n":"<12 byte nonce, base64>","c":"<cipher text and 16 byte tag, base64>"}
```

AES-256-GCM with the seal key, a fresh random nonce for every write, and as additional data the
ASCII text `pageink-lock-v2`, a newline, and `f`: the name the file was sealed for, from the top of
the place (`pages/<hash>.ink.json`). The plain text is the record file exactly as it would be
written without the lock (pretty JSON and a newline). Base64 is the standard alphabet with padding.

**Reading.** A file belongs where it was found only when all of these hold: it is a version 2
envelope; `f` is a page file name; the file's name is `f`, or, for a sync copy, starts with the
hash in `f`; it opens with the key; and the page key inside gives that hash. Anything else in
`pages/` while the lock is on (a plain file, a file sealed for another name or with another key,
a version 1 file after the move) is "not ours": sync never merges it, never writes over it, never
removes it, writes nothing for its page, and tells the reader. A device with no key leaves every
sealed file alone and writes nothing to a locked place.

**Who may change the state.** Only the reader, on a device that holds the key, turns the lock
off. A device that holds a key decides before every sync:

| Lock file found                                         | What the device does                    |
| ------------------------------------------------------- | --------------------------------------- |
| none                                                    | stops, keeps its notes, asks the reader |
| unreadable, another check, or a MAC that does not match | stops, keeps its notes, asks the reader |
| `turning-off`, and this device did not start it         | stops, keeps its notes, asks the reader |
| `turning-on`, and this device has seen the lock `on`    | stops, keeps its notes, asks the reader |
| `turning-on` otherwise, or `turning-off` it started     | finishes the step, then syncs           |
| `on`                                                    | syncs                                   |

The reader's two choices: put the lock file back from this device (written as `turning-on` with
the settings this device kept, then every file is sealed again and it is set `on`), or turn the
lock off here on purpose. Each device keeps, with its key, the lock's settings and the last state
it wrote or accepted (`lockKey`).

**Turning on.** Write the lock file with `turning-on`. Then, one file at a time, seal each plain
file under its keyed name: write the new file first, then remove the old one. Then set `on`.
**Turning off.** Set `turning-off`. Then open each sealed file and write it plain under its plain
name, the same way. Then remove the lock file. A name that is already taken gets a sync copy
(`<hash> (moved <tag>).ink.json`), which the next sync folds in. A device that stops halfway
finishes on its next sync, and at every step every file opens with the key. Plain files are taken
in only while turning on.

**Version 1, development builds only.** Readers still accept it. The lock file has `"v": 1` and no `mac`; sealed files are
`{"lock":1,"alg":"A256GCM","n":...,"c":...}`, sealed with the key itself and the additional data
`lock-v1`, under plain names. A device with the key moves such a place to version 2 on its next
sync: `on` stays `on` (plain files found there are not ours and stay as they are), `turning-on`
continues as above, and `turning-off` is treated as a change it did not make.

**What the lock does not protect against.** Someone who can write to the place can put back an
older sealed copy of a whole file, and no device can tell it from the current one, because there
is no counter that the place cannot rewind. Notes merge, so a device that already has the newer
notes loses nothing and writes them back; a device that has not seen them yet gets the older copy.
Such a writer can also delete files, and can see sizes, times and how many files there are.

**On each device.** The password is asked once. The key, its check, the lock's settings and the
state are kept on that device (`lockKey`, in the extension's secret store or the app's keychain),
never in the place. A recovery key is the same 32 bytes in base32 (RFC 4648 alphabet, no padding),
in groups of four with dashes: 52 letters and digits.

If the password and the recovery key are both lost, the copy in the place cannot be read. The
notes on each device stay readable there.
