/**
 * The one place the product talks to a cloud. Every request checks its address against the
 * provider's list first, waits and tries again when the provider asks us to slow down, and
 * turns failures into the plain problems the reader sees (connect/dest.ts).
 */
import type { Problem } from '../connect/dest';
import { type AuthDetail, scrub } from '../connect/explain';

export type CloudCode = Problem | 'conflict' | 'not-found' | 'reset';

export class CloudError extends Error {
  constructor(
    readonly code: CloudCode,
    readonly status = 0,
    detail = '',
    /** What the provider said, scrubbed, for the Details block. Never a token or a code. */
    public info?: AuthDetail,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CloudError';
  }
}

/** Add to what an error already says, without replacing what it knows. */
export function annotate(e: unknown, more: Partial<AuthDetail> & { step: AuthDetail['step'] }): unknown {
  if (!(e instanceof CloudError)) return e;
  const had = Object.fromEntries(Object.entries(e.info ?? {}).filter(([, v]) => v !== undefined));
  e.info = { ...more, ...had } as AuthDetail;
  if (more.provider) e.info.provider = more.provider;
  return e;
}

/** The error code and message in an API's JSON error body (Drive and Graph), scrubbed. */
export function apiError(
  text: string,
  secrets: (string | undefined)[] = [],
): { error?: string; description?: string } {
  try {
    const b = JSON.parse(text) as {
      error?:
        | string
        | { code?: unknown; status?: unknown; message?: unknown; errors?: { reason?: unknown }[] };
      error_description?: unknown;
    };
    if (typeof b.error === 'string')
      return {
        error: b.error,
        description:
          typeof b.error_description === 'string' ? scrub(b.error_description, secrets) : undefined,
      };
    const e = b.error;
    if (!e) return {};
    const reason = e.errors?.[0]?.reason;
    const code = typeof reason === 'string' ? reason : typeof e.status === 'string' ? e.status : e.code;
    return {
      error: code === undefined ? undefined : String(code),
      description: typeof e.message === 'string' ? scrub(e.message, secrets) : undefined,
    };
  } catch {
    return text ? { description: scrub(text.slice(0, 400), secrets) } : {};
  }
}

export const isCode = (e: unknown, code: CloudCode): boolean => e instanceof CloudError && e.code === code;

export interface Net {
  /** Address prefixes this provider may reach. Anything else is refused before it is sent. */
  allow: string[];
  /** Waits between tries. Tests pass a quick one. */
  sleep?: (ms: number) => Promise<void>;
  /** First wait when the provider asks us to slow down. Doubles each time. */
  baseMs?: number;
  tries?: number;
}

export interface Req {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** When set, the bearer token, renewed once on a 401. */
  token?: { get(): Promise<string>; renew(): Promise<string> };
  /** True when this response means "slow down", beyond 429 and 503 (Drive uses some 403s). */
  slowDown?: (status: number, body: string) => boolean;
}

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** True when the address is under one of the prefixes, compared as parsed addresses. */
export function allowed(url: string, allow: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return allow.some((p) => {
    const a = new URL(p);
    return u.origin === a.origin && u.pathname.startsWith(a.pathname);
  });
}

function retryAfter(r: Response): number | undefined {
  const v = r.headers.get('retry-after');
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.min(60, Math.max(0, s)) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.min(60_000, Math.max(0, t - Date.now())) : undefined;
}

/**
 * Send a request. Returns the response for any status the caller should judge (2xx, 3xx,
 * 400, 403, 404, 409, 412, 507 and so on). Throws CloudError for offline, for a token that
 * stays refused, and for a provider that keeps asking us to slow down or keeps failing.
 */
export async function send(net: Net, req: Req): Promise<{ res: Response; text: string }> {
  if (!allowed(req.url, net.allow)) throw new CloudError('denied', 0, 'address not allowed');
  const sleep = net.sleep ?? wait;
  const tries = net.tries ?? 5;
  let base = net.baseMs ?? 1000;
  let renewed = false;
  let token = req.token ? await req.token.get() : undefined;
  for (let i = 0; ; i++) {
    const headers: Record<string, string> = { ...req.headers };
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method ?? 'GET',
        headers,
        body: req.body as BodyInit | undefined,
        // No cookies or cached answers: each request stands alone.
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw new CloudError('offline');
    }
    if (res.status === 401 && req.token && !renewed) {
      renewed = true;
      token = await req.token.renew();
      continue;
    }
    if (res.status === 401) throw new CloudError('expired', 401);
    const text = await res.text().catch(() => '');
    const slow = res.status === 429 || res.status === 503 || !!req.slowDown?.(res.status, text);
    // 500, 502 and 504 pass; 501 and 507 (storage full) do not, so they go to the caller.
    if (slow || [500, 502, 504].includes(res.status)) {
      if (i + 1 >= tries) throw new CloudError(slow ? 'throttled' : 'server', res.status);
      // Full jitter keeps two devices from retrying in step.
      await sleep(retryAfter(res) ?? Math.round(base * (0.5 + Math.random() / 2)));
      base *= 2;
      continue;
    }
    return { res, text };
  }
}

/** Parse a JSON answer, or throw a server problem. */
export function json<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CloudError('server', 0, 'not JSON');
  }
}
