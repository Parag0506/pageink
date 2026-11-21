/**
 * The seam between the stub and the lazy modules. A Load function returns a
 * module by name. It takes it from the content script world, where a registered
 * or injected plain script left it, and otherwise asks the background to inject
 * it. Every browser, Safari included, works this way. The tools are loaded by the viewer through the same seam, so they share the
 * loader's modules.
 */
import type { ElementPath, Front, InkConfig, Viewer } from 'pageink-core/types';
import type { Api } from '../api';

export interface LoaderStart {
  api: Api;
  cfg?: Partial<InkConfig>;
  top: boolean;
  /** Called when the reader switches ink off for the site from the bar. */
  off?: () => void;
  /** The stub's early window listeners. */
  front?: Front;
  /**
   * Storage items the stub has read, absent ones included as undefined: the site index,
   * the settings and the record its address points at. The viewer's first reads use them.
   */
  pre?: Promise<Record<string, unknown>>;
}

export interface LoaderModule {
  start(ctx: LoaderStart): Promise<Viewer>;
  /** Structural path of a frame element in this document. */
  pathOf(el: Element): ElementPath;
}

/** The PDF chunk. Started by the stub in the top frame of a PDF document. */
export interface PdfModule {
  start(ctx: { api: Api; cfg?: Partial<InkConfig> }): void;
}

export interface Modules {
  loader: LoaderModule;
  pdf: PdfModule;
}

/**
 * Load a module. With `tools`, the tools are injected in the same request when they are
 * missing, so a first pen-down costs one trip to the background, not two.
 */
export type Load = <K extends keyof Modules>(name: K, tools?: boolean) => Promise<Modules[K]>;

/** A record read started at document start, by the boot script on hosts with ink. */
export interface Early {
  key: string;
  items: Promise<Record<string, unknown>>;
}

/**
 * What the content script world holds: modules that are in, the request for a missing
 * one, and the early record read. Pages cannot see this world.
 */
export type World = { [K in keyof Modules]?: Modules[K] } & {
  tools?: unknown;
  need?: (name: string) => Promise<unknown>;
  early?: Early;
  diag?: DiagEarly;
};

export const world = (): World => ((globalThis as { __ink?: World }).__ink ??= {});

/**
 * What the stub saw before the tools loaded, for the device check. Kept in the content script
 * world, so the stub and the viewer, which are separate scripts, share it. Only diagnostics
 * builds call this.
 */
export interface DiagEarly {
  /** Stylus touches the stub held back, and how many of them ended up cancelled. */
  stylus: number;
  stylusCancelled: number;
  /** Pointer events buffered for capture, and when the tools took them. */
  buffered: number;
  downAt: number;
  adoptedAt: number;
  /** Time spent waiting for the background to inject the viewer and the tools. */
  injectMs: number;
  reported: boolean;
}

export const diagOf = (): DiagEarly =>
  (world().diag ??= {
    stylus: 0,
    stylusCancelled: 0,
    buffered: 0,
    downAt: 0,
    adoptedAt: 0,
    injectMs: 0,
    reported: false,
  });

/**
 * A load that sends a request lost while the background stopped once more, for what is
 * still missing. A module already in costs no second request.
 */
export const twice =
  <F extends (name: string, tools?: boolean) => Promise<unknown>>(f: F) =>
  async (name: string, tools?: boolean): Promise<unknown> => {
    await f(name, tools).catch(() => {});
    return f(name, tools);
  };

/**
 * Default: a module already in the content script world, else the background injects
 * it (and the tools with it when asked) and the module is taken from the world. The
 * viewer asks for the tools through `need`.
 */
export const lazyLoad = (api: Api): Load => {
  const g = world();
  const once = async (name: string, tools?: boolean): Promise<unknown> => {
    const files = (tools ? [name, 'tools'] : [name]).filter((n) => !g[n as keyof World]);
    // A module that did not arrive leaves undefined, and the caller's next step fails.
    if (!files.length) return g[name as keyof World];
    const t = __INK_BENCH__ || __INK_DIAG__ ? performance.now() : 0;
    await api.runtime.sendMessage({ ink: 'inject', files });
    if (__INK_BENCH__) performance.measure('ink:inject', { start: t, duration: performance.now() - t });
    if (__INK_DIAG__) diagOf().injectMs += performance.now() - t;
    return g[name as keyof World];
  };
  // Safari stops its background often. Other browsers keep it while a request is open.
  const load = __INK_TARGET__ === 'safari' ? twice(once) : once;
  g.need = load;
  return load as Load;
};
