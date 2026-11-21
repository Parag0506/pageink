import { expect, test } from 'vitest';
import {
  CREDENTIAL_PARAMS,
  CREDENTIAL_PREFIXES,
  hashKey,
  idxKey,
  isCredentialValue,
  newId,
  pageKeyOf,
  stripCredentials,
} from './hash';

test('hashKey is stable and short', () => {
  expect(hashKey('example.com')).toBe(hashKey('example.com'));
  expect(hashKey('a')).not.toBe(hashKey('b'));
  expect(idxKey('example.com')).toMatch(/^idx:[0-9a-z]+$/);
  expect(pageKeyOf('https://example.com/a')).toMatch(/^p:[0-9a-z]+$/);
});

test('newId is unique', () => {
  const ids = new Set(Array.from({ length: 1000 }, newId));
  expect(ids.size).toBe(1000);
});

test('the credential list is explicit', () => {
  expect([...CREDENTIAL_PARAMS].sort()).toEqual(
    [
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
    ].sort(),
  );
  expect(CREDENTIAL_PREFIXES).toEqual(['x-amz-', 'x-goog-']);
});

test('signed links lose every signing part, and keep the parts that name the file', () => {
  const s3 =
    'https://b.s3.amazonaws.com/report.pdf?response-content-disposition=inline&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260101T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Security-Token=IQoJb3JpZ2luX2VjEXAMPLE&X-Amz-Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  expect(stripCredentials(s3)).toBe(
    'https://b.s3.amazonaws.com/report.pdf?response-content-disposition=inline',
  );
  const gcs =
    'https://storage.googleapis.com/b/o.pdf?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=sa%40p.iam%2F20260101%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20260101T000000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=abcdef0123';
  expect(stripCredentials(gcs)).toBe('https://storage.googleapis.com/b/o.pdf');
  // Azure SAS: the signature goes; the rest says which version of the blob.
  expect(
    stripCredentials('https://a.blob.core.windows.net/c/f.pdf?sv=2024-01-01&se=2026&sp=r&sig=abc%3D'),
  ).toBe('https://a.blob.core.windows.net/c/f.pdf?sv=2024-01-01&se=2026&sp=r');
  expect(stripCredentials('https://d.cloudfront.net/f.pdf?Expires=1&Signature=abc&Key-Pair-Id=K1')).toBe(
    'https://d.cloudfront.net/f.pdf?Expires=1',
  );
  for (const name of ['token', 'jwt', 'otp', 'auth', 'key', 'sig', 'signature']) {
    expect(stripCredentials(`https://a.example/p?n=1&${name}=x`)).toBe('https://a.example/p?n=1');
  }
});

test('values that look like credentials go, whatever their name; ids that name a page stay', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  expect(stripCredentials(`https://a.example/view?doc=7&t=${jwt}`)).toBe('https://a.example/view?doc=7');
  expect(isCredentialValue('x', jwt)).toBe(true);
  const long = 'q8Zr2LkP0vX7mN4bT1yH6cJ9wE3sA5dF0gU8iO2pQ7lK4jR1zV6xC3nB9mY5tW2e';
  expect(stripCredentials(`https://a.example/dl?file=7&sharing_token=${long}`)).toBe(
    'https://a.example/dl?file=7',
  );
  // A long random value under a plain name can be the page's own id.
  expect(stripCredentials(`https://a.example/post.php?i=${long}`)).toBe(
    `https://a.example/post.php?i=${long}`,
  );
  expect(stripCredentials('https://a.example/p?authToken=Zk3q9LmP2xR7vT4w&id=3')).toBe(
    'https://a.example/p?id=3',
  );
  expect(stripCredentials('https://a.example/p?X-Sig=Zk3q9LmP2xR7vT4wQ1')).toBe('https://a.example/p');
  // These name the page and stay exactly as written.
  for (const u of [
    'https://docs.google.com/open?id=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
    'https://a.example/commit?sha=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'https://a.example/item?id=550e8400-e29b-41d4-a716-446655440000',
    'https://a.example/list?pageToken=2',
    'https://a.example/search?q=keys+and+tokens+in+urls+are+a+bad+idea+because+logs+keep+them+forever',
    'https://a.example/watch?v=dQw4w9WgXcQ',
  ]) {
    expect(stripCredentials(u)).toBe(u);
  }
});

test('stripCredentials takes out every listed credential and nothing that names the page', () => {
  for (const name of CREDENTIAL_PARAMS) {
    expect(stripCredentials(`https://a.example/p?id=7&${name}=s3cret`)).toBe('https://a.example/p?id=7');
    expect(stripCredentials(`https://a.example/p?${name.toUpperCase()}=s3cret`)).toBe('https://a.example/p');
  }
  // OAuth: code with state is a credential, code alone names a page.
  expect(stripCredentials('https://a.example/cb?code=abc&state=xyz&lang=en')).toBe(
    'https://a.example/cb?lang=en',
  );
  expect(stripCredentials('https://a.example/redeem?code=SPRING')).toBe(
    'https://a.example/redeem?code=SPRING',
  );
  // Fragments written like a query, as sign-in redirects do.
  expect(stripCredentials('https://a.example/#access_token=t&expires_in=3600')).toBe(
    'https://a.example/#expires_in=3600',
  );
  expect(stripCredentials('https://a.example/#/cb?id_token=t&page=2')).toBe('https://a.example/#/cb?page=2');
  expect(stripCredentials('https://a.example/#access_token=t')).toBe('https://a.example/');
  expect(stripCredentials('https://user:pw@a.example/x')).toBe('https://a.example/x');
  // Parameters that identify the page stay, written exactly as they were.
  for (const u of [
    'https://www.youtube.com/watch?v=abc&t=10',
    'https://a.example/search?q=tokens+and+keys&page=2',
    'https://a.example/item?id=5&sort=new',
    'https://a.example/app#/inbox/abc',
    'https://A.example/Path?x=%20y',
  ]) {
    expect(stripCredentials(u)).toBe(u);
  }
  expect(stripCredentials('not an address')).toBe('not an address');
  expect(stripCredentials('file:///x?token=1')).toBe('file:///x?token=1');
});
