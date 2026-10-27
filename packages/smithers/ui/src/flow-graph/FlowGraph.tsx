/** @jsxImportSource react */
import { useCallback, useId, useRef, useState, type ComponentProps } from "react";
import { Button } from "../button";
import { cn } from "../cn";
import { STEP_WORDS, STEP_GLYPHS } from "../run-page/runPage";
import { useInjectUiCss } from "../styles";
import { fitGraph, graphNeighbour, type GraphEdge, type GraphNode } from "./graphLayout";

export type FlowGraphProps = Omit<ComponentProps<"div">, "onSelect" | "children"> & {
  nodes: ReadonlyArray<GraphNode>;
  edges: ReadonlyArray<GraphEdge>;
  selected?: string | null;
  onSelect?: (id: string) => void;
  onInspect?: (id: string) => void;
};
const words = { next: STEP_WORDS.pending, current: STEP_WORDS.running, done: STEP_WORDS.completed, failed: STEP_WORDS.failed, waiting: STEP_WORDS.waiting, cancelled: STEP_WORDS.cancelled, skipped: STEP_WORDS.skipped };
const glyphs = { next: "○", current: "◌", done: "✓", failed: "✕", waiting: "◷", cancelled: "■", skipped: STEP_GLYPHS.skipped };
/** A read-only view of recorded graph data. All selection belongs to the host. */
export function FlowGraph({ nodes, edges, selected = null, onSelect, onInspect, className, ...props }: FlowGraphProps) {
  useInjectUiCss();
  const marker = useId().replace(/:/g, "");
  const [size, setSize] = useState({ width: 720, height: 360 });
  const [camera, setCamera] = useState({ zoom: 1, x: 0, y: 0, follow: true });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const measure = useCallback((element: HTMLDivElement | null) => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = fitGraph(nodes, edges, size.width, size.height);
  const positions = new Map(layout.nodes.map((n) => [n.id, n]));
  const fit = Math.min(size.width / layout.width, size.height / layout.height, 1);
  // Keep an active step readable in larger graphs; Fit always restores the whole graph.
  const active = positions.get(selected ?? nodes.find((n) => n.state === "current")?.id ?? "");
  const follow = fit < 0.45 && active !== undefined && camera.follow;
  const zoom = follow ? 0.65 / fit : camera.zoom;
  const viewWidth = layout.width / zoom, viewHeight = layout.height / zoom;
  const x = follow ? active.x + 92 - viewWidth / 2 : camera.x;
  const y = follow ? active.y + 36 - viewHeight / 2 : camera.y;
  return <div className={cn("sui-flow-graph", className)} data-slot="flow-graph" {...props}>
    <div className="sui-flow-graph-viewport" ref={measure}>
      <svg role="group" aria-label="Run graph" tabIndex={0} viewBox={`${x} ${y} ${viewWidth} ${viewHeight}`}
        onKeyDown={(event) => {
          if (event.key.startsWith("Arrow")) {
            event.preventDefault();
            const id = graphNeighbour(nodes, event.key === "ArrowUp" || event.key === "ArrowDown" ? [] : edges, selected, event.key === "ArrowRight" || event.key === "ArrowDown");
            if (id !== undefined) {
              onSelect?.(id);
              const target = [...event.currentTarget.querySelectorAll<SVGElement>("[data-node]")].find((element) => element.dataset.node === id);
              target?.focus?.();
            }
          } else if ((event.key === "Enter" || event.key === "i") && selected !== null) {
            event.preventDefault(); event.stopPropagation(); onInspect?.(selected);
          }
        }}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return;
          drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current === null) return;
          const dx = (event.clientX - drag.current.x) * viewWidth / size.width;
          const dy = (event.clientY - drag.current.y) * viewHeight / size.height;
          drag.current = { x: event.clientX, y: event.clientY };
          setCamera({ zoom, x: x - dx, y: y - dy, follow: false });
        }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
        {edges.map((edge, i) => {
          const a = positions.get(edge.from), b = positions.get(edge.to);
          if (!a || !b) return null;
          const lr = layout.direction === "LR";
          const x1 = a.x + (lr ? 184 : 92), y1 = a.y + (lr ? 36 : 72);
          const x2 = b.x + (lr ? 0 : 92), y2 = b.y + (lr ? 36 : 0);
          const d = lr ? `M${x1},${y1} C${(x1+x2)/2},${y1} ${(x1+x2)/2},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1},${(y1+y2)/2} ${x2},${(y1+y2)/2} ${x2},${y2}`;
          return <g key={`${edge.from}:${edge.to}:${i}`} data-edge-kind={edge.kind} className="sui-flow-edge"><path d={d} markerEnd={`url(#${marker})`} /><title>{edge.label ?? edge.kind ?? "Dependency"}</title>{edge.label ? <text x={(x1+x2)/2} y={(y1+y2)/2-6}>{edge.label}</text> : null}</g>;
        })}
        {nodes.map((node) => {
          const position = positions.get(node.id)!;
          return <g key={node.id} transform={`translate(${position.x} ${position.y})`} className="sui-flow-node"
            role="button" tabIndex={selected === node.id || (selected === null && nodes[0] === node) ? 0 : -1}
            aria-label={`${node.label}, ${words[node.state]}`} aria-pressed={selected === node.id}
            data-node={node.id} data-state={node.state} data-selected={selected === node.id ? "true" : undefined}
            onClick={() => onSelect?.(node.id)} onDoubleClick={() => onInspect?.(node.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onSelect?.(node.id); onInspect?.(node.id); }
            }}>
            <rect width="184" height="72" rx="11" /><text x="16" y="29" className="sui-flow-node-label">{node.label.length > 23 ? `${node.label.slice(0, 22)}…` : node.label}</text>
            <text x="16" y="53" className="sui-flow-node-state">{glyphs[node.state]} {words[node.state]}</text><title>{node.kind ?? node.label}</title>
          </g>;
        })}
      </svg>
    </div>
    <div className="sui-flow-graph-tools" role="toolbar" aria-label="Graph view">
      <Button variant="ghost" size="sm" aria-label="Zoom out" onClick={() => setCamera({ zoom: Math.max(0.25, zoom / 1.25), x, y, follow: false })}>−</Button>
      <Button variant="ghost" size="sm" aria-label="Zoom in" onClick={() => setCamera({ zoom: Math.min(4, zoom * 1.25), x, y, follow: false })}>+</Button>
      <Button variant="ghost" size="sm" onClick={() => setCamera({ zoom: 1, x: 0, y: 0, follow: false })}>Fit</Button>
    </div>
  </div>;
}
