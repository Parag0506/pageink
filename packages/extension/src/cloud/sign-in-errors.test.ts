/**
 * Failed sign-ins against the local fakes: each carries the step, the provider's code, a
 * scrubbed description and the status, and never a token, a code or the verifier. Also the
 * scopes: nothing beyond the least is ever asked for.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { Fake, msError } from '../../test/cloud-fake';
import { memorySecrets } from '../background/secrets';
import { clean } from '../connect/explain';
import { DRIVE_SCOPE } from './google';
import { fakeHosts } from './hosts';
import { CloudError } from './http';
import { createCloud } from './index';
import { MS_SCOPES } from './onedrive';

const REDIRECT = 'https://abcdefgh.chromiumapp.org/';

function area() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of ks) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

let fake: Fake;
/** Everything secret that went through the flow: returned addresses and request bodies. */
let seen: string[];
beforeEach(async () => {
  fake = await new Fake().start();
  seen = [];
});
afterEach(() => fake.stop());

function cloud() {
  const storage = area();
  const secrets = memorySecrets();
  const flow = async (url: string, interactive: boolean) => {
    const r = await fetch(url, { redirect: 'manual' });
    const to = r.headers.get('location');
    if (!to) throw new Error('The user did not approve access.');
    for (const [k, v] of new URL(to.replace('#', '?')).searchParams)
      if (k === 'code' || k === 'access_token') seen.push(v);
    void interactive;
    return to;
  };
  return {
    storage,
    secrets,
    cloud: createCloud({
      storage: storage as never,
      secrets,
      ids: { google: 'g-id', microsoft: 'm-id' },
      flow: (u, i) =>
        flow(u, i).catch((e) => {
          throw e instanceof CloudError
            ? e
            : new CloudError(i ? 'cancelled' : 'expired', 0, '', {
                step: 'authorize',
                description: String(e.message),
              });
        }),
      redirect: REDIRECT,
      hosts: fakeHosts(fake.base),
      net: { sleep: async () => {}, baseMs: 1 },
    }),
  };
}

async function failure(p: 'google' | 'onedrive') {
  const c = cloud();
  const e = await c.cloud.connect(p).then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(CloudError);
  const info = (e as CloudError).info;
  const text = JSON.stringify(clean(info)) + String((e as Error).message);
  // Nothing secret, ever: no token or code seen in the flow, no stored token, no verifier.
  const stored = JSON.stringify([...c.storage.data.values(), ...c.secrets.all.values()]);
  for (const s of seen) expect(text).not.toContain(s);
  for (const m of stored.matchAll(/"(access|refresh)":"([^"]+)"/g)) expect(text).not.toContain(m[2]);
  expect(text).not.toMatch(/(code_verifier|access_token|refresh_token|code)=(?!\[removed\])/);
  return { e: e as CloudError, info: clean(info)! };
}

test('Microsoft: a token step refused for a Mobile and desktop address carries AADSTS9002326', async () => {
  fake.tokenError = {
    status: 400,
    body: msError(
      'invalid_request',
      9002326,
      "Cross-origin token redemption is permitted only for the 'Single-Page Application' client-type.",
    ),
  };
  const { e, info } = await failure('onedrive');
  expect(e.code).toBe('denied');
  expect(info).toMatchObject({
    provider: 'onedrive',
    step: 'token',
    error: 'invalid_request',
    status: 400,
    redirect: REDIRECT,
  });
  expect(info.description).toMatch(/^AADSTS9002326: Cross-origin token redemption/);
  expect(info.description).not.toMatch(/Trace ID|0000aaaa|abcdefghijklmnop/);
});

test('Microsoft: an error that repeats the code and the verifier never shows them', async () => {
  let sent = new URLSearchParams();
  fake.tokenError = {
    status: 400,
    body: (f) => {
      sent = f;
      // A provider that echoes the request, raw and as parameters.
      return {
        error: 'invalid_grant',
        error_description: `AADSTS70008: bad grant ${f.get('code')} ${f.get('code_verifier')} ${f.toString()}`,
      };
    },
  };
  const { info } = await failure('onedrive');
  expect(info.step).toBe('token');
  expect(info.description).toContain('AADSTS70008');
  expect(sent.get('code')).toBeTruthy();
  expect(info.description).not.toContain(sent.get('code')!);
  expect(info.description).not.toContain(sent.get('code_verifier')!);
});

test('Microsoft: an error sent back to the return address is an authorize step', async () => {
  fake.authError = {
    error: 'invalid_request',
    error_description: 'AADSTS50011: The redirect URI does not match.',
  };
  const { e, info } = await failure('onedrive');
  expect(e.code).toBe('denied');
  expect(info).toMatchObject({ step: 'authorize', error: 'invalid_request', provider: 'onedrive' });
  expect(info.description).toMatch(/^AADSTS50011/);
});

test('Google: an error page that never comes back reads as a closed window, with the address', async () => {
  fake.authErrorPage = 'redirect_uri_mismatch';
  const { e, info } = await failure('google');
  expect(e.code).toBe('cancelled');
  expect(info).toMatchObject({ step: 'authorize', provider: 'google', redirect: REDIRECT });
  expect(info.error).toBeUndefined();
});

test('Google: access_denied comes back as the authorize step', async () => {
  fake.authError = { error: 'access_denied' };
  const { e, info } = await failure('google');
  expect(e.code).toBe('denied');
  expect(info).toMatchObject({ step: 'authorize', error: 'access_denied' });
});

test('Google: the Drive API turned off fails the first file call with its reason', async () => {
  fake.apiError = {
    status: 403,
    body: {
      error: {
        code: 403,
        message: 'Google Drive API has not been used in project 123456789012 before or it is disabled.',
        errors: [{ reason: 'accessNotConfigured' }],
        status: 'PERMISSION_DENIED',
      },
    },
  };
  const { e, info } = await failure('google');
  expect(e.code).toBe('denied');
  expect(info).toMatchObject({ step: 'first file call', error: 'accessNotConfigured', status: 403 });
});

test('Microsoft: a Single-page application address works when the request carries an Origin header', async () => {
  // Node's fetch sends none, so a "spa" registration refuses it, as Microsoft does.
  fake.msPlatform = 'spa';
  const { info } = await failure('onedrive');
  expect(info.description).toMatch(/^AADSTS9002327/);
});

test('only the least scopes are ever asked for', async () => {
  expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  expect(MS_SCOPES.split(' ').sort()).toEqual(['Files.ReadWrite.AppFolder', 'offline_access']);
  const a = cloud();
  await a.cloud.connect('google');
  await a.cloud.connect('onedrive');
  // Renewals too.
  fake.expireAccess();
  fake.expireRefresh();
  await a.cloud
    .open('onedrive')
    .list('pages')
    .catch(() => {});
  await a.cloud
    .open('google')
    .list('pages')
    .catch(() => {});
  const allowed = new Set([
    'https://www.googleapis.com/auth/drive.file',
    'Files.ReadWrite.AppFolder',
    'offline_access',
  ]);
  expect(fake.scopes.length).toBeGreaterThan(2);
  for (const s of fake.scopes) for (const one of s.split(' ')) expect(allowed).toContain(one);
});
