import { tokens as t } from "./tokens";

/** The house interaction speed, as in uiCss.ts. */
const interaction = "transition:background-color .12s ease, border-color .12s ease, color .12s ease;";

/**
 * `Kbd`'s sheet: a mono key chip with a 2px bottom edge. 10px is the
 * geometry contract's micro-label size; the type scale has no half step.
 */
export const kbdCss = `
.sui-kbd { padding:2px 4px; border:1px solid ${t.borderStrong}; border-bottom-width:2px; border-radius:4px; background:${t.card}; color:${t.mutedForeground}; font:500 10px/1 ${t.fontMono}; white-space:nowrap; }
`;

/**
 * `SegmentedControl`'s sheet: one border around, hairline dividers between,
 * the checked option on the strong brand tint, a disabled one struck through.
 * The focus ring is inset because the group clips its corners.
 */
export const segmentedControlCss = `
.sui-segmented { display:inline-flex; align-items:stretch; height:${t.controlHeight}; border:1px solid ${t.borderStrong}; border-radius:${t.radiusControl}; overflow:hidden; background:${t.card}; }
.sui-segmented[data-size='sm'] { height:var(--ctl-h-sm, 28px); }
.sui-segmented-item { display:inline-flex; align-items:center; gap:6px; margin:0; padding:0 10px; border:0; background:${t.card}; color:${t.mutedForeground}; font:inherit; font-size:${t.fontSizeCompact}; white-space:nowrap; cursor:pointer; ${interaction} }
@media (max-width:960px) { .sui-segmented { min-height:calc(${t.controlHeight} + 2px); } .sui-segmented-item { min-height:${t.controlHeight}; min-width:32px; } }
.sui-segmented-item + .sui-segmented-item { border-left:1px solid ${t.borderStrong}; }
.sui-segmented-item:hover:not(:disabled) { background:${t.secondary}; color:${t.foreground}; }
.sui-segmented-item[aria-checked='true'] { background:${t.primarySoftStrong}; color:${t.foreground}; }
.sui-segmented-item:focus-visible { outline:none; box-shadow:inset 0 0 0 1px ${t.ringBorder}, inset 0 0 0 3px ${t.ring}; }
.sui-segmented-item:disabled { color:${t.textFaint}; text-decoration:line-through; cursor:not-allowed; }
`;

/**
 * `CommandPalette`'s sheet: a panel 12vh from the top over the dialog
 * backdrop, a 46px input with only a bottom hairline, and the highlighted row
 * on the brand tint.
 */
export const commandPaletteCss = `
.sui-command-palette { position:fixed; top:12vh; left:50%; transform:translateX(-50%); z-index:50; display:flex; flex-direction:column; width:calc(100vw - 32px); max-width:640px; max-height:76vh; overflow:hidden; border:1px solid ${t.borderStrong}; border-radius:var(--r-3, 12px); background:${t.card}; color:${t.foreground}; box-shadow:${t.shadow3}; }
.sui-command-palette-input { flex:none; width:100%; height:46px; margin:0; padding:0 16px; border:0; border-bottom:1px solid ${t.border}; border-radius:0; background:transparent; color:${t.foreground}; font:inherit; font-size:var(--fs-4, 15px); outline:none; }
.sui-command-palette-input::placeholder { color:${t.placeholder}; }
.sui-command-palette-list { min-height:0; max-height:420px; overflow:auto; padding:6px; }
.sui-command-palette-list:empty { display:none; }
.sui-command-palette-option { display:flex; align-items:center; gap:10px; min-width:0; padding:6px 10px; border-radius:${t.radiusControl}; color:${t.foreground}; cursor:pointer; }
.sui-command-palette-option:hover { background:${t.hoverSubtle}; }
.sui-command-palette-option[aria-selected='true'] { background:${t.primarySoft}; }
.sui-command-palette-badge { flex:none; display:inline-flex; }
.sui-command-palette-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-command-palette-detail { flex:none; margin-left:auto; color:${t.textFaint}; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; }
.sui-command-palette-footer { flex:none; display:flex; align-items:center; gap:14px; padding:8px 14px; border-top:1px solid ${t.border}; color:${t.textFaint}; font-size:var(--fs-1, 11px); }
`;
