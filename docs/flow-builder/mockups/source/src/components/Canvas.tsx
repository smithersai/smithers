import {
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node
} from "@xyflow/react"
import dagre from "dagre"
import { useEffect, useMemo } from "react"

import { type FlowSpec, type NodeState } from "../flow.ts"
import type { Frame } from "../script.ts"
import { FlowNode, type FlowNodeData } from "./FlowNode.tsx"

const NODE_WIDTH = 228
const NODE_HEIGHT = 88

type Layout = Readonly<Record<string, { readonly x: number; readonly y: number }>>
const layouts = new Map<string, Layout>()

/** The same left-to-right dagre pass the retired GraphCard used, memoised per flow. */
const layoutFor = (spec: FlowSpec): Layout => {
  const cached = layouts.get(spec.id)
  if (cached) return cached
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: "TB", ranksep: 54, nodesep: 30, marginx: 48, marginy: 48 })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const node of spec.nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const edge of spec.edges) graph.setEdge(edge.from, edge.to)
  dagre.layout(graph)
  const layout = Object.fromEntries(
    spec.nodes.map((node) => {
      const laid = graph.node(node.id)
      return [node.id, { x: laid.x - NODE_WIDTH / 2, y: laid.y - NODE_HEIGHT / 2 }]
    })
  )
  layouts.set(spec.id, layout)
  return layout
}

const nodeTypes = { flow: FlowNode }

const EDGE_TONE: Record<string, string> = {
  value: "var(--border-strong)",
  continuation: "var(--border-strong)",
  failure: "color-mix(in srgb, var(--danger) 45%, transparent)",
  fires: "var(--border-strong)"
}

const SETTLED: readonly NodeState[] = ["built", "clean", "skipped", "fired"]

interface CanvasProps {
  readonly spec: FlowSpec
  readonly verdict?: string
  readonly frame: Frame
  readonly onSelect: (id: string | null) => void
  readonly selected: string | null
}

/** Where the camera should sit for a frame: on the action, or on the whole graph. */
const cameraFor = (spec: FlowSpec, frame: Frame, selected: string | null): { mode: "fit" } | { mode: "follow"; id: string } => {
  if (frame.focus) return { mode: "follow", id: frame.focus }
  const live = spec.nodes.find((spec) => {
    const state = frame.nodes[spec.id]
    if (state === "failed") return frame.activeEdges.length > 0
    return state === "running" || state === "waiting" || state === "retrying"
  })
  const id = frame.cursor ?? selected ?? live?.id
  return id ? { mode: "follow", id } : { mode: "fit" }
}

const Inner = ({ spec, verdict, frame, onSelect, selected }: CanvasProps) => {
  const flow = useReactFlow()
  const LAYOUT = layoutFor(spec)
  const camera = cameraFor(spec, frame, selected)
  const cameraKey = `${spec.id}/${camera.mode === "fit" ? "fit" : camera.id}@${frame.zoom}`

  /*
   * React Flow owns the viewport imperatively, so this is the one effect in the
   * mock. In the app it would be a transition on the card payload instead.
   */
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (camera.mode === "fit") {
        flow.fitView({ padding: 0.08, maxZoom: 0.92, duration: 620 })
        return
      }
      const at = LAYOUT[camera.id]
      const lead = frame.zoom >= 0.9 ? 90 : 30
      flow.setCenter(at.x + NODE_WIDTH / 2, at.y + NODE_HEIGHT / 2 + lead, {
        zoom: frame.zoom,
        duration: 620
      })
    }, 40)
    return () => window.clearTimeout(id)
  }, [cameraKey, flow])  // eslint-disable-line react-hooks/exhaustive-deps

  const nodes = useMemo<Node[]>(
    () =>
      spec.nodes.filter((node) => frame.nodes[node.id] !== "hidden").map((node) => ({
        id: node.id,
        type: "flow",
        position: LAYOUT[node.id],
        draggable: false,
        connectable: false,
        selectable: true,
        data: {
          spec: node,
          state: frame.nodes[node.id],
          caption: frame.captions[node.id],
          attempt: frame.attempts[node.id],
          settledMs: frame.settled[node.id],
          selected: selected === node.id,
          cursor: frame.cursor === node.id
        } satisfies FlowNodeData
      })),
    [spec, LAYOUT, frame, selected]
  )

  const edges = useMemo<Edge[]>(
    () =>
      spec.edges.filter(
        (edge) => frame.nodes[edge.from] !== "hidden" && frame.nodes[edge.to] !== "hidden"
      ).map((edge) => {
        const active = frame.activeEdges.includes(edge.id)
        const complete =
          SETTLED.includes(frame.nodes[edge.from]) && SETTLED.includes(frame.nodes[edge.to])
        const dead = frame.nodes[edge.to] === "skipped" || frame.nodes[edge.from] === "skipped"
        const dirty = frame.nodes[edge.to] === "dirty"
        const stroke = active
          ? "var(--brand)"
          : dirty
            ? "color-mix(in srgb, var(--warning) 70%, transparent)"
            : complete
              ? "color-mix(in srgb, var(--success) 40%, transparent)"
              : EDGE_TONE[edge.reason]
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          type: "smoothstep",
          animated: active,
          label: edge.label,
          labelShowBg: false,
          labelStyle: {
            fill: "var(--text-faint)",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.04em",
            textTransform: "uppercase"
          },
          style: {
            stroke,
            strokeWidth: active ? 2.4 : complete ? 1.8 : 1.4,
            strokeDasharray: edge.reason === "failure" ? "5 4" : edge.reason === "fires" ? "2 4" : dirty ? "6 5" : undefined,
            opacity: dead ? 0.28 : 1,
            transition: "stroke 220ms var(--ease-current), opacity 220ms var(--ease-current)"
          }
        } satisfies Edge
      }),
    [spec, frame]
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 0.92 }}
      minZoom={0.18}
      maxZoom={1.6}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => onSelect(node.id === selected ? null : node.id)}
      onPaneClick={() => onSelect(null)}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="var(--canvas-dot)" />
      <Controls showInteractive={false} position="bottom-left" />

      {verdict ? (
        <Panel position="top-right" className="fl-panel">
          <span className="fl-panel-digest">last run</span>
          <span className="fl-panel-name">{verdict}</span>
        </Panel>
      ) : null}

      {frame.hud ? (
        <Panel position="top-center" className="fl-hud" data-tone={frame.hud.tone}>
          <div className="fl-hud-head">
            <strong>{frame.hud.title}</strong>
            <p>{frame.hud.detail}</p>
          </div>
          <div className="fl-hud-stats">
            {frame.hud.stats.map((stat) => (
              <div className="fl-hud-stat" key={stat.label} data-tone={stat.tone}>
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
    </ReactFlow>
  )
}

export const Canvas = (props: CanvasProps) => (
  <ReactFlowProvider>
    <Inner {...props} />
  </ReactFlowProvider>
)
