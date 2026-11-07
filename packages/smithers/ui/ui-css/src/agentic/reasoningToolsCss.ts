import { tokens as t } from "../tokens";

export const REASONING_TOOLS_CSS_ID = "reasoning-tools";

/**
 * Lane-owned fragment for the reasoning-tools compound additions. Every rule
 * extends an existing canonical prefix (sui-reasoning*, sui-cot*,
 * sui-toolcall*, sui-codeblock*) and resolves color only through the tokens
 * bridge. The shimmer keyframes (`sui-shimmer-sweep`) are owned by uiCss,
 * which composes this fragment and which every component injects.
 */
export const reasoningToolsCss = `
.sui-reasoning-summary { min-width:0; display:grid; gap:4px; }
.sui-reasoning-summary-label { color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-reasoning-summary-label[data-streaming='true'] { background:linear-gradient(90deg, ${t.mutedForeground} 35%, ${t.foreground} 50%, ${t.mutedForeground} 65%); background-size:200% 100%; background-clip:text; -webkit-background-clip:text; color:transparent; animation:sui-shimmer-sweep 2s linear infinite; }
.sui-reasoning-summary-text { min-width:0; color:${t.mutedForeground}; font-size:13px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }

.sui-cot-step-trigger { grid-column:2; min-width:0; display:flex; align-items:center; gap:6px; padding:0; border:0; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; border-radius:${t.radiusControl}; }
.sui-cot-step-trigger:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-cot-step-icon { flex:none; display:inline-flex; align-items:center; color:${t.mutedForeground}; }

.sui-toolcall-duration { flex:none; color:${t.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-toolcall-header .sui-toolcall-trigger { width:100%; }
.sui-toolcall-section-title[data-shimmer='true'] { background:linear-gradient(90deg, ${t.mutedForeground} 35%, ${t.foreground} 50%, ${t.mutedForeground} 65%); background-size:200% 100%; background-clip:text; -webkit-background-clip:text; color:transparent; animation:sui-shimmer-sweep 2s linear infinite; }
.sui-toolcall-pre[data-partial='true'] { opacity:.72; }
.sui-toolcall-part { min-width:0; }
.sui-toolcall-part-image { display:block; max-width:100%; height:auto; border:1px solid ${t.borderStrong}; border-radius:${t.radiusControl}; }
.sui-toolcall-error-box { min-width:0; padding:10px 12px; border:1px solid ${t.destructiveBorder}; border-radius:${t.radiusControl}; background:${t.destructiveSoft}; color:${t.destructive}; font-size:12px; line-height:1.5; overflow-wrap:anywhere; }

.sui-codeblock-group { margin:8px 0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; overflow:hidden; }
.sui-codeblock-group .sui-codeblock { margin:0; border-radius:0; }
.sui-codeblock-group-header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 8px; border-bottom:1px solid ${t.border}; background:${t.surface2}; }
.sui-codeblock-filename { display:inline-flex; align-items:center; gap:6px; min-width:0; font-family:${t.fontMono}; font-size:11px; color:${t.mutedForeground}; }
.sui-codeblock-tabs { display:inline-flex; align-items:center; gap:2px; min-width:0; }
.sui-codeblock-tab { min-height:24px; padding:0 8px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:11px; font-family:${t.fontMono}; cursor:pointer; }
.sui-codeblock-tab:hover { background:${t.hoverSubtle}; color:${t.foreground}; }
.sui-codeblock-tab:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-codeblock-tab[aria-selected='true'] { border-color:${t.borderStrong}; background:${t.card}; color:${t.foreground}; }
`;
