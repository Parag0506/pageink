/**
 * Small helpers shared by every folder and by the extension stub.
 * Keep this file tiny and free of imports. The stub inlines it.
 */

/** 53-bit string hash (cyrb53) as base36. Used for storage keys. */
export function hashKey(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Storage key of the per-host index. */
export const idxKey = (host: string): string => `idx:${hashKey(host)}`;
/** Storage key of a page record. */
export const pageKeyOf = (key: string): string => `p:${hashKey(key)}`;
export const CFG_KEY = 'cfg';

/**
 * Query and fragment parameters that carry a credential, matched lower-case. They are never
 * stored: not in a page key, not in a record's addresses. The list is explicit on purpose.
 * Parameters that say which page this is (id, q, page, v and the like) are kept.
 */
export const CREDENTIAL_PARAMS: readonly string[] = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth',
  'auth_token',
  'authtoken',
  'authorization',
  'key',
  'apikey',
  'api_key',
  'api-key',
  'x-api-key',
  'api_token',
  'apitoken',
  'access_key',
  'accesskey',
  'secret_key',
  'session',
  'sessionid',
  'session_id',
  'session_token',
  'sessiontoken',
  'security_token',
  'sid',
  'sig',
  'signature',
  'password',
  'pass',
  'passwd',
  'secret',
  'client_secret',
  'credential',
  'credentials',
  'private_token',
  'oauth_token',
  'oauth_verifier',
  'oauth_signature',
  'jwt',
  'otp',
  'hmac',
  'key-pair-id',
];

/**
 * Prefixes of every parameter of a storage service's signed link (Amazon S3 and Google Cloud
 * Storage): the signature, the credential, the session token and the parts they sign.
 */
export const CREDENTIAL_PREFIXES: readonly string[] = ['x-amz-', 'x-goog-'];

/** OAuth returns `code` with `state`. Alone, `code` often names the page (a coupon, a snippet). */
const OAUTH_PAIR = ['code', 'state'];

/** True for a parameter name that carries a credential, given every name in the same string. */
export function isCredential(name: string, all: string[]): boolean {
  const n = name.toLowerCase();
  if (CREDENTIAL_PARAMS.includes(n) || CREDENTIAL_PREFIXES.some((p) => n.startsWith(p))) return true;
  const lower = all.map((a) => a.toLowerCase());
  return OAUTH_PAIR.includes(n) && OAUTH_PAIR.every((p) => lower.includes(p));
}

/** A JSON web token: three base64url parts, the first two JSON objects. */
const JWT = /^eyJ[\w-]{6,}\.eyJ[\w-]{6,}\.[\w-]*$/;
/** Words in a parameter name that say it holds a secret. */
const SECRET_WORDS = [
  'token',
  'secret',
  'sig',
  'signature',
  'auth',
  'key',
  'pass',
  'password',
  'session',
  'credential',
  'otp',
  'jwt',
];

/** Bits of information per character, over the characters the value uses. */
function bitsPerChar(v: string): number {
  const n = new Map<string, number>();
  for (const c of v) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) h -= (k / v.length) * Math.log2(k / v.length);
  return h;
}

/**
 * A long run of base64 or hex characters with letters and digits mixed, spread as evenly as
 * random keys are: at least 80% of the most a string of its length and alphabet can carry.
 */
function randomLooking(v: string, min: number): boolean {
  if (v.length < min || !/^[A-Za-z0-9+/=_.~-]+$/.test(v) || !/[0-9]/.test(v) || !/[A-Za-z]/.test(v))
    return false;
  const alphabet = /^[0-9a-fA-F]+$/.test(v) ? 16 : 64;
  return bitsPerChar(v) >= 0.8 * Math.log2(Math.min(v.length, alphabet));
}

/**
 * True for a value that is a credential: a JSON web token under any name, or a random value of
 * 16 characters or more under a name with a secret word in it (`authToken`, `sharing_token`,
 * `X-Sig`). A long random value under any other name stays: some sites name their pages that
 * way (`post.php?i=<88 random characters>`).
 */
export function isCredentialValue(name: string, value: string): boolean {
  if (JWT.test(value)) return true;
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((w) => SECRET_WORDS.includes(w)) && randomLooking(value, 16);
}

/** A query string without credential parameters. Null when there were none to take out. */
function stripQuery(q: string): string | null {
  const params = new URLSearchParams(q);
  const names: string[] = [];
  params.forEach((_v, k) => {
    names.push(k);
  });
  const drop = (k: string, v: string) => isCredential(k, names) || isCredentialValue(k, v);
  let any = false;
  params.forEach((v, k) => {
    if (drop(k, v)) any = true;
  });
  if (!any) return null;
  const out = new URLSearchParams();
  params.forEach((v, k) => {
    if (!drop(k, v)) out.append(k, v);
  });
  return out.toString();
}

/**
 * The address with credentials taken out: user name and password, credential parameters in
 * the query, and in a fragment written like a query (`#access_token=...`, `#/cb?token=...`).
 * Anything else stays exactly as it was. Strings that are not web addresses are returned as they are.
 */
export function stripCredentials(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
  let changed = !!(u.username || u.password);
  u.username = '';
  u.password = '';
  const q = u.search ? stripQuery(u.search.slice(1)) : null;
  if (q !== null) {
    u.search = q ? `?${q}` : '';
    changed = true;
  }
  const frag = u.hash.slice(1);
  if (frag.includes('=')) {
    const at = frag.indexOf('?');
    const head = at < 0 ? '' : frag.slice(0, at);
    const f = stripQuery(at < 0 ? frag : frag.slice(at + 1));
    if (f !== null) {
      u.hash = head && f ? `${head}?${f}` : head || f;
      changed = true;
    }
  }
  // An address with nothing to take out is kept exactly as written.
  return changed ? u.href : url;
}

/** New unique id: time prefix plus random tail, base36. Sorts by creation time. */
export function newId(): string {
  const r = new Uint32Array(2);
  crypto.getRandomValues(r);
  return (
    Date.now().toString(36) +
    (r[0]! % 1679616).toString(36).padStart(4, '0') +
    (r[1]! % 1679616).toString(36).padStart(4, '0')
  );
}
