/**
 * The docs page sheet. `inline` bounds the page's height for a chat message
 * and scrolls its body; `full` makes the article a growing column whose body
 * scrolls in the remaining height of its container. The prose keeps a
 * readable measure.
 */
import { tokens as t } from "../tokens";

export const docsPageCss = `
.sui-docs-page-view { margin:0; min-width:0; width:100%; display:flex; flex-direction:column; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; overflow:hidden; }
.sui-docs-page-view[data-size='full'] { flex:1 1 auto; height:100%; min-height:0; }
.sui-docs-page-bar { flex:none; display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:6px 8px 6px 14px; border-bottom:1px solid ${t.border}; }
.sui-docs-page-origin { min-width:0; flex:1; color:${t.mutedForeground}; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; overflow-wrap:anywhere; }
.sui-docs-page-actions { flex:none; display:flex; align-items:center; gap:4px; }
.sui-docs-page-body { min-width:0; overflow:auto; padding:16px 20px 20px; }
.sui-docs-page-body > * { max-width:72ch; }
.sui-docs-page-view[data-size='inline'] .sui-docs-page-body { max-height:28rem; }
.sui-docs-page-view[data-size='full'] .sui-docs-page-body { flex:1 1 auto; min-height:0; }
.sui-docs-page-title { margin:0 0 12px; color:${t.foreground}; font-family:${t.fontSans}; font-size:1.25rem; font-weight:650; line-height:1.3; overflow-wrap:anywhere; }
.sui-docs-page-truncated { margin:12px 0 0; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
`;
