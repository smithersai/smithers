import { tokens as t } from "../tokens";
export const flowGraphCss = `
.sui-flow-graph { position:relative; min-width:0; border:1px solid ${t.border}; border-radius:12px; overflow:hidden; background:radial-gradient(${t.border} 1px,transparent 1px) 0 0/18px 18px ${t.background}; }
.sui-flow-graph-viewport { height:360px; min-width:0; }
.sui-flow-graph svg { display:block; width:100%; height:100%; touch-action:none; }
.sui-flow-node { cursor:pointer; outline:none; }
.sui-flow-node rect { fill:${t.card}; stroke:${t.border}; stroke-width:1.5; }
.sui-flow-node text { fill:${t.foreground}; font-family:var(--font-sans,inherit); font-size:12px; pointer-events:none; }
.sui-flow-node-label { font-weight:650; }
.sui-flow-node .sui-flow-node-state { fill:${t.mutedForeground}; font-size:11px; }
.sui-flow-node[data-state=done] rect { stroke:${t.success}; }
.sui-flow-node[data-state=current] rect { stroke:${t.primary}; stroke-width:2.5; }
.sui-flow-node[data-state=failed] rect { stroke:${t.destructive}; }
.sui-flow-node[data-state=waiting] rect { stroke:${t.warning}; stroke-dasharray:5 3; }
.sui-flow-node[data-selected=true] rect,.sui-flow-node:focus-visible rect { stroke:${t.ringBorder}; stroke-width:3; }
.sui-flow-edge path { stroke:${t.mutedForeground}; stroke-width:1.4; fill:none; }
.sui-flow-edge[data-edge-kind=failure] path { stroke:${t.destructive}; stroke-dasharray:5 4; }
.sui-flow-edge[data-edge-kind=continuation] path { stroke-dasharray:3 3; }
.sui-flow-edge text { fill:${t.mutedForeground}; font-size:10px; }
.sui-flow-graph-tools { position:absolute; bottom:8px; left:8px; display:flex; gap:2px; border:1px solid ${t.border}; border-radius:${t.radiusControl}; background:${t.background}; }
.sui-journal-scrubber { display:flex; gap:6px; align-items:center; min-width:0; padding:8px 0; }
.sui-journal-scrubber-track { flex:1; position:relative; min-width:30px; }
.sui-journal-scrubber input { width:100%; margin:0; accent-color:${t.primary}; position:relative; }
.sui-journal-ticks { position:absolute; inset:0; overflow:hidden; }
.sui-journal-ticks span { position:absolute; height:100%; border-left:1px solid ${t.border}; }
.sui-journal-scrubber output { font-size:11px; color:${t.mutedForeground}; font-variant-numeric:tabular-nums; }
.sui-step-inspector { border:1px solid ${t.border}; border-radius:12px; min-width:0; overflow:hidden; background:${t.card}; }
.sui-step-inspector-time { padding:0 12px 12px; display:flex; justify-content:space-between; color:${t.mutedForeground}; font-size:11px; }
.sui-step-inspector [data-slot=tabs-list] { display:flex; overflow-x:auto; }
.sui-step-inspector [data-slot=tabs-trigger] { padding-inline:10px; font-size:11px; }
.sui-step-inspector [data-slot=tabs-content] { padding:12px; min-width:0; }
.sui-step-logs { margin:0; padding:0; list-style:none; font-family:${t.fontMono}; font-size:11px; line-height:1.6; min-width:0; }
.sui-step-logs li { display:flex; flex-wrap:wrap; column-gap:8px; white-space:pre-wrap; overflow-wrap:anywhere; }
.sui-step-logs time,.sui-step-log-field span { color:${t.mutedForeground}; font-variant-numeric:tabular-nums; }
.sui-step-log-level { font-weight:650; }
.sui-step-logs [data-level=WARN] .sui-step-log-level { color:${t.warning}; }
.sui-step-logs [data-level=ERROR] .sui-step-log-level,.sui-step-logs [data-level=FATAL] .sui-step-log-level,.sui-step-log-error { color:${t.destructive}; }
.sui-step-logs [data-level=DEBUG],.sui-step-logs [data-level=TRACE] { color:${t.mutedForeground}; }
.sui-step-log-error { flex-basis:100%; padding-inline-start:2ch; }
.sui-step-logs [data-kind=attempt] { color:${t.mutedForeground}; font-weight:650; padding-top:6px; }
.sui-waterfall-track { position:relative; }
.sui-waterfall-segment { position:absolute; top:25%; height:50%; background:${t.primary}; border-radius:2px; min-width:2px; }
.sui-waterfall-segment[data-state=failed] { background:${t.destructive}; }
.sui-waterfall-segment[data-state=waiting] { background:repeating-linear-gradient(120deg,transparent 0 3px,${t.mutedForeground} 3px 5px); }
.sui-waterfall-cursor { position:absolute; top:0; bottom:0; width:1px; background:${t.foreground}; pointer-events:none; }
@media(max-width:640px) { .sui-flow-graph-viewport { height:330px; } }
@media(max-width:960px) {
  .sui-flow-graph-tools { position:static; width:max-content; max-width:100%; margin:8px; }
  .sui-journal-scrubber input { min-height:${t.controlHeight}; }
}
`;
