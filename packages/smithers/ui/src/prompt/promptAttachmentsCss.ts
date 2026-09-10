/**
 * prompt-attachments lane stylesheet fragment: PromptInput family and the
 * Attachment compound parts. Obeys the css-contract: sui- namespace only, no
 * :root, colors only through the tokens bridge with byte-equal light
 * fallbacks, tints only via color-mix(in srgb, ...). Composed into
 * smithersUiCss, which every component in this lane injects.
 */
import { tokens as t } from "../tokens";

export const PROMPT_ATTACHMENTS_CSS_ID = "prompt-attachments";

const focusRing = `outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring};`;

export const promptAttachmentsCss = `

.sui-prompt { position:relative; display:grid; gap:8px; width:100%; padding:12px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; box-shadow:0 1px 2px rgb(${t.shadowRgb} / 0.04); transition:border-color .15s ease, box-shadow .15s ease; }
.sui-prompt:focus-within { border-color:color-mix(in srgb, ${t.primary} 32%, ${t.border}); box-shadow:0 0 0 4px color-mix(in srgb, ${t.primary} 12%, transparent), 0 1px 2px rgb(${t.shadowRgb} / 0.05); }
.sui-prompt[data-disabled='true'] { opacity:.6; }
.sui-prompt[data-drop-active='true'] { border-color:${t.primaryBorder}; background:${t.primarySoft}; }
.sui-prompt-header { min-width:0; display:flex; align-items:center; gap:8px; }
.sui-prompt-body { min-width:0; display:grid; gap:8px; }
.sui-prompt-attachments { min-width:0; display:flex; flex-wrap:wrap; gap:8px; }
.sui-prompt-textarea { width:100%; min-width:0; min-height:24px; max-height:240px; padding:2px 4px; resize:none; overflow-y:auto; border:0; outline:0; background:transparent; color:${t.foreground}; font:inherit; font-size:16px; line-height:1.5; }
.sui-prompt-textarea::placeholder { color:${t.placeholder}; }
.sui-prompt-textarea:disabled { cursor:not-allowed; opacity:.55; }
.sui-prompt-footer { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sui-prompt-tools { min-width:0; display:flex; align-items:center; gap:4px; flex:1 1 auto; }
.sui-prompt-button { min-height:28px; display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:0 8px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; user-select:none; }
.sui-prompt-button:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-prompt-button:focus-visible { ${focusRing} }
.sui-prompt-button:disabled { cursor:not-allowed; opacity:.45; }
.sui-prompt-submit { width:30px; height:30px; min-height:30px; display:inline-flex; align-items:center; justify-content:center; padding:0; border:1px solid ${t.primary}; border-radius:${t.radiusControl}; background:${t.primary}; color:${t.primaryForeground}; font:inherit; font-size:15px; cursor:pointer; flex:none; }
.sui-prompt-submit:hover:not(:disabled) { background:color-mix(in srgb, ${t.primary} 88%, ${t.foreground}); }
.sui-prompt-submit:focus-visible { ${focusRing} }
.sui-prompt-submit:disabled { cursor:not-allowed; opacity:.45; }
.sui-prompt-submit[data-status='error'] { border-color:${t.destructiveBorder}; background:${t.destructiveSoft}; color:${t.destructive}; }
.sui-prompt-stop { width:30px; height:30px; min-height:30px; display:inline-flex; align-items:center; justify-content:center; padding:0; border:1px solid ${t.input}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font:inherit; cursor:pointer; flex:none; }
.sui-prompt-stop:hover { background:${t.secondary}; }
.sui-prompt-stop:focus-visible { ${focusRing} }
.sui-prompt-action-menu { position:relative; display:inline-flex; }
.sui-prompt-action-menu-content { position:absolute; bottom:calc(100% + 6px); left:0; z-index:50; min-width:180px; display:grid; gap:2px; padding:4px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.popover}; color:${t.popoverForeground}; box-shadow:0 4px 12px rgb(${t.shadowRgb} / 0.10), 0 16px 48px rgb(${t.shadowRgb} / 0.16); }
.sui-prompt-action-menu-item { display:flex; align-items:center; gap:8px; width:100%; min-height:30px; padding:4px 8px; border:0; border-radius:${t.radiusControl}; background:transparent; color:${t.foreground}; font:inherit; font-size:13px; text-align:left; cursor:pointer; }
.sui-prompt-action-menu-item:hover, .sui-prompt-action-menu-item[data-highlighted='true'] { background:${t.secondary}; }
.sui-prompt-action-menu-item:focus-visible { ${focusRing} }

.sui-attachment-group { min-width:0; display:flex; flex-wrap:wrap; gap:8px; }
.sui-attachment-trigger { display:contents; padding:0; border:0; background:transparent; font:inherit; text-align:left; cursor:pointer; }
.sui-attachment-media { width:48px; height:48px; display:grid; place-items:center; overflow:hidden; border-radius:${t.radiusControl}; background:${t.secondary}; color:${t.mutedForeground}; flex:none; }
.sui-attachment-media img { width:100%; height:100%; object-fit:cover; }
.sui-attachment-content { min-width:0; display:grid; gap:2px; }
.sui-attachment-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:${t.fontSizeCompact}; font-weight:650; }
.sui-attachment-description { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${t.mutedForeground}; font-size:11px; }
.sui-attachment-actions { display:flex; align-items:center; gap:2px; }
.sui-attachment-action { min-width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; gap:4px; padding:0 6px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:12px; cursor:pointer; }
.sui-attachment-action:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-attachment-action:focus-visible { ${focusRing} }
.sui-attachment-action:disabled { cursor:not-allowed; opacity:.45; }
.sui-attachment-preview { width:100%; max-width:240px; overflow:hidden; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.secondary}; }
.sui-attachment-preview img { display:block; width:100%; height:auto; object-fit:cover; }
.sui-attachment-preview-tile { display:grid; place-items:center; min-height:64px; padding:8px; color:${t.mutedForeground}; font-family:${t.fontMono}; font-size:11px; font-weight:650; }
.sui-attachment[data-state='error'] .sui-attachment-title, .sui-attachment[data-state='error'] .sui-attachment-description { color:${t.destructive}; }
`;
