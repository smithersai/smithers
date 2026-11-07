/**
 * `ActionMenu`'s sheet: a quiet square trigger, and a popover menu whose
 * highlighted item takes the hover fill; a destructive item reads in the
 * danger color.
 */
import { tokens as t } from "../tokens";

export const actionMenuCss = `
.sui-action-menu-trigger { flex:none; width:28px; min-height:28px; height:28px; padding:0; color:${t.mutedForeground}; }
@media (max-width:960px) {
  .sui-action-menu-trigger { width:32px; min-height:${t.controlHeight}; height:${t.controlHeight}; }
}
.sui-action-menu-trigger:hover, .sui-action-menu-trigger[data-state='open'] { color:${t.foreground}; }
.sui-action-menu { z-index:60; min-width:160px; padding:4px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.popover}; color:${t.popoverForeground}; box-shadow:${t.shadow3}; outline:none; }
.sui-action-menu-item { display:flex; align-items:center; gap:6px; padding:6px 8px; border-radius:${t.radiusControl}; color:${t.foreground}; font-size:13px; cursor:pointer; user-select:none; outline:none; }
.sui-action-menu-item[data-highlighted] { background:${t.secondary}; }
.sui-action-menu-item[data-destructive] { color:${t.destructive}; }
`;
