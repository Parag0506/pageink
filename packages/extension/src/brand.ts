/**
 * The extension's names, in one place. The product name itself comes from
 * pageink-core so the bar, the embed and the extension always agree.
 */
import { NAME } from 'pageink-core/brand';

export { FORMER_NAMES, NAME, PREFIX, SLUG } from 'pageink-core/brand';

/**
 * The manifest name in the Chrome and Edge stores. Search inside a store matches on the
 * name, so it says what the extension does. The toolbar title, the popup and every other
 * place in the extension still say just NAME (`short_name` and `action.default_title`).
 */
export const STORE_NAME = `${NAME}: Handwrite and Annotate Web Pages`;

/** The same for Firefox Add-ons. */
export const STORE_NAME_FIREFOX = `${NAME}: Handwrite on Web Pages`;

/** Store and manifest description, for Chrome, Edge and Firefox. It names no browser. */
export const DESCRIPTION =
  'Handwrite and annotate web pages and PDFs with a pen, finger or mouse. Notes return on the same words. Free, no account.';

/**
 * The same for Safari. The App Store refuses a manifest description over 112 characters, so
 * this one leaves out the list of what you can write with.
 */
export const DESCRIPTION_SAFARI =
  'Handwrite and draw on any web page. Your notes come back on the same words and go only where you choose.';

/** Firefox add-on id. It is permanent once the add-on is listed, so change it only before then. */
export const FIREFOX_ID = 'pageink@pageink';
