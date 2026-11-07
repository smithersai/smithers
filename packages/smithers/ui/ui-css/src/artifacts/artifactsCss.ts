/**
 * coding-artifacts lane stylesheet fragment. Ships as a TypeScript string
 * (never a .css import) composed into smithersUiCss, which every component in
 * this lane injects. Rules follow the css contract:
 * sui- namespace only, colors only through the tokens bridge, no :root.
 */
import { tokens as t } from "../tokens";

export const CODING_ARTIFACTS_CSS_ID = "coding-artifacts";

const focusRing = `outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring};`;

export const artifactsCss = `
.sui-artifact { display:flex; flex-direction:column; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; overflow:hidden; }
.sui-artifact-header { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid ${t.border}; background:${t.surface2}; }
.sui-artifact-title { margin:0; font-size:13px; font-weight:650; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-artifact-description { margin:0; padding:4px 12px 0; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-artifact-actions { display:inline-flex; align-items:center; gap:2px; margin-left:auto; }
.sui-artifact-action { display:inline-flex; align-items:center; justify-content:center; min-width:26px; height:26px; padding:0 6px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:${t.fontSizeCompact}; cursor:pointer; }
.sui-artifact-action:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-artifact-action:focus-visible { ${focusRing} }
.sui-artifact-close { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:18px; line-height:1; cursor:pointer; }
.sui-artifact-close:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-artifact-close:focus-visible { ${focusRing} }
.sui-artifact-content { padding:12px; min-width:0; }

.sui-snippet { display:inline-flex; align-items:center; gap:8px; max-width:100%; padding:4px 6px 4px 10px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.surface2}; color:${t.foreground}; font-size:${t.fontSizeCompact}; }
.sui-snippet-code { font-family:${t.fontMono}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-snippet-copy { flex:none; display:inline-flex; align-items:center; height:22px; padding:0 8px; border:1px solid ${t.input}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font:inherit; font-size:${t.fontSizeCompact}; cursor:pointer; }
.sui-snippet-copy:hover { background:${t.secondary}; }
.sui-snippet-copy:focus-visible { ${focusRing} }

.sui-pkginfo { display:flex; flex-direction:column; gap:8px; padding:12px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; }
.sui-pkginfo-header { display:flex; align-items:baseline; gap:8px; min-width:0; }
.sui-pkginfo-name { font-family:${t.fontMono}; font-size:13px; font-weight:650; color:${t.foreground}; text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
a.sui-pkginfo-name { color:${t.primary}; }
a.sui-pkginfo-name:hover { text-decoration:underline; text-underline-offset:3px; }
.sui-pkginfo-version { font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-pkginfo-description { margin:0; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }

.sui-schema { border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; overflow:hidden; }
.sui-schema-trigger { display:flex; align-items:center; gap:6px; width:100%; padding:8px 12px; border:none; background:${t.surface2}; color:${t.foreground}; font:inherit; font-size:13px; font-weight:650; text-align:left; cursor:pointer; }
.sui-schema-trigger:hover { background:${t.secondary}; }
.sui-schema-trigger:focus-visible { ${focusRing} }
.sui-schema-trigger::before { content:""; flex:none; width:0; height:0; border-left:4px solid ${t.mutedForeground}; border-top:4px solid transparent; border-bottom:4px solid transparent; transition:transform .12s ease; }
.sui-schema[data-state='open'] > .sui-schema-trigger::before { transform:rotate(90deg); }
.sui-schema-content { padding:8px 12px 12px; }
.sui-schema-list { margin:0; display:flex; flex-direction:column; gap:4px; }
.sui-schema-list .sui-schema-list { margin:4px 0 0 12px; padding-left:8px; border-left:1px solid ${t.border}; }
.sui-schema-row { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px; font-size:${t.fontSizeCompact}; }
.sui-schema-name { font-family:${t.fontMono}; font-weight:650; color:${t.foreground}; }
.sui-schema-required { color:${t.destructive}; font-size:${t.fontSizeCompact}; }
.sui-schema-type { font-family:${t.fontMono}; color:${t.info}; }
.sui-schema-description { margin:0; flex-basis:100%; color:${t.mutedForeground}; }

.sui-stack { border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; overflow:hidden; }
.sui-stack-trigger { display:flex; align-items:center; gap:6px; width:100%; padding:8px 12px; border:none; background:${t.surface2}; color:${t.foreground}; font:inherit; font-size:${t.fontSizeCompact}; font-weight:650; text-align:left; cursor:pointer; }
.sui-stack-trigger:hover { background:${t.secondary}; }
.sui-stack-trigger:focus-visible { ${focusRing} }
.sui-stack-trigger::before { content:""; flex:none; width:0; height:0; border-left:4px solid ${t.mutedForeground}; border-top:4px solid transparent; border-bottom:4px solid transparent; transition:transform .12s ease; }
.sui-stack[data-state='open'] > .sui-stack-trigger::before { transform:rotate(90deg); }
.sui-stack-content { padding:4px 0; }
.sui-stack-frames { margin:0; padding:0; list-style:none; }
.sui-stack-frame { padding:2px 12px; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-stack-frame-button { display:block; width:100%; padding:0; border:none; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; border-radius:${t.radiusControl}; }
.sui-stack-frame-button:hover { color:${t.foreground}; background:${t.hoverSubtle}; }
.sui-stack-frame-button:focus-visible { ${focusRing} }
.sui-stack-frame-fn { color:${t.foreground}; }
.sui-stack-frame-loc { color:${t.mutedForeground}; }
.sui-stack-raw { margin:0; padding:8px 12px; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; white-space:pre-wrap; word-break:break-word; }

.sui-tests { display:flex; flex-direction:column; gap:8px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; padding:12px; }
.sui-tests-header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.sui-tests-summary { display:inline-flex; align-items:center; gap:8px; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-tests-summary-count[data-tone='ok'] { color:${t.success}; }
.sui-tests-summary-count[data-tone='bad'] { color:${t.destructive}; }
.sui-tests-summary-count[data-tone='muted'] { color:${t.mutedForeground}; }
.sui-tests-summary-count[data-tone='run'] { color:${t.primary}; }
.sui-tests-duration { font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-tests-progress { flex:1; min-width:120px; }
.sui-tests-content { display:flex; flex-direction:column; gap:6px; }
.sui-tests-suite { border:1px solid ${t.border}; border-radius:${t.radiusControl}; overflow:hidden; }
.sui-tests-suite-trigger { display:flex; align-items:center; gap:8px; width:100%; padding:6px 10px; border:none; background:${t.surface2}; color:${t.foreground}; font:inherit; font-size:13px; text-align:left; cursor:pointer; }
.sui-tests-suite-trigger:hover { background:${t.secondary}; }
.sui-tests-suite-trigger:focus-visible { ${focusRing} }
.sui-tests-suite-trigger::before { content:""; flex:none; width:0; height:0; border-left:4px solid ${t.mutedForeground}; border-top:4px solid transparent; border-bottom:4px solid transparent; transition:transform .12s ease; }
.sui-tests-suite[data-state='open'] > .sui-tests-suite-trigger::before { transform:rotate(90deg); }
.sui-tests-suite-name { font-weight:650; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-tests-suite-stats { font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-tests-suite-content { display:flex; flex-direction:column; }
.sui-tests-row { display:flex; align-items:baseline; gap:8px; padding:4px 10px; font-size:${t.fontSizeCompact}; border-top:1px solid ${t.border}; }
.sui-tests-row[data-status='failed'] { background:${t.destructiveSoft}; }
.sui-tests-name { flex:1; min-width:0; font-family:${t.fontMono}; overflow-wrap:anywhere; }
.sui-tests-row-duration { font-family:${t.fontMono}; color:${t.mutedForeground}; }
.sui-tests-row-detail { flex-basis:100%; display:flex; flex-direction:column; gap:6px; padding:4px 0; }
.sui-tests-row-error { margin:0; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; color:${t.destructive}; white-space:pre-wrap; word-break:break-word; }

.sui-commit { display:flex; flex-direction:column; gap:8px; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; padding:12px; }
.sui-commit-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.sui-commit-author { font-size:13px; font-weight:650; }
.sui-commit-info { display:inline-flex; align-items:center; gap:8px; margin-left:auto; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-commit-message { font-size:13px; overflow-wrap:anywhere; white-space:pre-wrap; }
.sui-commit-metadata { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-commit-hash { font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-commit-hash[data-vcs='jj'] { color:${t.info}; }
.sui-commit-timestamp { font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-commit-actions { display:inline-flex; align-items:center; gap:4px; }
.sui-commit-files { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; border:1px solid ${t.border}; border-radius:${t.radiusControl}; overflow:hidden; }
.sui-commit-file { display:flex; align-items:baseline; gap:8px; padding:4px 10px; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; }
.sui-commit-file + .sui-commit-file { border-top:1px solid ${t.border}; }
.sui-commit-file-status { flex:none; display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:4px; font-size:10px; font-weight:650; }
.sui-commit-file-status[data-tone='ok'] { color:${t.success}; background:${t.successSoft}; }
.sui-commit-file-status[data-tone='bad'] { color:${t.destructive}; background:${t.destructiveSoft}; }
.sui-commit-file-status[data-tone='warn'] { color:${t.warning}; background:${t.warningSoft}; }
.sui-commit-file-status[data-tone='muted'] { color:${t.mutedForeground}; background:${t.secondary}; }
.sui-commit-file-status[data-tone='run'] { color:${t.info}; background:${t.infoSoft}; }
.sui-commit-file-path { flex:1; min-width:0; overflow-wrap:anywhere; }
.sui-commit-file-counts { color:${t.mutedForeground}; }
.sui-commit-file-counts .sui-commit-add { color:${t.success}; }
.sui-commit-file-counts .sui-commit-del { color:${t.destructive}; }

.sui-changesum { display:inline-flex; align-items:center; gap:8px; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-changesum-add { color:${t.success}; }
.sui-changesum-del { color:${t.destructive}; }
.sui-changesum-files { color:${t.mutedForeground}; }

.sui-envvars { display:flex; flex-direction:column; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.foreground}; overflow:hidden; }
.sui-envvar { display:flex; align-items:center; gap:12px; padding:6px 12px; font-size:${t.fontSizeCompact}; }
.sui-envvar + .sui-envvar { border-top:1px solid ${t.border}; }
.sui-envvar-name { font-family:${t.fontMono}; font-weight:650; color:${t.foreground}; }
.sui-envvar-value { font-family:${t.fontMono}; color:${t.mutedForeground}; overflow-wrap:anywhere; }
.sui-envvar-unset { color:${t.placeholder}; }

.sui-secret { display:inline-flex; align-items:center; gap:6px; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; color:${t.foreground}; }
.sui-secret-mask { letter-spacing:2px; color:${t.mutedForeground}; }
.sui-secret-value { overflow-wrap:anywhere; }
.sui-secret-toggle, .sui-secret-copy { display:inline-flex; align-items:center; height:20px; padding:0 6px; border:1px solid transparent; border-radius:${t.radiusControl}; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:11px; cursor:pointer; }
.sui-secret-toggle:hover, .sui-secret-copy:hover { background:${t.secondary}; color:${t.foreground}; }
.sui-secret-toggle:focus-visible, .sui-secret-copy:focus-visible { ${focusRing} }
`;
