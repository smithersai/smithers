/**
 * Lane CSS fragment for the approvals-checkpoints lane: Confirmation,
 * ApprovalCard, and Checkpoint families. Composed into smithersUiCss, which
 * every component in this lane injects. Obeys the css-contract: sui-
 * namespace only, no
 * :root, colors only via the tokens bridge or color-mix(in srgb, ...).
 */
import { tokens as t } from "../tokens";

export const APPROVALS_CHECKPOINTS_CSS_ID = "approvals-checkpoints";

const focusRing = `outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring};`;

export const approvalsCss = `
.sui-confirm { min-width:0; display:grid; align-content:start; gap:8px; padding:12px 14px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; font-size:13px; }
.sui-confirm[data-state='requested'], .sui-confirm[data-state='failed-submission'] { border-color:${t.warningBorder}; background:${t.warningSoft}; }
.sui-confirm[data-state='approved'] { border-color:${t.successBorder}; background:${t.successSoft}; }
.sui-confirm[data-state='denied'] { border-color:${t.destructiveBorder}; background:${t.destructiveSoft}; }
.sui-confirm[data-state='expired'], .sui-confirm[data-state='unavailable'] { color:${t.mutedForeground}; }
.sui-confirm:focus-visible { ${focusRing} }
.sui-confirm-title { min-width:0; font-size:13px; font-weight:650; }
.sui-confirm-request { min-width:0; display:grid; align-content:start; gap:6px; }
.sui-confirm-accepted { min-width:0; display:flex; align-items:center; gap:6px; color:${t.success}; font-weight:650; }
.sui-confirm-rejected { min-width:0; display:flex; align-items:center; gap:6px; color:${t.destructive}; font-weight:650; }
.sui-confirm-note { min-width:0; color:${t.mutedForeground}; font-size:12px; }
.sui-confirm-failure { color:${t.destructive}; }
.sui-confirm-actions { display:flex; align-items:center; gap:8px; min-width:0; }
.sui-confirm-deny { display:grid; gap:8px; min-width:0; padding:10px; border:1px solid ${t.destructiveBorder}; border-radius:${t.radiusControl}; background:${t.destructiveSoft}; color:${t.foreground}; font-weight:650; }
.sui-confirm-action:focus-visible { ${focusRing} }

.sui-approval-card { min-width:0; display:grid; align-content:start; gap:10px; padding:14px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; font-size:13px; }
.sui-approval-header { display:flex; align-items:center; gap:8px; min-width:0; }
.sui-approval-title { min-width:0; flex:1; font-size:13px; font-weight:650; }
.sui-approval-summary { min-width:0; color:${t.mutedForeground}; }
.sui-approval-risk { flex:none; display:inline-flex; align-items:center; gap:4px; min-height:22px; padding:0 8px; border-radius:${t.radiusFull}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-approval-risk[data-level='low'] { border:1px solid ${t.infoBorder}; background:${t.infoSoft}; color:${t.info}; }
.sui-approval-risk[data-level='medium'] { border:1px solid ${t.warningBorder}; background:${t.warningSoft}; color:${t.warning}; }
.sui-approval-risk[data-level='high'] { border:1px solid ${t.warningBorder}; background:color-mix(in srgb, ${t.warning} 22%, ${t.card}); color:${t.warning}; }
.sui-approval-risk[data-level='critical'] { border:1px solid ${t.destructiveBorder}; background:${t.destructiveSoft}; color:${t.destructive}; }
.sui-approval-actions-list { min-width:0; margin:0; padding:0 0 0 18px; display:grid; gap:4px; }
.sui-approval-resources { min-width:0; display:grid; gap:4px; }
.sui-approval-resource { display:flex; align-items:center; gap:6px; min-width:0; font-family:${t.fontMono}; font-size:11px; color:${t.mutedForeground}; }
.sui-approval-resource a { color:${t.primary}; text-decoration:none; }
.sui-approval-resource a:hover { text-decoration:underline; }
.sui-approval-resource a:focus-visible { ${focusRing} }
.sui-approval-resource-kind { flex:none; padding:2px 6px; border:1px solid ${t.border}; border-radius:${t.radiusFull}; background:${t.surface2}; font-size:10px; text-transform:uppercase; letter-spacing:.05em; }
.sui-approval-note { min-width:0; display:grid; gap:4px; }
.sui-approval-note-label { font-size:12px; font-weight:650; color:${t.mutedForeground}; }
.sui-approval-note-input { min-width:0; width:100%; min-height:56px; padding:6px 8px; border:1px solid ${t.input}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font:inherit; font-size:13px; resize:vertical; }
.sui-approval-note-input:focus-visible { ${focusRing} }
.sui-approval-note-input[readonly] { background:${t.surface2}; color:${t.mutedForeground}; }

.sui-checkpoint { min-width:0; display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:6px 10px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; font-size:13px; }
.sui-checkpoint[data-current='true'] { border-color:${t.primaryBorder}; background:${t.primarySoft}; }
.sui-checkpoint-icon { flex:none; display:inline-flex; align-items:center; color:${t.mutedForeground}; }
.sui-checkpoint[data-current='true'] .sui-checkpoint-icon { color:${t.primary}; }
.sui-checkpoint-label { min-width:0; flex:1; font-weight:650; }
.sui-checkpoint-metadata { flex:none; display:flex; align-items:center; gap:8px; color:${t.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-checkpoint-trigger:focus-visible { ${focusRing} }
.sui-checkpoint-actions { flex:none; display:flex; align-items:center; gap:4px; }
.sui-checkpoint-action:focus-visible { ${focusRing} }
.sui-checkpoint-error { flex-basis:100%; min-width:0; color:${t.destructive}; font-size:12px; }
`;
