/**
 * The agent-status sheet: the pill's glyph, delayed Working and count; the needs-you
 * card in gold; the toast stack at the bottom-left, full width on a phone;
 * an update's toast in muted tones, and an unread entry's brand dot.
 * Gold is `--warning` and ember is `--danger` (mvp.md §6.4: "Needs you is gold
 * and failures are ember").
 */
import { LOADING_DELAY_MS } from "../loading-delay";
import { tokens as t } from "../tokens";

export const agentStatusCss = `
button.sui-agent-status { cursor:pointer; font:inherit; font-size:12px; font-weight:650; }
button.sui-agent-status:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-agent-status-glyph { flex:none; font-size:11px; line-height:1; }
/* Working is the one loading pattern: it shows once the work has lasted the loading delay, so brief work never
   flashes it, and it holds still. */
.sui-agent-status[data-state='working'] { --motion-hold:${LOADING_DELAY_MS}ms; animation:sui-loading-appear .2s ease-out ${LOADING_DELAY_MS}ms both; }
.sui-agent-status-count { min-width:18px; padding:0 6px; border-radius:${t.radiusFull}; background:${t.warning}; color:${t.card}; font-size:11px; font-variant-numeric:tabular-nums; text-align:center; }
.sui-needs-you { display:flex; flex-direction:column; gap:8px; min-width:0; max-width:100%; padding:10px 12px; border:1px solid ${t.warningBorder}; border-radius:${t.radius}; background:${t.warningSoft}; color:${t.foreground}; }
.sui-needs-you-prompt { margin:0; font-size:15px; overflow-wrap:anywhere; }
.sui-needs-you[data-compact] { padding:0; border:0; background:transparent; }
.sui-needs-you-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin:0; }
.sui-needs-you-field { flex:1 1 180px; font-size:16px; }
.sui-needs-you-answered { display:flex; flex-direction:column; gap:2px; min-width:0; padding:0 2px; color:${t.mutedForeground}; font-size:13px; }
.sui-needs-you-answered-label { font-size:12px; font-weight:650; }
.sui-needs-you-answer { color:${t.foreground}; overflow-wrap:anywhere; }
.sui-toast-stack { position:fixed; z-index:40; left:16px; bottom:16px; display:flex; flex-direction:column; align-items:flex-start; gap:6px; width:min(380px, calc(100vw - 32px)); pointer-events:none; }
.sui-toast-stack > * { pointer-events:auto; }
.sui-toast { display:flex; align-items:center; gap:8px; width:100%; min-width:0; padding:6px 6px 6px 12px; border:1px solid ${t.borderStrong}; border-left:3px solid ${t.mutedForeground}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; box-shadow:${t.shadow3}; font-size:13px; }
.sui-toast[data-delayed] { animation:sui-toast-in .12s ease .3s both; }
@keyframes sui-toast-in { from { opacity:0; } to { opacity:1; } }
.sui-toast[data-tone='needs_you'] { border-left-color:${t.warning}; }
.sui-toast[data-tone='failed'] { border-left-color:${t.destructive}; }
.sui-toast[data-tone='working'] { border-left-color:${t.primary}; }
.sui-toast[data-tone='update'] { border-left-color:${t.mutedForeground}; }
.sui-toast-glyph { flex:none; font-size:12px; }
.sui-toast[data-tone='needs_you'] .sui-toast-glyph { color:${t.warning}; }
.sui-toast[data-tone='failed'] .sui-toast-glyph { color:${t.destructive}; }
.sui-toast[data-tone='working'] .sui-toast-glyph { color:${t.primary}; }
.sui-toast[data-tone='update'] .sui-toast-glyph { color:${t.mutedForeground}; }
.sui-toast-unread { flex:none; width:6px; height:6px; margin-right:-2px; border-radius:${t.radiusFull}; background:${t.primary}; }
.sui-toast-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-toast-text b { font-weight:650; }
.sui-toast-hide { flex:none; color:${t.mutedForeground}; }
@media (max-width: 640px) { .sui-toast-stack[data-placement='fixed'] { left:16px; right:16px; bottom:64px; width:auto; } }
.sui-toast-stack[data-placement='inline'] { position:static; width:100%; }
button.sui-toast-open { flex:1; min-width:0; display:flex; align-items:center; gap:8px; padding:2px 0; border:0; border-radius:${t.radius}; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
button.sui-toast-open:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-toast:has(button.sui-toast-open:hover) { border-color:${t.primaryBorder}; }
.sui-notification-panel { position:fixed; z-index:50; top:12px; right:12px; display:flex; flex-direction:column; width:min(420px, calc(100vw - 24px)); max-height:min(640px, calc(100dvh - 24px)); border:1px solid ${t.borderStrong}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; box-shadow:${t.shadow3}; }
.sui-notification-panel-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 6px 6px 14px; border-bottom:1px solid ${t.border}; }
.sui-notification-panel-head h2 { margin:0; font-size:15px; font-weight:650; }
.sui-notification-list { display:flex; flex-direction:column; gap:2px; margin:0; padding:4px; list-style:none; overflow-y:auto; overscroll-behavior:contain; }
.sui-notification-empty { margin:0; padding:16px 14px; color:${t.mutedForeground}; font-size:13px; }
.sui-notification { border-radius:${t.radius}; }
.sui-notification[data-expanded] { background:${t.surface2}; }
.sui-notification-head { display:flex; align-items:center; gap:2px; }
button.sui-notification-row { flex:1; min-width:0; display:flex; align-items:center; gap:8px; padding:8px 6px 8px 10px; border:0; border-radius:${t.radius}; background:transparent; color:inherit; font:inherit; font-size:13px; text-align:left; cursor:pointer; }
button.sui-notification-row:hover { background:${t.accent}; }
button.sui-notification-row:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-notification-unread { flex:none; width:6px; height:6px; margin-right:-2px; border-radius:${t.radiusFull}; background:${t.primary}; }
.sui-notification-glyph { flex:none; font-size:12px; color:${t.mutedForeground}; }
.sui-notification[data-tone='needs_you'] .sui-notification-glyph { color:${t.warning}; }
.sui-notification[data-tone='failed'] .sui-notification-glyph { color:${t.destructive}; }
.sui-notification[data-tone='working'] .sui-notification-glyph { color:${t.primary}; }
.sui-notification-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-notification-text b { font-weight:650; }
.sui-notification[data-expanded] .sui-notification-text { white-space:normal; overflow-wrap:anywhere; }
.sui-notification-time { flex:none; color:${t.mutedForeground}; font-size:12px; }
.sui-notification-hide { flex:none; color:${t.mutedForeground}; }
.sui-notification-body { display:flex; flex-direction:column; gap:8px; padding:0 10px 10px 30px; font-size:13px; }
.sui-notification-meta { margin:0; color:${t.mutedForeground}; font-size:12px; }
.sui-notification-steps { display:flex; flex-direction:column; gap:2px; margin:0; padding:0; list-style:none; font-family:${t.fontMono}; font-size:12px; }
.sui-notification-steps li { display:flex; gap:6px; align-items:center; min-width:0; overflow-wrap:anywhere; }
.sui-notification-step-glyph { flex:none; color:${t.mutedForeground}; }
.sui-notification-steps li[data-state='running'] .sui-notification-step-glyph { color:${t.primary}; }
.sui-notification-steps li[data-state='failed'] .sui-notification-step-glyph { color:${t.destructive}; }
.sui-notification-note { margin:0; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:4; overflow:hidden; overflow-wrap:anywhere; white-space:pre-wrap; }
.sui-notification[data-tone='failed'] .sui-notification-note { color:${t.destructive}; }
.sui-notification-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
.sui-notification-bell { position:relative; min-height:${t.controlHeight}; min-width:${t.controlHeight}; flex-shrink:0; }
.sui-notification-bell[data-needs-you] { gap:6px; padding:0 8px; border:1px solid ${t.warningBorder}; border-radius:${t.radiusFull}; background:${t.warningSoft}; color:${t.warning}; }
.sui-notification-needs { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:650; white-space:nowrap; }
.sui-notification-needs-glyph { font-size:11px; line-height:1; }
.sui-notification-needs-count { min-width:18px; padding:0 6px; border-radius:${t.radiusFull}; background:${t.warning}; color:${t.card}; font-size:11px; font-variant-numeric:tabular-nums; text-align:center; }
.sui-notification-count { position:absolute; top:-3px; right:-3px; min-width:16px; height:16px; padding:0 4px; border-radius:${t.radiusFull}; background:${t.primary}; color:${t.primaryForeground}; font-size:10px; font-weight:650; line-height:16px; font-variant-numeric:tabular-nums; text-align:center; }
@media (max-width:960px) {
  button.sui-toast-open { min-height:${t.controlHeight}; }
  .sui-toast-text, .sui-notification-text { white-space:normal; overflow-wrap:anywhere; }
  .sui-notification-bell { flex-shrink:0; }
  .sui-notification-count { position:static; flex:none; }
  .sui-notification-bell:has(.sui-notification-count) { width:auto; padding-inline:8px; }
}
@media (max-width: 640px) { .sui-notification-panel { top:0; right:0; left:0; width:auto; max-height:100dvh; border-radius:0; } }
`;
