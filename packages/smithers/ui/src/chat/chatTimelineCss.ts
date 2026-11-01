import { tokens as t } from "../tokens";

// The approved mock's rail (apps/mvp/docs/design/timeline/timeline.html), with Will's single-line entry summaries.
// `--sui-tl-*` belong to the rail; the `q-` ones are what hover or keyboard focus brings forward.
export const chatTimelineCss = `
.sui-chat-transcript:has(> .sui-timeline-disclosure){position:relative;overflow:visible;container-type:inline-size}
.sui-timeline-disclosure{position:absolute;inset-inline-end:8px;top:6px;z-index:9}
.sui-timeline-disclosure>summary{cursor:pointer;font-size:12px;color:var(--text-muted,#665f54);padding:4px 10px;border-radius:6px;background:var(--bg,#f7f4ee);border:1px solid var(--border-strong,rgba(33, 29, 24, 0.14));list-style:none}
.sui-timeline-disclosure>summary::-webkit-details-marker{display:none}
.sui-timeline-disclosure[open]>summary{color:var(--text,#211d18)}
@media(max-width:960px){.sui-timeline-disclosure>summary{min-width:32px;min-height:${t.controlHeight};box-sizing:border-box;display:flex;align-items:center}}
@media(max-width:1179px){.sui-chat-transcript:has(> .sui-timeline-disclosure[open]){z-index:41}}
.sui-chat-timeline{
  --sui-tl-text:var(--text,#211d18);--sui-tl-muted:var(--text-muted,#665f54);--sui-tl-faint:var(--text-faint,#6c655a);
  --sui-tl-ask:var(--sui-tl-muted);--sui-tl-answer:var(--brand,#0f766e);--sui-tl-bg:var(--bg,#f7f4ee);
  --sui-tl-warning:var(--warning,#8c5a08);--sui-tl-danger:var(--danger,#a4442a);
  --q-tx:var(--sui-tl-faint);--q-tx-in:var(--sui-tl-muted);--q-off:.85;--q-mk:30%;--q-mk-in:56%;--q-st:62%;--q-ui:30%;--q-dot:68%;--q-line:20%;
  position:relative;box-sizing:border-box;user-select:none;-webkit-user-select:none;font-size:11px;font-weight:400;color:var(--sui-tl-muted)}
.sui-chat-timeline:hover,.sui-chat-timeline:focus-within,.sui-timeline-disclosure[open] .sui-chat-timeline{--q-tx:var(--sui-tl-muted);--q-tx-in:var(--sui-tl-text);--q-off:1;--q-mk:48%;--q-mk-in:100%;--q-st:100%;--q-ui:62%;--q-dot:100%;--q-line:40%}
.sui-timeline-disclosure[open]{position:absolute;top:40px;inset-inline-end:8px}
.sui-timeline-disclosure[open]>summary{position:absolute;top:-34px;inset-inline-end:0}
.sui-timeline-disclosure[open] .sui-chat-timeline{width:min(340px,calc(100cqi - 16px));height:min(560px,70vh);padding:14px 14px 14px 10px;background:var(--surface,#fffefa);border:1px solid var(--border-strong,rgba(33, 29, 24, 0.14));border-radius:12px;box-shadow:${t.shadow2}}
.sui-timeline-box{position:relative;width:100%;height:100%}
@media(min-width:1180px){@container(min-width:600px){
.sui-timeline-disclosure,.sui-timeline-disclosure[open]{inset-inline-end:calc(100% + 8px);top:22px;bottom:22px;width:var(--sui-timeline-room,342px);z-index:1}
.sui-timeline-disclosure>summary,.sui-timeline-disclosure[open]>summary{display:none}
.sui-timeline-disclosure::details-content{display:block;content-visibility:visible;height:100%}
.sui-timeline-disclosure .sui-chat-timeline,.sui-timeline-disclosure[open] .sui-chat-timeline{display:block;width:100%;height:100%;padding:0;background:none;border:0;border-radius:0;box-shadow:none}
.sui-chat-timeline:not(:hover):not(:focus-within){--q-tx:var(--sui-tl-faint);--q-tx-in:var(--sui-tl-muted);--q-off:.85;--q-mk:30%;--q-mk-in:56%;--q-st:62%;--q-ui:30%;--q-dot:68%;--q-line:20%}
}}
.sui-tl-lv{position:absolute;top:0;transition:left 240ms cubic-bezier(.2,.7,.2,1),width 240ms cubic-bezier(.2,.7,.2,1)}
.sui-tl-clip{position:absolute;top:0;left:-8px;right:-6px;overflow:hidden;transition:height 260ms cubic-bezier(.2,.7,.2,1)}
.sui-tl-inner{position:relative;margin-left:8px;width:calc(100% - 14px)}
.sui-tl-inner>ol{position:relative;z-index:0;list-style:none;margin:0;padding:0}
.sui-tl-row{position:absolute;left:0;display:block;width:100%;margin:0;padding:0;border:0;background:none;font:inherit;color:inherit;cursor:pointer;text-align:start;border-radius:4px;opacity:var(--q-off);transition:opacity .15s,background-color .15s,top var(--sui-tl-move,0ms) cubic-bezier(.2,.7,.2,1),height var(--sui-tl-move,0ms) cubic-bezier(.2,.7,.2,1)}
.sui-tl-row::before{content:"";position:absolute;inset:-1px 0}
.sui-tl-row[data-in]{opacity:1}
.sui-tl-mk{position:absolute;left:11px;top:0;bottom:0;width:3px;border-radius:2px;background:color-mix(in srgb,var(--sui-tl-answer) var(--q-mk),var(--sui-tl-bg));transition:background-color .15s}
.sui-tl-row[data-kind=ask] .sui-tl-mk{background:color-mix(in srgb,var(--sui-tl-ask) var(--q-mk),var(--sui-tl-bg))}
.sui-tl-row[data-in] .sui-tl-mk{background:color-mix(in srgb,var(--sui-tl-answer) var(--q-mk-in),var(--sui-tl-bg))}
.sui-tl-row[data-kind=ask][data-in] .sui-tl-mk{background:color-mix(in srgb,var(--sui-tl-ask) var(--q-mk-in),var(--sui-tl-bg))}
.sui-tl-tx{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--sui-tl-lines,2);overflow:hidden;font-size:11px;line-height:14px;color:var(--q-tx);letter-spacing:-.05px;transition:color .15s}
.sui-tl-row .sui-tl-tx{position:absolute;left:22px;right:2px;top:0;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sui-tl-row[data-label=hidden] .sui-tl-tx{visibility:hidden}
.sui-tl-lead{display:none;position:absolute;left:14px;top:0;width:6px;box-sizing:border-box;border-left:1px solid color-mix(in srgb,var(--sui-tl-text) var(--q-line),transparent);border-bottom:1px solid color-mix(in srgb,var(--sui-tl-text) var(--q-line),transparent);border-bottom-left-radius:4px;pointer-events:none}
.sui-tl-lead[data-on]{display:block}
.sui-tl-row[data-in] .sui-tl-tx{color:var(--q-tx-in)}
.sui-tl-row[data-summary=pending] .sui-tl-tx,.sui-tl-blk[data-summary=pending] .sui-tl-tx{font-style:italic}
.sui-tl-row[data-summary=unavailable] .sui-tl-tx,.sui-tl-blk[data-summary=unavailable] .sui-tl-tx{font-style:italic;opacity:.75}
.sui-tl-row:hover,.sui-tl-blk:hover{background:color-mix(in srgb,var(--sui-tl-text) 4.5%,transparent)}
.sui-tl-row:focus-visible,.sui-tl-blk:focus-visible{outline:1.5px solid var(--sui-tl-answer);outline-offset:1px}
[data-state=working] .sui-tl-mk,.sui-tl-sm[data-state=working]{background:color-mix(in srgb,var(--sui-tl-answer) var(--q-mk-in),var(--sui-tl-bg))!important;animation:sui-tl-pulse 1.6s ease-in-out infinite}
[data-state=waiting] .sui-tl-mk,.sui-tl-sm[data-state=waiting]{background:color-mix(in srgb,var(--sui-tl-warning) var(--q-st),var(--sui-tl-bg))!important}
[data-state=failed] .sui-tl-mk,.sui-tl-sm[data-state=failed]{background:transparent!important;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--sui-tl-danger) var(--q-st),var(--sui-tl-bg))}
[data-state=queued] .sui-tl-mk,.sui-tl-sm[data-state=queued]{background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--sui-tl-text) 32%,transparent) 0 1px,transparent 1px 3px)!important;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--sui-tl-text) 28%,transparent)}
.sui-tl-row[data-state=waiting] .sui-tl-tx{color:color-mix(in srgb,var(--sui-tl-warning) var(--q-st),var(--sui-tl-bg))}
.sui-tl-row[data-state=failed] .sui-tl-tx{color:color-mix(in srgb,var(--sui-tl-danger) var(--q-st),var(--sui-tl-bg))}
.sui-tl-row[data-state=working] .sui-tl-tx,.sui-tl-row[data-state=queued] .sui-tl-tx{color:var(--q-tx-in)}
@keyframes sui-tl-pulse{50%{opacity:.4}}
.sui-tl-thumb{position:absolute;left:2.5px;width:2px;border-radius:2px;background:color-mix(in srgb,var(--sui-tl-text) var(--q-ui),transparent);cursor:grab;z-index:2;transition:background-color .15s}
.sui-tl-thumb::before{content:"";position:absolute;inset:0 -6px}
.sui-tl-dot{position:absolute;left:-.5px;width:8px;height:8px;margin-top:-4px;border-radius:50%;background:color-mix(in srgb,var(--sui-tl-text) var(--q-dot),var(--sui-tl-bg));box-shadow:0 0 0 2px var(--sui-tl-bg);cursor:grab;z-index:3;transition:background-color .15s}
.sui-tl-cur{position:absolute;left:7px;width:10px;height:1px;background:color-mix(in srgb,var(--sui-tl-text) var(--q-ui),transparent);z-index:1;pointer-events:none}
.sui-tl-blk-li{position:absolute;left:0;right:0;transition:top var(--sui-tl-move,0ms) cubic-bezier(.2,.7,.2,1),height var(--sui-tl-move,0ms) cubic-bezier(.2,.7,.2,1)}
.sui-tl-blk{position:absolute;inset:0;display:block;width:100%;margin:0;padding:0;border:0;background:none;font:inherit;color:inherit;cursor:pointer;text-align:start;border-radius:4px}
.sui-tl-sms{position:absolute;right:4px;top:0;bottom:0;width:3px}
.sui-tl-sm{position:absolute;left:0;width:3px;border-radius:2px;background:color-mix(in srgb,var(--sui-tl-answer) var(--q-mk),var(--sui-tl-bg));transition:background-color .15s}
.sui-tl-sm[data-in]{background:color-mix(in srgb,var(--sui-tl-answer) var(--q-mk-in),var(--sui-tl-bg))}
.sui-tl-blk .sui-tl-tx{position:absolute;left:8px;right:10px;top:0;font-size:10px;line-height:12px;overflow-wrap:break-word;hyphens:auto}
.sui-tl-blk[data-in] .sui-tl-tx{color:var(--q-tx-in)}
.sui-tl-lv[data-strip] .sui-tl-blk .sui-tl-tx{display:none}
.sui-tl-lens{position:absolute;right:0;width:11px;box-sizing:border-box;border:1px solid color-mix(in srgb,var(--sui-tl-text) var(--q-line),transparent);border-radius:6px;cursor:grab;z-index:2;transition:border-color .15s}
.sui-tl-fun{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.sui-tl-trk{fill:none;stroke:color-mix(in srgb,var(--sui-tl-text) 15%,transparent);stroke-width:1}
.sui-tl-ln{fill:none;stroke:color-mix(in srgb,var(--sui-tl-text) var(--q-line),transparent);stroke-width:1;transition:stroke .15s}
.sui-tl-beam{fill:color-mix(in srgb,var(--sui-tl-text) 2.2%,transparent)}
.sui-tl-lv[data-entering]{animation:sui-tl-in 240ms cubic-bezier(.2,.7,.2,1) both}
.sui-tl-lv[data-leaving]{animation:sui-tl-out 220ms cubic-bezier(.2,.7,.2,1) 150ms both}
.sui-tl-lv[data-entering] .sui-tl-lens{animation:sui-tl-fade 220ms ease 240ms both}
.sui-tl-lv[data-leaving] .sui-tl-lens{animation:sui-tl-fade 150ms ease reverse both}
g[data-entering] .sui-tl-beam{animation:sui-tl-fade 220ms ease 240ms both}
g[data-entering] .sui-tl-ln{stroke-dasharray:1;animation:sui-tl-draw 220ms ease 240ms both}
g[data-leaving] .sui-tl-beam{animation:sui-tl-fade 150ms ease reverse both}
g[data-leaving] .sui-tl-ln{stroke-dasharray:1;animation:sui-tl-draw 150ms ease reverse both}
@keyframes sui-tl-in{from{opacity:0;transform:translateX(-18px)}}
@keyframes sui-tl-out{to{opacity:0;transform:translateX(-18px)}}
@keyframes sui-tl-fade{from{opacity:0}}
@keyframes sui-tl-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
.sui-chat-timeline[data-dragging],.sui-chat-timeline[data-dragging] *{cursor:grabbing!important}
.sui-timeline-preview{position:fixed;z-index:20;box-sizing:border-box;width:max-content;max-width:240px;padding:6px 10px;border-radius:6px;background:var(--surface,#fffefa);border:1px solid var(--border-strong,rgba(33, 29, 24, 0.14));box-shadow:${t.shadow2};font-size:12px;line-height:1.45;pointer-events:none;color:var(--text-muted,#665f54);font-variant-numeric:tabular-nums}
.sui-timeline-preview[hidden]{display:none}
.sui-timeline-preview strong{display:block;font-weight:500;color:var(--text,#211d18)}
.sui-timeline-preview span{display:block}
@media(prefers-reduced-motion:reduce){
.sui-tl-lv,.sui-tl-clip{transition:none}
.sui-tl-row,.sui-tl-blk-li{transition:opacity .15s,background-color .15s}
[data-state=working] .sui-tl-mk,.sui-tl-sm[data-state=working]{animation:none}
.sui-tl-lv[data-entering],.sui-tl-lv[data-entering] .sui-tl-lens,g[data-entering] .sui-tl-beam,g[data-entering] .sui-tl-ln{animation:sui-tl-fade 120ms ease both}
.sui-tl-lv[data-leaving],.sui-tl-lv[data-leaving] .sui-tl-lens,g[data-leaving] .sui-tl-beam,g[data-leaving] .sui-tl-ln{animation:sui-tl-fade 120ms ease reverse both}
g[data-entering] .sui-tl-ln,g[data-leaving] .sui-tl-ln{stroke-dasharray:none}
}
`;
