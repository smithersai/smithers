/**
 * Styles for a GitHub-style user or organization profile (`OwnerProfile`).
 * Composed into `smithersUiCss` like every other sheet; every color flows
 * through `tokens.ts` so light and dark themes work automatically.
 */
import { tokens as t } from "./tokens.ts";

const focusRing = `outline:none; border-color:${t.ringBorder}; box-shadow:0 0 0 3px ${t.ring};`;
const interaction = "transition:background-color .12s ease, border-color .12s ease, color .12s ease;";

export const profileCss = `
.sui-profile { position:relative; min-width:0; display:grid; grid-template-columns:296px minmax(0, 1fr); align-items:start; gap:24px; color:${t.foreground}; font-size:13px; }
.sui-profile-sidebar { min-width:0; display:grid; align-content:start; gap:16px; }
.sui-profile-identity { min-width:0; display:grid; gap:16px; }
.sui-profile-avatar-wrap { position:relative; width:260px; max-width:100%; aspect-ratio:1 / 1; border-radius:${t.radiusFull}; overflow:hidden; border:1px solid ${t.border}; background:${t.muted}; display:grid; place-items:center; color:${t.mutedForeground}; font-size:20px; font-weight:650; }
.sui-profile-avatar-wrap[data-kind='Organization'] { border-radius:${t.radius}; }
.sui-profile-avatar { display:block; width:100%; height:100%; object-fit:cover; }
.sui-profile-names { min-width:0; display:grid; gap:2px; }
.sui-profile-name { margin:0; font-size:20px; font-weight:650; line-height:1.25; overflow-wrap:anywhere; }
.sui-profile-login-row { display:flex; align-items:center; flex-wrap:wrap; gap:8px; color:${t.mutedForeground}; font-size:16px; line-height:1.4; }
.sui-profile-login { overflow-wrap:anywhere; }
.sui-profile-pronouns { font-size:13px; color:${t.mutedForeground}; }
.sui-profile-status { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.card}; color:${t.foreground}; font-size:12px; line-height:1.4; overflow-wrap:anywhere; }
.sui-profile-bio { margin:0; font-size:15px; line-height:1.5; color:${t.foreground}; overflow-wrap:anywhere; }
.sui-profile-follows { display:flex; align-items:center; flex-wrap:wrap; gap:6px; color:${t.mutedForeground}; font-size:13px; }
.sui-profile-follows strong { color:${t.foreground}; font-weight:650; font-variant-numeric:tabular-nums; }
.sui-profile-details { display:grid; gap:6px; margin:0; padding:0; list-style:none; color:${t.foreground}; font-size:13px; }
.sui-profile-details li { display:flex; align-items:center; gap:8px; min-width:0; }
.sui-profile-detail-icon { flex:none; width:16px; height:16px; color:${t.mutedForeground}; }
.sui-profile-detail-text { min-width:0; overflow-wrap:anywhere; }
.sui-profile-detail-link { min-width:0; color:${t.foreground}; text-decoration:none; overflow-wrap:anywhere; }
.sui-profile-detail-link:hover { color:${t.primary}; text-decoration:underline; }
.sui-profile-detail-link:focus-visible { ${focusRing} border-radius:${t.radiusControl}; }
.sui-profile-section { display:grid; gap:10px; padding-top:16px; border-top:1px solid ${t.border}; }
.sui-profile-section-title { margin:0; font-size:15px; font-weight:650; color:${t.foreground}; }
.sui-profile-orgs { display:flex; flex-wrap:wrap; gap:6px; margin:0; padding:0; list-style:none; }
.sui-profile-org-link { display:block; width:${t.controlHeight}; height:${t.controlHeight}; border:1px solid ${t.border}; border-radius:${t.radiusControl}; overflow:hidden; background:${t.muted}; }
.sui-profile-org-link:focus-visible { ${focusRing} }
.sui-profile-org-avatar { display:block; width:100%; height:100%; object-fit:cover; }

.sui-profile-main { min-width:0; display:grid; align-content:start; gap:20px; }
.sui-profile-tabs { display:flex; align-items:center; gap:4px; min-width:0; overflow-x:auto; border-bottom:1px solid ${t.border}; }
.sui-profile-tab { display:inline-flex; align-items:center; gap:6px; min-height:${t.controlHeight}; padding:8px 12px; border:none; border-bottom:2px solid transparent; margin-bottom:-1px; background:transparent; color:${t.mutedForeground}; font:inherit; font-size:13px; font-weight:500; text-decoration:none; cursor:pointer; white-space:nowrap; ${interaction} }
.sui-profile-tab:hover { color:${t.foreground}; }
.sui-profile-tab:focus-visible { ${focusRing} border-radius:${t.radiusControl}; }
.sui-profile-tab[aria-current='page'] { color:${t.foreground}; border-bottom-color:${t.primary}; font-weight:650; }
.sui-profile-tab-count { padding:0 6px; border-radius:${t.radiusFull}; background:${t.muted}; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; font-weight:650; line-height:18px; font-variant-numeric:tabular-nums; }

.sui-profile-block { min-width:0; display:grid; gap:12px; }
.sui-profile-block-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.sui-profile-block-title { margin:0; font-size:15px; font-weight:650; color:${t.foreground}; }

.sui-profile-readme { padding:0; gap:0; overflow:hidden; }
.sui-profile-readme-bar { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 16px; border-bottom:1px solid ${t.border}; background:${t.surface2}; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; color:${t.mutedForeground}; }
.sui-profile-readme-bar a { color:${t.foreground}; text-decoration:none; font-weight:650; }
.sui-profile-readme-bar a:hover { color:${t.primary}; text-decoration:underline; }
.sui-profile-readme-body { padding:20px 24px; min-width:0; overflow-x:auto; }

.sui-profile-pinned { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; margin:0; padding:0; list-style:none; }
.sui-profile-pinned-card { display:grid; grid-template-rows:auto 1fr auto; gap:8px; min-height:112px; }
.sui-profile-repo-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
.sui-profile-repo-name { color:${t.primary}; font-size:15px; font-weight:650; text-decoration:none; overflow-wrap:anywhere; }
.sui-profile-repo-name:hover { text-decoration:underline; }
.sui-profile-repo-name:focus-visible { ${focusRing} border-radius:${t.radiusControl}; }
.sui-profile-repo-desc { margin:0; color:${t.mutedForeground}; font-size:13px; line-height:1.45; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.sui-profile-repo-meta { display:flex; align-items:center; flex-wrap:wrap; gap:6px 14px; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; font-variant-numeric:tabular-nums; }
.sui-profile-meta-item { display:inline-flex; align-items:center; gap:4px; }
.sui-profile-lang-dot { width:10px; height:10px; border-radius:${t.radiusFull}; flex:none; }

.sui-profile-contrib-card { padding:16px; gap:12px; }
.sui-profile-contrib-scroll { min-width:0; overflow-x:auto; padding-bottom:4px; }
.sui-profile-contrib-grid { display:grid; grid-template-columns:28px auto; gap:4px 6px; width:max-content; }
.sui-profile-contrib-months { grid-column:2; display:grid; grid-auto-flow:column; grid-auto-columns:12px; gap:2px; font-size:10px; color:${t.mutedForeground}; height:14px; align-items:end; }
.sui-profile-contrib-month { white-space:nowrap; overflow:visible; }
.sui-profile-contrib-days { display:grid; grid-template-rows:repeat(7, 10px); gap:2px; font-size:10px; line-height:10px; color:${t.mutedForeground}; align-items:center; }
.sui-profile-contrib-weeks { display:grid; grid-auto-flow:column; grid-auto-columns:10px; gap:2px; }
.sui-profile-contrib-week { display:grid; grid-template-rows:repeat(7, 10px); gap:2px; }
.sui-profile-contrib-cell { width:10px; height:10px; border-radius:2px; background:${t.muted}; border:1px solid ${t.border}; box-sizing:border-box; }
.sui-profile-contrib-cell[data-level='1'] { background:color-mix(in srgb, ${t.success} 28%, ${t.muted}); border-color:color-mix(in srgb, ${t.success} 36%, transparent); }
.sui-profile-contrib-cell[data-level='2'] { background:color-mix(in srgb, ${t.success} 52%, ${t.muted}); border-color:color-mix(in srgb, ${t.success} 58%, transparent); }
.sui-profile-contrib-cell[data-level='3'] { background:color-mix(in srgb, ${t.success} 76%, ${t.muted}); border-color:color-mix(in srgb, ${t.success} 80%, transparent); }
.sui-profile-contrib-cell[data-level='4'] { background:${t.success}; border-color:${t.success}; }
.sui-profile-contrib-foot { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px 16px; color:${t.mutedForeground}; font-size:11px; }
.sui-profile-contrib-breakdown { display:flex; align-items:center; flex-wrap:wrap; gap:6px 12px; font-variant-numeric:tabular-nums; }
.sui-profile-contrib-legend { display:inline-flex; align-items:center; gap:4px; }

.sui-profile-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.sui-profile-search { flex:1 1 220px; }
.sui-profile-filters { display:inline-flex; align-items:center; flex-wrap:wrap; gap:4px; }
.sui-profile-repo-list { display:grid; margin:0; padding:0; list-style:none; border-top:1px solid ${t.border}; }
.sui-profile-repo-row { display:grid; gap:8px; padding:16px 0; border-bottom:1px solid ${t.border}; }
.sui-profile-repo-row .sui-profile-repo-desc { -webkit-line-clamp:3; }
.sui-profile-topics { display:flex; flex-wrap:wrap; gap:6px; margin:0; padding:0; list-style:none; }
.sui-profile-topic { padding:2px 10px; border-radius:${t.radiusFull}; background:${t.primarySoft}; color:${t.primary}; font-size:${t.fontSizeCompact}; font-weight:650; line-height:20px; }

.sui-profile-skeleton-avatar { width:260px; max-width:100%; aspect-ratio:1 / 1; border-radius:${t.radiusFull}; }
.sui-profile-skeleton-line { height:18px; width:72%; }
.sui-profile-skeleton-short { height:14px; width:48%; }
.sui-profile-skeleton-card { min-height:112px; border-radius:${t.radius}; }

@media (max-width:960px) {
  .sui-profile { grid-template-columns:minmax(0, 1fr); gap:20px; }
  .sui-profile-identity { grid-template-columns:72px minmax(0, 1fr); align-items:center; gap:16px; }
  .sui-profile-avatar-wrap, .sui-profile-skeleton-avatar { width:72px; height:72px; }
  .sui-profile-pinned { grid-template-columns:minmax(0, 1fr); }
}
`;
