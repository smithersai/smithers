/**
 * The issue page's sheet: `ItemConversation` (header, body, timeline,
 * comments, composer, side column) and `IssueForm`. Posts are cards on the
 * house border; a requested comment's border is dashed and a not-sent one's
 * is danger, so a pending write reads at a glance in both themes. Timeline
 * events hang off a thin rail as GitHub's do. With a side column the page is
 * two columns from 768 pixels, the column 256 pixels wide; narrower, it
 * stacks under the main column.
 */
import { tokens as t } from "../tokens";

export const itemConversationCss = `
.sui-item-conv { min-width:0; display:grid; align-content:start; gap:14px; color:${t.foreground}; }
.sui-item-conv-main { min-width:0; display:grid; align-content:start; gap:14px; }
@media (min-width:768px) {
  .sui-item-conv[data-aside] { grid-template-columns:minmax(0, 1fr) 256px; column-gap:24px; }
  .sui-item-conv[data-aside] > .sui-item-conv-header { grid-column:1 / -1; }
}
.sui-item-conv-aside { min-width:0; display:grid; align-content:start; justify-items:start; gap:10px; }
.sui-item-aside-section { justify-self:stretch; min-width:0; display:grid; justify-items:start; gap:6px; padding-bottom:10px; border-bottom:1px solid ${t.border}; font-size:${t.fontSizeCompact}; }
.sui-item-aside-section:last-child { padding-bottom:0; border-bottom:none; }
.sui-item-aside-title { color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; font-weight:650; }
.sui-item-aside-link { min-width:0; color:${t.primary}; font-family:${t.fontMono}; text-decoration:none; border-radius:${t.radiusControl}; overflow-wrap:anywhere; }
.sui-item-aside-link:hover { color:${t.primary}; text-decoration:underline; text-underline-offset:3px; }
.sui-item-aside-link:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-item-conv-events { position:relative; margin:0; padding:0 0 0 14px; list-style:none; display:grid; gap:10px; }
.sui-item-conv-events::before { content:""; position:absolute; top:0; bottom:0; left:24px; width:2px; background:${t.border}; }
.sui-item-conv-event { position:relative; min-width:0; display:flex; align-items:center; gap:8px; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
/* An event's time keeps the event's line: the text shrinks and wraps within itself. */
.sui-item-conv-event > :last-child:not(.sui-item-conv-event-text) { flex:none; }
.sui-item-conv-event-icon { flex:none; display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:${t.radiusFull}; background:${t.surface2}; }
.sui-item-conv-event-text { min-width:0; overflow-wrap:anywhere; }
.sui-item-conv-header { min-width:0; display:grid; gap:8px; padding-bottom:12px; border-bottom:1px solid ${t.border}; }
.sui-item-conv-title { margin:0; min-width:0; color:${t.foreground}; font-size:20px; font-weight:650; line-height:1.3; overflow-wrap:anywhere; }
.sui-item-conv-number { color:${t.mutedForeground}; font-weight:400; }
.sui-item-conv-meta, .sui-item-conv-comment-meta { min-width:0; display:flex; flex-wrap:wrap; align-items:center; gap:8px; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-item-conv-state { flex:none; }
.sui-item-conv-state .sui-state-icon { color:currentColor; width:14px; height:14px; }
.sui-item-conv-pending { min-height:18px; padding:0 6px; font-size:11px; }
.sui-item-conv-author { color:${t.foreground}; font-weight:650; overflow-wrap:anywhere; }
.sui-item-conv-reason { color:${t.destructive}; }
.sui-item-conv-external { margin-left:auto; color:${t.primary}; text-decoration:none; border-radius:${t.radiusControl}; }
.sui-item-conv-external:hover { text-decoration:underline; text-underline-offset:3px; }
.sui-item-conv-external:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
@media (max-width:960px) {
  .sui-item-aside-link { display:inline-flex; align-items:center; min-width:32px; min-height:${t.controlHeight}; max-width:100%; }
  .sui-item-conv-external { display:inline-flex; align-items:center; min-width:32px; min-height:${t.controlHeight}; }
}
.sui-item-conv-header-actions { margin-left:auto; display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.sui-item-conv-external + .sui-item-conv-header-actions { margin-left:0; }
.sui-item-conv-post, .sui-item-conv-comment { min-width:0; display:grid; gap:8px; padding:12px 14px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; }
.sui-item-conv-comments { margin:0; padding:0; list-style:none; display:grid; gap:10px; }
.sui-item-conv-comment[data-pending='requested'] { border-style:dashed; border-color:${t.borderStrong}; }
.sui-item-conv-comment[data-pending='not_sent'] { border-color:${t.destructiveBorder}; }
.sui-item-conv-comment-actions { display:flex; flex-wrap:wrap; gap:6px; }
.sui-item-conv-composer { min-width:0; display:grid; gap:8px; }
.sui-item-conv-composer-actions, .sui-issue-form-actions { display:flex; justify-content:flex-end; gap:6px; }
.sui-item-conv-loading { display:grid; gap:10px; }
.sui-item-conv-skeleton-title { width:min(100%, 420px); height:24px; }
.sui-item-conv-skeleton-body { height:64px; }
.sui-issue-form { min-width:0; display:grid; gap:14px; }
.sui-issue-form-error { margin:0; color:${t.destructive}; font-size:${t.fontSizeCompact}; }
`;
