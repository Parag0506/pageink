import { describe, expect, test } from 'vitest';
import { bytesFrom, fromViewer, looksLikePdf, originOf, sourceOf, viewerAddress } from './handoff';

const pdfBytes = () => new TextEncoder().encode('%PDF-1.4\n%...').buffer as ArrayBuffer;
const EXT = 'chrome-extension://abcdefghijklmnop';
const SRC = 'https://example.com/papers/a.pdf?x=1';

describe('addresses', () => {
  test('the viewer address carries the PDF address in its fragment, and gives it back', () => {
    const a = viewerAddress(`${EXT}/pdf.html#old`, SRC);
    expect(a.startsWith(`${EXT}/pdf.html#src=`)).toBe(true);
    expect(sourceOf(new URL(a).hash)).toBe(SRC);
  });

  test('only web addresses are accepted as a source', () => {
    expect(sourceOf('')).toBeNull();
    expect(sourceOf('#src=')).toBeNull();
    expect(sourceOf(`#src=${encodeURIComponent('javascript:alert(1)')}`)).toBeNull();
    expect(sourceOf(`#src=${encodeURIComponent('file:///a.pdf')}`)).toBeNull();
    expect(sourceOf('#src=%E0%A4%A')).toBeNull();
  });

  test('originOf', () => {
    expect(originOf(SRC)).toBe('https://example.com');
    expect(originOf('nonsense')).toBeNull();
    expect(originOf('data:text/plain,x')).toBeNull();
  });

  test('looksLikePdf wants %PDF- in the first kilobyte', () => {
    expect(looksLikePdf(pdfBytes())).toBe(true);
    const late = new Uint8Array(2000);
    late.set(new TextEncoder().encode('%PDF-'), 1500);
    expect(looksLikePdf(late.buffer)).toBe(false);
    expect(looksLikePdf(new TextEncoder().encode('<html>').buffer as ArrayBuffer)).toBe(false);
    expect(looksLikePdf(new ArrayBuffer(0))).toBe(false);
  });
});

describe('content script side', () => {
  const frame = {};
  test('takes messages only from its frame on the extension origin', () => {
    expect(fromViewer({ data: { ink: 'pdf-ready' }, origin: EXT, source: frame }, frame, EXT)).toEqual({
      ink: 'pdf-ready',
    });
    expect(fromViewer({ data: { ink: 'pdf-ready' }, origin: EXT, source: {} }, frame, EXT)).toBeNull();
    expect(
      fromViewer({ data: { ink: 'pdf-ready' }, origin: 'https://evil.example', source: frame }, frame, EXT),
    ).toBeNull();
    expect(fromViewer({ data: { ink: 'pdf-ready' }, origin: EXT, source: null }, null, EXT)).toBeNull();
  });

  test('checks the shape of each message', () => {
    const m = (data: unknown) => fromViewer({ data, origin: EXT, source: frame }, frame, EXT);
    expect(m({ ink: 'pdf-title', title: 'A paper' })).toEqual({ ink: 'pdf-title', title: 'A paper' });
    expect(m({ ink: 'pdf-title', title: 'x'.repeat(1000) })).toEqual({
      ink: 'pdf-title',
      title: 'x'.repeat(300),
    });
    expect(m({ ink: 'pdf-title', title: 3 })).toBeNull();
    expect(m({ ink: 'pdf-failed', extra: 1 })).toEqual({ ink: 'pdf-failed' });
    expect(m({ ink: 'pdf-unsupported' })).toEqual({ ink: 'pdf-unsupported' });
    expect(m({ ink: 'other' })).toBeNull();
    expect(m('pdf-ready')).toBeNull();
    expect(m(null)).toBeNull();
  });
});

describe('viewer side', () => {
  const parent = {};
  const ok = () => ({
    data: { ink: 'pdf-bytes', url: SRC, bytes: pdfBytes() },
    origin: 'https://example.com',
    source: parent,
  });

  test('takes the bytes from its parent on the origin of the PDF address', () => {
    expect(bytesFrom(ok(), parent, SRC)).toBeInstanceOf(ArrayBuffer);
  });

  test('refuses another sender, another origin, another address or bytes that are not a PDF', () => {
    expect(bytesFrom({ ...ok(), source: {} }, parent, SRC)).toBeNull();
    expect(bytesFrom({ ...ok(), origin: 'https://evil.example' }, parent, SRC)).toBeNull();
    expect(bytesFrom({ ...ok(), origin: 'http://example.com' }, parent, SRC)).toBeNull();
    expect(bytesFrom(ok(), parent, 'https://example.com/other.pdf')).toBeNull();
    expect(
      bytesFrom({ ...ok(), data: { ink: 'pdf-bytes', url: SRC, bytes: new ArrayBuffer(8) } }, parent, SRC),
    ).toBeNull();
    expect(bytesFrom({ ...ok(), data: { ink: 'pdf-bytes', url: SRC, bytes: 'x' } }, parent, SRC)).toBeNull();
    expect(bytesFrom({ ...ok(), data: { ink: 'pdf-ready' } }, parent, SRC)).toBeNull();
    expect(bytesFrom(ok(), null, SRC)).toBeNull();
    expect(bytesFrom(ok(), parent, 'not an address')).toBeNull();
  });
});
