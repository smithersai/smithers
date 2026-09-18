/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Simulation } from "d3-force";
import { cn } from "../cn";
import { Badge } from "../badge";
import { Button } from "../button";
import { EmptyState } from "../empty-state";
import { Eyebrow } from "../section-header";
import { RowButton } from "../row-button";
import { prefersReducedMotion } from "../styles";
import { useVaultCss } from "./useVaultCss";
import { settleSimulation } from "./settleSimulation";
import {
  GRAPH_VIEWPORT_HEIGHT,
  GRAPH_VIEWPORT_WIDTH,
  computeGraphModel,
  folderTint,
  neighbourSet,
  nodeRadius,
  shouldShowLabel,
  type VaultGraphEdge,
  type VaultGraphNode,
} from "./graphModel";
import { vaultDataAttributes, type VaultLink, type VaultNoteMeta, type VaultRowProps } from "./types";

const WIDTH = GRAPH_VIEWPORT_WIDTH;
const HEIGHT = GRAPH_VIEWPORT_HEIGHT;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
/**
 * Settle ticks when reduced motion is requested: the layout runs to
 * completion instead of animating through hundreds of frames. The ticks are
 * spread over budgeted batches (see {@link settleSimulation}) so a large
 * vault does not block the main thread while it settles.
 */
const REDUCED_MOTION_TICKS = 180;
/** Hub cap for the no-physics fallback list. */
const FALLBACK_HUB_COUNT = 20;

type D3Force = typeof import("d3-force");
type PhysicsState = "loading" | "ready" | "failed";

export type KnowledgeGraphProps = {
  notes: VaultNoteMeta[];
  links: VaultLink[];
  onOpenNote?: (path: string) => void;
  /**
   * Extra attributes for each node affordance — the host's own binding
   * (`data-flow`, a test id, a title). The hub rows of the no-physics
   * fallback take all of them; the rendered SVG node takes their `data-*`
   * half, which is all an SVG group can carry. The zoom controls are this
   * component's own chrome and never take them.
   */
  nodeProps?: (node: VaultGraphNode) => VaultRowProps;
  /** Container height for the SVG (number = px). */
  height?: number | string;
  className?: string;
  style?: CSSProperties;
  /**
   * Physics loader seam (tests / custom bundlers). Defaults to a lazy
   * `import("d3-force")`; a rejecting promise renders the hub-list fallback.
   */
  loadPhysics?: () => Promise<D3Force>;
  /**
   * Yield seam for the reduced-motion settle (tests / custom hosts). Defaults
   * to `requestIdleCallback`, falling back to `setTimeout`. Schedule the
   * callback in a later task and return a canceller.
   */
  scheduleSettle?: (run: () => void) => () => void;
};

/**
 * The Obsidian-style knowledge graph: every note a node, every wikilink an
 * edge. SVG rendering (hit-testing, hover, and accessibility for free) over a
 * d3-force simulation. d3-force is lazy-imported so the main bundle stays
 * lean; if it cannot load, a list of the vault's hub notes renders instead.
 */
export function KnowledgeGraph({
  notes,
  links,
  onOpenNote,
  nodeProps,
  height = 480,
  className,
  style,
  loadPhysics,
  scheduleSettle,
}: KnowledgeGraphProps) {
  useVaultCss();
  // computeGraphModel returns fresh copies: d3-force mutates nodes/links in
  // place, and mutating the caller's props would corrupt them on refetch.
  const model = useMemo(() => computeGraphModel(notes, links), [notes, links]);
  const [physics, setPhysics] = useState<PhysicsState>("loading");
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const simRef = useRef<Simulation<VaultGraphNode, undefined> | null>(null);
  const d3Ref = useRef<D3Force | null>(null);

  useEffect(() => {
    if (model.nodes.length === 0) return;
    let cancelled = false;
    let sim: Simulation<VaultGraphNode, undefined> | null = null;
    let cancelSettle: (() => void) | null = null;
    void (async () => {
      try {
        const d3 = d3Ref.current ?? (await (loadPhysics ?? (() => import("d3-force")))());
        if (cancelled) return;
        d3Ref.current = d3;
        const reducedMotion = prefersReducedMotion();
        // Keep in-progress positions private, including during hover/zoom renders.
        const simulationModel = reducedMotion ? computeGraphModel(notes, links) : model;
        sim = d3
          .forceSimulation<VaultGraphNode>(simulationModel.nodes)
          .force(
            "link",
            d3
              .forceLink<VaultGraphNode, VaultGraphEdge>(simulationModel.links)
              .id((d) => d.id)
              .distance(55)
              .strength(0.35),
          )
          .force("charge", d3.forceManyBody<VaultGraphNode>().strength(-140))
          .force("center", d3.forceCenter(WIDTH / 2, HEIGHT / 2))
          .force(
            "collide",
            d3.forceCollide<VaultGraphNode>().radius((d) => nodeRadius(d.degree) + 3),
          )
          .alphaDecay(0.045);
        if (reducedMotion) {
          // Settle in budgeted batches that yield to the thread between them,
          // and repaint once at the end: no animated frames, no long block.
          cancelSettle = settleSimulation(sim, {
            ticks: REDUCED_MOTION_TICKS,
            schedule: scheduleSettle,
            onSettled: () => {
              if (cancelled) return;
              simulationModel.nodes.forEach((node, index) => {
                model.nodes[index]!.x = node.x;
                model.nodes[index]!.y = node.y;
              });
              setPhysics("ready");
              setTick((t) => t + 1);
            },
          });
        } else {
          // Repaint on tick rather than per-node state: one setState per
          // frame keeps hundreds of nodes smooth.
          simRef.current = sim;
          sim.on("tick", () => setTick((t) => t + 1));
          setPhysics("ready");
        }
      } catch {
        if (!cancelled) setPhysics("failed");
      }
    })();
    return () => {
      cancelled = true;
      cancelSettle?.();
      sim?.stop();
      if (simRef.current === sim) simRef.current = null;
    };
  }, [model]);

  const neighbours = useMemo(() => neighbourSet(hover, model.links), [hover, model.links]);
  // Endpoints resolve by id so edges render before (and without) d3 mutating
  // the link refs into node objects.
  const nodeById = useMemo(() => new Map(model.nodes.map((node) => [node.id, node])), [model]);

  if (model.nodes.length === 0) {
    return <EmptyState title="No graph" description="No wikilinks found across the vault." />;
  }

  if (physics === "failed") {
    const hubs = [...model.nodes].sort((a, b) => b.degree - a.degree).slice(0, FALLBACK_HUB_COUNT);
    return (
      <div data-slot="vault-graph-fallback" className={cn("sui-vault-graph-fallback", className)} style={style}>
        <Eyebrow>
          {model.nodes.length} notes · {model.links.length} links
        </Eyebrow>
        <p className="sui-vault-graph-meta">Graph physics unavailable — the vault’s hub notes instead.</p>
        {hubs.map((node) => (
          <RowButton key={node.id} onClick={() => onOpenNote?.(node.id)} {...nodeProps?.(node)}>
            <span className="sui-vault-link-label">{node.label}</span>
            <Badge variant="secondary">{node.degree}</Badge>
          </RowButton>
        ))}
      </div>
    );
  }

  const isDim = (id: string) => neighbours !== null && !neighbours.has(id);
  const heightCss = typeof height === "number" ? `${height}px` : height;

  return (
    <div data-slot="vault-graph" className={cn("sui-vault-graph-shell", className)} style={style}>
      <div className="sui-vault-graph-head">
        <Eyebrow>
          {model.nodes.length} notes · {model.links.length} links
          {hover ? ` · ${hover}` : ""}
        </Eyebrow>
        <span className="sui-vault-graph-actions">
          <Button
            size="sm"
            variant="outline"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.25))}
          >
            +
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.25))}
          >
            −
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
              simRef.current?.alpha(0.8).restart();
            }}
          >
            Reset
          </Button>
        </span>
      </div>

      <svg
        className="sui-vault-graph"
        style={{ height: heightCss }}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Vault link graph"
        onMouseDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
        }}
        onMouseMove={(e) => {
          const drag = dragRef.current;
          if (!drag) return;
          setPan({ x: drag.panX + (e.clientX - drag.x), y: drag.panY + (e.clientY - drag.y) });
        }}
        onMouseUp={() => {
          dragRef.current = null;
        }}
        onMouseLeave={() => {
          dragRef.current = null;
          setHover(null);
        }}
        onWheel={(e) => {
          setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.1 : 0.9))));
        }}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {model.links.map((link, i) => {
            const source = typeof link.source === "string" ? nodeById.get(link.source) : link.source;
            const target = typeof link.target === "string" ? nodeById.get(link.target) : link.target;
            if (!source || !target) return null;
            const dim = neighbours !== null && !(neighbours.has(source.id) && neighbours.has(target.id));
            return (
              <line
                key={i}
                className="sui-vault-graph-edge"
                x1={source.x ?? 0}
                y1={source.y ?? 0}
                x2={target.x ?? 0}
                y2={target.y ?? 0}
                strokeOpacity={dim ? 0.05 : 0.25}
                strokeWidth={1}
              />
            );
          })}
          {model.nodes.map((node) => {
            const dim = isDim(node.id);
            const r = nodeRadius(node.degree);
            return (
              <g
                key={node.id}
                className="sui-vault-graph-node"
                data-tint={folderTint(node.folder)}
                {...vaultDataAttributes(nodeProps?.(node))}
                transform={`translate(${node.x ?? 0} ${node.y ?? 0})`}
              >
                <circle
                  r={r}
                  fillOpacity={dim ? 0.15 : 0.9}
                  strokeOpacity={dim ? 0.05 : 0.3}
                  strokeWidth={0.5}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHover(node.id)}
                  onClick={() => onOpenNote?.(node.id)}
                >
                  <title>{`${node.id} — ${node.in} in, ${node.out} out`}</title>
                </circle>
                {shouldShowLabel(node.degree) && !dim ? (
                  <text
                    className="sui-vault-graph-label"
                    x={r + 3}
                    y={3}
                    fontSize={10}
                    style={{ pointerEvents: "none" }}
                  >
                    {node.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="sui-vault-graph-meta">
        Drag to pan · scroll to zoom · hover to isolate a note’s neighbourhood · click to open it
      </div>
    </div>
  );
}
