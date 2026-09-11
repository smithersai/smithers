/*
 * The graph card (docs/LOCAL-APP.md "Cards: target graph"): the repository's
 * typed dependency DAG on the shared @smthrs/ui WorkflowCanvas, laid out
 * left-to-right with dagre and painted by @xyflow/react — the same renderer
 * and canvas anatomy Smithers' gateway-ui WorkflowGraph composes. Node color
 * follows the rule family, edges follow their kind (data solid, gates
 * dashed, services dotted, deps thin), private helpers dim until asked for,
 * and the search box filters labels. Clicking a node focuses it:
 * deps()/rdeps() highlight, everything else fades, and the detail drawer
 * opens with the plan facts the backend resolved. A payload `runId` overlays
 * the run's node statuses; the summary's critical path draws as a thick
 * chain. Every act is a registry command through onRunCommand.
 */
import dagre from "dagre"
/* React Flow's base stylesheet; vite bundles it (bun test tolerates the import). */
import "@xyflow/react/dist/style.css"
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react"
import { Badge, Button, EmptyState, StatusPill, WorkflowCanvas, WorkflowNode } from "@smthrs/ui"
import { memo, useMemo, useState } from "react"
import { reachable } from "@smthrs/rpc/TargetGraph"
import type { GraphEdge, GraphNode, NodeRunStatus, NodeTiming, TargetGraphResponse } from "@smthrs/rpc/TargetGraph"
import type { Card } from "../state/AppState"
import type { RunCommand } from "./CardFamily"

/** The rule's family: the segment before the first dot (`Shell.Test` → `Shell`). */
export const ruleFamily = (rule: string): string => {
  const dot = rule.indexOf(".")
  return dot < 0 ? rule : rule.slice(0, dot)
}

const NODE_WIDTH = 240
const NODE_HEIGHT = 84

export interface GraphNodeFocus {
  readonly root: string
  readonly highlighted: ReadonlySet<string>
}

/** The focus model: the root plus deps() ∪ rdeps() highlighted; everything else fades. */
export const focusFor = (edges: ReadonlyArray<GraphEdge>, label: string): GraphNodeFocus => {
  const highlighted = new Set<string>([...reachable(edges, label, "deps"), ...reachable(edges, label, "rdeps")])
  highlighted.add(label)
  return { root: label, highlighted }
}

export type TargetFlowNodeData = {
  readonly node: GraphNode
  readonly timing: NodeTiming | undefined
  readonly focus: "root" | "highlighted" | "faded" | undefined
  readonly critical: boolean
  readonly [key: string]: unknown
}
export type TargetFlowNode = Node<TargetFlowNodeData, "targetNode">

/** The critical path as an edge set: consecutive labels, walk order dependency-first, root last. */
export const criticalEdgeIds = (path: ReadonlyArray<string>): ReadonlySet<string> => {
  const ids = new Set<string>()
  for (let index = 0; index + 1 < path.length; index += 1) {
    /* Edges run dependent → dependency, so the pair (dep, dependent) is the id `${dependent}->${dep}`. */
    ids.add(`${path[index + 1]}->${path[index]}`)
  }
  return ids
}

/**
 * The DAG as ReactFlow nodes and edges: dagre's layered left-to-right layout
 * over the visible (filtered) node set, edges styled per kind, overlay
 * timings and focus state baked into node data. Pure — the render test
 * drives it without a canvas.
 */
export const layoutTargetGraph = (
  graph: TargetGraphResponse,
  options: {
    readonly showPrivate: boolean
    readonly filter?: string
    readonly timings?: ReadonlyMap<string, NodeTiming>
    readonly focus?: GraphNodeFocus
    readonly criticalPath?: ReadonlyArray<string>
  }
): { readonly nodes: Array<TargetFlowNode>; readonly edges: Array<Edge> } => {
  const needle = (options.filter ?? "").trim().toLowerCase()
  const visible = graph.nodes.filter((node) => {
    if (!options.showPrivate && node.private) return false
    if (needle !== "" && !node.label.toLowerCase().includes(needle)) return false
    return true
  })
  const kept = new Set(visible.map((node) => node.label))
  const edges = graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to))

  const layout = new dagre.graphlib.Graph()
  layout.setDefaultEdgeLabel(() => ({}))
  layout.setGraph({ rankdir: "LR", ranksep: 120, nodesep: 36, marginx: 24, marginy: 24 })
  for (const node of visible) layout.setNode(node.label, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of edges) layout.setEdge(edge.from, edge.to)
  dagre.layout(layout)

  const critical = criticalEdgeIds(options.criticalPath ?? [])
  const criticalNodes = new Set(options.criticalPath ?? [])

  const nodes: Array<TargetFlowNode> = visible.map((node) => {
    const positioned = layout.node(node.label)
    const focus = options.focus === undefined
      ? undefined
      : options.focus.root === node.label
      ? "root"
      : options.focus.highlighted.has(node.label)
      ? "highlighted"
      : "faded"
    return {
      id: node.label,
      type: "targetNode",
      position: {
        x: Math.round((positioned?.x ?? 0) - NODE_WIDTH / 2),
        y: Math.round((positioned?.y ?? 0) - NODE_HEIGHT / 2)
      },
      data: {
        node,
        timing: options.timings?.get(node.label),
        focus,
        critical: criticalNodes.has(node.label)
      },
      ariaLabel: `${node.label} (${node.rule} node)`,
      draggable: false,
      connectable: false,
      deletable: false,
      width: NODE_WIDTH,
      height: NODE_HEIGHT
    }
  })

  const flowEdges: Array<Edge> = edges.map((edge) => {
    const id = `${edge.from}->${edge.to}`
    return {
      id,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      className: "graph-edge",
      data: { kind: edge.kind, critical: critical.has(id) },
      style: {
        strokeDasharray: edge.kind === "gates" ? "7 4" : edge.kind === "services" ? "2 4" : undefined,
        strokeWidth: edge.kind === "deps" ? 1 : critical.has(id) ? 3 : 1.6
      }
    }
  })
  return { nodes, edges: flowEdges }
}

/** The overlay legend: the statuses a run paints, in words. */
const OVERLAY_LEGEND: ReadonlyArray<NodeRunStatus> = ["pending", "running", "hit", "ran", "failed", "skipped", "refused"]

const TargetGraphNode = memo(({ data, selected }: NodeProps<TargetFlowNode>) => {
  const { node, timing, focus, critical } = data
  return (
    <WorkflowNode
      title={node.name}
      kind={ruleFamily(node.rule)}
      selected={selected}
      className="graph-node"
      data-label={node.label}
      data-rule-family={ruleFamily(node.rule)}
      data-private={node.private}
      data-focus={focus}
      data-critical={critical}
      data-run-status={timing?.status}
    >
      <Handle type="target" position={Position.Left} className="graph-node-handle" />
      <Handle type="source" position={Position.Right} className="graph-node-handle" />
      <div className="graph-node-footer">
        {node.kinds.map((kind) => <Badge key={kind} variant="outline">{kind}</Badge>)}
        {timing !== undefined ?
          (
            <span className="graph-node-run">
              <StatusPill status={timing.status} />
              {timing.durationMs !== undefined ?
                <span className="graph-node-duration">{(timing.durationMs / 1000).toFixed(1)}s</span> :
                null}
              {timing.status === "hit" ? <Badge variant="success">hit</Badge> : null}
            </span>
          ) :
          null}
      </div>
    </WorkflowNode>
  )
})
TargetGraphNode.displayName = "TargetGraphNode"

const nodeTypes = { targetNode: TargetGraphNode }

/** One plan fact row; absent facts render nothing (no invention). */
const Fact = ({ name, children }: { readonly name: string; readonly children: React.ReactNode }) => (
  <div className="graph-drawer-fact">
    <span className="graph-drawer-fact-name">{name}</span>
    <span className="graph-drawer-fact-value">{children}</span>
  </div>
)

export const GraphNodeDrawer = ({
  node,
  repoId,
  timing,
  onRunCommand,
  onDismissDrawer
}: {
  readonly node: GraphNode
  readonly repoId: string
  readonly timing: NodeTiming | undefined
  readonly onRunCommand: RunCommand
  readonly onDismissDrawer: () => void
}) => {
  const [copied, setCopied] = useState(false)
  const plan = node.plan
  return (
    <aside className="graph-drawer" data-testid={`graph-drawer-${node.label}`} aria-label={`${node.label} details`}>
      <header className="graph-drawer-header">
        <span className="graph-drawer-label">{node.label}</span>
        <Button
          variant="ghost"
          size="icon"
          data-flow="target.graph.focus"
          aria-label="Close the graph focus details"
          onClick={() => onDismissDrawer()}
        >
          ×
        </Button>
      </header>
      <Fact name="rule">{node.rule}</Fact>
      <Fact name="package">{node.package}</Fact>
      {node.kinds.length > 0 ?
        (
          <Fact name="kinds">
            {node.kinds.map((kind) => <Badge key={kind} variant="outline">{kind}</Badge>)}
          </Fact>
        ) :
        null}
      {plan?.mode !== undefined ? <Fact name="mode">{plan.mode}</Fact> : null}
      {plan?.cacheable !== undefined ? <Fact name="cacheable">{plan.cacheable ? "yes" : "no"}</Fact> : null}
      {plan?.key !== undefined ?
        (
          <Fact name="key">
            <code className="graph-drawer-mono">{plan.key.slice(0, 16)}…</code>
          </Fact>
        ) :
        null}
      {plan?.refusal !== undefined ?
        (
          <p className="graph-drawer-refusal" role="alert">
            {plan.refusal}
          </p>
        ) :
        null}
      {plan?.argv !== undefined && plan.argv.length > 0 ?
        (
          <div className="graph-drawer-fact">
            <span className="graph-drawer-fact-name">argv</span>
            <span className="graph-drawer-fact-value">
              <code className="graph-drawer-mono graph-drawer-argv">{plan.argv.join(" ")}</code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(plan.argv?.join(" ") ?? "")
                  setCopied(true)
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </span>
          </div>
        ) :
        null}
      {plan?.sandbox !== undefined ? <Fact name="sandbox">{plan.sandbox}</Fact> : null}
      {plan?.outDirs !== undefined && plan.outDirs.length > 0 ?
        (
          <Fact name="outputs">
            <code className="graph-drawer-mono">{[...plan.outDirs, ...plan.outFiles ?? []].join(", ")}</code>
          </Fact>
        ) :
        null}
      {timing !== undefined ?
        (
          <Fact name="last run">
            <StatusPill status={timing.status} />{" "}
            {timing.durationMs !== undefined ? `${(timing.durationMs / 1000).toFixed(1)}s` : ""}
            {timing.reason !== undefined ? ` — ${timing.reason}` : ""}
          </Fact>
        ) :
        null}
      {node.source !== undefined ?
        (
          <div className="graph-drawer-fact">
            <span className="graph-drawer-fact-name">source</span>
            <span className="graph-drawer-fact-value">
              <code className="graph-drawer-mono">
                {node.source.file}
                {node.source.line !== undefined ? `:${node.source.line}` : ""}
              </code>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onRunCommand(
                    "target.source.open",
                    `${repoId} ${node.source?.file ?? ""}${node.source?.line !== undefined ? `:${node.source.line}` : ""}`
                  )}
              >
                Open
              </Button>
            </span>
          </div>
        ) :
        null}
      <div className="graph-drawer-actions">
        <Button size="sm" data-flow="target.run" onClick={() => onRunCommand("target.run", `${repoId} ${node.label}`)}>
          Run
        </Button>
      </div>
    </aside>
  )
}

export const GraphCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "graph" }>
  readonly onRunCommand: RunCommand
}) => {
  const { status, graph, error, focus, runId, run, view } = card.payload
  /*
   * Filter and focus live in the card payload (target.graph.filter /
   * target.graph.focus), so the component stays a projection and the view
   * survives a reload and an open-in-tab — the targets table's rule.
   */
  const search = view?.query ?? ""
  const showPrivate = view?.showPrivate ?? false
  const repoId = card.payload.repoId

  const focusModel = useMemo(
    () => (graph !== undefined && focus !== undefined ? focusFor(graph.edges, focus) : undefined),
    [graph, focus]
  )
  const timings = useMemo(() => new Map((run?.nodes ?? []).map((timing) => [timing.label, timing])), [run])
  const laidOut = useMemo(
    () =>
      graph === undefined
        ? { nodes: [], edges: [] }
        : layoutTargetGraph(graph, {
            showPrivate,
            filter: search,
            timings,
            focus: focusModel,
            criticalPath: run?.summary?.criticalPath
          }),
    [graph, showPrivate, search, timings, focusModel, run]
  )
  const drawerNode = graph?.nodes.find((node) => node.label === focus)

  if (status === "pending") return <p className="smithers-card-note">Loading the target graph…</p>
  if (status === "failed" || graph === undefined) {
    return (
      <p className="sui-approval-error" role="alert">
        {error ?? "The target graph did not load."}
      </p>
    )
  }

  return (
    <div className="graph-card" data-testid={`graph-card-${card.payload.repoId}`}>
      <div className="graph-card-toolbar">
        <input
          className="graph-card-search"
          type="search"
          value={search}
          placeholder="Filter labels…"
          aria-label="Filter graph labels"
          data-flow="target.graph.filter"
          onInput={(event) => onRunCommand("target.graph.filter", `${repoId} query=${event.currentTarget.value}`)}
        />
        <label className="graph-card-private-toggle">
          <input
            type="checkbox"
            checked={showPrivate}
            data-flow="target.graph.filter"
            onChange={(event) => onRunCommand("target.graph.filter", `${repoId} private=${event.target.checked ? "on" : "off"}`)}
          />
          Private nodes
        </label>
        <span className="graph-card-counts">
          {laidOut.nodes.length} targets · {laidOut.edges.length} edges
        </span>
      </div>
      {runId !== undefined ?
        (
          <ul className="graph-card-legend" aria-label="Run status legend">
            {OVERLAY_LEGEND.map((entry) => (
              <li key={entry}>
                <StatusPill status={entry} /> {entry}
              </li>
            ))}
          </ul>
        ) :
        null}
      <div className="graph-card-canvas-row">
        <WorkflowCanvas className="graph-card-canvas" role="region" aria-label="Target graph">
          {laidOut.nodes.length === 0 ?
            <EmptyState description="No targets match this view." /> :
            (
              <ReactFlow
                nodes={laidOut.nodes}
                edges={laidOut.edges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.15 }}
                minZoom={0.2}
                nodesDraggable={false}
                nodesConnectable={false}
                nodesFocusable
                deleteKeyCode={null}
                proOptions={{ hideAttribution: true }}
                onNodeClick={(_, flowNode) =>
                  onRunCommand("target.graph.focus", flowNode.id === focus ? repoId : `${repoId} ${flowNode.id}`)}
              >
                <Background gap={26} />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable className="graph-card-minimap" />
              </ReactFlow>
            )}
        </WorkflowCanvas>
        {drawerNode !== undefined ?
          (
            <GraphNodeDrawer
              node={drawerNode}
              repoId={card.payload.repoId}
              timing={timings.get(drawerNode.label)}
              onRunCommand={onRunCommand}
              /* The focus is payload state, so only the command can clear it. */
              onDismissDrawer={() => onRunCommand("target.graph.focus", repoId)}
            />
          ) :
          null}
      </div>
    </div>
  )
}
