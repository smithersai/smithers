import { tokens as t } from "../tokens.ts";

export const SANDBOX_CSS_ID = "sandbox-previews";

export const sandboxCss = `
.sui-sandbox { border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; overflow:hidden; }
.sui-sandbox-trigger { display:flex; align-items:center; gap:6px; width:100%; padding:8px 10px; border:0; background:transparent; color:${t.foreground}; font:inherit; font-size:${t.fontSizeCompact}; font-weight:650; cursor:pointer; text-align:left; }
.sui-sandbox-trigger:hover { background:${t.hoverSubtle}; }
.sui-sandbox-trigger:focus-visible { outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring}; }
.sui-sandbox-chevron { display:inline-block; transition:transform 120ms ease; color:${t.mutedForeground}; }
.sui-sandbox[data-state='open'] > .sui-sandbox-trigger .sui-sandbox-chevron { transform:rotate(90deg); }
.sui-sandbox-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 10px; border-top:1px solid ${t.border}; font-size:${t.fontSizeCompact}; }
.sui-sandbox-identity { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; flex:1; }
.sui-sandbox-workspace, .sui-sandbox-repository { display:inline-flex; align-items:center; gap:4px; color:${t.mutedForeground}; font-family:${t.fontMono}; }
.sui-sandbox-repository { color:${t.foreground}; }
.sui-sandbox-actions { display:flex; align-items:center; gap:6px; padding:6px 10px; border-top:1px solid ${t.border}; }
.sui-sandbox-action { display:inline-flex; align-items:center; gap:4px; min-height:${t.controlHeight}; padding:0 10px; border:1px solid ${t.input}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font:inherit; font-size:${t.fontSizeCompact}; cursor:pointer; }
.sui-sandbox-action:hover { background:${t.secondary}; }
.sui-sandbox-action:focus-visible { outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring}; }
.sui-sandbox-content { border-top:1px solid ${t.border}; padding:8px 10px; }
.sui-webpreview { display:flex; flex-direction:column; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; overflow:hidden; }
.sui-webpreview-toolbar { display:flex; align-items:center; gap:4px; padding:6px 8px; border-bottom:1px solid ${t.border}; }
.sui-webpreview-toolbar-button { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border:0; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; cursor:pointer; }
.sui-webpreview-toolbar-button:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-webpreview-toolbar-button:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-webpreview-address { flex:1; min-width:0; }
.sui-webpreview-address-row { display:flex; flex-direction:column; gap:2px; flex:1; min-width:0; }
.sui-webpreview-address-error { color:${t.destructive}; font-size:${t.fontSizeCompact}; }
.sui-webpreview-content { position:relative; min-height:120px; background:${t.surface2}; }
.sui-webpreview-frame { display:block; width:100%; height:100%; min-height:120px; border:0; background:${t.card}; }
.sui-webpreview-loading { position:absolute; inset:0; z-index:1; }
.sui-jsxpreview { border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; overflow:hidden; }
.sui-jsxpreview-frame { padding:8px 10px; }
`;
