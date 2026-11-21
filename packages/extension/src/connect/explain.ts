/**
 * What a provider said when a sign-in or a token request failed, kept so the reader can see
 * it and copy it. No network code here. Nothing in a detail may hold a token, an
 * authorization code, the code verifier, an email address or a long id: scrub() removes
 * them, and clean() keeps only the known fields.
 */
import type { ProviderId } from './dest';

/** Where it failed: the sign-in window, the code exchange, a renewal, or the first file call. */
export type AuthStep = 'authorize' | 'token' | 'refresh' | 'first file call' | 'file call';

export interface AuthDetail {
  provider?: ProviderId;
  step: AuthStep;
  /** The provider's error code, such as redirect_uri_mismatch or invalid_request. */
  error?: string;
  /** The provider's description, scrubbed and trimmed. */
  description?: string;
  /** The HTTP status, when there was a response. */
  status?: number;
  /** The return address the extension sent. */
  redirect?: string;
}

const STEPS: AuthStep[] = ['authorize', 'token', 'refresh', 'first file call', 'file call'];
const MAX = 400;

/**
 * Remove what must never be shown or copied. Known secrets are removed by value first. Then
 * secret parameters, tokens shaped like JWTs, emails, GUIDs and any long run of id-like
 * characters. Short codes such as AADSTS9002326 stay.
 */
export function scrub(text: string, secrets: (string | undefined)[] = []): string {
  let s = String(text);
  for (const x of secrets) if (x && x.length >= 4) s = s.split(x).join('[removed]');
  s = s
    .replace(
      /\b(access_token|refresh_token|id_token|code|code_verifier|client_secret|assertion|token)=([^&\s"']+)/gi,
      '$1=[removed]',
    )
    .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, '[removed]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/[A-Za-z0-9_~+/=-]{20,}/g, '[id]')
    // Microsoft adds these after every description. They are only ids and a time.
    .replace(/\s*(Trace ID|Correlation ID|Timestamp):[^\r\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s;
}

const word = (v: unknown) =>
  typeof v === 'string' && /^[\w.:-]{1,80}$/.test(v)
    ? v
    : typeof v === 'string'
      ? scrub(v).slice(0, 80)
      : undefined;

/** Keep only the known fields, scrubbed again. For anything that crosses a message. */
export function clean(v: unknown): AuthDetail | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const step = STEPS.includes(o.step as AuthStep) ? (o.step as AuthStep) : undefined;
  if (!step) return undefined;
  const d: AuthDetail = { step };
  if (o.provider === 'google' || o.provider === 'onedrive') d.provider = o.provider;
  const e = word(o.error);
  if (e) d.error = e;
  if (typeof o.description === 'string' && o.description) d.description = scrub(o.description);
  if (typeof o.status === 'number' && Number.isInteger(o.status) && o.status > 0) d.status = o.status;
  if (typeof o.redirect === 'string' && /^https:\/\/[\w.-]+\/[\w/-]*$/.test(o.redirect))
    d.redirect = o.redirect;
  return d;
}

/** The AADSTS number in a Microsoft description, if any. */
export const aadsts = (d: AuthDetail): string | undefined =>
  /AADSTS(\d+)/.exec(`${d.error ?? ''} ${d.description ?? ''}`)?.[0];

/** One helpful sentence per known code. The keys are what the reader may also see in the window. */
export const HINTS: Record<ProviderId, Record<string, string>> = {
  google: {
    redirect_uri_mismatch:
      'The return address is not registered for this client id. Add the address below under Authorized redirect URIs (not Authorized JavaScript origins), then wait a few minutes.',
    invalid_client:
      'Google does not know this client id, or it is not a Web application client. Check the Google client id this build was made with.',
    unauthorized_client:
      'This client id may not use this kind of sign-in. Make a client of type Web application and build with its id.',
    access_denied:
      'If you did not choose Cancel, this account is not on the test users list. Add it under Audience, Test users, then try again.',
    accessNotConfigured:
      'The Google Drive API is off for this project. Turn it on, wait a few minutes, then try again.',
    SERVICE_DISABLED:
      'The Google Drive API is off for this project. Turn it on, wait a few minutes, then try again.',
  },
  onedrive: {
    AADSTS9002326:
      'Move the return address from Mobile and desktop applications to Single-page application in the app registration, then try again.',
    AADSTS9002327:
      'This browser did not send the header a Single-page application needs. Register this return address under Mobile and desktop applications instead.',
    AADSTS50011:
      'The return address is not registered for this app. Add the address below under Single-page application in Authentication, then try again.',
    AADSTS700016:
      'Microsoft does not know this client id. Check the Application (client) ID this build was made with, and that the app allows personal accounts.',
    AADSTS65001:
      'The app has no consent for its permissions. Add Files.ReadWrite.AppFolder and offline_access under API permissions, then try again.',
    AADSTS70011:
      'A requested permission is not set up. Check the delegated permissions under API permissions, then try again.',
    AADSTS7000218:
      'The registration expects a secret. Turn on Allow public client flows under Authentication, or use Single-page application for the return address.',
  },
};

/** The one sentence for this detail, if its code is known. */
export function hintFor(d: AuthDetail): string | undefined {
  const table = d.provider ? HINTS[d.provider] : { ...HINTS.google, ...HINTS.onedrive };
  const ms = aadsts(d);
  if (ms && table[ms]) return table[ms];
  if (d.error && Object.hasOwn(table, d.error)) return table[d.error];
  return undefined;
}

/** True when the reader closed the window or chose Cancel, as far as the extension can tell. */
export const closedByReader = (d: AuthDetail): boolean =>
  d.step === 'authorize' && (!d.error || d.error === 'access_denied');

/** The plain line and the one next step, told apart by where it failed. */
export function explain(d: AuthDetail, place: string): { text: string; next: string; hint?: string } {
  const hint = hintFor(d);
  if (closedByReader(d))
    return { text: 'You closed the sign-in window or chose Cancel.', next: 'Try again', hint };
  if (d.step === 'authorize')
    return {
      text: `${place} refused the sign-in.`,
      next: hint ? 'Fix it, then try again' : 'Try again',
      hint,
    };
  return {
    text: `Sign-in worked, but ${place} refused the next step.`,
    next: hint ? 'Fix it, then try again' : 'Try again',
    hint,
  };
}

const PLACE: Record<ProviderId, string> = { google: 'Google Drive', onedrive: 'OneDrive' };

/** The details as lines, for the Details block and for Copy details. */
export function detailLines(d: AuthDetail, redirect?: string): [string, string][] {
  const out: [string, string][] = [];
  if (d.provider) out.push(['Provider', PLACE[d.provider]]);
  out.push(['Step', d.step]);
  if (d.error) out.push(['Error', d.error]);
  if (d.description) out.push(['Description', d.description]);
  if (d.status) out.push(['HTTP status', String(d.status)]);
  const r = d.redirect ?? redirect;
  if (r) out.push(['Return address used by this build', r]);
  return out;
}

export const detailText = (d: AuthDetail, redirect?: string): string =>
  detailLines(d, redirect)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
