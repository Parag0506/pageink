/**
 * The product name, in one place. Every name a reader sees comes from here or
 * from the extension's brand file, so a rename starts and ends in these files.
 */

/** The name readers see. */
export const NAME = 'PageInk';

/** The lower-case form, for file names the reader sees, such as exports and store zips. */
export const SLUG = NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/**
 * Names the product had before. Tests fail if one is written as a name outside
 * this file, and the embed keeps the old global working under the first one.
 */
export const FORMER_NAMES: readonly string[] = ['Ink'];

/**
 * Lower-case prefix for element names. The layer host is `<PREFIX-layer>`.
 * Host pages and tests may select the element by this name, so change it only
 * together with them. Storage keys, file names, data attributes and the
 * `ink:` timing marks are part of the format and do not follow it.
 */
export const PREFIX = 'ink';

/** Tag of the element that hosts the layer's shadow root. */
export const LAYER_TAG = `${PREFIX}-layer`;

/** The global that the one-script embed build sets on window. */
export const GLOBAL = NAME.replace(/[^\w$]/g, '');

/** Old globals that still point at GLOBAL. Deprecated: pages should move to GLOBAL. */
export const FORMER_GLOBALS: readonly string[] = FORMER_NAMES.map((n) => n.replace(/[^\w$]/g, ''));
