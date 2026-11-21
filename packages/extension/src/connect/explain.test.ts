import { expect, test } from 'vitest';
import { clean, detailText, explain, hintFor, scrub } from './explain';

test('scrub removes tokens, codes, emails and long ids, and keeps the error codes', () => {
  const s = scrub(
    'AADSTS9002326: Cross-origin token redemption. Request origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop. ' +
      'code=M.C507_BAY.2.U.1234 refresh_token=r-secret access_token=eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig ' +
      'for reader@example.test, client 0000aaaa-11bb-cccc-dd22-eeeeee333333\r\nTrace ID: 1234\r\nTimestamp: 2026',
    ['my-verifier-value'],
  );
  expect(s).toContain('AADSTS9002326');
  for (const bad of [
    'M.C507',
    'r-secret',
    'eyJ0',
    'reader@',
    '0000aaaa',
    'abcdefghijklmnop',
    'Trace ID',
    'Timestamp',
  ])
    expect(s).not.toContain(bad);
  expect(scrub('verifier is my-verifier-value', ['my-verifier-value'])).toBe('verifier is [removed]');
  expect(scrub('xxxxx   y')).toBe('xxxxx y');
  expect(scrub('a '.repeat(600)).length).toBeLessThanOrEqual(400);
});

test('clean keeps only known fields and drops bad ones', () => {
  expect(
    clean({ step: 'token', error: 'invalid_request', status: 400, access_token: 'x', code: 'y' }),
  ).toEqual({
    step: 'token',
    error: 'invalid_request',
    status: 400,
  });
  expect(clean({ step: 'nonsense' })).toBeUndefined();
  expect(clean(null)).toBeUndefined();
  expect(clean({ step: 'authorize', redirect: 'javascript:alert(1)' })).toEqual({ step: 'authorize' });
  expect(clean({ step: 'authorize', redirect: 'https://abc.chromiumapp.org/' })?.redirect).toBe(
    'https://abc.chromiumapp.org/',
  );
  expect(clean({ step: 'token', description: 'see refresh_token=abc for a@b.cd' })?.description).toBe(
    'see refresh_token=[removed] for [email]',
  );
});

test('each known code maps to one sentence', () => {
  const g = (error: string) => hintFor({ provider: 'google', step: 'authorize', error });
  expect(g('redirect_uri_mismatch')).toMatch(
    /^The return address is not registered for this client id\. Add the address below under Authorized redirect URIs/,
  );
  expect(g('redirect_uri_mismatch')).toMatch(/wait a few minutes\.$/);
  expect(g('invalid_client')).toMatch(/client id/);
  expect(g('unauthorized_client')).toMatch(/Web application/);
  expect(g('access_denied')).toMatch(/test users list/);
  expect(g('accessNotConfigured')).toMatch(/Drive API is off/);
  const m = (code: number) =>
    hintFor({
      provider: 'onedrive',
      step: 'token',
      error: 'invalid_request',
      description: `AADSTS${code}: words`,
    });
  expect(m(9002326)).toBe(
    'Move the return address from Mobile and desktop applications to Single-page application in the app registration, then try again.',
  );
  expect(m(9002327)).toMatch(/Mobile and desktop/);
  expect(m(50011)).toMatch(/not registered/);
  expect(m(700016)).toMatch(/client id/);
  expect(m(65001)).toMatch(/API permissions/);
  expect(m(70011)).toMatch(/permission/);
  expect(m(7000218)).toMatch(/public client flows/);
  expect(m(1)).toBeUndefined();
  // A Google code is not a Microsoft hint.
  expect(
    hintFor({ provider: 'onedrive', step: 'authorize', error: 'redirect_uri_mismatch' }),
  ).toBeUndefined();
  // No em dashes in anything the reader sees.
  for (const v of [g('redirect_uri_mismatch'), m(9002326)])
    expect(v).not.toContain(String.fromCharCode(0x2014));
});

test('a closed window and a refused next step are told apart', () => {
  expect(explain({ step: 'authorize' }, 'OneDrive').text).toBe(
    'You closed the sign-in window or chose Cancel.',
  );
  expect(explain({ step: 'authorize', error: 'access_denied' }, 'OneDrive').text).toBe(
    'You closed the sign-in window or chose Cancel.',
  );
  const t = explain(
    { provider: 'onedrive', step: 'token', error: 'invalid_request', description: 'AADSTS9002326: x' },
    'OneDrive',
  );
  expect(t.text).toBe('Sign-in worked, but OneDrive refused the next step.');
  expect(t.hint).toMatch(/Single-page application/);
  expect(t.next).toBe('Fix it, then try again');
});

test('detailText lists every field, and the return address', () => {
  expect(
    detailText(
      {
        provider: 'onedrive',
        step: 'token',
        error: 'invalid_request',
        description: 'AADSTS9002326: x',
        status: 400,
      },
      'https://abc.chromiumapp.org/',
    ),
  ).toBe(
    [
      'Provider: OneDrive',
      'Step: token',
      'Error: invalid_request',
      'Description: AADSTS9002326: x',
      'HTTP status: 400',
      'Return address used by this build: https://abc.chromiumapp.org/',
    ].join('\n'),
  );
});
