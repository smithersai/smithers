import { tokens as t } from "../tokens";

export const AGENT_IDENTITY_CONTEXT_CSS_ID = "agent-identity-context";

const focusRing = `outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring};`;

/**
 * Lane CSS fragment for agent-identity-context: AgentDefinition/AgentCard,
 * ModelSelector, ModelBadge/ProviderBadge, and the ContextUsage family.
 * Obeys the css contract: sui- namespace only, no :root, colors only through
 * the tokens bridge or color-mix(in srgb, ...).
 */
export const agentsCss = `
.sui-agentdef { min-width:0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; overflow:hidden; }
.sui-agentdef-header { min-width:0; display:flex; align-items:center; gap:8px; padding:8px 10px; }
.sui-agentdef-name { min-width:0; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-agentdef-identity { min-width:0; display:inline-flex; align-items:center; gap:4px; color:${t.mutedForeground}; font-size:11px; font-family:${t.fontMono}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-agentdef-identity-sep { color:${t.textFaint}; }
.sui-agentdef-provider { color:${t.mutedForeground}; }
.sui-agentdef-model { color:${t.foreground}; }
.sui-agentdef-availability { flex:none; display:inline-flex; align-items:center; min-height:20px; padding:0 8px; border:1px solid ${t.border}; border-radius:${t.radiusFull}; color:${t.mutedForeground}; font-size:10px; font-weight:650; text-transform:uppercase; letter-spacing:.02em; }
.sui-agentdef-availability[data-availability='available'] { border-color:${t.successBorder}; background:${t.successSoft}; color:${t.success}; }
.sui-agentdef-availability[data-availability='unauthenticated'] { border-color:${t.warningBorder}; background:${t.warningSoft}; color:${t.warning}; }
.sui-agentdef-availability[data-availability='unavailable'] { border-color:${t.destructiveBorder}; background:${t.destructiveSoft}; color:${t.destructive}; }
.sui-agentdef-content { min-width:0; display:grid; gap:8px; padding:0 10px 10px; }
.sui-agentdef-trigger { width:100%; min-height:28px; display:flex; align-items:center; gap:8px; padding:4px 6px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.foreground}; font:inherit; text-align:left; cursor:pointer; }
.sui-agentdef-trigger:hover { background:${t.secondary}; }
.sui-agentdef-trigger:focus-visible { ${focusRing} }
.sui-agentdef-chevron { display:inline-flex; align-items:center; justify-content:center; width:12px; flex:none; color:${t.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-agentdef-trigger[aria-expanded='true'] .sui-agentdef-chevron { transform:rotate(90deg); }
.sui-agentdef-trigger-label { min-width:0; font-size:12px; font-weight:650; color:${t.mutedForeground}; text-transform:uppercase; letter-spacing:.04em; }
.sui-agentdef-region { min-width:0; margin:2px 0 6px 20px; padding:8px 10px; border-radius:${t.radiusControl}; background:${t.surface2}; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; line-height:1.45; }
.sui-agentdef-tools { display:grid; gap:0; margin:0; padding:0; }
.sui-agentdef-tool { min-width:0; border-top:1px solid ${t.border}; list-style:none; }
.sui-agentdef-tool-name { min-width:0; font-size:12px; font-weight:650; font-family:${t.fontMono}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-agentdef-tool-description { margin:0 0 6px; color:${t.mutedForeground}; }
.sui-agentdef-tool-permissions { margin:0 0 6px; color:${t.mutedForeground}; font-size:11px; }
.sui-agentdef-tool-permissions-label { font-weight:650; color:${t.foreground}; }
.sui-agentdef-schema { min-width:0; margin:0 0 6px; max-height:240px; overflow:auto; padding:8px 10px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font-family:${t.fontMono}; font-size:11px; line-height:1.5; white-space:pre; }
.sui-agentdef-schema:focus-visible { ${focusRing} }
.sui-agentcard { min-width:0; display:grid; gap:4px; padding:10px 12px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; text-align:left; font:inherit; }
.sui-agentcard-selectable { cursor:pointer; }
.sui-agentcard-selectable:hover { background:${t.hoverSubtle}; }
.sui-agentcard-selectable:focus-visible { ${focusRing} }
.sui-agentcard-selectable:disabled { cursor:not-allowed; opacity:.45; }
.sui-agentcard[data-selected='true'] { border-color:${t.primaryBorder}; background:${t.primarySoft}; }
.sui-agentcard-header { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sui-agentcard-name { min-width:0; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-agentcard-identity { min-width:0; display:inline-flex; align-items:center; gap:4px; color:${t.mutedForeground}; font-size:11px; font-family:${t.fontMono}; }
.sui-agentcard-identity-sep { color:${t.textFaint}; }
.sui-agentcard-provider { color:${t.mutedForeground}; }
.sui-agentcard-model { color:${t.foreground}; }
.sui-agentcard-description { min-width:0; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; line-height:1.45; }
.sui-model-badge { display:inline-flex; align-items:center; gap:6px; min-width:0; max-width:100%; min-height:20px; padding:0 8px; border:1px solid ${t.primaryBorder}; border-radius:${t.radiusFull}; background:${t.primarySoft}; color:${t.primary}; font-size:11px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sui-model-badge-icon { display:inline-flex; align-items:center; flex:none; }
.sui-model-badge-name { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.sui-model-badge-provider { flex:none; font-weight:500; opacity:.75; }
.sui-provider-badge { display:inline-flex; align-items:center; gap:4px; min-width:0; max-width:100%; min-height:18px; padding:0 6px; border:1px solid ${t.border}; border-radius:${t.radiusFull}; background:${t.hoverSubtle}; color:${t.mutedForeground}; font-size:10px; font-weight:650; text-transform:uppercase; letter-spacing:.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sui-provider-badge-icon { display:inline-flex; align-items:center; flex:none; }
.sui-provider-badge-name { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.sui-model-sel-trigger { gap:8px; }
.sui-model-sel-content { min-width:220px; }
.sui-model-sel-item { align-items:flex-start; }
.sui-model-sel-item-body { min-width:0; display:grid; gap:2px; }
.sui-model-sel-item-row { min-width:0; display:flex; align-items:center; gap:6px; }
.sui-model-sel-item-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-model-sel-item-description { color:${t.mutedForeground}; font-size:11px; line-height:1.35; }
.sui-ctx { position:relative; display:inline-block; min-width:0; }
.sui-ctx-trigger { min-height:24px; display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border:1px solid ${t.border}; border-radius:${t.radiusFull}; background:${t.card}; color:${t.mutedForeground}; font:inherit; font-size:11px; font-variant-numeric:tabular-nums; cursor:pointer; }
.sui-ctx-trigger:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-ctx-trigger:focus-visible { ${focusRing} }
.sui-ctx-trigger-label { min-width:0; }
.sui-ctx-content { position:absolute; z-index:60; bottom:calc(100% + 6px); right:0; width:240px; padding:10px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.popover}; color:${t.popoverForeground}; box-shadow:0 4px 12px rgb(${t.shadowRgb} / 0.10), 0 16px 48px rgb(${t.shadowRgb} / 0.16); }
.sui-ctx-header { min-width:0; display:flex; align-items:baseline; justify-content:space-between; gap:8px; padding-bottom:6px; border-bottom:1px solid ${t.border}; }
.sui-ctx-header-title { min-width:0; font-size:12px; font-weight:650; color:${t.foreground}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-ctx-header-value { flex:none; color:${t.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-ctx-body { display:grid; gap:4px; padding:6px 0; }
.sui-ctx-row { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; }
.sui-ctx-row-label { color:${t.mutedForeground}; }
.sui-ctx-row-value { color:${t.foreground}; font-variant-numeric:tabular-nums; }
.sui-ctx-footer { min-height:0; padding-top:6px; border-top:1px solid ${t.border}; }
.sui-ctx-footer:empty { display:none; }
.sui-ctx-cost { color:${t.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
`;
