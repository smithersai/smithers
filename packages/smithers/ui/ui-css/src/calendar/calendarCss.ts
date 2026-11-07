/**
 * calendar lane CSS fragment. All `sui-cal-*` namespaced and colored only
 * through the tokens bridge (`var(--house-token, lightFallback)` /
 * `color-mix(in srgb, ...)`); tints rotate across the shared semantic
 * soft/border pairs. Composed into `smithersUiCss` by uiCss.ts, which every
 * calendar component injects; exported for hosts that mount the lane alone.
 */
import { tokens as t } from "../tokens";

export const CALENDAR_CSS_ID = "calendar";

const interaction = "transition:background-color .12s ease, border-color .12s ease, color .12s ease;";

export const calendarCss = `
.sui-cal { min-width:0; display:grid; align-content:start; gap:10px; color:${t.foreground}; font-family:${t.fontSans}; font-size:13px; }
.sui-cal-header { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.sui-cal-title { min-width:0; color:${t.foreground}; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-cal-controls { display:flex; align-items:center; gap:8px; flex:none; flex-wrap:wrap; }
.sui-cal-segment { display:inline-flex; align-items:center; gap:2px; padding:2px; border:1px solid ${t.input}; border-radius:${t.radiusControl}; background:${t.secondary}; }
.sui-cal-segment-button { min-height:26px; display:inline-flex; align-items:center; justify-content:center; padding:0 10px; border:none; border-radius:4px; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:12px; font-weight:650; cursor:pointer; white-space:nowrap; ${interaction} }
.sui-cal-segment-button:hover { color:${t.foreground}; }
.sui-cal-segment-button:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-cal-segment-button[data-active='true'] { background:${t.card}; color:${t.foreground}; box-shadow:${t.shadow1}; }

/* Month */
.sui-cal-grid { display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); gap:1px; overflow:hidden; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.border}; }
.sui-cal-weekday { padding:6px 8px; background:${t.card}; color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-cal-day { position:relative; min-width:0; min-height:96px; display:grid; align-content:start; gap:2px; padding:4px; border:none; background:${t.card}; color:${t.foreground}; font:inherit; text-align:left; cursor:pointer; ${interaction} }
.sui-cal-day:hover { background:${t.secondary}; }
.sui-cal-day:focus-visible { outline:none; box-shadow:inset 0 0 0 3px ${t.ring}; }
.sui-cal-day[data-outside='true'] { background:${t.surface2}; }
.sui-cal-day[data-outside='true']:hover { background:${t.secondary}; }
.sui-cal-day[data-today='true'] { background:${t.primarySoft}; }
.sui-cal-day-num { display:inline-grid; place-items:center; min-width:22px; height:22px; padding:0 4px; border-radius:${t.radiusFull}; color:${t.mutedForeground}; font-size:12px; justify-self:start; }
.sui-cal-day[data-today='true'] .sui-cal-day-num { background:${t.primary}; color:${t.primaryForeground}; font-weight:650; }
.sui-cal-day[data-outside='true'] .sui-cal-day-num { color:${t.textFaint}; }

/* Event chips (month cells, all-day lanes, popovers) */
.sui-cal-chip { min-width:0; width:100%; min-height:20px; display:inline-flex; align-items:center; gap:4px; padding:0 4px; border:1px solid ${t.border}; border-radius:4px; background:${t.hoverSubtle}; color:${t.foreground}; font:inherit; font-size:11px; line-height:1.3; text-align:left; text-decoration:none; cursor:pointer; ${interaction} }
.sui-cal-chip:hover { border-color:currentColor; }
.sui-cal-chip:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-cal-chip[data-tint='brand'] { border-color:${t.primaryBorder}; background:${t.primarySoft}; color:${t.primary}; }
.sui-cal-chip[data-tint='success'] { border-color:${t.successBorder}; background:${t.successSoft}; color:${t.success}; }
.sui-cal-chip[data-tint='info'] { border-color:${t.infoBorder}; background:${t.infoSoft}; color:${t.info}; }
.sui-cal-chip[data-tint='warning'] { border-color:${t.warningBorder}; background:${t.warningSoft}; color:${t.warning}; }
.sui-cal-chip-dot { width:6px; height:6px; flex:none; border-radius:${t.radiusFull}; background:currentColor; }
.sui-cal-chip-time { flex:none; font-variant-numeric:tabular-nums; color:color-mix(in srgb, currentColor 75%, transparent); }
.sui-cal-chip-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-cal-more { min-height:20px; display:inline-flex; align-items:center; padding:0 4px; border:none; border-radius:4px; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:11px; font-weight:650; text-align:left; cursor:pointer; ${interaction} }
.sui-cal-more:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-cal-more:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }
.sui-cal-popover { position:absolute; z-index:30; top:calc(100% + 2px); left:0; width:240px; max-height:280px; overflow:auto; display:grid; align-content:start; gap:2px; padding:6px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.popover}; color:${t.popoverForeground}; box-shadow:${t.shadow3}; }
.sui-cal-popover[data-align='end'] { left:auto; right:0; }
.sui-cal-popover[data-placement='up'] { top:auto; bottom:calc(100% + 2px); }
.sui-cal-popover-label { padding:2px 4px; color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }

/* Week time grid */
.sui-cal-week { min-width:0; overflow:hidden; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; }
.sui-cal-week-scroll { overflow-x:auto; }
.sui-cal-week-inner { min-width:604px; display:grid; }
.sui-cal-week-head { display:grid; grid-template-columns:44px repeat(7, minmax(0, 1fr)); border-bottom:1px solid ${t.border}; }
.sui-cal-week-corner { background:${t.card}; }
.sui-cal-week-day { min-width:0; display:grid; justify-items:center; gap:2px; padding:6px 4px; border:none; border-left:1px solid ${t.border}; background:${t.card}; color:${t.foreground}; font:inherit; cursor:pointer; ${interaction} }
.sui-cal-week-day:hover { background:${t.secondary}; }
.sui-cal-week-day:focus-visible { outline:none; box-shadow:inset 0 0 0 3px ${t.ring}; }
.sui-cal-week-day-label { color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-cal-week-day-num { display:inline-grid; place-items:center; min-width:24px; height:24px; padding:0 4px; border-radius:${t.radiusFull}; font-size:13px; }
.sui-cal-week-day[data-today='true'] .sui-cal-week-day-num { background:${t.primary}; color:${t.primaryForeground}; font-weight:650; }
.sui-cal-week-allday { display:grid; grid-template-columns:44px repeat(7, minmax(0, 1fr)); border-bottom:1px solid ${t.border}; }
.sui-cal-week-allday-label { display:grid; align-content:center; justify-items:end; padding:2px 4px; color:${t.textFaint}; font-size:10px; }
.sui-cal-week-allday-cell { min-width:0; min-height:28px; display:grid; align-content:start; gap:2px; padding:2px; border-left:1px solid ${t.border}; }
.sui-cal-week-body { display:grid; grid-template-columns:44px repeat(7, minmax(0, 1fr)); }
.sui-cal-week-gutter { position:relative; }
.sui-cal-week-hour { position:absolute; right:4px; transform:translateY(-50%); padding:0 2px; background:${t.card}; color:${t.textFaint}; font-size:10px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.sui-cal-week-col { position:relative; border-left:1px solid ${t.border}; background-image:repeating-linear-gradient(to bottom, ${t.border} 0, ${t.border} 1px, transparent 1px, transparent 44px); }
.sui-cal-week-event { position:absolute; z-index:1; left:2px; right:2px; min-width:0; display:grid; align-content:start; padding:2px 4px; border:1px solid ${t.border}; border-radius:4px; background:${t.hoverSubtle}; color:${t.foreground}; font:inherit; font-size:11px; line-height:1.3; text-align:left; text-decoration:none; cursor:pointer; overflow:hidden; ${interaction} }
.sui-cal-week-event:hover { border-color:currentColor; z-index:2; }
.sui-cal-week-event:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; z-index:2; }
.sui-cal-week-event[data-tint='brand'] { border-color:${t.primaryBorder}; background:${t.primarySoft}; color:${t.primary}; }
.sui-cal-week-event[data-tint='success'] { border-color:${t.successBorder}; background:${t.successSoft}; color:${t.success}; }
.sui-cal-week-event[data-tint='info'] { border-color:${t.infoBorder}; background:${t.infoSoft}; color:${t.info}; }
.sui-cal-week-event[data-tint='warning'] { border-color:${t.warningBorder}; background:${t.warningSoft}; color:${t.warning}; }
.sui-cal-week-event-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:650; }
.sui-cal-week-event-time { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-variant-numeric:tabular-nums; color:color-mix(in srgb, currentColor 75%, transparent); }
.sui-cal-now-line { position:absolute; z-index:3; left:0; right:0; height:0; border-top:1px solid ${t.destructive}; pointer-events:none; }
.sui-cal-now-line::before { content:""; position:absolute; left:-3px; top:-4px; width:7px; height:7px; border-radius:${t.radiusFull}; background:${t.destructive}; }

/* Agenda */
.sui-cal-agenda { min-width:0; display:grid; align-content:start; gap:10px; }
.sui-cal-agenda-day { min-width:0; display:grid; align-content:start; gap:2px; }
.sui-cal-agenda-day-label { display:flex; align-items:baseline; gap:8px; padding:0 2px; color:${t.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-cal-agenda-row { min-width:0; width:100%; display:flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font:inherit; font-size:13px; text-align:left; text-decoration:none; cursor:pointer; ${interaction} }
.sui-cal-agenda-row:hover { background:${t.secondary}; }
.sui-cal-agenda-row:focus-visible { outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring}; }
.sui-cal-agenda-time { flex:none; width:84px; overflow:hidden; color:${t.mutedForeground}; font-size:12px; font-variant-numeric:tabular-nums; text-overflow:ellipsis; white-space:nowrap; }
.sui-cal-agenda-title { min-width:0; flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-cal-agenda-source { flex:none; max-width:140px; overflow:hidden; color:${t.mutedForeground}; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
`;
