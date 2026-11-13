import { tokens as t } from "../tokens.ts";

/**
 * workflow-canvas lane CSS fragment. Renderer-neutral canvas anatomy styles,
 * all `sui-canvas-*` namespaced and colored only through the tokens bridge
 * (`var(--house-token, lightFallback)` / `color-mix(in srgb, ...)`). Composed
 * into `smithersUiCss`, which every canvas component injects.
 */
export const WORKFLOW_CANVAS_CSS_ID = "workflow-canvas";

export const canvasCss = `
.sui-canvas { position:relative; width:100%; height:100%; min-height:240px; overflow:hidden; background:${t.surface2}; border-radius:${t.radius}; }
.sui-canvas-node { display:grid; gap:6px; align-content:center; box-sizing:border-box; min-width:180px; padding:12px 14px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.card}; box-shadow:0 8px 18px rgb(${t.shadowRgb} / 0.08); }
.sui-canvas-node[data-selected='true'] { border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring}, 0 8px 18px rgb(${t.shadowRgb} / 0.08); }
.sui-canvas-node-header { display:flex; align-items:center; gap:6px; min-width:0; }
.sui-canvas-node-kind { flex:none; text-transform:uppercase; }
.sui-canvas-node-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:650; color:${t.foreground}; }
.sui-canvas-node-status { margin-left:auto; flex:none; }
.sui-canvas-node-content { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-canvas-edge { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border:1px solid ${t.border}; border-radius:${t.radiusFull}; background:${t.card}; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-canvas-edge-glyph { display:inline-flex; align-items:center; justify-content:center; width:12px; height:12px; flex:none; font-size:10px; line-height:1; color:${t.mutedForeground}; }
.sui-canvas-edge[data-status-class='run'] .sui-canvas-edge-glyph { color:${t.primary}; }
.sui-canvas-edge[data-status-class='ok'] .sui-canvas-edge-glyph { color:${t.success}; }
.sui-canvas-edge[data-status-class='warn'] .sui-canvas-edge-glyph { color:${t.warning}; }
.sui-canvas-edge[data-status-class='bad'] .sui-canvas-edge-glyph { color:${t.destructive}; }
.sui-canvas-edge-arrow { color:${t.textFaint}; }
.sui-canvas-edge-label { color:${t.foreground}; }
.sui-canvas-connection { display:inline-block; width:48px; border-top:2px dashed ${t.borderStrong}; }
.sui-canvas-connection[data-status='valid'] { border-top-style:solid; border-top-color:${t.success}; }
.sui-canvas-connection[data-status='invalid'] { border-top-color:${t.destructive}; }
.sui-canvas-connection[data-status='pending'] { border-top-color:${t.primary}; }
.sui-canvas-controls { display:flex; flex-direction:column; gap:2px; width:max-content; padding:4px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.card}; box-shadow:0 2px 8px rgb(${t.shadowRgb} / 0.08); }
.sui-canvas-controls-button { display:flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:0; border-radius:${t.radiusControl}; background:transparent; color:${t.foreground}; font-size:18px; line-height:1; cursor:pointer; }
.sui-canvas-controls-button:hover { background:${t.secondary}; }
.sui-canvas-controls-button:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-canvas-panel { position:absolute; z-index:5; display:flex; gap:8px; margin:12px; max-width:calc(100% - 24px); }
.sui-canvas-panel[data-position='top-left'] { top:0; left:0; }
.sui-canvas-panel[data-position='top-right'] { top:0; right:0; }
.sui-canvas-panel[data-position='bottom-left'] { bottom:0; left:0; }
.sui-canvas-panel[data-position='bottom-right'] { bottom:0; right:0; }
.sui-canvas-toolbar { display:flex; align-items:center; gap:4px; width:max-content; padding:4px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.card}; }
.sui-canvas-minimap { box-sizing:border-box; width:160px; height:100px; overflow:hidden; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.card}; box-shadow:0 2px 8px rgb(${t.shadowRgb} / 0.08); }
`;
