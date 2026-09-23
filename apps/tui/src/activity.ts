/** The terminal reads the same evidence and phase rules as the app. */
import { trace } from "@smthrs/agent/AgentSession"
import type { AgentEvent } from "@smthrs/harness/AgentEvent"
import { CallIdentity, displayDescriptor } from "@smthrs/harness/Cell"
import { Schema } from "effect"
import { phaseExtent, traceFromJournal, type JournalRecord, type TraceModel, type Milestone } from "@smthrs/gateway/RunTrace"

export interface Activity {
  readonly records: ReadonlyArray<JournalRecord>
  readonly status: "running" | "completed" | "failed" | "cancelled"
}
export const empty: Activity = { records: [], status: "running" }
const hasIdentity = Schema.is(CallIdentity)

export const apply = (activity: Activity, event: AgentEvent, at: number): Activity => {
  // Older session files predate captured model requests. Keep their recorded
  // request time without manufacturing a prompt or throwing during restore.
  const record = event._tag === "model-requested" && event.request === undefined
    ? { eventType: "control.agent.model-requested", payload: { seat: event.seat, scope: event.scope, frame: event.frame } }
    : event._tag === "cell-call-started" && !hasIdentity(event.call.identity)
    ? { eventType: "control.agent.cell-call-started", payload: {
      flowName: event.call.flowName, input: event.call.input, descriptor: displayDescriptor(event.call)
    } }
    : event._tag === "cell-call-settled" && !hasIdentity(event.identity)
    ? { eventType: "control.agent.cell-call-settled", payload: { flowName: event.flowName, ...event.result } }
    : event._tag === "cell-settled" && event.outcome._tag === "settled" && event.outcome.transition === undefined
    ? { eventType: "control.agent.cell-settled", payload: { outcome: event.outcome } }
    : trace(event)
  if (record === undefined) return activity
  return {
    status: event._tag === "resolved" ? "completed" : event._tag === "aborted" ? "failed" : activity.status,
    records: [...activity.records, {
      sequence: activity.records.length + 1, kind: record.eventType, occurredAt: at, payload: record.payload
    }]
  }
}

export const finish = (activity: Activity, status: "failed" | "cancelled", at: number, message: string): Activity => {
  if (activity.status === status) return activity
  return { status, records: [...activity.records, { sequence: activity.records.length + 1,
    kind: `control.run.${status}`, occurredAt: at, payload: { cause: message } }] }
}

const models = new WeakMap<Activity, TraceModel>()
export const model = (activity: Activity): TraceModel => {
  let value = models.get(activity)
  if (value === undefined) {
    value = traceFromJournal({ runId: "terminal", flowId: "chat", status: activity.status }, activity.records)
    models.set(activity, value)
  }
  return value
}

const inspections = new WeakMap<Activity, { seq: number; model: TraceModel }>()
export const at = (activity: Activity, seq: number): TraceModel => {
  const cached = inspections.get(activity)
  if (cached?.seq === seq) return cached.model
  const value = traceFromJournal({ runId: "terminal", flowId: "chat", status: "running" },
    activity.records.filter(record => record.sequence! <= seq))
  inspections.set(activity, { seq, model: value })
  return value
}

/** The owner is journal order, including ties and regressing clocks. */
export const owner = (model: TraceModel, seq: number): string =>
  model.owners.findLast(record => record.seq <= seq)?.spanId ?? model.root.id

export const move = (activity: Activity, seq: number | undefined, key: string): number | undefined => {
  const records = activity.records
  if (records.length === 0 || key === "escape") return undefined
  const index = seq === undefined ? records.length - 1 : Math.max(0, records.findIndex(record => record.sequence === seq))
  const next = key === "home" ? 0 : key === "end" ? records.length - 1
    : key === "left" || key === "up" ? index - 1 : key === "right" || key === "down" ? index + 1 : index
  return records[Math.min(records.length - 1, Math.max(0, next))]!.sequence
}

/** Allocate columns proportionally without exceeding the terminal width.
 * Tiny/zero-duration phases remain reachable through the journal cursor. */
export const widths = (model: TraceModel, width: number): ReadonlyArray<number> => {
  const bands = model.bands
  const available = Math.max(1, Math.floor(width))
  const total = bands.reduce((sum, band) => sum + Math.max(0, band.endedAt - band.startedAt), 0)
  let used = 0, elapsed = 0
  return bands.map((band, index) => {
    elapsed += Math.max(0, band.endedAt - band.startedAt)
    const target = Math.round((total === 0 ? (index + 1) / bands.length : elapsed / total) * available)
    const result = Math.max(0, target - used)
    used += result
    return result
  })
}

/** Two non-overlapping label rows. Crowded moments retain a tick and remain
 * individually reachable by the sequence cursor. */
export const pins = (model: TraceModel, width: number): ReadonlyArray<{
  milestone: Milestone; left: number; row: number; label: string
}> => {
  const columns = Math.max(1, Math.floor(width)), extent = phaseExtent(model)
  const occupied: Array<Array<[number, number]>> = [[], []]
  return model.milestones.map(milestone => {
    const point = Math.min(columns - 1, Math.max(0, Math.round(
      (milestone.at - extent.start) / Math.max(1, extent.end - extent.start) * (columns - 1))))
    const label = milestone.label.slice(0, Math.min(columns, 22))
    const left = Math.max(0, Math.min(columns - label.length, point - Math.floor(label.length / 2)))
    const row = occupied.findIndex(spans => spans.every(([start, end]) => left > end || left + label.length < start))
    if (row < 0) return { milestone, left: point, row: 2, label: "·" }
    occupied[row]!.push([left, left + label.length])
    return { milestone, left, row, label }
  })
}
