/// <reference types="chrome" />

/** Set per build in build/targets.ts. */
declare const __INK_TARGET__: 'chrome' | 'edge' | 'firefox' | 'safari';
/** Default for cfg.penReady in this build. */
declare const __INK_PEN_READY__: boolean;
/** True only in the bench build, which keeps performance marks and measures. */
declare const __INK_BENCH__: boolean;
/** OAuth client ids from cloud-ids.json, or cloud-ids.local.json when present. */
declare const __INK_CLOUD_IDS__: { google: string; microsoft: string };
/** True only in the test build (INK_CLOUD_FAKE=1), which talks to a local fake of each provider. */
declare const __INK_CLOUD_FAKE__: boolean;
/** True only in a diagnostics build for the device check. Never in a release. */
declare const __INK_DIAG__: boolean;
/** The one origin that may receive diagnostics. Empty when __INK_DIAG__ is false. */
declare const __INK_DIAG_ORIGIN__: string;
