/**
 * Built-ins the legacy PDF.js build uses without a polyfill of its own.
 * Safari 17.0 to 17.3 lacks them, and the app supports iOS 17. Each one is
 * added only when the browser does not have it. The viewer page and the
 * worker import this before PDF.js.
 */

type Resolvers<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };

/** Adds the missing built-ins. Returns the names it added. */
export function installCompat(): string[] {
  const added: string[] = [];
  const P = Promise as unknown as { withResolvers?: () => Resolvers<unknown> };
  if (typeof P.withResolvers !== 'function') {
    (Promise as unknown as { withResolvers: () => Resolvers<unknown> }).withResolvers = () => {
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      return { promise, resolve, reject };
    };
    added.push('Promise.withResolvers');
  }
  const S = globalThis.AbortSignal as unknown as { any?: unknown } | undefined;
  if (S && typeof S.any !== 'function') {
    (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any = (signals) => {
      const ac = new AbortController();
      for (const s of signals) {
        if (s.aborted) {
          ac.abort(s.reason);
          break;
        }
        s.addEventListener('abort', () => ac.abort(s.reason), { once: true, signal: ac.signal });
      }
      return ac.signal;
    };
    added.push('AbortSignal.any');
  }
  const B = ArrayBuffer.prototype as unknown as { transferToFixedLength?: unknown };
  if (typeof B.transferToFixedLength !== 'function') {
    // A copy, not a move: the old buffer stays usable, which PDF.js never relies on.
    (
      ArrayBuffer.prototype as unknown as { transferToFixedLength: (n?: number) => ArrayBuffer }
    ).transferToFixedLength = function (this: ArrayBuffer, n?: number) {
      const len = n ?? this.byteLength;
      const out = new ArrayBuffer(len);
      new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(len, this.byteLength)));
      return out;
    };
    added.push('ArrayBuffer.prototype.transferToFixedLength');
  }
  return added;
}

installCompat();
