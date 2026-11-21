/**
 * Which notes record a PDF opens. A PDF from the web is keyed by its own
 * address through pageIdentity, so arXiv PDFs join the family record of their
 * abs and html pages. A local file has no address worth keeping, so it is
 * keyed by the PDF.js fingerprint of its contents: the same file opened from
 * another folder or under another name finds the same notes.
 */
import { pageIdentity } from 'pageink-core/anchor';
import type { PageIdentity } from 'pageink-core/types';

export const LOCAL_PREFIX = 'pdf:';

/** Web addresses only. Anything else is treated as a local file. */
export function isWebAddress(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Identity for a local file from its fingerprint. It has no host, so no site index lists it. */
export function localIdentity(fingerprint: string): PageIdentity {
  const key = `${LOCAL_PREFIX}${fingerprint.toLowerCase()}`;
  return { key, aliases: [], host: '', hosts: [], url: key };
}

/** Identity for a PDF: by address when it came from the web, else by fingerprint. */
export function pdfIdentity(src: { url?: string; fingerprint: string }): PageIdentity {
  if (isWebAddress(src.url)) return pageIdentity(src.url);
  return localIdentity(src.fingerprint);
}

/** True for a record key made from a fingerprint. */
export const isLocalKey = (key: string): boolean => key.startsWith(LOCAL_PREFIX);

/** arXiv ids of the new form, 2401.12345 with an optional version. */
const NEW_ID = /^(\d{2})(\d{2})\.(\d{4,5})(v\d+)?$/;
const OLD_ID = /^([a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?$/i;
const ARXIV_HOSTS = new Set(['arxiv.org', 'www.arxiv.org', 'export.arxiv.org']);

/**
 * Address of the HTML version of an arXiv PDF, when one is likely to exist.
 * arXiv makes HTML for papers sent since December 2023. Older papers have the
 * ar5iv rendering. This never checks the network; the reader follows the link.
 */
export function arxivHtml(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!ARXIV_HOSTS.has(u.hostname.toLowerCase())) return null;
  const m = /^\/pdf\/(.+?)(?:\.pdf)?\/?$/i.exec(u.pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[1]!);
  const out = new URL(u.href);
  out.search = '';
  out.hash = '';
  const neu = NEW_ID.exec(id);
  if (neu) {
    const yymm = Number(neu[1]) * 100 + Number(neu[2]);
    if (yymm >= 2312) {
      out.hostname = 'arxiv.org';
      out.pathname = `/html/${id}`;
      return out.href;
    }
    out.hostname = 'ar5iv.labs.arxiv.org';
    out.pathname = `/html/${id.replace(/v\d+$/, '')}`;
    return out.href;
  }
  const old = OLD_ID.exec(id);
  if (old) {
    out.hostname = 'ar5iv.labs.arxiv.org';
    out.pathname = `/html/${old[1]}`;
    return out.href;
  }
  return null;
}

/** File name of a web address, for the title before the PDF says its own. */
export function fileTitle(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last) || url;
  } catch {
    return url;
  }
}
