import { tokens as t } from "../tokens";

const focusRing = `outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring};`;

/** Stable id for this lane fragment. */
export const CONVERSATION_FOUNDATION_CSS_ID = "conversation-foundation";

/**
 * Lane fragment for the conversation-foundation anatomy: Message family,
 * MessageBranch family, Bubble compound parts, CompactGroup,
 * ConversationCheckpoint, and the MessageScroller compound item layer.
 */
export const conversationFoundationCss = `
.sui-msg { display:flex; gap:10px; max-width:100%; }
.sui-msg[data-align='end'] { flex-direction:row-reverse; }
.sui-msg[data-grouped='true'] { margin-top:-10px; }
.sui-msg[data-grouped='true'] .sui-msg-avatar { visibility:hidden; }
.sui-msg-avatar { flex:none; width:28px; height:28px; display:inline-flex; align-items:center; justify-content:center; overflow:hidden; border-radius:${t.radiusFull}; background:${t.secondary}; color:${t.mutedForeground}; font-size:11px; font-weight:650; user-select:none; }
.sui-msg-avatar img { width:100%; height:100%; object-fit:cover; }
.sui-msg-header { display:flex; align-items:baseline; gap:8px; color:${t.mutedForeground}; font-size:11px; font-weight:650; }
.sui-msg-content { min-width:0; flex:1 1 auto; display:flex; flex-direction:column; gap:4px; }
.sui-msg-footer { display:flex; align-items:center; gap:8px; color:${t.mutedForeground}; font-size:11px; }
.sui-msg-actions { display:flex; align-items:center; gap:2px; opacity:0; transition:opacity .12s ease; }
.sui-msg:hover .sui-msg-actions, .sui-msg:focus-within .sui-msg-actions { opacity:1; }
.sui-msg-group { display:flex; flex-direction:column; gap:18px; }

.sui-msg-branch { display:grid; gap:6px; }
.sui-msg-branch-content { min-width:0; }
.sui-msg-branch-selector { display:inline-flex; align-items:center; gap:6px; color:${t.mutedForeground}; }
.sui-msg-branch-button { min-width:22px; min-height:22px; display:inline-flex; align-items:center; justify-content:center; padding:0 4px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:12px; cursor:pointer; }
.sui-msg-branch-button:hover:not(:disabled) { background:${t.secondary}; color:${t.foreground}; }
.sui-msg-branch-button:focus-visible { ${focusRing} }
.sui-msg-branch-button:disabled { cursor:not-allowed; opacity:.4; }
.sui-msg-branch-page { font-size:11px; font-variant-numeric:tabular-nums; }

.sui-bubble-actions { display:flex; align-items:center; gap:2px; margin-top:6px; }
.sui-bubble-reactions { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:6px; }
.sui-bubble-reaction { display:inline-flex; align-items:center; gap:4px; min-height:22px; padding:0 8px; border:1px solid ${t.border}; border-radius:${t.radiusFull}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:11px; cursor:pointer; }
.sui-bubble-reaction:hover { background:${t.secondary}; }
.sui-bubble-reaction:focus-visible { ${focusRing} }
.sui-bubble-reaction[aria-pressed='true'] { border-color:${t.primaryBorder}; background:${t.primarySoft}; color:${t.primary}; }

.sui-compact-group { border:1px dashed ${t.borderStrong}; border-radius:${t.radius}; background:${t.hoverSubtle}; }
.sui-compact-group-trigger { width:100%; display:flex; align-items:center; gap:8px; min-height:${t.controlHeight}; padding:4px 10px; border:0; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:12px; cursor:pointer; text-align:left; }
.sui-compact-group-trigger:hover { color:${t.foreground}; }
.sui-compact-group-trigger:focus-visible { ${focusRing} }
.sui-compact-group-chevron { flex:none; font-size:10px; transition:transform .12s ease; }
.sui-compact-group[data-open='true'] .sui-compact-group-chevron { transform:rotate(90deg); }
.sui-compact-group-content { padding:4px 10px 10px; display:grid; gap:8px; }

.sui-convo-checkpoint { display:flex; align-items:center; gap:10px; }
.sui-convo-checkpoint::before, .sui-convo-checkpoint::after { content:""; flex:1 1 0; height:1px; background:${t.border}; }
.sui-convo-checkpoint-body { flex:none; display:inline-flex; align-items:center; gap:8px; max-width:70%; padding:2px 10px; border:1px solid ${t.border}; border-radius:${t.radiusFull}; color:${t.mutedForeground}; font-size:11px; }
.sui-convo-checkpoint-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-convo-checkpoint-time { flex:none; font-variant-numeric:tabular-nums; }
.sui-convo-checkpoint-actions { flex:none; display:inline-flex; align-items:center; gap:4px; }

.sui-msg-scroller-item { min-width:0; content-visibility:auto; contain-intrinsic-size:auto var(--sui-msg-intrinsic, 96px); }
.sui-msg-scroller-button { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); z-index:5; min-width:32px; height:${t.controlHeight}; display:inline-flex; align-items:center; justify-content:center; padding:0 10px; border:1px solid ${t.border}; border-radius:${t.radiusFull}; background:${t.glassStrong}; color:${t.foreground}; font:inherit; font-size:12px; cursor:pointer; box-shadow:0 1px 2px rgb(${t.shadowRgb} / 0.06), 0 8px 24px rgb(${t.shadowRgb} / 0.10); }
.sui-msg-scroller-button[data-target='start'] { bottom:auto; top:14px; }
.sui-msg-scroller-button[data-active='false'] { display:none; }
.sui-msg-scroller-button:hover { background:${t.secondary}; }
.sui-msg-scroller-button:focus-visible { ${focusRing} }
`;
