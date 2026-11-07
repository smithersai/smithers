/**
 * The `issues` template's sheet, after GitHub's lists. `inline` bounds the
 * list's height and lets it scroll; `full` lets it grow with the page. A row
 * leads with its state icon, colored for its kind; a linked title takes the
 * brand on hover and the house ring on focus; a pending or triage chip is a
 * compact badge. The Open and Closed tabs read as GitHub's: the current one
 * in the foreground, the other muted.
 */
import { tokens as t } from "../tokens";

export const issuesViewCss = `
.sui-issues-view { min-width:0; display:grid; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; }
.sui-issues-header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; min-height:48px; padding:8px 14px; border-bottom:1px solid ${t.border}; border-radius:${t.radius} ${t.radius} 0 0; background:${t.surface2}; font-size:13px; }
.sui-issues-repo { min-width:0; margin-right:auto; font-weight:650; overflow-wrap:anywhere; }
.sui-issues-counts { flex:none; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-issues-actions { flex:none; display:flex; align-items:center; gap:6px; }
.sui-issues-filters { min-width:0; margin-right:auto; display:flex; align-items:center; gap:14px; }
.sui-issues-filter { display:inline-flex; align-items:center; gap:6px; border-radius:${t.radiusControl}; color:${t.mutedForeground}; font-weight:650; text-decoration:none; }
.sui-issues-filter:hover { color:${t.foreground}; }
.sui-issues-filter[aria-current='page'] { color:${t.foreground}; }
.sui-issues-filter:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-issues-filter .sui-state-icon { color:currentColor; }
.sui-issues-filter-count { font-variant-numeric:tabular-nums; }
@media (max-width:960px) {
  .sui-issues-filter { min-height:${t.controlHeight}; min-width:32px; }
}
.sui-issues-loading { display:grid; gap:10px; padding:12px 14px; }
.sui-issues-skeleton { height:18px; }
.sui-issues-list { margin:0; padding:0; list-style:none; }
.sui-issues-view[data-size='inline'] .sui-issues-list { max-height:320px; overflow-y:auto; }
.sui-issues-list:focus-visible { outline:none; box-shadow:inset 0 0 0 2px ${t.ringBorder}; }
.sui-issues-row { min-width:0; display:flex; align-items:flex-start; gap:10px; padding:10px 14px; border-bottom:1px solid ${t.border}; }
.sui-issues-row:last-child { border-bottom:none; }
.sui-issues-row:hover { background:${t.hoverSubtle}; }
.sui-issues-state { flex:none; margin-top:2px; }
.sui-issues-main { min-width:0; flex:1; display:grid; gap:4px; }
.sui-issues-title-line { min-width:0; display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.sui-issues-title { min-width:0; color:${t.foreground}; font-size:15px; font-weight:650; overflow-wrap:anywhere; }
.sui-issues-link { text-decoration:none; border-radius:${t.radiusControl}; }
.sui-issues-link:hover { color:${t.primary}; }
.sui-issues-link:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-issues-pending, .sui-issues-triage { min-height:18px; padding:0 6px; font-size:11px; }
.sui-issues-meta { display:flex; flex-wrap:wrap; align-items:center; gap:8px; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-issues-number { font-variant-numeric:tabular-nums; }
.sui-issues-meta-link { color:${t.mutedForeground}; font-family:${t.fontMono}; text-decoration:none; border-radius:${t.radiusControl}; overflow-wrap:anywhere; }
.sui-issues-meta-link:hover { color:${t.primary}; text-decoration:underline; text-underline-offset:3px; }
.sui-issues-meta-link:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
@media (max-width:960px) {
  .sui-issues-link, .sui-issues-meta-link { display:inline-flex; align-items:center; min-height:${t.controlHeight}; min-width:32px; }
}
.sui-issues-comments { flex:none; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-issues-menu { margin:-4px -6px -4px 0; }
.sui-state-icon { flex:none; display:block; color:${t.mutedForeground}; }
.sui-state-icon[data-kind='open'], .sui-state-icon[data-kind='in_review'] { color:${t.success}; }
.sui-state-icon[data-kind='queued'] { color:${t.foreground}; }
.sui-state-icon[data-kind='running'], .sui-state-icon[data-kind='merged'] { color:${t.primary}; }
.sui-state-icon[data-kind='needs_you'] { color:${t.warning}; }
.sui-state-icon[data-kind='failed'] { color:${t.destructive}; }
/* Live work: one calm 2 s blink. The document-wide reduced-motion policy (reducedMotionCss) ends it at once, steady. */
.sui-state-icon[data-live] { animation:sui-state-live 2s ease-in-out infinite; }
@keyframes sui-state-live { 50% { opacity:.3; } }
`;
