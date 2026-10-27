/**
 * A repository home's sheet (apps/mvp/docs/design/repo-home/repo-home.html): sections a column apart, a landing hero,
 * an example's code card, card grids, a stats strip, releases, the ask band, and the live blocks' counts and panels.
 * It reflows by the home's own width (a container query), so a narrow column reads like a phone.
 */
import { tokens as t } from "../tokens";

const soft = (color: string, percent = 10) => `color-mix(in srgb, ${color} ${percent}%, ${t.card})`;

export const repositoryHomeCss = `
.sui-link-tabs { display:flex; align-items:center; flex-wrap:wrap; gap:20px; border-bottom:1px solid ${t.border}; }
.sui-link-tabs > a { padding:8px 0 10px; margin-bottom:-1px; border-bottom:2px solid transparent; color:${t.mutedForeground}; font-size:13px; font-weight:650; text-decoration:none; }
.sui-link-tabs > a:hover { color:${t.foreground}; }
.sui-link-tabs > a[aria-current="page"] { color:${t.foreground}; border-bottom-color:${t.foreground}; }
.sui-link-tabs > a:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; border-radius:${t.radiusControl}; }
.sui-repository-home { min-width:0; container-type:inline-size; display:flex; flex-direction:column; gap:56px; color:${t.foreground}; }
.sui-rh-section { min-width:0; display:flex; flex-direction:column; gap:24px; }
.sui-rh-section-head { display:flex; align-items:center; flex-wrap:wrap; gap:8px 10px; }
.sui-rh-section-title { margin:0; font-size:20px; line-height:1.25; letter-spacing:-0.01em; font-weight:650; }
.sui-rh-audience { display:inline-flex; align-items:center; gap:6px; height:22px; padding:0 10px; border-radius:${t.radiusFull}; border:1px solid ${t.borderStrong}; background:${t.surface2}; color:${t.mutedForeground}; font-size:11px; font-weight:650; letter-spacing:0.02em; }
.sui-rh-audience::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
.sui-rh-audience[data-audience="maintainer"] { background:${t.primarySoft}; border-color:${t.primaryBorder}; color:${t.primary}; }
.sui-rh-audience[data-audience="contributor"] { background:${t.infoSoft}; border-color:${t.infoBorder}; color:${t.info}; }
.sui-rh-section-actions { margin-left:auto; display:flex; flex-wrap:wrap; gap:8px; }
.sui-rh-actions { min-width:0; display:flex; flex-wrap:wrap; gap:8px; }
.sui-rh-action-button { display:inline-flex; align-items:center; gap:10px; min-height:40px; padding:0 8px 0 16px; border:0; border-radius:10px; background:${t.primary}; color:${t.primaryForeground}; font:650 15px ${t.fontSans}; cursor:pointer; box-shadow:${t.shadow1}; }
.sui-rh-action-button:hover:not(:disabled) { opacity:0.92; }
.sui-rh-action-button:disabled { cursor:default; opacity:0.6; }
.sui-rh-action-button kbd { display:grid; place-items:center; min-width:24px; height:24px; padding:0 6px; border-radius:6px; background:color-mix(in srgb, ${t.primaryForeground} 18%, transparent); font:650 12px ${t.fontMono}; }

.sui-repository-home-block { min-width:0; display:flex; flex-direction:column; align-items:stretch; gap:12px; }
.sui-repository-home-title { margin:0; color:${t.mutedForeground}; font-size:12px; font-weight:650; letter-spacing:0.06em; text-transform:uppercase; }
.sui-repository-home-text { margin:0; max-width:72ch; font-size:15px; line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; }
.sui-repository-home-links { margin:0; padding:0; list-style:none; display:flex; flex-wrap:wrap; gap:8px; }
.sui-repository-home-link { display:inline-flex; align-items:center; height:34px; padding:0 14px; border-radius:${t.radiusFull}; border:1px solid ${t.borderStrong}; background:${t.card}; color:${t.foreground}; font-size:13px; font-weight:650; text-decoration:none; overflow-wrap:anywhere; }
.sui-repository-home-link:hover { border-color:${t.primaryBorder}; color:${t.primary}; }
.sui-repository-home-block > .sui-md { min-width:0; }
.sui-repository-home-notice { margin:0; color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; overflow-wrap:anywhere; }
/* A Markdown block's file still loading: text lines in the document's place. */
.sui-rh-loading { display:grid; gap:10px; }
.sui-rh-skeleton { height:16px; }
.sui-rh-skeleton-short { width:60%; }
.sui-repository-home-apps { min-width:0; display:flex; flex-wrap:wrap; gap:8px; }
.sui-repository-home-apps > .sui-repository-home-block { align-items:flex-start; }
.sui-repository-home a:focus-visible, .sui-repository-home button:focus-visible, .sui-rh-code-body:focus-visible { outline:none; box-shadow:0 0 0 3px ${t.ring}; }

.sui-rh-hero { position:relative; display:flex; flex-direction:column; align-items:flex-start; padding:32px 0 4px; }
.sui-rh-hero::before { content:""; position:absolute; inset:-24px 0 auto; height:320px; z-index:-1; pointer-events:none; background:radial-gradient(60% 80% at 10% 0%, ${t.primarySoft}, transparent 70%); }
.sui-rh-announce { display:inline-flex; align-items:center; gap:8px; height:28px; padding:0 12px; margin-bottom:18px; border-radius:${t.radiusFull}; border:1px solid ${t.primaryBorder}; background:${t.card}; color:${t.primary}; font-size:13px; font-weight:650; text-decoration:none; }
.sui-rh-announce:hover { background:${t.primarySoft}; }
.sui-rh-hero-title { margin:0; font-size:56px; line-height:1; letter-spacing:-0.035em; font-weight:650; overflow-wrap:anywhere; }
.sui-rh-hero-tagline { margin:14px 0 0; color:${t.foreground}; max-width:26ch; font-size:20px; line-height:1.3; letter-spacing:-0.015em; font-weight:650; }
.sui-rh-hero-text { margin:12px 0 0; max-width:52ch; font-size:17px; line-height:1.55; color:${t.mutedForeground}; }
.sui-rh-hero-actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:26px; }
.sui-rh-action { display:inline-flex; align-items:center; height:40px; padding:0 18px; border-radius:10px; border:1px solid ${t.borderStrong}; background:${t.card}; color:${t.foreground}; font-size:15px; font-weight:650; text-decoration:none; }
.sui-rh-action:hover { border-color:${t.textFaint}; }
.sui-rh-action-primary { background:${t.inverseBg}; color:${t.inverseText}; border-color:transparent; }
.sui-rh-action-primary:hover { border-color:transparent; opacity:0.9; }
.sui-rh-install { display:flex; align-items:center; gap:10px; width:100%; max-width:380px; min-height:44px; margin-top:16px; padding:6px 6px 6px 14px; border-radius:10px; border:1px solid ${t.borderStrong}; background:${t.card}; font:13px ${t.fontMono}; }
.sui-rh-install code { flex:1; min-width:0; white-space:pre; overflow-wrap:normal; overflow-x:auto; }
.sui-rh-install-prompt { color:${t.textFaint}; user-select:none; }
.sui-rh-copy { flex:none; min-height:${t.controlHeight}; padding:0 10px; border-radius:6px; border:0; background:${t.surface2}; color:${t.foreground}; font:650 12px ${t.fontSans}; cursor:pointer; }
.sui-rh-copy:hover { background:${t.borderStrong}; }
.sui-rh-copy[data-copied="true"] { color:${t.primary}; }
.sui-rh-copy[data-copy-failed="true"] { color:${t.destructive}; }

.sui-rh-lead { min-width:0; display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1.05fr); gap:40px; align-items:center; }
.sui-rh-code { margin:0; min-width:0; border-radius:12px; border:1px solid ${t.borderStrong}; background:${t.codeBg}; overflow:hidden; box-shadow:${t.shadow1}; }
.sui-rh-code-bar { display:flex; align-items:center; gap:8px; height:40px; padding:0 6px 0 14px; border-bottom:1px solid ${t.border}; }
.sui-rh-code-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:12px ${t.fontMono}; color:${t.mutedForeground}; }
.sui-rh-code-body { margin:0; padding:16px 18px 18px; overflow-x:auto; font:13px/1.65 ${t.fontMono}; color:${t.codeText}; }
.sui-rh-tok-keyword { color:${t.primary}; font-weight:650; }
.sui-rh-tok-string { color:${t.warning}; }
.sui-rh-tok-number { color:${t.destructive}; }
.sui-rh-tok-type { color:${t.info}; font-weight:650; }
.sui-rh-tok-call { color:${t.info}; }
.sui-rh-tok-comment { color:${t.textFaint}; font-style:italic; }

.sui-rh-cards { margin:0; padding:0; list-style:none; display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:12px; }
.sui-rh-cards[data-columns="4"] { grid-template-columns:repeat(4, minmax(0, 1fr)); }
.sui-rh-cards > li { display:flex; min-width:0; }
.sui-rh-card { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; padding:16px 18px; border-radius:12px; border:1px solid ${t.borderStrong}; background:${t.card}; color:${t.foreground}; text-decoration:none; transition:border-color 120ms ease, transform 120ms ease; }
a.sui-rh-card:hover { border-color:${t.primaryBorder}; transform:translateY(-1px); }
.sui-rh-card-label { font:12px ${t.fontMono}; color:${t.primary}; overflow-wrap:anywhere; }
.sui-rh-card-title { margin:0; font-size:15px; font-weight:650; letter-spacing:-0.005em; overflow-wrap:anywhere; }
.sui-rh-card-text { margin:0; font-size:13px; line-height:1.5; color:${t.mutedForeground}; overflow-wrap:anywhere; }
.sui-rh-more { align-self:flex-start; font-size:13px; font-weight:650; color:${t.primary}; text-decoration:none; }
.sui-rh-more:hover { text-decoration:underline; text-underline-offset:3px; }

.sui-rh-stats { margin:0; display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 160px), 1fr)); border:1px solid ${t.borderStrong}; border-radius:12px; background:${t.card}; overflow:hidden; }
.sui-rh-stat { min-width:0; display:flex; flex-direction:column-reverse; justify-content:flex-end; gap:2px; padding:16px 18px; box-shadow:-1px 0 0 ${t.border}, 0 -1px 0 ${t.border}; }
.sui-rh-stat dt { font-size:12px; font-weight:500; color:${t.mutedForeground}; }
.sui-rh-stat dd { margin:0; font-size:20px; line-height:1.2; font-weight:650; letter-spacing:-0.02em; overflow-wrap:anywhere; }

.sui-rh-releases { margin:0; padding:0; list-style:none; border:1px solid ${t.borderStrong}; border-radius:12px; background:${t.card}; }
.sui-rh-release { display:grid; grid-template-columns:minmax(0, 14rem) minmax(0, 1fr) auto; gap:4px 16px; align-items:baseline; padding:14px 18px; }
.sui-rh-release + .sui-rh-release { border-top:1px solid ${t.border}; }
.sui-rh-release-name { grid-column:1; font:650 13px ${t.fontMono}; color:${t.foreground}; text-decoration:none; overflow-wrap:anywhere; }
.sui-rh-release-name:hover { color:${t.primary}; }
.sui-rh-release-summary { grid-column:2; margin:0; min-width:0; font-size:13px; color:${t.mutedForeground}; }
.sui-rh-release-date { grid-column:3; font-size:12px; color:${t.textFaint}; white-space:nowrap; }

.sui-rh-ask { display:flex; align-items:center; flex-wrap:wrap; gap:16px 24px; padding:24px; border-radius:12px; background:${t.inverseBg}; color:${t.inverseText}; }
.sui-rh-ask-title { flex:1 1 220px; margin:0; color:${t.inverseText}; font-size:20px; line-height:1.3; letter-spacing:-0.01em; font-weight:650; }
.sui-rh-ask-link { flex:1 1 280px; display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:46px; padding:0 8px 0 16px; border-radius:10px; background:${t.background}; color:${t.mutedForeground}; font-size:15px; text-decoration:none; }
.sui-rh-ask-link:hover { color:${t.foreground}; }
.sui-rh-ask-key { flex:none; display:grid; place-items:center; height:30px; padding:0 12px; border-radius:6px; background:${t.inverseBg}; color:${t.inverseText}; font-size:13px; font-weight:650; }

.sui-rh-tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 140px), 1fr)); gap:10px; }
.sui-rh-tile { min-width:0; display:flex; flex-direction:column; gap:2px; padding:14px 16px; border-radius:12px; border:1px solid ${t.borderStrong}; background:${t.card}; color:${t.foreground}; text-decoration:none; }
a.sui-rh-tile:hover { border-color:${t.textFaint}; }
.sui-rh-tile-value { font-size:20px; line-height:1.15; font-weight:650; letter-spacing:-0.03em; font-variant-numeric:tabular-nums; }
.sui-rh-tile-label { font-size:12px; font-weight:650; color:${t.mutedForeground}; }
.sui-rh-tile-warning { background:${soft(t.warning, 12)}; border-color:${t.warningBorder}; }
.sui-rh-tile-warning .sui-rh-tile-value { color:${t.warning}; }
.sui-rh-panels { min-width:0; display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap:14px; }
.sui-rh-panels > .sui-repository-home-block { gap:0; }
.sui-rh-panel { min-width:0; display:flex; flex-direction:column; border-radius:12px; border:1px solid ${t.borderStrong}; background:${t.card}; }
.sui-rh-panel-head { display:flex; align-items:center; gap:8px; padding:12px 16px; border-bottom:1px solid ${t.border}; }
.sui-rh-panel-title { flex:1; min-width:0; margin:0; font-size:13px; font-weight:650; }
.sui-rh-panel-link { color:inherit; text-decoration:none; }
.sui-rh-panel-link:hover { color:${t.primary}; }
.sui-rh-count { flex:none; padding:2px 8px; border-radius:${t.radiusFull}; background:${t.surface2}; color:${t.mutedForeground}; font-size:12px; font-weight:650; font-variant-numeric:tabular-nums; }
.sui-rh-count-failed { color:${t.destructive}; }
.sui-rh-entries { margin:0; padding:4px 0; list-style:none; }
.sui-rh-entry { display:flex; align-items:center; gap:10px; min-width:0; padding:8px 16px; font-size:13px; }
.sui-rh-entry-label { flex:none; font:12px ${t.fontMono}; color:${t.textFaint}; }
.sui-rh-entry-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${t.foreground}; text-decoration:none; }
a.sui-rh-entry-title:hover { color:${t.primary}; }
.sui-rh-entry-at { flex:none; font-size:12px; color:${t.textFaint}; white-space:nowrap; }
.sui-rh-empty { margin:0; padding:14px 16px; font-size:13px; color:${t.mutedForeground}; }

.sui-rh-flows { display:flex; flex-wrap:wrap; gap:8px; }
.sui-rh-flow { display:inline-flex; align-items:center; gap:8px; min-height:36px; padding:0 14px; border-radius:10px; border:1px solid ${t.borderStrong}; background:${t.card}; color:${t.foreground}; font-size:13px; font-weight:650; text-decoration:none; }
.sui-rh-flow { max-width:100%; }
.sui-rh-flow code { flex:none; font:12px ${t.fontMono}; color:${t.primary}; }
.sui-rh-flow-title { min-width:0; max-width:36ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; color:${t.mutedForeground}; }
.sui-rh-flow:hover { border-color:${t.primaryBorder}; }

@container (max-width: 860px) {
  .sui-rh-lead { grid-template-columns:minmax(0, 1fr); gap:28px; }
  .sui-rh-cards, .sui-rh-cards[data-columns="4"] { grid-template-columns:repeat(2, minmax(0, 1fr)); }
}
@container (max-width: 520px) {
  .sui-rh-cards, .sui-rh-cards[data-columns="4"] { grid-template-columns:minmax(0, 1fr); }
}
@container (max-width: 640px) {
  .sui-repository-home { gap:44px; }
  .sui-rh-hero { padding-top:20px; }
  .sui-rh-hero-title { font-size:40px; }
  .sui-rh-hero-tagline { font-size:20px; }
  .sui-rh-release { grid-template-columns:minmax(0, 1fr) auto; }
  .sui-rh-release-summary { grid-column:1 / -1; grid-row:2; }
  .sui-rh-release-date { grid-column:2; grid-row:1; }
  .sui-rh-code-body { font-size:12px; }
  .sui-rh-ask { padding:18px; }
}
/* A touch screen's tap targets: the announcement, a release's name, All versions and a panel's title link. */
@media (max-width:960px) {
  .sui-rh-announce { height:auto; min-height:${t.controlHeight}; }
  .sui-rh-more, .sui-rh-release-name, .sui-rh-panel-link { display:inline-flex; align-items:center; min-height:${t.controlHeight}; min-width:32px; }
}
`;
