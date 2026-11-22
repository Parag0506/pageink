// Every rule is scoped under .iu because this sheet shares a shadow root with
// the ink layer. Every property the UI depends on is set here, since the page
// may reset or poison anything that inherits into the root. The one rule outside .iu is
// .iu-room, the box that keeps room at the end of the page (room.ts). It sits beside the
// mount, which is fixed to the screen.
//
// The bar is centred on its edge with auto margins between two insets, not with left: 50%
// and a transform. Half the screen was all the room that gave it, so it wrapped into more
// rows than it needed and covered more of the page.
//
// On the left and right edges the bar is a row in a vertical writing mode, not a flex
// column. Where the screen is too short for one column it wraps into a second one, and the
// bar grows wider with it. A wrapped flex column keeps the width of one column in Firefox,
// which left buttons off the bar and off the screen.
//
// Colours follow the brand (brand/colours.md). --pri is the deep ink for primary actions.
// --acc is the terracotta, the one accent, for active and selected states, links and the
// focus ring. Both keep 4.5:1 or more against --solid and --bg in each theme. The ink
// people draw with is not here: it lives in render/theme.ts.
export const CSS = `
.iu{all:initial;position:fixed;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483647;display:block;
font:400 13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--fg);
letter-spacing:normal;word-spacing:normal;text-transform:none;text-align:left;text-indent:0;direction:ltr;
white-space:normal;visibility:visible;pointer-events:none;-webkit-font-smoothing:antialiased;
--bg:rgba(255,255,255,.93);--solid:#fff;--fg:#2f241c;--mut:#6e6155;--line:rgba(47,36,28,.12);--hov:rgba(47,36,28,.07);
--act:rgba(201,140,94,.16);--acc:#9a5530;--on:#fff;--pri:#2f241c;--on-pri:#fff;--focus:#9a5530;--bad:#c62828;
--sh:0 8px 28px rgba(47,36,28,.14),0 1px 3px rgba(47,36,28,.1);--b:32px;--g:12px;--t:.18s}
.iu[data-theme=dark]{--bg:rgba(34,34,38,.93);--solid:#26262b;--fg:#f3ebdd;--mut:#b5a898;--line:rgba(248,239,220,.14);
--hov:rgba(248,239,220,.09);--act:rgba(201,140,94,.22);--acc:#e0a77b;--on:#2f241c;--pri:#f8efdc;--on-pri:#2f241c;
--focus:#e0a77b;--bad:#ff8f86;--sh:0 8px 28px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.3)}
@media (pointer:coarse){.iu{--b:44px}}
.iu *,.iu *::before,.iu *::after{box-sizing:border-box;margin:0;font:inherit;color:inherit;letter-spacing:inherit}
.iu [hidden]{display:none!important}
.iu button{all:unset;box-sizing:border-box;position:relative;display:inline-flex;flex:none;align-items:center;
justify-content:center;gap:8px;min-width:var(--b);height:var(--b);padding:0;border-radius:9px;cursor:pointer;
font:inherit;color:inherit;background:transparent;touch-action:manipulation;user-select:none;-webkit-user-select:none;
-webkit-tap-highlight-color:transparent;transition:background-color var(--t),color var(--t),opacity var(--t)}
@media (hover:hover){.iu button:hover{background:var(--hov)}}
.iu button:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.iu button[aria-pressed=true]{background:var(--act);color:var(--acc)}
.iu button[aria-disabled=true]{opacity:.35;cursor:default;background:transparent}
.iu .ic{display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;
stroke-linejoin:round;pointer-events:none;overflow:visible}
.iu .bar,.iu .hdl,.iu .tray,.iu .ban{position:fixed;pointer-events:auto}
.iu .bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:2px;padding:4px;
background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:var(--sh);
backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);
max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);
transition:opacity var(--t) ease,visibility 0s linear 0s}
.iu .bar>.draw[aria-pressed=true]{background:var(--acc);color:var(--on)}
.iu .grip{cursor:grab;touch-action:none;color:var(--mut);min-width:20px;width:20px}
.iu .grip .ic{stroke-width:2.6}
.iu .sep{flex:none;width:1px;height:18px;margin:0 3px;background:var(--line)}
.iu .sw{display:block;width:16px;height:16px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(0,0,0,.18)}
.iu .swb[aria-pressed=true]{background:transparent}
.iu [aria-pressed=true]>.sw{box-shadow:0 0 0 2px var(--solid),0 0 0 4px var(--acc)}
.iu .hib{position:absolute;left:50%;bottom:5px;width:14px;height:3px;margin-left:-7px;border-radius:2px}
.iu .wn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;margin:auto 4px;border-radius:9px;background:#b7791f;color:#fff;font:700 12px/1 system-ui,sans-serif;cursor:help}
.iu .wn[hidden]{display:none}
.iu .cnt{position:absolute;top:2px;right:1px;min-width:15px;height:15px;padding:0 4px;border-radius:8px;
background:var(--acc);color:var(--on);font-size:10px;font-weight:600;line-height:15px;text-align:center}
.iu[data-edge=bottom] .bar,.iu[data-edge=top] .bar{left:8px;right:8px;width:fit-content;margin:0 auto}
.iu[data-edge=bottom] .bar{bottom:max(var(--g),env(safe-area-inset-bottom))}
.iu[data-edge=top] .bar{top:max(var(--g),env(safe-area-inset-top))}
.iu[data-edge=left] .bar,.iu[data-edge=right] .bar{top:8px;bottom:8px;height:fit-content;margin:auto 0;writing-mode:vertical-lr}
.iu[data-edge=right] .bar{writing-mode:vertical-rl}
.iu[data-edge=left] .bar>*,.iu[data-edge=right] .bar>*{writing-mode:horizontal-tb}
.iu[data-edge=left] .bar{left:max(var(--g),env(safe-area-inset-left))}
.iu[data-edge=right] .bar{right:max(var(--g),env(safe-area-inset-right))}
.iu[data-edge=left] .sep,.iu[data-edge=right] .sep{width:18px;height:1px;margin:3px 0}
.iu[data-edge=left] .grip,.iu[data-edge=right] .grip{width:var(--b);height:20px;min-width:var(--b)}
.iu[data-edge=left] .grip .ic,.iu[data-edge=right] .grip .ic{transform:rotate(90deg)}
.iu .bar.drag{transition:none;opacity:.85}
.iu.hid .bar{opacity:0;visibility:hidden;transition:opacity var(--t) ease,visibility 0s linear var(--t)}
.iu .hdl{opacity:0;visibility:hidden;color:var(--mut);transition:opacity var(--t) ease,visibility 0s linear var(--t)}
.iu.hid .hdl{opacity:.75;visibility:visible;transition:opacity var(--t) ease}
.iu .hdl i{display:block;width:30px;height:5px;border-radius:3px;background:currentColor;box-shadow:0 0 0 1px var(--solid)}
.iu[data-edge=bottom] .hdl,.iu[data-edge=top] .hdl{left:50%;width:56px;margin-left:-28px}
.iu[data-edge=bottom] .hdl{bottom:max(4px,env(safe-area-inset-bottom));align-items:flex-end;padding-bottom:4px}
.iu[data-edge=top] .hdl{top:max(4px,env(safe-area-inset-top));align-items:flex-start;padding-top:4px}
.iu[data-edge=left] .hdl,.iu[data-edge=right] .hdl{top:50%;height:56px;margin-top:-28px}
.iu[data-edge=left] .hdl i,.iu[data-edge=right] .hdl i{width:5px;height:30px}
.iu[data-edge=left] .hdl{left:max(4px,env(safe-area-inset-left));justify-content:flex-start;padding-left:4px}
.iu[data-edge=right] .hdl{right:max(4px,env(safe-area-inset-right));justify-content:flex-end;padding-right:4px}
.iu .pop{position:absolute;z-index:2;display:flex;padding:4px;gap:2px;background:var(--solid);
border:1px solid var(--line);border-radius:12px;box-shadow:var(--sh)}
.iu .menu{flex-direction:column;min-width:228px}
.iu .note{flex-direction:column;gap:2px;padding:8px 12px;width:max-content;max-width:min(300px,calc(100vw - 24px));
white-space:normal}
.iu .note .pv{color:var(--mut);font-size:12px}
.iu[data-edge=bottom] .note,.iu[data-edge=top] .note{left:0}
.iu[data-edge=left] .note,.iu[data-edge=right] .note{top:0}
.iu .menu button,.iu .tray .acts button,.iu .ban button{justify-content:flex-start;padding:0 10px;white-space:nowrap}
.iu .menu button{width:100%}
.iu .menu .warn{padding:6px 10px 4px;font-weight:600}
.iu .menu .bad{color:var(--bad)}
.iu .sel{white-space:nowrap;flex-wrap:wrap;justify-content:center;width:max-content;max-width:calc(100vw - 24px)}
.iu .sel button{padding:0 10px}
.iu[data-edge=bottom] .pop{bottom:calc(100% + 8px)}
.iu[data-edge=top] .pop{top:calc(100% + 8px)}
.iu[data-edge=bottom] .menu,.iu[data-edge=top] .menu{right:0}
.iu[data-edge=left] .pop{left:calc(100% + 8px)}
.iu[data-edge=right] .pop{right:calc(100% + 8px)}
.iu[data-edge=left] .menu,.iu[data-edge=right] .menu{bottom:0}
.iu[data-edge=bottom] .sel,.iu[data-edge=top] .sel{left:50%;transform:translateX(-50%)}
.iu[data-edge=left] .sel,.iu[data-edge=right] .sel{top:0;flex-direction:column;align-items:stretch}
.iu .tray{display:flex;flex-direction:column;width:min(360px,calc(100vw - 24px));max-height:min(72vh,560px);
background:var(--solid);border:1px solid var(--line);border-radius:14px;box-shadow:var(--sh);overflow:hidden}
.iu[data-edge=bottom] .tray,.iu[data-edge=top] .tray{left:50%;transform:translateX(-50%)}
.iu[data-edge=bottom] .tray{bottom:calc(var(--b) + 36px)}
.iu[data-edge=top] .tray{top:calc(var(--b) + 36px)}
.iu[data-edge=left] .tray,.iu[data-edge=right] .tray{top:50%;transform:translateY(-50%);width:min(360px,calc(100vw - var(--b) - 48px))}
.iu[data-edge=left] .tray{left:calc(var(--b) + 36px)}
.iu[data-edge=right] .tray{right:calc(var(--b) + 36px)}
.iu .hd{display:flex;align-items:center;justify-content:space-between;padding:4px 4px 4px 14px;
border-bottom:1px solid var(--line)}
.iu h2{font-size:14px;font-weight:600}
.iu ul{flex:1 1 auto;min-height:0;list-style:none;padding:0;overflow:auto;overscroll-behavior:contain}
.iu li{display:grid;grid-template-columns:76px 1fr;gap:12px;padding:12px 14px}
.iu li+li{border-top:1px solid var(--line)}
.iu li[data-on]{background:var(--act)}
.iu .pic{position:relative;width:76px;height:56px;border-radius:8px;background:var(--hov);overflow:hidden}
.iu .pic img,.iu .pic svg{position:absolute;inset:0;width:100%;height:100%;display:block}
.iu .pic img{object-fit:cover;opacity:.55}
.iu .pic svg{padding:4px}
.iu .q{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-style:italic;
user-select:text;-webkit-user-select:text}
.iu .meta{margin-top:3px;color:var(--mut);font-size:12px}
.iu .lnk{display:block;margin-top:3px;color:var(--acc);font-size:12px;text-decoration:underline;word-break:break-all;
user-select:text;-webkit-user-select:text;cursor:pointer}
.iu .lnk:focus-visible{outline:2px solid var(--focus);outline-offset:1px;border-radius:2px}
.iu .acts{display:flex;gap:6px;margin-top:8px}
.iu .acts button{border:1px solid var(--line);border-radius:8px;padding:0 12px}
.iu .acts .pri,.iu .ban .pri{background:var(--pri);color:var(--on-pri);border-color:transparent}
@media (hover:hover){.iu .acts .pri:hover,.iu .ban .pri:hover{background:var(--pri);filter:brightness(1.15)}}
.iu .empty{padding:18px 14px;color:var(--mut)}
.iu .sub{padding:8px 14px 0;color:var(--mut);font-size:12px;border-top:1px solid var(--line)}
.iu ul.held{flex:0 1 auto}
.iu .ban{left:50%;transform:translateX(-50%);top:max(var(--g),env(safe-area-inset-top));display:flex;align-items:center;
gap:10px;padding:4px 4px 4px 16px;max-width:calc(100vw - 24px);background:var(--solid);border:1px solid var(--line);
border-radius:999px;box-shadow:var(--sh);font-weight:500}
.iu[data-edge=top] .ban{top:auto;bottom:max(var(--g),env(safe-area-inset-bottom))}
.iu .ban button{border-radius:999px;padding:0 14px}
@media (prefers-reduced-motion:reduce){.iu,.iu *{--t:0s;transition:none!important;animation:none!important}}
.iu-room{all:initial;display:block;position:absolute;left:0;width:1px;visibility:hidden;pointer-events:none}
.iu-room[hidden]{display:none}
@media print{.iu-room{display:none}}
`;
