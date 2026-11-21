/**
 * The extension API object. Firefox and Safari expose promise-based `browser`.
 * Chrome MV3 returns promises from `chrome`. An element with id "browser" can
 * shadow the global, so check for a real runtime id.
 */
export type Api = typeof chrome;

export function pickApi(g: unknown = globalThis): Api {
  const o = g as { browser?: { runtime?: { id?: string } }; chrome?: Api };
  return (o.browser?.runtime?.id ? o.browser : o.chrome) as Api;
}
