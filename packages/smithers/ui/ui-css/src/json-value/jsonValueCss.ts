/** The value disclosure's sheet: a quiet summary row and a scrolling monospace body. */
import { tokens as t } from "../tokens";

export const jsonValueCss = `
.sui-json-value { min-width:0; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.card}; }
.sui-json-value-summary { display:flex; align-items:center; gap:8px; padding:4px 8px; cursor:pointer; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; list-style-position:inside; }
.sui-json-value-summary:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; border-radius:${t.radiusControl}; }
@media (max-width:960px) { .sui-json-value-summary { min-height:${t.controlHeight}; box-sizing:border-box; } }
.sui-json-value-label { font-weight:650; color:${t.foreground}; }
.sui-json-value-size { font-variant-numeric:tabular-nums; }
.sui-json-value-clipped { padding:0 6px; border-radius:${t.radiusFull}; background:${t.warningSoft}; color:${t.warning}; font-weight:650; }
.sui-json-value-text { margin:0; padding:8px; max-height:24rem; overflow:auto; border-top:1px solid ${t.border}; background:${t.codeBg}; color:${t.codeText}; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; white-space:pre-wrap; overflow-wrap:anywhere; }
`;
