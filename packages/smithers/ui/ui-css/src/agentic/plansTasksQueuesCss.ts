/**
 * plans-tasks-queues lane CSS fragment. Composed into smithersUiCss, which
 * every component in this lane injects. Obeys the css-contract: sui-
 * namespace only, no :root,
 * colors only through the tokens bridge.
 */
import { tokens as t } from "../tokens";
import { statusColors } from "../status";

export const PLANS_TASKS_QUEUES_CSS_ID = "plans-tasks-queues";

const focusRing = `outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring};`;

export const plansTasksQueuesCss = `
.sui-plan-description { min-width:0; padding:0 10px 8px; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; line-height:1.45; }
.sui-plan-content { min-width:0; padding:0 10px 10px; }
.sui-plan-content .sui-plan-steps, .sui-plan-content > ol { margin:0; padding:0; list-style:none; }
.sui-plan-action { min-height:24px; padding:2px 8px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:11px; cursor:pointer; }
.sui-plan-action:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-plan-action:focus-visible { ${focusRing} }
.sui-plan-footer { min-width:0; display:flex; align-items:center; gap:8px; padding:8px 10px; border-top:1px solid ${t.border}; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }

.sui-agenttask { min-width:0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; overflow:hidden; }
.sui-agenttask-trigger { min-width:0; min-height:${t.controlHeight}; width:100%; display:flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.foreground}; font:inherit; text-align:left; cursor:pointer; }
.sui-agenttask-trigger:hover { background:${t.secondary}; }
.sui-agenttask-trigger:focus-visible { ${focusRing} }
.sui-agenttask-chevron { display:inline-flex; align-items:center; justify-content:center; width:12px; flex:none; color:${t.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-agenttask-trigger[aria-expanded='true'] .sui-agenttask-chevron { transform:rotate(90deg); }
.sui-agenttask-title { min-width:0; flex:1 1 auto; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-agenttask-content { min-width:0; padding:6px 10px 10px; border-top:1px solid ${t.border}; }
.sui-agenttask-group { min-width:0; display:grid; gap:6px; }

.sui-queue { min-width:0; display:grid; gap:8px; }
.sui-queue-section { min-width:0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; overflow:hidden; }
.sui-queue-section-trigger { min-width:0; min-height:${t.controlHeight}; width:100%; display:flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.foreground}; font:inherit; text-align:left; cursor:pointer; }
.sui-queue-section-trigger:hover { background:${t.secondary}; }
.sui-queue-section-trigger:focus-visible { ${focusRing} }
.sui-queue-section-chevron { display:inline-flex; align-items:center; justify-content:center; width:12px; flex:none; color:${t.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-queue-section-trigger[aria-expanded='true'] .sui-queue-section-chevron { transform:rotate(90deg); }
.sui-queue-section-label { min-width:0; display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:650; }
.sui-queue-section-icon { display:inline-flex; align-items:center; flex:none; color:${t.mutedForeground}; }
.sui-queue-section-count { flex:none; padding:0 6px; border-radius:${t.radiusFull}; background:${t.hoverSubtle}; color:${t.mutedForeground}; font-size:10px; font-variant-numeric:tabular-nums; line-height:16px; }
.sui-queue-section-content { min-width:0; border-top:1px solid ${t.border}; }
.sui-queue-list { min-width:0; margin:0; padding:4px; list-style:none; display:grid; gap:2px; }
.sui-queue-item { min-width:0; display:grid; grid-template-columns:14px minmax(0, 1fr); column-gap:8px; padding:6px 8px; border-radius:${t.radiusControl}; }
.sui-queue-item:hover { background:${t.hoverSubtle}; }
.sui-queue-item-indicator { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; margin-top:1px; border-radius:${t.radiusFull}; border:1px solid ${t.borderStrong}; color:transparent; font-size:10px; line-height:1; }
.sui-queue-item[data-status-class='ok'] .sui-queue-item-indicator, .sui-queue-item-indicator[data-status-class='ok'] { border-color:${t.successBorder}; background:${t.successSoft}; color:${statusColors.ok}; }
.sui-queue-item[data-status-class='run'] .sui-queue-item-indicator, .sui-queue-item-indicator[data-status-class='run'] { border-color:${t.primaryBorder}; background:${t.primarySoft}; color:${statusColors.run}; }
.sui-queue-item[data-status-class='warn'] .sui-queue-item-indicator, .sui-queue-item-indicator[data-status-class='warn'] { border-color:${t.warningBorder}; background:${t.warningSoft}; color:${statusColors.warn}; }
.sui-queue-item[data-status-class='bad'] .sui-queue-item-indicator, .sui-queue-item-indicator[data-status-class='bad'] { border-color:${t.destructiveBorder}; background:${t.destructiveSoft}; color:${statusColors.bad}; }
.sui-queue-item-content { min-width:0; grid-column:2; font-size:${t.fontSizeCompact}; line-height:1.45; overflow-wrap:anywhere; }
.sui-queue-item-content[data-completed='true'] { color:${t.mutedForeground}; text-decoration:line-through; }
.sui-queue-item-description { min-width:0; grid-column:2; margin-top:2px; color:${t.mutedForeground}; font-size:11px; line-height:1.45; overflow-wrap:anywhere; }

.sui-activity-timeline { min-width:0; margin:0; padding:0; list-style:none; display:grid; gap:0; }
.sui-activity-item { position:relative; min-width:0; display:flex; align-items:flex-start; gap:10px; padding:6px 0 6px 2px; }
.sui-activity-item + .sui-activity-item { border-top:1px solid ${t.border}; }
.sui-activity-marker { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; margin-top:1px; flex:none; border-radius:${t.radiusFull}; border:1px solid ${t.border}; background:${t.surface2}; color:${t.mutedForeground}; font-size:10px; line-height:1; }
.sui-activity-item[data-status-class='ok'] .sui-activity-marker { border-color:${t.successBorder}; background:${t.successSoft}; color:${statusColors.ok}; }
.sui-activity-item[data-status-class='run'] .sui-activity-marker { border-color:${t.primaryBorder}; background:${t.primarySoft}; color:${statusColors.run}; }
.sui-activity-item[data-status-class='warn'] .sui-activity-marker { border-color:${t.warningBorder}; background:${t.warningSoft}; color:${statusColors.warn}; }
.sui-activity-item[data-status-class='bad'] .sui-activity-marker { border-color:${t.destructiveBorder}; background:${t.destructiveSoft}; color:${statusColors.bad}; }
.sui-activity-body { min-width:0; flex:1 1 auto; display:grid; gap:2px; }
.sui-activity-title { min-width:0; font-size:${t.fontSizeCompact}; line-height:1.45; color:${t.foreground}; overflow-wrap:anywhere; }
.sui-activity-actor { color:${t.mutedForeground}; font-size:11px; }
.sui-activity-time { color:${t.textFaint}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-activity-detail { min-width:0; margin-top:2px; padding:8px 10px; border-radius:${t.radiusControl}; background:${t.surface2}; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; line-height:1.45; }
.sui-activity-group { min-width:0; padding:6px 0 6px 2px; }
.sui-activity-group + .sui-activity-item, .sui-activity-item + .sui-activity-group, .sui-activity-group + .sui-activity-group { border-top:1px solid ${t.border}; }
.sui-activity-group-label { color:${t.mutedForeground}; font-size:11px; font-weight:650; letter-spacing:0.02em; text-transform:uppercase; }
.sui-activity-group-items { min-width:0; margin:4px 0 0; padding:0; list-style:none; display:grid; gap:0; }

.sui-taskitem-file-icon { display:inline-flex; align-items:center; margin-right:3px; color:${t.mutedForeground}; }
`;
