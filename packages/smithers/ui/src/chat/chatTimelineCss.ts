import { tokens as t } from "../tokens";

export const chatTimelineCss = `
.sui-chat-transcript:has(> .sui-timeline-disclosure){position:relative;overflow:visible;container-type:inline-size}
.sui-timeline-disclosure{position:absolute;inset-inline-end:8px;top:0;z-index:4}
.sui-timeline-disclosure>summary{cursor:pointer;font-size:11px;color:var(--text-muted,#665f54);padding:6px 8px;list-style:none}
.sui-timeline-disclosure>summary::-webkit-details-marker{display:none}
@media(max-width:960px){.sui-timeline-disclosure>summary{min-width:32px;min-height:${t.controlHeight};box-sizing:border-box;display:flex;align-items:center}}
@media(max-width:1179px){.sui-chat-transcript:has(> .sui-timeline-disclosure[open]){z-index:41}}
.sui-chat-timeline{container-type:inline-size;width:190px;max-height:70vh;overflow:visible;scrollbar-width:thin;font-size:11px;font-weight:400;color:var(--text-muted,#665f54)}
.sui-timeline-disclosure[open]{background:var(--surface,#fffefa);border:1px solid var(--border-solid,#e4ddcf);border-radius:${t.radius};box-shadow:${t.shadow2}}
.sui-timeline-disclosure[open] .sui-chat-timeline{width:min(300px,80vw);padding:8px}
.sui-chat-timeline{display:flex;margin-top:18px;gap:8px;height:min(560px,70vh)}
.sui-chat-timeline ol{position:relative;display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;list-style:none;margin:0;padding:0;border-inline-start:1px solid var(--border-solid,#e4ddcf)}
.sui-chat-timeline ol::before{content:attr(aria-label);position:absolute;top:-18px;inset-inline-start:0;white-space:nowrap;font-size:10px}
.sui-chat-timeline li{min-height:0;flex-basis:0;position:relative;border-inline-start:1px solid transparent;margin-inline-start:-1px}
.sui-chat-timeline li[data-in-view]{border-inline-start-color:var(--text-muted,#665f54)}
.sui-chat-timeline button{font:inherit;color:inherit;border:0;background:var(--surface-2,#efeae0);border-radius:2px;width:100%;height:100%;padding:0 4px;text-align:start;cursor:pointer}
.sui-chat-timeline button>span{display:block;line-height:1.25;max-height:100%;white-space:normal;overflow:hidden;opacity:.7}
.sui-chat-timeline button:hover,.sui-chat-timeline button:focus-visible{color:var(--text,#211d18);background:var(--surface-2,#efeae0)}
.sui-chat-timeline button:focus-visible{outline:1px solid currentColor;outline-offset:-1px}
.sui-chat-timeline li[data-state=waiting]{color:var(--warning,#8c5a08);border-inline-start-style:dashed}
.sui-chat-timeline li[data-state=failed]{color:var(--danger,#a4442a)}
.sui-chat-timeline li[data-state=waiting] button>span,.sui-chat-timeline li[data-state=failed] button>span{opacity:1}
.sui-timeline-preview{box-sizing:border-box;display:none;position:absolute;top:100%;inset-inline-start:calc(-1 * (100cqi + 8px) * var(--sui-timeline-column) / var(--sui-timeline-columns));z-index:6;width:100cqi;margin:0;padding:10px 12px;border:1px solid var(--border-solid,#e4ddcf);border-radius:${t.radiusControl};background:var(--surface,#fffefa);color:var(--text,#211d18);font-size:11px;line-height:1.5;box-shadow:${t.shadow2}}
.sui-timeline-preview>*{display:block;white-space:normal}
.sui-timeline-preview strong{font-size:12px;font-weight:500;margin-bottom:4px}
.sui-timeline-preview small{color:var(--text-muted,#665f54);margin-top:6px}
.sui-chat-timeline li:hover>.sui-timeline-preview,.sui-chat-timeline li:focus-within>.sui-timeline-preview{display:block}
@media(min-width:1180px){@container(min-width:600px){
.sui-timeline-disclosure,.sui-timeline-disclosure[open]{inset-inline-end:calc(100% + 24px);top:0;bottom:0;width:190px;border:0;background:none;box-shadow:none}
.sui-timeline-disclosure>summary{display:none}
.sui-timeline-disclosure::details-content{display:block;content-visibility:visible}
.sui-timeline-disclosure .sui-chat-timeline,.sui-timeline-disclosure[open] .sui-chat-timeline{display:flex;width:190px;padding:0;max-height:70vh;overflow:visible}
.sui-chat-timeline li{min-height:0}
}}
/* Full summaries remain in the accessible name and focus/hover preview. */
.sui-chat-timeline button>span{max-height:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;overflow-wrap:normal}
.sui-timeline-band{position:absolute;pointer-events:none;z-index:1;left:-2px;right:-2px;border:1px solid var(--text-muted,#665f54);border-radius:2px;background:color-mix(in srgb,var(--text-muted,#665f54) 6%,transparent)}
.sui-chat-timeline ol:not([data-level="0"]) .sui-timeline-band{border-inline-end-width:3px}
.sui-chat-timeline li[data-state=working] button{animation:sui-timeline-pulse 1.8s ease-in-out infinite}
@keyframes sui-timeline-pulse{50%{opacity:.45}}
@media(max-width:340px){.sui-timeline-disclosure[open] .sui-chat-timeline{flex-direction:column;height:auto;max-height:70vh;overflow:auto}.sui-chat-timeline ol{flex:none;height:170px}.sui-timeline-preview{inset-inline-start:0}}
`;
