/** @jsxImportSource react */
/**
 * The package's one sheet: the repository view, the code view and the diff
 * view's frame. Every rule reads `@smthrs/ui`'s theme tokens, so the views
 * follow light and dark, and every class is `sui-` namespaced like the rest
 * of the Smithers components. The Markdown editor ships its own sheet
 * (`markdownEditorCss`).
 *
 * The repository view sizes itself from its own width, not the window's
 * (`container-type: inline-size`), so the same view lays out right as a page
 * and inside a conversation: below 720px it drops the tree and stacks.
 */
import { tokens as t } from "@smthrs/ui-css";
import { useInsertionEffect } from "react";

const focusRing = `outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring};`;
const interaction = "transition:background-color .12s ease, border-color .12s ease, color .12s ease;";

/** `PierreDiffView`: a thin frame; pierre's `CodeView` owns the highlighted body. */
const pierreDiffCss = `
.sui-pierre-diff-frame { min-width:0; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; }
.sui-pierre-diff { --diffs-font-family:${t.fontMono}; --diffs-header-font-family:${t.fontSans}; --diffs-light-bg:${t.card}; --diffs-dark-bg:${t.card}; --diffs-light:${t.foreground}; --diffs-dark:${t.foreground}; --diffs-addition-color:${t.success}; --diffs-deletion-color:${t.destructive}; --diffs-bg-addition-override:${t.successSoft}; --diffs-bg-deletion-override:${t.destructiveSoft}; --diffs-bg-context-override:${t.surface2}; --diffs-bg-separator-override:${t.surface2}; --diffs-fg-number-override:${t.mutedForeground}; display:block; min-width:0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; overflow:hidden; }
.sui-pierre-diff-empty { padding:24px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; text-align:center; color:${t.mutedForeground}; font-size:13px; }
`;

/*
 * `CodeFileView`: one file on the same pierre engine. The frame follows the
 * house CODE tokens on both theme axes so a file reads like the app's other
 * code, and pierre's own background variables point at the same token. The
 * plain `<pre>` is the complete state until pierre has painted; the view
 * flips `data-state` and the sheet hides the fallback.
 */
const codeViewCss = `
.sui-code-view { --diffs-font-family:${t.fontMono}; --diffs-light-bg:${t.codeBg}; --diffs-dark-bg:${t.codeBg}; --diffs-light:${t.codeText}; --diffs-dark:${t.codeText}; --diffs-fg-number-override:${t.mutedForeground}; display:block; min-width:0; border-radius:${t.radius}; background:${t.codeBg}; color:${t.codeText}; overflow:hidden; }
.sui-code-view > diffs-container { display:block; min-width:0; }
.sui-code-view-plain { margin:0; padding:12px 14px; font-family:${t.fontMono}; font-size:12px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; tab-size:4; }
.sui-code-view[data-state="ready"] > .sui-code-view-plain { display:none; }
.sui-code-view { position:relative; }
.sui-code-view[tabindex]:focus-visible { outline:none; box-shadow:inset 0 0 0 2px ${t.ringBorder}; }
.sui-code-view:has(> .sui-code-hover) { overflow:visible; }
.sui-code-hover { position:absolute; top:0; left:0; z-index:5; width:max-content; max-width:min(560px, calc(100% - 24px)); visibility:hidden; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.popover}; color:${t.popoverForeground}; box-shadow:0 8px 24px color-mix(in srgb, ${t.foreground} 14%, transparent); font-family:${t.fontSans}; font-size:13px; line-height:1.5; overflow:hidden; }
.sui-code-hover[data-placed] { visibility:visible; }
.sui-code-hover-signature { margin:0; padding:8px 12px; background:${t.codeBg}; color:${t.codeText}; font-family:${t.fontMono}; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
.sui-code-hover-body { padding:8px 12px; color:${t.mutedForeground}; max-height:240px; overflow:auto; }
.sui-code-hover-body > :first-child { margin-top:0; }
.sui-code-hover-body > :last-child { margin-bottom:0; }
.sui-code-hover-problems { margin:0; padding:8px 12px; list-style:none; border-top:1px solid ${t.border}; display:grid; gap:4px; }
.sui-code-hover-problems > [data-severity="error"] { color:${t.destructive}; }
.sui-code-hover-problems > [data-severity="warning"] { color:${t.warning}; }
.sui-code-hover-problems > [data-severity="info"] { color:${t.info}; }
`;

/** `RepoView`: the tree beside the content, the header, a directory's listing and README, and a file. */
const repositoryCss = `
.sui-repo { container-type:inline-size; min-width:0; color:${t.foreground}; }
.sui-repo-layout { min-width:0; display:grid; grid-template-columns:minmax(0, 1fr); gap:16px; }
.sui-repo[data-size='full'] > .sui-repo-layout { grid-template-columns:240px minmax(0, 1fr); align-items:start; }
.sui-repo-side { position:sticky; top:0; min-width:0; max-height:100vh; display:grid; gap:4px; padding-right:12px; border-right:1px solid ${t.border}; overflow:auto; }
.sui-repo-main { min-width:0; display:grid; align-content:start; gap:12px; }
.sui-repo-head { min-width:0; display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.sui-repo-revision { flex:none; display:inline-flex; align-items:center; }
.sui-repo-trail { flex:1 1 auto; }
.sui-repo-actions { flex:none; display:flex; align-items:center; gap:8px; margin-left:auto; }
.sui-repo-summary { min-width:0; }
.sui-repo-content { min-width:0; display:grid; align-content:start; gap:16px; }
.sui-repo[data-size='inline'] .sui-repo-content { max-height:420px; overflow:auto; }
.sui-repo-box { min-width:0; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; overflow:hidden; }
.sui-repo-readme > .sui-markdown-editor,
.sui-repo-file > .sui-markdown-editor { height:auto; }
.sui-repo-toolbar { min-width:0; display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:8px 14px; border-bottom:1px solid ${t.border}; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; }
.sui-repo-readme-name { color:${t.foreground}; font-weight:650; text-decoration:none; border-radius:${t.radiusControl}; }
.sui-repo-readme-name:hover { text-decoration:underline; }
.sui-repo-readme-name:focus-visible { ${focusRing} }
@media (max-width:960px) {
  .sui-repo-readme-name { display:inline-flex; align-items:center; min-height:${t.controlHeight}; }
}
.sui-repo-stats { min-width:0; font-variant-numeric:tabular-nums; }
.sui-repo-file-actions { display:flex; align-items:center; gap:8px; margin-left:auto; }
.sui-repo-file-badges { display:flex; align-items:center; gap:6px; }
.sui-repo-segmented { display:inline-flex; padding:2px; gap:2px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.secondary}; }
.sui-repo-segment { padding:2px 10px; border:none; border-radius:4px; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:${t.fontSizeCompact}; cursor:pointer; ${interaction} }
.sui-repo-segment:hover { color:${t.foreground}; }
.sui-repo-segment:focus-visible { ${focusRing} }
.sui-repo-segment[aria-pressed='true'] { background:${t.card}; color:${t.foreground}; font-weight:650; }
@media (max-width:960px) {
  .sui-repo-segment { min-width:32px; min-height:${t.controlHeight}; }
}
.sui-repo-note { padding:14px; color:${t.mutedForeground}; font-size:13px; }
/* The files or a file still loading: skeleton lines where they will be. */
.sui-repo-loading { display:grid; gap:12px; padding:14px; }
.sui-repo-skeleton { height:16px; }
.sui-repo-skeleton-short { width:55%; }
.sui-repo-code { border-radius:0; }
/* No tree on the left; an about panel on the right, as GitHub's repository page. */
.sui-repo[data-size='full'][data-tree='false'] > .sui-repo-layout { grid-template-columns:minmax(0, 1fr); }
.sui-repo[data-size='full'][data-aside='true'] > .sui-repo-layout { grid-template-columns:240px minmax(0, 1fr) 280px; }
.sui-repo[data-size='full'][data-tree='false'][data-aside='true'] > .sui-repo-layout { grid-template-columns:minmax(0, 1fr) 296px; column-gap:32px; }
.sui-repo-aside { min-width:0; }
/* An HTML file as CodePen shows it: the source beside the page, or either alone. */
.sui-repo-html-split { min-width:0; display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr); }
.sui-repo-html-split > * + * { border-left:1px solid ${t.border}; }
.sui-repo-html-preview { display:block; width:100%; min-height:420px; height:70vh; border:0; color-scheme:light; background:Canvas; }
@container (max-width: 1023px) {
  .sui-repo[data-size='full'][data-aside='true'] > .sui-repo-layout { grid-template-columns:240px minmax(0, 1fr); }
  .sui-repo[data-size='full'][data-tree='false'][data-aside='true'] > .sui-repo-layout { grid-template-columns:minmax(0, 1fr); }
  .sui-repo-aside { grid-column:1 / -1; }
}
@container (max-width: 719px) {
  .sui-repo[data-size='full'] > .sui-repo-layout,
  .sui-repo[data-size='full'][data-aside='true'] > .sui-repo-layout { grid-template-columns:minmax(0, 1fr); }
  .sui-repo-side { display:none; }
  .sui-repo-html-split { grid-template-columns:minmax(0, 1fr); }
  .sui-repo-html-split > * + * { border-left:none; border-top:1px solid ${t.border}; }
}
`;

/** The package's sheet: the diff view's frame, the code view and the repository view. */
/** `SymbolsPane`: a symbol's definitions and references, or the file's outline, beside the code. */
const symbolsPaneCss = `
.sui-repo-aside:has(> .sui-symbols) { position:sticky; top:0; }
.sui-symbols { min-width:0; max-height:100vh; display:flex; flex-direction:column; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; font-size:13px; overflow:auto; }
.sui-symbols-head { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid ${t.border}; }
.sui-symbols-title { min-width:0; margin-right:auto; font-family:${t.fontMono}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-symbols-close { padding:2px 6px; border:none; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; cursor:pointer; ${interaction} }
.sui-symbols-close:hover { color:${t.foreground}; background:${t.secondary}; }
.sui-symbols-close:focus-visible { ${focusRing} }
.sui-symbols-section { padding-bottom:6px; }
.sui-symbols-heading { display:flex; justify-content:space-between; margin:0; padding:8px 12px 4px; color:${t.mutedForeground}; font-size:12px; font-weight:600; }
.sui-symbols-file-name { display:flex; justify-content:space-between; gap:8px; padding:6px 12px 2px; font-weight:600; overflow-wrap:anywhere; }
.sui-symbols-file-name > span { color:${t.mutedForeground}; font-weight:400; }
.sui-symbols-row { display:grid; grid-template-columns:36px minmax(0, 1fr); gap:6px; padding:2px 12px; color:inherit; text-decoration:none; ${interaction} }
.sui-symbols-row:hover { background:${t.secondary}; }
.sui-symbols-row:focus-visible { outline:none; background:${t.primarySoft}; box-shadow:inset 3px 0 ${t.ringBorder}; }
.sui-symbols-line { color:${t.mutedForeground}; text-align:right; font-family:${t.fontMono}; font-size:12px; font-variant-numeric:tabular-nums; }
.sui-symbols-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:${t.fontMono}; font-size:12px; }
.sui-symbols-filter { margin:8px 12px; padding:5px 8px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.background}; color:${t.foreground}; font:inherit; }
.sui-symbols-filter:focus-visible { ${focusRing} }
.sui-symbols-outline-row { grid-template-columns:auto minmax(0, 1fr); align-items:center; }
.sui-symbols-kind { min-width:28px; padding:0 4px; border-radius:4px; background:${t.surface2}; color:${t.mutedForeground}; font:600 10px/16px ${t.fontMono}; text-align:center; }
`;

export const repoViewCss = `${pierreDiffCss}${codeViewCss}${repositoryCss}${symbolsPaneCss}`;

/**
 * Marker attribute on the sheet's `<style>` element. The injection fallback
 * checks for it and stands down when {@link RepoViewStyles} already rendered
 * the sheet.
 */
export const REPO_VIEW_STYLE_ATTR = "data-smithers-repo-view";

/**
 * Renders the package's sheet in a `<style>` tag. Render it once near the
 * root, beside `@smthrs/ui`'s `SmithersUiStyles`, where effects never run:
 * server rendering and `renderToStaticMarkup`. In a browser every view also
 * injects it itself.
 */
export function RepoViewStyles() {
  // Literal attribute: JSX attribute names must be static; keep it equal to REPO_VIEW_STYLE_ATTR.
  return <style data-smithers-repo-view="">{repoViewCss}</style>;
}

/**
 * Browser fallback: appends the sheet to `<head>` once, unless a marked
 * `<style>` is already there. Server rendering never runs insertion effects,
 * so there it does nothing.
 */
export function useInjectRepoViewCss(): void {
  useInsertionEffect(() => {
    if (document.querySelector(`style[${REPO_VIEW_STYLE_ATTR}]`)) return;
    const element = document.createElement("style");
    element.setAttribute(REPO_VIEW_STYLE_ATTR, "");
    element.textContent = repoViewCss;
    document.head.appendChild(element);
  }, []);
}
