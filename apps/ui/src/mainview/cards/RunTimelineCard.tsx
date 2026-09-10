/*
 * The run timeline card (docs/LOCAL-APP.md "Cards: target graph"): one Gantt
 * row per node on a shared time axis — label, status pill, and a bar from
 * startedAt to endedAt, cache hits as zero-width markers — with the critical
 * path emphasized and the run's totals from the summary. Clicking a row
 * opens that node's stdout/stderr (the attributed frames) in the log panel.
 * A replay (the history card's select) renders a scrubber: the cursor
 * replays the recorded events into this card and the graph overlay.
 */
import { Button, EmptyState, KpiStat, StatusPill } from "@smthrs/ui"
import { useMemo, useRef, useState } from "react"
import type { NodeTiming } from "@smthrs/rpc/TargetGraph"
import { timeLabel } from "../Timestamps"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"

/** The shared axis: the earliest start to the latest end the payload knows. */
export const timelineExtent = (nodes: ReadonlyArray<NodeTiming>): { readonly start: number; readonly end: number } => {
  let start = Number.POSITIVE_INFINITY
  let end = 0
  for (const node of nodes) {
    if (node.startedAt !== undefined) start = Math.min(start, node.startedAt)
    if (node.endedAt !== undefined) end = Math.max(end, node.endedAt)
    else if (node.startedAt !== undefined) end = Math.max(end, node.startedAt)
  }
  if (!Number.isFinite(start)) return { start: 0, end: 0 }
  return { start, end: Math.max(end, start) }
}

/** One row's bar geometry on the axis, as percentages; a hit is a zero-width marker. */
export const barGeometry = (
  node: NodeTiming,
  extent: { readonly start: number; readonly end: number }
): { readonly left: number; readonly width: number } => {
  const span = Math.max(extent.end - extent.start, 1)
  const from = node.startedAt ?? extent.start
  const to = node.endedAt ?? from
  const left = ((from - extent.start) / span) * 100
  const width = Math.max(((to - from) / span) * 100, 0)
  return { left: Math.round(left * 100) / 100, width: Math.round(width * 100) / 100 }
}

const durationLabel = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)

export const RunTimelineCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "run-timeline" }>
  readonly onRunCommand: RunCommand
}) => {
  const { runId, label, status, nodes, summary, cursor, logs, extent, error } = card.payload
  const [openLog, setOpenLog] = useState<string | undefined>(undefined)
  /*
   * The scrubber dispatches on both `input` (every drag tick) and `change`
   * (the release), because a range emits both and only `input` is delivered
   * headlessly. Time travel is idempotent, so the only thing to suppress is
   * the consecutive duplicate the pair produces: one cursor, one command.
   */
  const lastScrub = useRef<string | undefined>(undefined)
  const scrub = (raw: string): void => {
    if (raw === lastScrub.current) return
    lastScrub.current = raw
    onRunCommand("target.run.scrub", `${runId} ${raw}`)
  }
  const axis = extent ?? timelineExtent(nodes)
  const critical = new Set(summary?.criticalPath ?? [])
  /* One sort per node set, not one per render of the card around it. */
  const rows = useMemo(
    () => [...nodes].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.label.localeCompare(b.label)),
    [nodes]
  )

  return (
    <div className="run-timeline-card" data-testid={`run-timeline-${runId}`}>
      <p className="run-timeline-meta">
        <span className="targets-card-label">{label}</span> <StatusPill status={status} />
      </p>
      {status === "failed" && error !== undefined ? <p className="sui-approval-error" role="alert">{error}</p> : null}
      {summary !== undefined ?
        (
          <div className="run-timeline-totals" data-testid={`run-timeline-totals-${runId}`}>
            <KpiStat label="hit" value={String(summary.hit)} />
            <KpiStat label="ran" value={String(summary.ran)} />
            <KpiStat label="failed" value={String(summary.failed)} />
            <KpiStat label="skipped" value={String(summary.skipped)} />
            <KpiStat label="wall time" value={durationLabel(summary.durationMs)} />
          </div>
        ) :
        null}
      {rows.length === 0 ?
        <EmptyState description="No node timings yet — they arrive as the run streams." /> :
        (
          <ol className="run-timeline-rows" aria-label="Node timings">
            {rows.map((node) => {
              const bar = barGeometry(node, axis)
              const zero = node.startedAt !== undefined && (node.endedAt ?? node.startedAt) <= node.startedAt
              return (
                <li key={node.label}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="run-timeline-row"
                    data-timeline-row={node.label}
                    data-status={node.status}
                    data-critical={critical.has(node.label)}
                    data-open={openLog === node.label}
                    title={`${node.label} — ${node.status}${
                      node.durationMs !== undefined ? ` · ${durationLabel(node.durationMs)}` : ""
                    }${node.key !== undefined ? ` · key ${node.key.slice(0, 12)}…` : ""}`}
                    onClick={() => setOpenLog(openLog === node.label ? undefined : node.label)}
                  >
                    <span className="run-timeline-row-label">{node.label}</span>
                    <StatusPill status={node.status} />
                    <span className="run-timeline-track">
                      <span
                        className="run-timeline-bar"
                        data-zero-width={zero}
                        style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                      />
                    </span>
                    <span className="run-timeline-duration">
                      {node.durationMs !== undefined ? durationLabel(node.durationMs) : ""}
                    </span>
                  </Button>
                </li>
              )
            })}
          </ol>
        )}
      {cursor !== undefined ?
        (
          <label className="run-timeline-scrubber">
            Replay to {timeLabel(cursor)}
            <input
              type="range"
              min={axis.start}
              max={Math.max(axis.end, axis.start + 1)}
              value={cursor}
              aria-label="Replay cursor"
              data-testid={`run-timeline-scrubber-${runId}`}
              data-flow="target.run.scrub"
              onInput={(event) => scrub((event.target as HTMLInputElement).value)}
              onChange={(event) => scrub(event.target.value)}
            />
          </label>
        ) :
        null}
      {openLog !== undefined ?
        (
          <pre className="run-timeline-log" data-testid={`run-timeline-log-${card.id}`}>
            {logs?.[openLog] ?? "No output attributed to this node."}
          </pre>
        ) :
        null}
    </div>
  )
}

export const runTimelineCardFamily: CardFamily<"run-timeline"> = {
  "run-timeline": {
    render: (card, actions) => <RunTimelineCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: (card) => card.payload.status
  }
}
