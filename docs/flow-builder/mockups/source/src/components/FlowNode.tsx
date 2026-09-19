import { Handle, Position, type NodeProps } from "@xyflow/react"
import { memo } from "react"

import { PREDICTIONS, SEATS } from "../detail.ts"
import { formatDuration, type FlowNodeSpec, type NodeState } from "../flow.ts"
import { IconCheck, IconCursor, IconLock, IconX, KIND_ICON } from "./Icons.tsx"

export interface FlowNodeData extends Record<string, unknown> {
  readonly spec: FlowNodeSpec
  readonly state: NodeState
  readonly caption?: string
  readonly attempt?: number
  readonly settledMs?: number
  readonly selected: boolean
  readonly cursor: boolean
}

const STATE_WORD: Partial<Record<NodeState, string>> = {
  queued: "queued",
  running: "running",
  waiting: "waiting on you",
  retrying: "retrying",
  built: "built",
  clean: "clean",
  failed: "failed",
  skipped: "skipped",
  dirty: "will re-run",
  armed: "armed",
  fired: "fired 08:00"
}

const KIND_WORD = {
  trigger: "trigger",
  action: "action",
  agent: "agent",
  jev: "jev",
  human: "human",
  branch: "branch",
  merge: "merge"
} as const

export const FlowNode = memo(function FlowNode({ data }: NodeProps) {
  const { spec, state, caption, attempt, settledMs, selected, cursor } = data as unknown as FlowNodeData
  const Glyph = KIND_ICON[spec.kind]
  const word = STATE_WORD[state]
  const busy = state === "running" || state === "waiting" || state === "retrying"
  const prediction = PREDICTIONS[spec.tag]
  const pending = state === "idle" || state === "queued" || state === "dirty"
  const protocol = spec.seat ? SEATS[spec.seat]?.protocolId : spec.kind === "jev" ? "evaluation-model" : undefined

  return (
    <div
      className="fl-node"
      data-kind={spec.kind}
      data-state={state}
      data-tier={spec.tier}
      data-selected={selected ? "true" : undefined}
      role="option"
      aria-selected={selected}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />

      <span className="fl-node-rail" aria-hidden="true" />

      <div className="fl-node-body">
        <div className="fl-node-head">
          <span className="fl-node-glyph" aria-hidden="true">
            <Glyph />
          </span>
          <span className="fl-node-title">{spec.title}</span>
          {spec.tier === "irreversible" ? (
            <span className="fl-node-tier" title="irreversible — approval gated">
              <IconLock />
            </span>
          ) : null}
          <span className="fl-node-dot" data-state={state} aria-hidden="true">
            {state === "built" ? <IconCheck /> : null}
            {state === "clean" ? <IconCheck /> : null}
            {state === "failed" ? <IconX /> : null}
          </span>
        </div>

        <div className="fl-node-tag">{spec.title === spec.tag || spec.kind === "trigger" ? spec.summary || spec.id : spec.tag}</div>

        {busy && caption ? (
          <div className="fl-node-caption">
            <span className="fl-node-caret" aria-hidden="true" />
            {caption}
          </div>
        ) : null}

        {state === "running" ? <span className="fl-node-shimmer" aria-hidden="true" /> : null}
        {protocol && !busy ? <div className="fl-node-protocol">{spec.kind === "jev" ? "typesafe-ai/jev" : spec.model} · {protocol}</div> : null}

        <div className="fl-node-foot">
          <span className="fl-chip" data-kind={spec.kind}>
            {KIND_WORD[spec.kind]}
          </span>
          {spec.seat ? <span className="fl-chip fl-chip-quiet">{spec.seat}</span> : null}
          <span className="fl-node-spacer" />
          {pending && prediction && state !== "dirty" ? (
            <span className="fl-node-eta" title={`p50 of ${prediction.samples} runs · p90 ${formatDuration(prediction.p90)}`}>~{formatDuration(prediction.p50)}</span>
          ) : null}
          {state === "running" && prediction ? <span className="fl-node-eta">of ~{formatDuration(prediction.p50)}</span> : null}
          {attempt && attempt > 1 ? <span className="fl-chip fl-chip-warn">attempt {attempt}</span> : null}
          {word ? (
            <span className="fl-node-word" data-state={state}>
              {word}
            </span>
          ) : null}
          {state === "built" && settledMs !== undefined ? (
            <span className="fl-node-ms">{formatDuration(settledMs)}</span>
          ) : null}
          {state === "clean" ? <span className="fl-node-ms fl-node-ms-clean">0ms</span> : null}
        </div>
      </div>

      {cursor ? (
        <span className="fl-node-cursor" aria-hidden="true">
          <IconCursor />
          <em>Smithers</em>
        </span>
      ) : null}

      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  )
})
