/**
 * The outside-web-page sheet. `inline` gives the frame a fixed height for a
 * chat message; `full` makes the figure a growing column whose frame takes
 * the remaining height of its container.
 *
 * The frame's backdrop is the light `Canvas` system color, not a theme token:
 * an outside page that sets no background was written for a light canvas, and
 * under a dark host it would otherwise show dark text on the host's dark
 * surface. A page that declares a dark `color-scheme` gets the browser's own
 * dark backdrop instead.
 *
 * Until the frame loads, the page's preview covers it. The cover fades in
 * after 600 ms, so a page that loads at once never flashes it; the wait is
 * its `--motion-hold`, which reduced motion keeps (`reducedMotionCss`).
 */
import { tokens as t } from "../tokens";

export const webPageCss = `
.sui-web-page-view { margin:0; min-width:0; width:100%; display:flex; flex-direction:column; border:1px solid ${t.border}; border-radius:${t.radius}; background:${t.card}; color:${t.cardForeground}; overflow:hidden; }
.sui-web-page-view[data-size='full'] { flex:1 1 auto; height:100%; min-height:0; }
.sui-web-page-bar { flex:none; display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:6px 8px 6px 14px; border-bottom:1px solid ${t.border}; }
.sui-web-page-origin { min-width:0; flex:1; color:${t.mutedForeground}; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; overflow-wrap:anywhere; }
.sui-web-page-actions { flex:none; display:flex; align-items:center; gap:4px; }
.sui-web-page-stage { position:relative; display:flex; flex-direction:column; }
.sui-web-page-view[data-size='full'] .sui-web-page-stage { flex:1 1 auto; min-height:0; }
.sui-web-page-frame { display:block; width:100%; border:0; color-scheme:light; background:Canvas; }
.sui-web-page-view[data-size='inline'] .sui-web-page-frame { height:28rem; }
.sui-web-page-view[data-size='full'] .sui-web-page-frame { flex:1 1 auto; min-height:0; }
.sui-web-page-pending { --motion-hold:600ms; position:absolute; inset:0; display:grid; place-items:center; padding:24px; background:${t.card}; pointer-events:none; opacity:0; animation:sui-web-page-pending 160ms ease 600ms forwards; }
.sui-web-page-pending .sui-web-page-preview { flex:none; max-width:28rem; }
@keyframes sui-web-page-pending { to { opacity:1; } }
.sui-web-page-preview { min-width:0; flex:1; display:flex; align-items:flex-start; gap:10px; }
.sui-web-page-icon { flex:none; width:20px; height:20px; margin-top:1px; display:grid; place-items:center; overflow:hidden; border-radius:4px; background:${t.muted}; color:${t.mutedForeground}; font:650 11px/1 ${t.fontSans}; }
.sui-web-page-icon img { width:100%; height:100%; object-fit:contain; background:${t.card}; }
.sui-web-page-text { min-width:0; display:flex; flex-direction:column; gap:2px; }
.sui-web-page-title { color:${t.foreground}; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-web-page-description { color:${t.mutedForeground}; font-size:${t.fontSizeCompact}; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
.sui-web-page-domain { color:${t.mutedForeground}; font-family:${t.fontMono}; font-size:${t.fontSizeCompact}; overflow-wrap:anywhere; }
.sui-web-link-card { display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:12px 14px; }
.sui-web-link-card > .sui-button { flex:none; gap:6px; }
`;
