// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the samples are script source with template holes.
import { describe, expect, test } from 'vitest';
import { scanCss, scanHtml, scanJs, scanJson } from '../../../scripts/netscan';

const rules = (src: string) => scanJs(src).map((h) => `${h.rule}:${h.detail}`);

describe('scanJs', () => {
  test('network APIs by identifier, member name and literal key', () => {
    expect(
      rules(
        'new XMLHttpRequest;new WebSocket(a);new EventSource(b);navigator.sendBeacon(c);importScripts("x");' +
          'new RTCPeerConnection;new webkitRTCPeerConnection;window["fetch"](u);const {fetch: f} = self;',
      ),
    ).toEqual([
      'api:XMLHttpRequest',
      'api:WebSocket',
      'api:EventSource',
      'api:sendBeacon',
      'api:importScripts',
      'api:RTCPeerConnection',
      'api:webkitRTCPeerConnection',
      'api:fetch',
      'api:fetch',
    ]);
  });

  test('spacing, member access and string splitting do not hide a call', () => {
    expect(rules('fetch (u)')).toEqual(['api:fetch']);
    expect(rules('globalThis.fetch(u)')).toEqual(['api:fetch']);
    expect(rules('self["fe" + "tch"](u)')).toEqual(['api:fetch']);
    expect(rules('const u = "https://evil" + ".example/x"')).toContain(
      'remote-string:https://evil.example/x',
    );
    expect(rules('const u = "ht" + "tps://evil.example/x"')).toEqual([
      'remote-string:https://evil.example/x',
    ]);
  });

  test('comments and licence text are not scanned', () => {
    expect(rules('/* fetch("https://example.org/") */\n// new WebSocket("wss://x.y")\nlet a = 1;')).toEqual(
      [],
    );
  });

  test('computed access on globals with a key that is not a literal', () => {
    expect(rules('window[k](u); self[a+b]; globalThis[n]; navigator[m]; top[x]')).toEqual([
      'global-computed:window[k]',
      'global-computed:self[a+b]',
      'global-computed:globalThis[n]',
      'global-computed:navigator[m]',
      'global-computed:top[x]',
    ]);
    expect(rules('obj[k]; window["innerWidth"]')).toEqual([]);
  });

  test('remote addresses in strings, templates and protocol-relative form', () => {
    expect(
      rules('a = "https://cdn.example/x.js"; b = `wss://h.example/${p}`; c = "//cdn.example.com/x"'),
    ).toEqual([
      'remote-string:https://cdn.example/x.js',
      'remote-string:wss://h.example/${p}',
      'remote-string://cdn.example.com/x',
    ]);
    expect(rules('createElementNS("http://www.w3.org/2000/svg","path"); x = "// note"')).toEqual([]);
    // PDF.js builds `http://${url}` for links written as "www.".
    expect(rules('new URL(a,"https://foo.bar"); s = `http://${e}`')).toEqual([]);
    expect(rules('s = `http://${e}.example`')).toEqual(['remote-string:http://${e}.example']);
  });

  test('assignments, setAttribute and window.open with remote literals', () => {
    expect(rules('img.src = "https://t.example/p.gif"')).toContain(
      'remote-assign:src = https://t.example/p.gif',
    );
    expect(rules('location = "//t.example/"')).toContain('remote-assign:location = //t.example/');
    expect(rules('location.href = "https://t.example/"')).toContain(
      'remote-assign:href = https://t.example/',
    );
    expect(rules('form.action = "http://t.example/"')).toContain('remote-assign:action = http://t.example/');
    expect(rules('a.setAttribute("href", "https://t.example/")')).toContain(
      'remote-assign:href = https://t.example/',
    );
    expect(rules('window.open("https://t.example/")')).toContain('remote-open:https://t.example/');
    expect(rules('img.src = "/icons/32.png"; window.open(getURL("/pdf.html"))')).toEqual([]);
  });

  test('workers and imports from remote or non-relative addresses', () => {
    expect(rules('new Worker("https://t.example/w.js")')).toContain('worker:https://t.example/w.js');
    expect(rules('new Worker("/pdf/worker.js"); import("./a.js"); import("/x.js")')).toEqual([]);
    expect(rules('import("https://cdn.example/x.js")')).toContain('import:"https://cdn.example/x.js"');
    expect(rules('import("lodash")')).toEqual(['import:"lodash"']);
    expect(rules('import(u)')).toEqual(['import:u']);
    expect(rules('import(chrome.runtime.getURL("content/loader.js"))')).toEqual([]);
    expect(rules('var b = `/pdf/`; import(`${b}${n}.js`)')).toEqual([]);
    expect(rules('var b = `https://cdn.example/`; import(`${b}${n}.js`)')).toContain('import:`${b}${n}.js`');
    expect(rules('import x from "https://cdn.example/x.js"')).toContain('import:https://cdn.example/x.js');
  });

  test('a fetch is pinned to the page address only when it provably is', () => {
    const own = (src: string) => scanJs(src).find((h) => h.detail === 'fetch')?.own;
    expect(own('fetch(location.href)')).toBe(true);
    expect(
      own('async function s(e){return fetch(e,{})} async function c(){let n=location.href;await s(n)}'),
    ).toBe(true);
    expect(
      own('async function s(e){return fetch(e)} async function c(){let n=location.href;await s(n);s("x")}'),
    ).toBe(false);
    expect(
      own('async function s(e){return fetch(e)} async function c(){let n=location.href;n=q;await s(n)}'),
    ).toBe(false);
    expect(own('fetch("https://t.example/")')).toBe(false);
  });
});

test('scanCss finds remote url() and @import', () => {
  expect(
    scanCss(
      '/* url(https://c.example/a) */ a{background:url("https://t.example/a.png")} b{x:url(//t.example/b)} @import "https://f.example/c.css"; c{background:url(data:image/png;base64,AA)} d{background:url(/icons/a.png)}',
    ).map((h) => h.detail),
  ).toEqual(['https://t.example/a.png', '//t.example/b', 'https://f.example/c.css']);
});

test('scanHtml finds resource hints, remote attributes and inline code', () => {
  const html = `<link rel="dns-prefetch" href="/x"><link rel=preconnect href="https://t.example">
<link rel="stylesheet" href="./style.css"><img src="https://t.example/p.png"><script>fetch(u)</script>
<!-- <script src="https://c.example/x.js"></script> --><style>a{background:url(//t.example/a)}</style>`;
  expect(scanHtml(html).map((h) => `${h.rule}:${h.detail}`)).toEqual([
    'html:rel=dns-prefetch',
    'html:rel=preconnect',
    'html:href=https://t.example',
    'html:src=https://t.example/p.png',
    'api:fetch',
    'css://t.example/a',
  ]);
});

test('scanJson finds remote addresses in values', () => {
  expect(
    scanJson('{"a":["https://t.example/x"],"b":{"c":"http://www.w3.org/2000/svg"}}').map((h) => h.detail),
  ).toEqual(['https://t.example/x']);
});
