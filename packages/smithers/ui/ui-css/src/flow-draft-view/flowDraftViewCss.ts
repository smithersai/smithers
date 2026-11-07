/** The flow-draft card's sheet: key-value rows, questions with their default, the files and the check chips. */
import { tokens as t } from "../tokens";

export const flowDraftViewCss = `
.sui-flow-draft { min-width:0; }
.sui-flow-draft-header { display:flex; flex-direction:row; align-items:center; justify-content:space-between; gap:8px; }
.sui-flow-draft-status { color:${t.mutedForeground}; font-size:13px; font-variant-numeric:tabular-nums; }
.sui-flow-draft-status[data-status='needs_you'] { color:${t.warning}; font-weight:650; }
.sui-flow-draft-status[data-status='failed'] { color:${t.destructive}; font-weight:650; }
.sui-flow-draft-status[data-status='ready'], .sui-flow-draft-status[data-status='saved'], .sui-flow-draft-status[data-status='proposed'] { color:${t.success}; }
.sui-flow-draft-body { display:flex; flex-direction:column; gap:10px; min-width:0; }
.sui-flow-draft-fields { display:grid; gap:10px; min-width:0; margin:0; }
.sui-flow-draft-hint { color:${t.destructive}; font-size:${t.fontSizeCompact}; }
.sui-flow-draft-row { display:flex; gap:8px; min-width:0; font-size:13px; }
.sui-flow-draft-key { flex:none; width:4rem; color:${t.mutedForeground}; }
.sui-flow-draft-where, .sui-flow-draft-name { font-weight:650; overflow-wrap:anywhere; }
.sui-flow-draft-request { overflow-wrap:anywhere; white-space:pre-wrap; }
.sui-flow-draft-questions, .sui-flow-draft-checks { display:flex; flex-direction:column; gap:6px; margin:0; padding:0; list-style:none; }
.sui-flow-draft-question { display:grid; grid-template-columns:minmax(0, 1fr) minmax(8rem, 14rem) auto; align-items:center; gap:8px; font-size:13px; }
.sui-flow-draft-question-text { overflow-wrap:anywhere; }
.sui-flow-draft-tag { color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-flow-draft-tag[data-tone='needs_you'] { color:${t.warning}; font-weight:650; }
.sui-flow-draft-file { border:1px solid ${t.border}; border-radius:${t.radiusControl}; }
.sui-flow-draft-file-path { padding:4px 8px; cursor:pointer; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; }
.sui-flow-draft-file-path:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; border-radius:${t.radiusControl}; }
.sui-flow-draft-file-text { margin:0; padding:8px; max-height:24rem; overflow:auto; border-top:1px solid ${t.border}; background:${t.codeBg}; color:${t.codeText}; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; white-space:pre-wrap; overflow-wrap:anywhere; }
.sui-flow-draft-checks { flex-direction:row; flex-wrap:wrap; }
.sui-flow-draft-check { padding:0 8px; border-radius:${t.radiusFull}; background:${t.successSoft}; color:${t.success}; font-size:${t.fontSizeCompact}; line-height:22px; }
.sui-flow-draft-check[data-ok='false'] { background:${t.destructiveSoft}; color:${t.destructive}; }
.sui-flow-draft-failure { margin:0; color:${t.destructive}; font-size:13px; }
.sui-flow-draft-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
@media (max-width:960px) { .sui-flow-draft-file-path { min-height:${t.controlHeight}; box-sizing:border-box; } }
@media (max-width: 640px) { .sui-flow-draft-question { grid-template-columns:1fr; } }
`;
