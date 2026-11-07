import { tokens as t } from "./tokens";

/**
 * The six lanes a person's avatar paints with. A host that defines the lane
 * palette (`--lane-0` to `--lane-5`)
 * colors avatars with it; any other host gets the theme's own hues, which
 * follow light and dark. `--avatar-ink` is the initial's color, the theme's
 * inverse text by default, so the initial reads on every lane in both themes.
 */
const LANE_FALLBACKS = [t.destructive, t.info, t.mutedForeground, t.warning, t.primary, t.success] as const;

const laneCss = LANE_FALLBACKS.map(
  (fallback, lane) => `.sui-avatar[data-lane='${lane}'] { --sui-avatar-lane:var(--lane-${lane}, ${fallback}); }`,
).join("\n");

/**
 * `AvatarStack`'s sheet: overlapping 24px circles, each ringed in the page
 * background (`--sui-avatar-ring`, default `--bg`, so a host on a card surface
 * sets it to `--surface`) so an overlap reads in both themes, and a `+N` pill
 * for the rest. The hovered or focused avatar rises above its neighbors.
 */
export const avatarStackCss = `
.sui-avatar { flex:none; width:24px; height:24px; display:inline-flex; align-items:center; justify-content:center; border-radius:${t.radiusFull}; background:var(--sui-avatar-lane, ${t.mutedForeground}); color:var(--avatar-ink, ${t.inverseText}); font-size:11px; font-weight:650; line-height:1; user-select:none; }
${laneCss}
button.sui-avatar { margin:0; padding:0; border:0; font-family:inherit; cursor:pointer; }
.sui-avatar-stack { min-width:0; display:inline-flex; align-items:center; margin:0; padding:0; list-style:none; }
.sui-avatar-stack > li { position:relative; display:inline-flex; }
.sui-avatar-stack > li + li { margin-left:-6px; }
.sui-avatar-stack > li:hover, .sui-avatar-stack > li:focus-within { z-index:1; }
.sui-avatar-stack .sui-avatar { box-shadow:0 0 0 2px var(--sui-avatar-ring, ${t.background}); }
.sui-avatar-stack button.sui-avatar:focus-visible, .sui-avatar-more:focus-visible { outline:none; box-shadow:0 0 0 2px var(--sui-avatar-ring, ${t.background}), 0 0 0 4px ${t.ringBorder}; }
.sui-avatar-more { width:auto; min-width:24px; padding:0 6px; background:${t.surface2}; color:${t.mutedForeground}; }
@media (max-width:960px) {
  button.sui-avatar { min-width:32px; min-height:${t.controlHeight}; }
  .sui-avatar-stack { flex-wrap:wrap; gap:4px; }
  .sui-avatar-stack > li + li { margin-left:0; }
}
`;

/**
 * `ShareDialog`'s sheet, after Google Docs: the add row, the people rows with
 * a quiet access menu and Remove, the general access row with its icon, and a
 * footer with Copy link at the start and Done at the end.
 */
export const shareDialogCss = `
.sui-share-dialog { max-width:520px; gap:16px; }
.sui-share-dialog .sui-dialog-title { font-size:15px; }
.sui-share-add { display:flex; align-items:center; gap:8px; }
.sui-share-add-input { flex:1 1 auto; min-width:0; }
.sui-share-error { margin:0; color:${t.destructive}; font-size:${t.fontSizeCompact}; }
.sui-share-section { min-width:0; display:grid; gap:6px; }
.sui-share-heading { margin:0; color:${t.cardForeground}; font-size:13px; font-weight:650; }
.sui-share-people { min-width:0; max-height:280px; overflow:auto; display:grid; gap:2px; margin:0; padding:0; list-style:none; }
.sui-share-person { min-width:0; min-height:40px; display:flex; align-items:center; gap:10px; }
.sui-share-person .sui-avatar, .sui-share-general-icon { width:28px; height:28px; font-size:12px; }
.sui-share-name { flex:1 1 auto; min-width:0; overflow:hidden; color:${t.foreground}; font-size:13px; text-overflow:ellipsis; white-space:nowrap; }
.sui-share-owner { padding:0 10px; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-share-quiet { border-color:transparent; background:transparent; }
.sui-share-general { min-width:0; display:flex; align-items:center; gap:10px; }
.sui-share-general-icon { flex:none; display:inline-flex; align-items:center; justify-content:center; border-radius:${t.radiusFull}; background:${t.surface2}; color:${t.mutedForeground}; }
.sui-share-general-icon[data-general='link'] { background:${t.primarySoft}; color:${t.primary}; }
.sui-share-general-controls { flex:1 1 auto; min-width:0; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; }
.sui-share-footer { justify-content:space-between; }
`;
