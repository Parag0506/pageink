/**
 * The stub's entry, the same in every browser. The viewer and the tools are registered or
 * injected by the background when they are needed (CONTRACT 4).
 */
import { pickApi } from '../api';
import { startRelay } from './diag';
import { lazyLoad } from './modules';
import { startStub } from './stub';

const api = pickApi();
startStub({ win: window, api, load: lazyLoad(api), penReady: __INK_PEN_READY__ });
// The device check page hears from a diagnostics build. Other builds leave this out.
if (__INK_DIAG__) startRelay(window, api, { target: __INK_TARGET__, penReady: __INK_PEN_READY__ });
