/**
 * Runtime half of the no-network guarantee. Every browser context the e2e suite
 * launches records each network request the extension starts: from a content
 * script (seen in the initiator stack), from an extension page, or from the
 * service worker. Closing the context fails when anything other than the PDF
 * read was recorded.
 */
import { createHash } from 'node:crypto';
import type { BrowserContext, CDPSession, Frame, Page } from '@playwright/test';

export interface ExtRequest {
  /** Address requested. */
  url: string;
  /** Script or page of the extension that started it. */
  from: string;
  /** Address of the document the request was made for. */
  doc: string;
  /** CDP resource type, or "worker" for the service worker. */
  type: string;
}

interface Log {
  requests: ExtRequest[];
  /** Top documents loaded per address, so each PDF load may read itself once. */
  loads: Map<string, number>;
}

const logs = new WeakMap<BrowserContext, Log>();

/** Chromium's id for an unpacked extension: the path's SHA-256, first 32 hex digits mapped to a-p. */
export function unpackedId(dir: string): string {
  const hex = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
}

const remote = (u: string) => /^(?:https?|wss?|ftp):/i.test(u);

type Initiator = {
  type: string;
  url?: string;
  stack?: { callFrames: { url: string }[]; parent?: Initiator['stack'] };
};

/** First extension script in the initiator, if any. */
function extFrom(i: Initiator | undefined): string | undefined {
  if (!i) return undefined;
  if (i.url?.startsWith('chrome-extension://')) return i.url;
  for (let s = i.stack; s; s = s.parent) {
    const f = s.callFrames.find((c) => c.url.startsWith('chrome-extension://'));
    if (f) return f.url;
  }
  return undefined;
}

type WillBeSent = {
  request: { url: string };
  documentURL: string;
  type?: string;
  frameId?: string;
  initiator: Initiator;
};

async function watch(log: Log, ctx: BrowserContext, target: Page | Frame): Promise<void> {
  let cdp: CDPSession;
  try {
    cdp = await ctx.newCDPSession(target);
  } catch {
    // A frame in the page's own process shares the page's session.
    return;
  }
  cdp.on('Network.requestWillBeSent', (e: WillBeSent) => {
    const url = e.request.url;
    if (!remote(url)) return;
    const from =
      extFrom(e.initiator) ??
      (e.documentURL.startsWith('chrome-extension://') && e.type !== 'Document' ? e.documentURL : undefined);
    if (from) log.requests.push({ url, from, doc: e.documentURL, type: e.type ?? '' });
  });
  await cdp.send('Network.enable').catch(() => {});
}

/** Start recording on a context. Called once by launch(). */
export function record(ctx: BrowserContext): void {
  const log: Log = { requests: [], loads: new Map() };
  logs.set(ctx, log);
  const page = (p: Page) => {
    void watch(log, ctx, p);
    p.on('frameattached', (f) => void watch(log, ctx, f));
  };
  ctx.pages().forEach(page);
  ctx.on('page', page);
  ctx.on('request', (r) => {
    // Page loads are counted here, not through CDP: a session attaches a moment after its page
    // opens, so under load it can miss the first navigation and the PDF read would look extra.
    if (r.isNavigationRequest() && r.resourceType() === 'document' && remote(r.url())) {
      log.loads.set(r.url(), (log.loads.get(r.url()) ?? 0) + 1);
    }
    const sw = r.serviceWorker();
    if (sw && remote(r.url())) log.requests.push({ url: r.url(), from: sw.url(), doc: '', type: 'worker' });
  });
}

/** Requests recorded so far. The array is live: a test that makes one on purpose removes it. */
export const extensionRequests = (ctx: BrowserContext): ExtRequest[] => logs.get(ctx)?.requests ?? [];

/**
 * Requests by the extension that break the rule. Content scripts loaded through a dynamic
 * address carry a per-session origin, so every extension origin counts except those of other
 * extensions a test loads on purpose. The one allowed: the PDF chunk
 * reading the address of the PDF document it runs in, at most once per load of that address.
 */
export function forbidden(ctx: BrowserContext, others: string[] = []): ExtRequest[] {
  const log = logs.get(ctx);
  if (!log) return [];
  const ours = log.requests.filter((r) => !others.includes(new URL(r.from).host));
  const reads = new Map<string, number>();
  return ours.filter((r) => {
    const pdfRead = r.from.endsWith('/content/pdf.js') && r.url === r.doc && r.type === 'Fetch';
    if (!pdfRead) return true;
    const n = (reads.get(r.url) ?? 0) + 1;
    reads.set(r.url, n);
    return n > (log.loads.get(r.url) ?? 0);
  });
}
