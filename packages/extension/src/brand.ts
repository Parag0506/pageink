/**
 * The extension's names, in one place. The product name itself comes from
 * pageink-core so the bar, the embed and the extension always agree.
 */
export { FORMER_NAMES, NAME, PREFIX, SLUG } from 'pageink-core/brand';

/** Store and manifest description. */
export const DESCRIPTION =
  'Handwrite and draw on any web page with a pen, finger or mouse. Your notes come back on the same words and go only where you choose.';

/**
 * The same for Safari. The App Store refuses a manifest description over 112 characters, so
 * this one leaves out the list of what you can write with.
 */
export const DESCRIPTION_SAFARI =
  'Handwrite and draw on any web page. Your notes come back on the same words and go only where you choose.';

/** Firefox add-on id. It is permanent once the add-on is listed, so change it only before then. */
export const FIREFOX_ID = 'pageink@pageink';
