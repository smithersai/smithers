/**
 * The run page's sheet: the header line, the run list, the step tree, the
 * step detail, the timeline and the journal. Waiting is quiet, failures are
 * ember (`--danger`), live work is brand and holds still: the house loading
 * pattern never pulses a glyph.
 */
import { tokens as t } from "../tokens";

export const runPageCss = `
.sui-run-status-glyph { flex:none; font-size:11px; line-height:1; }
.sui-run-header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 12px; min-width:0; }
.sui-run-header-line { display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-width:0; color:${t.mutedForeground}; font-size:13px; }
.sui-run-header-title { margin:0; color:${t.foreground}; font-size:16px; font-weight:650; overflow-wrap:anywhere; }
.sui-run-header-elapsed { font-variant-numeric:tabular-nums; }
.sui-run-header-actions { display:flex; flex-wrap:wrap; gap:6px; }
.sui-run-list { min-width:0; }
.sui-run-list-flow { font-weight:650; overflow-wrap:anywhere; }
.sui-run-list-flow a { color:${t.foreground}; text-decoration:none; }
.sui-run-list-flow a:hover { text-decoration:underline; }
.sui-run-list-flow a:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; border-radius:${t.radiusControl}; }
@media (max-width:960px) {
  .sui-run-list-flow a { display:inline-flex; align-items:center; min-height:${t.controlHeight}; min-width:32px; }
}
.sui-run-list-time { color:${t.mutedForeground}; font-variant-numeric:tabular-nums; white-space:nowrap; }
.sui-run-list-toggle { width:28px; padding-right:0; }
.sui-run-list-toggle a { display:inline-flex; align-items:center; justify-content:center; min-width:24px; min-height:24px; color:${t.mutedForeground}; text-decoration:none; border-radius:${t.radiusControl}; }
.sui-run-list-toggle a:hover { color:${t.foreground}; background:${t.hoverSubtle}; }
.sui-run-list-toggle a:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-run-list-chevron { font-size:16px; line-height:1; }
@media (max-width:960px) { .sui-run-list-toggle a { min-width:${t.controlHeight}; min-height:${t.controlHeight}; } }
.sui-run-list-where { margin-left:6px; vertical-align:middle; font-weight:500; }
.sui-run-list-meta { color:${t.mutedForeground}; font-size:13px; max-width:16rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-run-list-branch { font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; }
.sui-run-list-details > td { padding:0 8px 12px 36px; background:${t.hoverSubtle}; }
.sui-run-details { display:flex; flex-direction:column; gap:10px; min-width:0; padding-top:8px; }
.sui-run-details-job { display:flex; flex-direction:column; gap:2px; min-width:0; }
.sui-run-details-job-head { display:flex; align-items:center; gap:8px; min-width:0; font-size:13px; font-weight:650; }
.sui-run-details-job-head a { color:${t.foreground}; text-decoration:none; }
.sui-run-details-job-head a:hover { text-decoration:underline; }
.sui-run-details-step { min-width:0; border-radius:${t.radiusControl}; }
.sui-run-details-step > summary { display:flex; align-items:center; gap:8px; min-width:0; padding:4px 8px; cursor:pointer; list-style:none; font-size:13px; border-radius:${t.radiusControl}; }
.sui-run-details-step > summary::-webkit-details-marker { display:none; }
.sui-run-details-step > summary:hover { background:${t.background}; }
.sui-run-details-step > summary:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-run-details-step > summary::before { content:'▸'; flex:none; width:10px; color:${t.mutedForeground}; font-size:10px; }
.sui-run-details-step[open] > summary::before { content:'▾'; }
.sui-run-details-glyph { flex:none; width:12px; text-align:center; font-size:11px; color:${t.mutedForeground}; }
.sui-run-details-step[data-state='completed'] .sui-run-details-glyph, .sui-run-details-job[data-state='completed'] .sui-run-details-glyph { color:${t.success}; }
.sui-run-details-step[data-state='failed'] .sui-run-details-glyph, .sui-run-details-job[data-state='failed'] .sui-run-details-glyph { color:${t.destructive}; }
.sui-run-details-step[data-state='running'] .sui-run-details-glyph, .sui-run-details-job[data-state='running'] .sui-run-details-glyph { color:${t.primary}; }
.sui-run-details-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-run-details-duration { flex:none; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; font-variant-numeric:tabular-nums; }
.sui-run-details-body { display:flex; flex-direction:column; gap:4px; min-width:0; padding:2px 8px 8px 30px; }
.sui-run-details-error { margin:0; color:${t.destructive}; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; overflow-wrap:anywhere; }
.sui-run-details-empty { margin:0; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-span-tree { display:flex; flex-direction:column; min-width:0; }
.sui-span-tree-row { display:flex; align-items:center; gap:8px; min-width:0; padding:4px 8px 4px calc(8px + var(--sui-span-depth, 0) * 14px); border-radius:${t.radiusControl}; cursor:pointer; font-size:13px; }
.sui-span-tree-row:hover { background:${t.hoverSubtle}; }
.sui-span-tree-row:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-span-tree-row[aria-selected='true'] { background:${t.primarySoft}; }
.sui-span-tree-glyph { flex:none; width:12px; text-align:center; font-size:11px; color:${t.mutedForeground}; }
.sui-span-tree-row[data-state='completed'] .sui-span-tree-glyph { color:${t.success}; }
.sui-span-tree-row[data-state='failed'] .sui-span-tree-glyph { color:${t.destructive}; }
.sui-span-tree-row[data-state='running'] .sui-span-tree-glyph { color:${t.primary}; }
.sui-span-tree-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-span-tree-attempts { flex:none; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-span-tree-attempts[data-failed='true'] { color:${t.destructive}; }
.sui-span-tree-duration { flex:none; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; font-variant-numeric:tabular-nums; }
.sui-span-detail { display:flex; flex-direction:column; gap:8px; min-width:0; }
.sui-span-detail-header { display:flex; align-items:center; gap:8px; min-width:0; }
.sui-span-detail-label { margin:0; font-size:15px; font-weight:650; overflow-wrap:anywhere; }
.sui-span-detail-word { color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-span-detail[data-state='failed'] .sui-span-detail-glyph { color:${t.destructive}; }
.sui-span-detail[data-state='completed'] .sui-span-detail-glyph { color:${t.success}; }
.sui-span-detail-wait, .sui-span-detail-attempts { margin:0; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; font-variant-numeric:tabular-nums; }
.sui-span-detail-actions { display:flex; flex-wrap:wrap; gap:6px; }
.sui-waterfall { display:flex; flex-direction:column; gap:2px; min-width:0; }
.sui-waterfall-row { display:grid; grid-template-columns:minmax(6rem, 12rem) 1fr; align-items:center; gap:8px; min-width:0; font-size:${t.fontSizeCompact}; }
.sui-waterfall-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${t.mutedForeground}; }
.sui-waterfall-row[data-selected='true'] .sui-waterfall-label { color:${t.foreground}; font-weight:650; }
.sui-waterfall-track { position:relative; display:block; height:14px; min-width:0; margin:0; padding:0; border:0; border-radius:${t.radiusControl}; background:${t.hoverSubtle}; font:inherit; }
button.sui-waterfall-track { cursor:pointer; }
@media (max-width:960px) { button.sui-waterfall-track { min-height:${t.controlHeight}; } }
button.sui-waterfall-track:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-waterfall-bar { position:absolute; top:3px; bottom:3px; min-width:2px; border-radius:${t.radiusFull}; background:${t.mutedForeground}; }
.sui-waterfall-row[data-state='completed'] .sui-waterfall-bar { background:${t.success}; }
.sui-waterfall-row[data-state='failed'] .sui-waterfall-bar { background:${t.destructive}; }
.sui-waterfall-row[data-state='running'] .sui-waterfall-bar { background:${t.primary}; }
.sui-waterfall-bar[data-open='true'] { opacity:.6; }
.sui-waterfall-bar[data-instant='true'] { width:8px; min-width:0; margin-left:-4px; transform:rotate(45deg); border-radius:2px; top:3px; bottom:auto; height:8px; }
.sui-run-journal { display:flex; flex-direction:column; gap:8px; min-width:0; }
.sui-run-journal-seq, .sui-run-journal-time { color:${t.mutedForeground}; font-variant-numeric:tabular-nums; white-space:nowrap; }
.sui-run-journal-type { font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; overflow-wrap:anywhere; }
.sui-run-journal-more { align-self:flex-start; }
`;
