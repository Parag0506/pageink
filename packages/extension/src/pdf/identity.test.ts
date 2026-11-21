import { pageIdentity } from 'pageink-core/anchor';
import { describe, expect, test } from 'vitest';
import { pdfOn } from './cfg';
import { arxivHtml, fileTitle, isLocalKey, isWebAddress, localIdentity, pdfIdentity } from './identity';

const FP = '0123456789ABCDEF0123456789abcdef';

describe('pdfIdentity', () => {
  test('a web PDF is keyed by its own address, like any page', () => {
    const url = 'https://example.com/papers/a.pdf?utm_source=x';
    const id = pdfIdentity({ url, fingerprint: FP });
    expect(id).toEqual(pageIdentity(url));
    expect(id.key).toBe('https://example.com/papers/a.pdf');
    expect(id.hosts).toEqual(['example.com']);
  });

  test('an arXiv PDF joins the family of its abs and html pages', () => {
    const pdf = pdfIdentity({ url: 'https://arxiv.org/pdf/2401.12345v2', fingerprint: FP });
    expect(pdf.key).toBe('arxiv:2401.12345');
    expect(pdf.version).toBe('v2');
    expect(pdfIdentity({ url: 'https://arxiv.org/pdf/2401.12345v1.pdf', fingerprint: FP }).key).toBe(pdf.key);
    expect(pageIdentity('https://arxiv.org/abs/2401.12345').key).toBe(pdf.key);
    expect(pageIdentity('https://arxiv.org/html/2401.12345v2').key).toBe(pdf.key);
    expect(pdf.hosts).toContain('arxiv.org');
  });

  test('a local file is keyed by its fingerprint, whatever its name or folder', () => {
    for (const url of [undefined, 'file:///Users/a/Downloads/paper.pdf', 'blob:abc', '']) {
      const id = pdfIdentity({ url, fingerprint: FP });
      expect(id.key).toBe('pdf:0123456789abcdef0123456789abcdef');
      expect(id.host).toBe('');
      expect(id.hosts).toEqual([]);
      expect(isLocalKey(id.key)).toBe(true);
    }
    expect(localIdentity(FP)).toEqual(pdfIdentity({ fingerprint: FP }));
    expect(isLocalKey('https://example.com/a.pdf')).toBe(false);
  });

  test('isWebAddress takes http and https only', () => {
    expect(isWebAddress('https://a.b/c.pdf')).toBe(true);
    expect(isWebAddress('http://a.b/c.pdf')).toBe(true);
    expect(isWebAddress('file:///c.pdf')).toBe(false);
    expect(isWebAddress('nonsense')).toBe(false);
    expect(isWebAddress(undefined)).toBe(false);
  });
});

describe('arxivHtml', () => {
  test('new papers link to the arXiv HTML version, with their version', () => {
    expect(arxivHtml('https://arxiv.org/pdf/2401.12345v2')).toBe('https://arxiv.org/html/2401.12345v2');
    expect(arxivHtml('https://arxiv.org/pdf/2312.00001.pdf')).toBe('https://arxiv.org/html/2312.00001');
    expect(arxivHtml('https://export.arxiv.org/pdf/2501.00001v1?x=1#p2')).toBe(
      'https://arxiv.org/html/2501.00001v1',
    );
  });

  test('older papers link to ar5iv', () => {
    expect(arxivHtml('https://arxiv.org/pdf/2105.01234v3')).toBe(
      'https://ar5iv.labs.arxiv.org/html/2105.01234',
    );
    expect(arxivHtml('https://arxiv.org/pdf/hep-th/9901001v2')).toBe(
      'https://ar5iv.labs.arxiv.org/html/hep-th/9901001',
    );
  });

  test('other addresses get no link', () => {
    expect(arxivHtml('https://example.com/pdf/2401.12345')).toBeNull();
    expect(arxivHtml('https://arxiv.org/abs/2401.12345')).toBeNull();
    expect(arxivHtml('https://arxiv.org/pdf/not-an-id')).toBeNull();
    expect(arxivHtml('bad')).toBeNull();
  });
});

test('fileTitle is the last part of the address', () => {
  expect(fileTitle('https://a.b/x/My%20Paper.pdf?y=1')).toBe('My Paper.pdf');
  expect(fileTitle('https://a.b/')).toBe('https://a.b/');
});

test('the PDF setting is on unless it is false', () => {
  expect(pdfOn(undefined)).toBe(true);
  expect(pdfOn({})).toBe(true);
  expect(pdfOn({ pdf: true })).toBe(true);
  expect(pdfOn({ pdf: false })).toBe(false);
});
