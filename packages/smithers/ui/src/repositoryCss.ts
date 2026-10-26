/**
 * Sheets for browsing a repository: the path trail (`Breadcrumbs`), one
 * directory's rows (`DirectoryListing`), the branch and tag picker
 * (`RefPicker`) and a panel anchored to its trigger (`Popover`). Composed into
 * `smithersUiCss` like every other sheet. `RepoView`, which composes them with
 * the file tree, the code view and the Markdown editor, ships its own sheet in
 * `@smthrs/repo-view`.
 */
import { tokens as t } from "./tokens";

const focusRing = `outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring};`;
const interaction = "transition:background-color .12s ease, border-color .12s ease, color .12s ease;";

export const breadcrumbsCss = `
.sui-breadcrumbs { min-width:0; font-size:13px; }
.sui-breadcrumbs-list { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin:0; padding:0; list-style:none; }
.sui-breadcrumbs-item { display:inline-flex; align-items:center; gap:4px; min-width:0; }
.sui-breadcrumbs-separator { color:${t.mutedForeground}; }
.sui-breadcrumbs-link { color:${t.primary}; text-decoration:none; border-radius:${t.radiusControl}; overflow-wrap:anywhere; }
.sui-breadcrumbs-link:hover { text-decoration:underline; }
.sui-breadcrumbs-link:focus-visible { ${focusRing} }
@media (max-width:960px) {
  .sui-breadcrumbs-link { display:inline-flex; align-items:center; min-height:${t.controlHeight}; min-width:32px; }
}
.sui-breadcrumbs-current { color:${t.foreground}; font-weight:650; overflow-wrap:anywhere; }
`;

export const directoryListingCss = `
.sui-dir { min-width:0; }
.sui-dir-list { margin:0; padding:0; list-style:none; }
.sui-dir-row { min-width:0; border-bottom:1px solid ${t.border}; }
.sui-dir-row:last-child { border-bottom:none; }
.sui-dir-link { min-width:0; display:flex; align-items:center; gap:10px; padding:8px 14px; color:${t.foreground}; font-size:13px; text-decoration:none; ${interaction} }
.sui-dir-link:hover { background:${t.hoverSubtle}; }
.sui-dir-link:hover .sui-dir-name { color:${t.primary}; text-decoration:underline; }
.sui-dir-link:focus-visible { ${focusRing} }
.sui-dir-icon { flex:none; width:16px; height:16px; color:${t.mutedForeground}; }
.sui-dir-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-dir-empty { padding:14px; color:${t.mutedForeground}; font-size:13px; }
`;

export const popoverCss = `
.sui-popover-content { z-index:50; min-width:220px; max-width:calc(100vw - 32px); padding:8px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.popover}; color:${t.popoverForeground}; box-shadow:${t.shadow3}; outline:none; }
`;

export const refPickerCss = `
.sui-ref-picker { display:inline-flex; min-width:0; }
.sui-ref-picker-trigger { max-width:240px; }
.sui-ref-picker-icon { flex:none; width:14px; height:14px; }
.sui-ref-picker-current { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; }
.sui-ref-picker-panel { width:300px; display:grid; gap:8px; }
.sui-ref-picker-filter { width:100%; }
.sui-ref-picker-list { max-height:280px; margin:0; padding:0; list-style:none; overflow-y:auto; }
.sui-ref-picker-item { min-width:0; display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:${t.radiusControl}; color:${t.foreground}; font-size:13px; text-decoration:none; ${interaction} }
.sui-ref-picker-item:hover { background:${t.hoverSubtle}; }
.sui-ref-picker-item:focus-visible { ${focusRing} }
.sui-ref-picker-item[aria-current='true'] { font-weight:650; }
.sui-ref-picker-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-ref-picker-sha { flex:none; color:${t.mutedForeground}; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; }
.sui-ref-picker-note { padding:8px; color:${t.mutedForeground}; font-size:13px; }
/* Branches and tags still loading: rows the size of the list's, in its place. */
.sui-ref-picker-loading { display:grid; gap:4px; padding:4px 8px; }
.sui-ref-picker-skeleton { height:19.5px; width:70%; }
`;

export const repoAboutCss = `
.sui-repo-about { position:relative; min-width:0; display:grid; gap:0; font-size:13px; color:${t.foreground}; }
.sui-repo-about-section { display:grid; gap:10px; padding:16px 0; border-bottom:1px solid ${t.border}; }
.sui-repo-about-section:first-of-type { padding-top:0; }
.sui-repo-about-section:last-of-type { border-bottom:none; }
.sui-repo-about-heading { display:flex; align-items:center; gap:6px; margin:0; font-size:15px; font-weight:650; }
.sui-repo-about-count { padding:0 6px; border-radius:${t.radiusFull}; background:${t.muted}; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; font-weight:650; line-height:18px; }
.sui-repo-about-description { margin:0; font-size:15px; line-height:1.5; overflow-wrap:anywhere; }
.sui-repo-about-homepage { color:${t.primary}; font-weight:650; text-decoration:none; overflow-wrap:anywhere; }
.sui-repo-about-homepage:hover { text-decoration:underline; }
.sui-repo-about-homepage:focus-visible { ${focusRing} }
.sui-repo-about-topics { display:flex; flex-wrap:wrap; gap:6px; margin:0; padding:0; list-style:none; }
.sui-repo-about-topic { padding:2px 10px; border-radius:${t.radiusFull}; background:${t.primarySoft}; color:${t.primary}; font-size:${t.fontSizeCompact}; font-weight:650; line-height:20px; }
.sui-repo-about-stats { display:grid; gap:6px; margin:0; padding:0; list-style:none; color:${t.mutedForeground}; }
.sui-repo-about-release { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; }
.sui-repo-about-release-name { color:${t.foreground}; font-weight:650; text-decoration:none; overflow-wrap:anywhere; }
a.sui-repo-about-release-name { display:inline-flex; align-items:center; min-height:${t.controlHeight}; min-width:${t.controlHeight}; }
a.sui-repo-about-release-name:hover { color:${t.primary}; text-decoration:underline; }
.sui-repo-about-latest { padding:0 6px; border:1px solid ${t.successBorder}; border-radius:${t.radiusFull}; color:${t.success}; font-size:${t.fontSizeCompact}; font-weight:650; line-height:18px; }
.sui-repo-about-muted { color:${t.mutedForeground}; }
.sui-repo-about-people { display:flex; flex-wrap:wrap; gap:6px; margin:0; padding:0; list-style:none; }
.sui-repo-about-people a { display:block; border-radius:${t.radiusFull}; }
.sui-repo-about-people a:focus-visible { ${focusRing} }
.sui-repo-about-avatar { display:block; width:28px; height:28px; border-radius:${t.radiusFull}; background:${t.muted}; }
@media (max-width:960px) {
  .sui-repo-about-people a { display:flex; align-items:center; justify-content:center; min-width:32px; min-height:${t.controlHeight}; }
}
.sui-repo-about-bar { display:flex; height:8px; overflow:hidden; border-radius:${t.radiusFull}; background:${t.muted}; }
.sui-repo-about-bar > span { display:block; height:100%; }
.sui-repo-about-bar > span + span { margin-left:2px; }
.sui-repo-about-languages { display:flex; flex-wrap:wrap; gap:6px 16px; margin:0; padding:0; list-style:none; }
.sui-repo-about-languages li { display:inline-flex; align-items:center; gap:6px; }
.sui-repo-about-dot { width:8px; height:8px; border-radius:${t.radiusFull}; }
.sui-repo-about-language { font-weight:650; }
.sui-repo-about-footer { padding-top:16px; border-top:1px solid ${t.border}; color:${t.mutedForeground}; }
`;

export const generatedChipCss = `
.sui-generated-chip { border:none; font:inherit; cursor:pointer; }
.sui-generated-chip:focus-visible { ${focusRing} }
.sui-generated-links { display:grid; gap:6px; margin:0; padding:4px; list-style:none; font-size:13px; }
.sui-generated-row { display:grid; grid-template-columns:72px minmax(0, 1fr); align-items:baseline; gap:8px; }
.sui-generated-label { color:${t.mutedForeground}; }
.sui-generated-row code { overflow-wrap:anywhere; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; }
.sui-generated-row a { color:${t.primary}; text-decoration:none; }
.sui-generated-row a:hover { text-decoration:underline; }
.sui-generated-row a:focus-visible { ${focusRing} }
`;
