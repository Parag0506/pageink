import { expect, describe as group, test } from 'vitest';
import { isRoute, pageIdentity } from './identity';

group('credentials and app routes', () => {
  const key = (u: string) => pageIdentity(u).key;

  test('a page key and its address never keep a credential', () => {
    const id = pageIdentity('https://mail.example.com/view?msg=4&token=abc&sig=zz');
    expect(id.key).toBe('https://mail.example.com/view?msg=4');
    expect(id.url).toBe('https://mail.example.com/view?msg=4');
    expect(key('https://a.example/x?session=1&id=2')).toBe('https://a.example/x?id=2');
  });

  test('a fragment with / or = is a route unless the document has that id or name', () => {
    expect(isRoute('#/inbox')).toBe(true);
    expect(isRoute('#!x')).toBe(true);
    expect(isRoute('#inbox/abc')).toBe(true);
    expect(isRoute('#view=2')).toBe(true);
    expect(isRoute('#section-2')).toBe(false);
    expect(isRoute('#:~:text=hello')).toBe(false);
    expect(isRoute('')).toBe(false);
    const doc = {
      getElementById: (id: string) => (id === 'a/b' ? {} : null),
      getElementsByName: (n: string) => (n === 'x=1' ? [{}] : []),
    } as unknown as Document;
    expect(isRoute('#a/b', doc)).toBe(false);
    expect(isRoute('#x=1', doc)).toBe(false);
    expect(isRoute('#inbox/abc', doc)).toBe(true);
    expect(isRoute('#a%2Fb', doc)).toBe(false);
  });

  test('mail and app pages keep their route in the key', () => {
    expect(key('https://mail.example.com/mail/u/0/#inbox/FMfcgz')).toBe(
      'https://mail.example.com/mail/u/0/#inbox/FMfcgz',
    );
    expect(key('https://a.example/doc#heading')).toBe('https://a.example/doc');
  });
});

const key = (u: string) => pageIdentity(u).key;

group('plain addresses', () => {
  test('drops the fragment but keeps routes', () => {
    expect(key('https://example.com/a/b#section-2')).toBe('https://example.com/a/b');
    expect(key('https://example.com/app#/inbox/3')).toBe('https://example.com/app#/inbox/3');
    expect(key('https://example.com/app#!/inbox')).toBe('https://example.com/app#!/inbox');
  });

  test('drops tracking parameters and sorts the rest', () => {
    expect(
      key(
        'https://Example.COM/p?utm_source=x&b=2&fbclid=abc&a=1&gclid=1&msclkid=2&mc_eid=3&igshid=4&ref_src=t&utm_medium=y',
      ),
    ).toBe('https://example.com/p?a=1&b=2');
    expect(key('https://example.com/p?utm_campaign=z')).toBe('https://example.com/p');
  });

  test('lower-cases the host only', () => {
    expect(key('https://WWW.Example.com/CaseSensitive')).toBe('https://www.example.com/CaseSensitive');
  });

  test('host and hosts', () => {
    const id = pageIdentity('https://News.example.org/x?utm_source=a');
    expect(id.host).toBe('news.example.org');
    expect(id.hosts).toEqual(['news.example.org']);
    expect(id.aliases).toEqual([]);
    expect(id.url).toBe('https://News.example.org/x?utm_source=a');
  });

  test('works without a document and with bad input', () => {
    expect(pageIdentity('not a url').key).toBe('not a url');
    expect(key('file:///Users/me/notes.html#top')).toBe('file:///Users/me/notes.html');
  });
});

group('arXiv', () => {
  const forms = [
    'https://arxiv.org/abs/2401.12345',
    'https://arxiv.org/abs/2401.12345v2',
    'https://www.arxiv.org/abs/2401.12345v1',
    'https://arxiv.org/html/2401.12345v2',
    'https://arxiv.org/html/2401.12345v2/#S3',
    'https://arxiv.org/pdf/2401.12345v2',
    'https://arxiv.org/pdf/2401.12345v2.pdf',
    'https://export.arxiv.org/abs/2401.12345',
    'https://browse.arxiv.org/abs/2401.12345',
    'https://ar5iv.labs.arxiv.org/html/2401.12345',
    'https://ar5iv.org/abs/2401.12345',
  ];
  test('every form maps to one key', () => {
    for (const f of forms) expect(key(f), f).toBe('arxiv:2401.12345');
  });
  test('version noted, all hosts listed, plain address as alias', () => {
    const id = pageIdentity('https://arxiv.org/html/2401.12345v2');
    expect(id.version).toBe('v2');
    expect(id.hosts).toEqual(
      expect.arrayContaining([
        'arxiv.org',
        'www.arxiv.org',
        'export.arxiv.org',
        'browse.arxiv.org',
        'ar5iv.labs.arxiv.org',
        'ar5iv.org',
      ]),
    );
    expect(id.aliases).toContain('https://arxiv.org/html/2401.12345v2');
    expect(pageIdentity('https://arxiv.org/abs/2401.12345').version).toBeUndefined();
  });
  test('old style ids', () => {
    expect(key('https://arxiv.org/abs/math/0601001v3')).toBe('arxiv:math/0601001');
    expect(key('https://arxiv.org/pdf/hep-th/9901001')).toBe('arxiv:hep-th/9901001');
  });
  test('other arXiv pages keep their address', () => {
    expect(key('https://arxiv.org/list/cs.CL/recent')).toBe('https://arxiv.org/list/cs.CL/recent');
  });
});

group('Wikipedia', () => {
  test('article, mobile, permanent link and index.php forms', () => {
    const k = 'wikipedia:en:Ada_Lovelace';
    expect(key('https://en.wikipedia.org/wiki/Ada_Lovelace')).toBe(k);
    expect(key('https://en.m.wikipedia.org/wiki/Ada_Lovelace#Life')).toBe(k);
    expect(key('https://en.wikipedia.org/w/index.php?title=Ada_Lovelace&oldid=1234567')).toBe(k);
    expect(key('https://en.wikipedia.org/wiki/Ada%20Lovelace')).toBe(k);
    expect(key('https://en.wikipedia.org/wiki/ada_Lovelace')).toBe(k);
  });
  test('oldid is the version, both hosts listed', () => {
    const id = pageIdentity('https://en.wikipedia.org/w/index.php?title=Ada_Lovelace&oldid=1234567');
    expect(id.version).toBe('oldid=1234567');
    expect(id.hosts).toEqual(expect.arrayContaining(['en.wikipedia.org', 'en.m.wikipedia.org']));
  });
  test('languages stay apart', () => {
    expect(key('https://de.wikipedia.org/wiki/Ada_Lovelace')).toBe('wikipedia:de:Ada_Lovelace');
  });
});

group('docs sites', () => {
  test('python versions', () => {
    const k = key('https://docs.python.org/3/library/os.html');
    expect(k).toBe(key('https://docs.python.org/3.12/library/os.html#os.walk'));
    expect(k).toBe(key('https://docs.python.org/3.13/library/os.html'));
    expect(pageIdentity('https://docs.python.org/3.12/library/os.html').version).toBe('3.12');
    expect(key('https://docs.python.org/fr/3/library/os.html')).not.toBe(k);
  });
  test('readthedocs latest, stable and numbers', () => {
    const k = key('https://requests.readthedocs.io/en/latest/user/quickstart/');
    expect(key('https://requests.readthedocs.io/en/stable/user/quickstart/')).toBe(k);
    expect(key('https://requests.readthedocs.io/en/v2.31.0/user/quickstart/')).toBe(k);
    expect(pageIdentity('https://requests.readthedocs.io/en/stable/user/quickstart/').version).toBe('stable');
  });
  test('MDN locale prefix', () => {
    const k = key('https://developer.mozilla.org/en-US/docs/Web/API/Range');
    expect(key('https://developer.mozilla.org/docs/Web/API/Range')).toBe(k);
    expect(key('https://developer.mozilla.org/en-us/docs/Web/API/Range')).toBe(k);
  });
  test('a plain docs page without a version keeps its address', () => {
    expect(key('https://docs.example.com/guide/start')).toBe('https://docs.example.com/guide/start');
  });
});

group('canonical link', () => {
  const docWith = (href: string) =>
    ({
      querySelector: (sel: string) =>
        sel.includes('canonical') ? { getAttribute: (n: string) => (n === 'href' ? href : null) } : null,
    }) as unknown as Document;

  test('same-site canonical becomes an alias', () => {
    const id = pageIdentity(
      'https://www.example.com/story?id=5&utm_source=x',
      docWith('https://example.com/story/5'),
    );
    expect(id.key).toBe('https://www.example.com/story?id=5');
    expect(id.aliases).toEqual(['https://example.com/story/5']);
  });
  test('other-site canonical is ignored', () => {
    const id = pageIdentity('https://mirror.net/story', docWith('https://example.com/story'));
    expect(id.aliases).toEqual([]);
  });
  test('relative canonical resolves against the address', () => {
    const id = pageIdentity('https://example.com/a/b?x=1', docWith('/a/b'));
    expect(id.aliases).toEqual(['https://example.com/a/b']);
  });
});
