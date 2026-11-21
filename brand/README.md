# PageInk brand

The mark is a cream sheet with its top right corner folded over, a hand-drawn "@" on it, and a
terracotta quill resting at the lower right. The wordmark sets "Page" in a serif italic and "Ink"
in a sans, with a pen stroke under "Ink".

## Files

| File                     | What                                                                     |
| ------------------------ | ------------------------------------------------------------------------ |
| `pageink-logo.svg`       | Mark and wordmark, for light grounds. Letters are outlines: no fonts.    |
| `pageink-logo-dark.svg`  | The same, with the words in the page colour, for dark grounds.           |
| `pageink-mark.svg`       | The mark alone, from 48 px up.                                           |
| `pageink-mark-small.svg` | The small mark for 16 to 32 px: sheet, fold and "@", heavier lines.      |
| `underline.svg`          | The pen stroke under "Ink", alone.                                       |
| `png/`                   | The mark at 16, 32, 48, 128, 256, 512 and 1024 px, transparent or cream. |
| `colours.md`             | The four colours with hex and RGB values.                                |

These files are the project's own work, under the repository's licence, and are kept as files. The
"@" and the pen stroke were drawn with the product's own pen outline. The logo's letters are outlines
of Geist Sans and Instrument Serif, both under the SIL Open Font License 1.1, which allows this. The
extension's icons (`packages/extension/scripts/icons.mjs`) and the
app's icons (`apple/Icon/make-icons.sh`) are rendered from the SVGs here.

## Colours

| Name  | Hex       | Use                               |
| ----- | --------- | --------------------------------- |
| Ink   | `#2f241c` | Every line, the "@", the wordmark |
| Page  | `#f8efdc` | The sheet, and icon backgrounds   |
| Fold  | `#e4cfa9` | The underside of the corner       |
| Quill | `#c98c5e` | The quill. The one accent colour. |

In the product UI the quill colour is darkened to `#9a5530` for text and controls on light
grounds (5.6:1 on white) and lightened to `#e0a77b` on dark grounds (7.3:1 on `#2a2420`).
Primary buttons use the ink on light grounds and the page colour on dark ones.

## Clear space

Keep a margin around the mark of at least one quarter of its width, and around the logo of
at least the height of the sheet's fold (about one eighth of the logo's height). Nothing else
sits in that space.

## Minimum sizes

- Full mark: 48 px. Below that the quill turns to noise.
- Small mark: 16 px. Use it at 16 to 32 px, such as favicons and toolbar icons.
- Logo with wordmark: 120 px wide on screen. Below that, use the mark alone.

## The small mark

At 16 and 32 px the quill and the thin lines of the full mark disappear. The small mark drops
the quill and draws the sheet, the fold and the "@" with heavier lines, so the shape still
reads. Its cream sheet stays visible on dark toolbars and its ink outline on light ones, so one
icon works on both.

## Do

- Use the files as they are, at the sizes above.
- Put the mark on the page colour, on white, or on a dark ground; the sheet carries its own ink.
- Use `pageink-logo-dark.svg` on dark grounds so the words stay readable.
- Use the cream PNGs where an icon must have no transparency, such as app icons.

## Do not

- Recolour, stretch, rotate, outline or add shadows to the mark.
- Set the wordmark in other fonts, or retype it as live text.
- Put the full mark below 48 px, or the small mark above 32 px.
- Place the mark on busy photos or on colours close to the page colour without its outline.
