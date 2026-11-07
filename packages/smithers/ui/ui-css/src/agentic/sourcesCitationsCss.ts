import { tokens as t } from "../tokens";

export const SOURCES_CITATIONS_CSS_ID = "sources-citations";

const focusRing = `outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring};`;

/**
 * Lane-owned fragment for the sources-citations components. Extends the
 * canonical `sui-sources*` / `sui-citation*` prefixes already shipped in
 * uiCss and adds the frozen `sui-suggestion*` / `sui-open-in-chat` prefixes.
 */
export const sourcesCitationsCss: string = `
.sui-sources-content { display:grid; gap:6px; margin:4px 0 0; padding:8px 8px 8px 28px; border-left:1px solid ${t.border}; list-style:decimal; }
.sui-sources-rich { display:flex; align-items:flex-start; gap:6px; text-decoration:none; color:${t.foreground}; }
.sui-sources-rich:hover { text-decoration:none; }
.sui-sources-favicon { width:16px; height:16px; flex:none; margin-top:1px; border-radius:4px; }
.sui-sources-favicon-fallback { width:16px; height:16px; flex:none; margin-top:1px; display:inline-flex; align-items:center; justify-content:center; border-radius:4px; background:${t.secondary}; color:${t.mutedForeground}; font-size:10px; font-weight:650; text-transform:uppercase; }
.sui-sources-body { min-width:0; display:grid; gap:1px; }
.sui-sources-title { color:${t.primary}; overflow-wrap:anywhere; }
.sui-sources-domain { color:${t.textFaint}; font-size:11px; overflow-wrap:anywhere; }
.sui-sources-excerpt { color:${t.mutedForeground}; font-size:11px; overflow-wrap:anywhere; }
.sui-citation-content { display:block; margin:4px 0; padding:8px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font-size:12px; font-weight:400; line-height:1.4; }
.sui-citation-card { min-width:0; display:grid; gap:6px; }
.sui-citation-card-header { display:flex; align-items:center; gap:6px; min-width:0; }
.sui-citation-favicon { width:16px; height:16px; flex:none; border-radius:4px; }
.sui-citation-favicon-fallback { width:16px; height:16px; flex:none; display:inline-flex; align-items:center; justify-content:center; border-radius:4px; background:${t.secondary}; color:${t.mutedForeground}; font-size:10px; font-weight:650; text-transform:uppercase; }
.sui-citation-card-title { min-width:0; font-weight:650; color:${t.foreground}; overflow-wrap:anywhere; }
.sui-citation-card-link { color:${t.primary}; text-decoration:underline; text-underline-offset:2px; overflow-wrap:anywhere; }
.sui-citation-card-link:hover { text-decoration-thickness:2px; }
.sui-citation-card-link:focus-visible { ${focusRing} }
.sui-citation-card-domain { flex:none; color:${t.textFaint}; font-size:11px; overflow-wrap:anywhere; }
.sui-citation-card-excerpt { color:${t.mutedForeground}; overflow-wrap:anywhere; }
.sui-citation-carousel { display:grid; gap:6px; }
.sui-citation-carousel-nav { display:flex; align-items:center; gap:6px; }
.sui-citation-carousel-button { min-width:24px; min-height:24px; display:inline-flex; align-items:center; justify-content:center; padding:2px 6px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:12px; line-height:1; cursor:pointer; }
.sui-citation-carousel-button:hover:not(:disabled) { background:${t.secondary}; color:${t.foreground}; }
.sui-citation-carousel-button:focus-visible { ${focusRing} }
.sui-citation-carousel-button:disabled { opacity:0.5; cursor:default; }
.sui-citation-carousel-index { color:${t.mutedForeground}; font-size:11px; }
.sui-citation-quote { margin:0; padding:4px 8px; border-left:2px solid ${t.borderStrong}; color:${t.mutedForeground}; font-style:italic; }
.sui-citation-quote p { margin:0; }
.sui-citation-quote cite { display:block; margin-top:2px; color:${t.textFaint}; font-size:11px; font-style:normal; }
.sui-suggestion-group { display:flex; gap:6px; overflow-x:auto; padding:2px; scrollbar-width:thin; }
.sui-suggestion { flex:none; min-height:28px; display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border:1px solid ${t.input}; border-radius:${t.radiusFull}; background:${t.card}; color:${t.mutedForeground}; font:inherit; font-size:12px; white-space:nowrap; cursor:pointer; }
.sui-suggestion:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-suggestion:focus-visible { ${focusRing} }
.sui-open-in-chat { min-height:28px; display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:12px; cursor:pointer; }
.sui-open-in-chat:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-open-in-chat:focus-visible { ${focusRing} }
.sui-open-in-chat-icon { display:inline-flex; width:14px; height:14px; flex:none; }
.sui-open-in-chat-icon svg { width:14px; height:14px; }
`;
