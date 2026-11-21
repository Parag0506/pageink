/**
 * Page identity (DESIGN 7.6). Pure: works with only a url, in node or a page.
 */
import { stripCredentials } from '../hash';
import type { PageIdentity, PageIdentityFn } from '../types';

/** Query parameters that only track the visit. Matched lower-case. */
const TRACKING = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_eid',
  'mc_cid',
  'igshid',
  'igsh',
  'ref_src',
  'ref_url',
  'yclid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'epik',
  'srsltid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  '__hssc',
  '__hstc',
  '__hsfp',
  'hsctatracking',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  'vero_conv',
  'wickedid',
  's_cid',
  'spm',
  'scid',
  'trk',
  'trkcampaign',
  'si',
  'cmpid',
]);

const TRACKING_PREFIX = ['utm_', 'pk_', 'mtm_', 'stm_'];

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING.has(n) || TRACKING_PREFIX.some((p) => n.startsWith(p));
}

const ARXIV_HOSTS = [
  'arxiv.org',
  'www.arxiv.org',
  'export.arxiv.org',
  'browse.arxiv.org',
  'ar5iv.labs.arxiv.org',
  'ar5iv.org',
];

/** New style ids (2401.12345) and old style ids (math/0601001, hep-th/9901001). */
const ARXIV_ID = /^((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[a-z]{2})?\/\d{7}))(v\d+)?$/i;

const VERSION_SEG = /^(latest|stable|dev|devel|main|master|current|nightly|v?\d+(?:\.\d+)*(?:\.x)?)$/i;
const LANG_SEG = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;
const MDN_LOCALE = /^[a-z]{2}(?:-[a-z]{2,4})?$/i;

function cleanPath(p: string): string {
  return p.replace(/\/{2,}/g, '/');
}

/**
 * True when the fragment names a place in an app, not a spot on the page: it starts with
 * `/` or `!`, or it holds a `/` or `=` and no element in the document has it as id or name
 * (mail and app pages such as `#inbox/abc`). Without a document only the shape decides.
 * Text fragments (`:~:`) are a browser feature, never a route.
 */
export function isRoute(hash: string, doc?: Document): boolean {
  const frag = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!frag || frag.startsWith(':~:')) return false;
  if (frag.startsWith('/') || frag.startsWith('!')) return true;
  if (!frag.includes('/') && !frag.includes('=')) return false;
  if (!doc?.getElementById) return true;
  let name = frag;
  try {
    name = decodeURIComponent(frag);
  } catch {
    // Keep the raw form when it is not valid percent encoding.
  }
  return !doc.getElementById(name) && !doc.getElementsByName?.(name).length;
}

/**
 * Normalised address key: host lower-cased, credentials and tracking dropped, query sorted,
 * fragment dropped unless it is a route.
 */
export function addressKey(raw: URL, doc?: Document): string {
  const u = new URL(stripCredentials(raw.href));
  // forEach and append, not entries() and spread: in a Firefox content script URL objects come
  // through a wrapper whose iterators cannot be spread.
  const params: [string, string][] = [];
  u.searchParams.forEach((v, k) => {
    if (!isTracking(k)) params.push([k, v]);
  });
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const sp = new URLSearchParams();
  for (const [k, v] of params) sp.append(k, v);
  const q = params.length ? `?${sp.toString()}` : '';
  const route = isRoute(u.hash, doc) ? u.hash : '';
  const host = u.host.toLowerCase();
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    return `${u.protocol}//${host}${cleanPath(u.pathname)}${q}${route}`;
  }
  // file:, about: and other schemes keep their shape.
  const slashes = u.href.startsWith(`${u.protocol}//`) ? '//' : '';
  return `${u.protocol}${slashes}${host}${u.pathname}${q}${route}`;
}

interface Family {
  key: string;
  hosts: string[];
  version?: string;
}

function arxiv(u: URL, host: string): Family | null {
  if (!ARXIV_HOSTS.includes(host)) return null;
  const m = /^\/(abs|html|pdf|format|papers)\/(.+?)\/?$/.exec(u.pathname);
  if (!m) return null;
  let rest = decodeURIComponent(m[2]!).replace(/\.pdf$/i, '');
  // HTML papers can have sub pages (/html/2401.12345v2/#S3 or /html/2401.12345v2/x1.png).
  const parts = rest.split('/');
  if (parts.length > 1 && !/^[a-z-]+(\.[a-z]{2})?$/i.test(parts[0]!)) rest = parts[0]!;
  else if (parts.length > 2) rest = `${parts[0]}/${parts[1]}`;
  const id = ARXIV_ID.exec(rest);
  if (!id) return null;
  return { key: `arxiv:${id[1]!.toLowerCase()}`, hosts: [...ARXIV_HOSTS], version: id[2]?.toLowerCase() };
}

function wikiTitle(t: string): string {
  let s = t;
  try {
    s = decodeURIComponent(t);
  } catch {
    // Keep the raw form when the address is not valid percent encoding.
  }
  s = s.replace(/ /g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function wikipedia(u: URL, host: string): Family | null {
  const m = /^([a-z0-9-]+)(\.m)?\.wikipedia\.org$/.exec(host);
  if (!m || m[1] === 'www' || m[1] === 'm') return null;
  const lang = m[1]!;
  let title: string | null = null;
  const w = /^\/wiki\/(.+)$/.exec(u.pathname);
  if (w) title = w[1]!;
  else if (u.pathname === '/w/index.php') title = u.searchParams.get('title');
  if (!title) return null;
  const oldid = u.searchParams.get('oldid');
  return {
    key: `wikipedia:${lang}:${wikiTitle(title)}`,
    hosts: [`${lang}.wikipedia.org`, `${lang}.m.wikipedia.org`],
    version: oldid ? `oldid=${oldid}` : undefined,
  };
}

function isDocsHost(host: string): boolean {
  return (
    host.startsWith('docs.') ||
    host.endsWith('.readthedocs.io') ||
    host.endsWith('.readthedocs-hosted.com') ||
    host.endsWith('.readthedocs.org')
  );
}

function docs(u: URL, host: string): Family | null {
  if (host === 'developer.mozilla.org') {
    const segs = u.pathname.split('/').filter(Boolean);
    let locale = 'en-us';
    if (segs[0] && segs[0] !== 'docs' && MDN_LOCALE.test(segs[0])) locale = segs.shift()!.toLowerCase();
    if (segs[0] !== 'docs') return null;
    return {
      key: `docs:${host}/${locale}/${segs.join('/')}`,
      hosts: [host],
      version: undefined,
    };
  }
  if (!isDocsHost(host)) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  // A version sits in the first or second segment (after an optional language).
  for (let i = 0; i < Math.min(2, segs.length); i++) {
    const s = segs[i]!;
    if (!VERSION_SEG.test(s)) {
      if (i === 0 && LANG_SEG.test(s)) continue;
      break;
    }
    if (i === 1 && !LANG_SEG.test(segs[0]!)) break;
    const lang = i === 1 ? `${segs[0]!.toLowerCase()}/` : '';
    const rest = segs.slice(i + 1).join('/');
    const trailing = u.pathname.endsWith('/') && rest ? '/' : '';
    return { key: `docs:${host}/${lang}${rest}${trailing}`, hosts: [host], version: s.toLowerCase() };
  }
  return null;
}

function family(u: URL): Family | null {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  return arxiv(u, host) ?? wikipedia(u, host) ?? docs(u, host);
}

/** Registrable-ish site of a host: the last two labels, or three for short second levels (co.uk). */
function siteOf(host: string): string {
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const two = labels.slice(-2);
  if (two[0]!.length <= 3 && two[1]!.length === 2) return labels.slice(-3).join('.');
  return two.join('.');
}

function parse(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** Identity for one address. Same-site rel=canonical becomes an alias. */
export const pageIdentity: PageIdentityFn = (url: string, doc?: Document): PageIdentity => {
  const u = parse(url);
  if (!u) return { key: url, aliases: [], host: '', hosts: [], url };
  const host = u.hostname.toLowerCase();
  const plain = addressKey(u, doc);
  const fam = family(u);
  const key = fam ? fam.key : plain;
  const aliases: string[] = [];
  const add = (k: string) => {
    if (k !== key && !aliases.includes(k)) aliases.push(k);
  };
  if (fam) add(plain);

  const canon = doc?.querySelector?.('link[rel~="canonical" i][href]')?.getAttribute('href');
  if (canon) {
    const c = parse(canon, url);
    if (
      c &&
      (c.protocol === 'http:' || c.protocol === 'https:') &&
      siteOf(c.hostname.toLowerCase()) === siteOf(host)
    ) {
      const cf = family(c);
      add(addressKey(c, doc));
      if (cf) add(cf.key);
    }
  }
  const hosts = fam ? [...fam.hosts] : [];
  if (host && !hosts.includes(host)) hosts.push(host);
  // The address is stored with the record, so it never keeps a credential.
  const out: PageIdentity = { key, aliases, host, hosts, url: stripCredentials(url) };
  if (fam?.version) out.version = fam.version;
  return out;
};
