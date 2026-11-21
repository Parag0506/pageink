import { expect, test } from 'vitest';
import { type Api, pickApi } from '../api';
import { lazyLoad, twice } from './modules';

test('lazyLoad takes a module from the content script world, or asks the background to inject it', async () => {
  const g = globalThis as { __ink?: Record<string, unknown> };
  delete g.__ink;
  const sent: unknown[] = [];
  const api = {
    runtime: {
      sendMessage: async (m: { files: string[] }) => {
        sent.push(m);
        // The background runs the files in the frame that asked. They store their exports.
        for (const f of m.files) (g.__ink as Record<string, unknown>)[f] = { name: f };
      },
    },
  } as unknown as Api;
  try {
    const load = lazyLoad(api);
    expect(((await load('loader')) as unknown as { name: string }).name).toBe('loader');
    expect(sent).toEqual([{ ink: 'inject', files: ['loader'] }]);
    // Already in the world: no request.
    await load('loader');
    expect(sent).toHaveLength(1);
    // The tools come in the same request as a missing loader, and not again once in.
    delete g.__ink!.loader;
    await load('loader', true);
    expect(sent.at(-1)).toEqual({ ink: 'inject', files: ['loader', 'tools'] });
    await load('loader', true);
    expect(sent).toHaveLength(2);
    // The viewer asks for the tools through the same function.
    expect(g.__ink!.need).toBe(load);
  } finally {
    delete g.__ink;
  }
});

test('path selection: a registered viewer needs no request; on Safari a lost request is sent once more', async () => {
  const g = globalThis as { __ink?: Record<string, unknown> };
  // The registered viewer ran at document start: the stub finds it and asks for nothing.
  g.__ink = { loader: { name: 'registered' } };
  const sent: string[][] = [];
  let lose = 0;
  const api = {
    runtime: {
      sendMessage: async (m: { files: string[] }) => {
        sent.push(m.files);
        // A background that stopped while it worked: the request fails or nothing arrives.
        if (lose-- > 0) {
          if (lose % 2) throw new Error('Could not establish connection');
          return undefined;
        }
        for (const f of m.files) (g.__ink as Record<string, unknown>)[f] = { name: f };
      },
    },
  } as unknown as Api;
  try {
    // The Safari build wraps the load in twice(). This test runs with the Chrome build's constants.
    const load = twice(lazyLoad(api) as (name: string, tools?: boolean) => Promise<unknown>);
    expect(((await load('loader')) as unknown as { name: string }).name).toBe('registered');
    expect(sent).toEqual([]);
    // The pen-down asks for the tools only, since the viewer is in.
    lose = 1;
    await load('loader', true);
    expect(sent).toEqual([['tools'], ['tools']]);
    expect(g.__ink!.tools).toBeTruthy();
    // Two lost requests: no third, and the caller sees nothing arrived.
    delete g.__ink!.loader;
    lose = 2;
    expect(await load('loader')).toBeUndefined();
    expect(sent.slice(2)).toEqual([['loader'], ['loader']]);
  } finally {
    delete g.__ink;
  }
});

test('pickApi prefers a real browser global and ignores a shadowing element', () => {
  const chrome = { runtime: { id: 'c' } };
  const browser = { runtime: { id: 'b' } };
  expect(pickApi({ browser, chrome })).toBe(browser);
  expect(pickApi({ browser: {}, chrome })).toBe(chrome);
  expect(pickApi({ chrome })).toBe(chrome);
});
