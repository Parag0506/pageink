import { expect, test } from 'vitest';
import type { Api } from '../api';
import { NAME } from '../brand';
import { consentNote, returnAddress, signInProblem } from './sign-in-help';

const ADDR = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';

test('a refused token step shows the plain line, the hint, and every detail', () => {
  let tried = 0;
  const el = signInProblem(
    {
      provider: 'onedrive',
      step: 'token',
      error: 'invalid_request',
      description: 'AADSTS9002326: Cross-origin token redemption is permitted only for SPA.',
      status: 400,
      redirect: ADDR,
    },
    'OneDrive',
    undefined,
    () => tried++,
  );
  document.body.replaceChildren(el);
  expect(el.querySelector('#place-problem-text')?.textContent).toBe(
    'Sign-in worked, but OneDrive refused the next step. ',
  );
  expect(el.querySelector('#place-hint')?.textContent).toMatch(
    /^Move the return address from Mobile and desktop/,
  );
  const dl = el.querySelector('#sign-in-details')!;
  const pairs = [...dl.querySelectorAll('dt')].map((dt) => [
    dt.textContent,
    dt.nextElementSibling?.textContent,
  ]);
  expect(pairs).toEqual([
    ['Provider', 'OneDrive'],
    ['Step', 'token'],
    ['Error', 'invalid_request'],
    ['Description', 'AADSTS9002326: Cross-origin token redemption is permitted only for SPA.'],
    ['HTTP status', '400'],
    ['Return address used by this build', ADDR],
  ]);
  expect(el.querySelector('#place-details summary')?.textContent).toBe('Details');
  expect(el.querySelector('#copy-details')?.textContent).toBe('Copy details');
  expect(el.querySelector('#place-details')?.textContent).toContain(
    `Return address used by this build: ${ADDR}`,
  );
  (el.querySelector('#place-fix') as HTMLButtonElement).click();
  expect(tried).toBe(1);
  expect(el.textContent).not.toContain(String.fromCharCode(0x2014));
});

test('a closed window says so, and points at the address to compare', () => {
  const el = signInProblem({ provider: 'google', step: 'authorize' }, 'Google Drive', ADDR);
  expect(el.querySelector('#place-problem-text')?.textContent).toBe(
    'You closed the sign-in window or chose Cancel. ',
  );
  expect(el.querySelector('#place-details')?.textContent).toContain('compare the return address below');
  expect(el.querySelector('.return-address')?.textContent).toBe(ADDR);
});

test('the note before the provider screen, with the return address', () => {
  const el = consentNote(ADDR);
  expect(el.textContent).toContain(`It says ${NAME} can use files in its own folder.`);
  expect(el.textContent).toContain('We have no servers and receive nothing.');
  expect(el.textContent).toContain('It cannot see anything else in your Drive or OneDrive.');
  expect(el.querySelector('#return-address-help')?.textContent).toBe(
    `Return address used by this build: ${ADDR}`,
  );
  expect(consentNote().querySelector('#return-address-help')).toBeNull();
});

test('with no address yet, a button asks the browser for it', async () => {
  const el = consentNote(undefined, async () => ADDR);
  document.body.replaceChildren(el);
  expect(el.querySelector('#return-address-help')).toBeNull();
  (el.querySelector('#show-return-address') as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 0));
  expect(el.querySelector('#return-address-help')?.textContent).toBe(
    `Return address used by this build: ${ADDR}`,
  );
});

test('returnAddress comes from the browser only', () => {
  const withId = {
    identity: { getRedirectURL: () => 'https://x.extensions.allizom.org/' },
    runtime: { id: 'abc' },
  };
  expect(returnAddress(withId as unknown as Api)).toBe('https://x.extensions.allizom.org/');
  expect(returnAddress({ runtime: { id: 'abc' } } as unknown as Api)).toBeUndefined();
});
