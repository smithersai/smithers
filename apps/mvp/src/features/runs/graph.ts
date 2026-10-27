import { Journal } from "@smthrs/flows"
import { InspectionJournal, RunTrace } from "@smthrs/gateway"
import type { GraphEdge, GraphNode, JsonValueData, StepRow } from "@smthrs/ui"
import { runPath, settled } from "./contract"
import { journalOf, type PageStep } from "./page"
import type { Inspection, RunPage } from "./schema"

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
const parsed = (value: JsonValueData): unknown => {
  if (value.clipped) return undefined
  try {
    return JSON.parse(value.text)
    // expected: a value that isn't JSON shows as none
  } catch {
    return undefined
  }
}
const asValue = (value: unknown): JsonValueData => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return { text, bytes: new TextEncoder().encode(text).length, clipped: false }
}
/** Personal runs name the recorded flow reference, while engine tags remain unchanged. */
export const runTitle = (run: Inspection["run"]): string => {
  const name = record(parsed(run.input)).name
  return run.flowName === "flow/run" && typeof name === "string" && name.length > 0 ? name : run.flowName
}
export const graphOf = (page: RunPage, at: number | null, now: number, pathOf: (runId: string) => string = runPath) => {
  const inspection = page.inspection as Inspection
  const descendants = (page.descendants ?? []) as ReadonlyArray<Inspection>
  const inspections = [inspection, ...descendants]
  const forest = InspectionJournal.inspectionForest(
    inspections.map((read, index) => ({
      runId: read.run.runId,
      events: index === 0 ? journalOf(page) : read.journal.events
    }))
  )
  const events = forest.events
  const run = { runId: inspection.run.runId, flowId: runTitle(inspection.run), status: inspection.run.status }
  const records = forest.records
  const monitor = RunTrace.monitorFromJournal(run, records, at ?? undefined, { childBoundaries: true })
  const trace = RunTrace.traceFromJournal(
    { ...run, status: at === null ? run.status : "running" },
    at === null ? records : records.filter((r) => r.sequence! <= at)
  )
  const attempt = monitor.attempts[0]!
  const title = runTitle(inspection.run)
  const label = (text: string) =>
    inspection.run.flowName === "flow/run" ? text.replace(/^flow\/run(?:\/|$)/, `${title}/`).replace(/\/$/, "") : text
  const depthOf = (id: string): number => {
    let depth = 0, current = inspections.find((read) => read.run.runId === id)
    const seen = new Set<string>()
    while (current?.run.parentRunId != null && !seen.has(current.run.runId)) {
      seen.add(current.run.runId)
      depth++
      current = inspections.find((read) => read.run.runId === current!.run.parentRunId)
    }
    return depth
  }
  const nodes: GraphNode[] = attempt.graph.map((n) => ({ ...n, label: label(n.label) }))
  // Edge reasons are optional evidence. Never infer a value or failure edge from dependency alone.
  const reasons = new Map<string, GraphEdge["kind"]>()
  for (const event of events) {
    if (at !== null && event.seq > at) continue
    const payload = record(parsed(event.payload))
    const graph = record(payload.graph)
    if (!Array.isArray(graph.edges)) continue
    const generation = typeof payload.generation === "number" ? payload.generation : 0
    const prefix = `engine-node:${encodeURIComponent(`${encodeURIComponent(event.runId)}:${generation}`)}:`
    for (const value of graph.edges) {
      const edge = record(value)
      if (edge.reason === "value" || edge.reason === "continuation" || edge.reason === "failure") {
        reasons.set(
          `${prefix}${encodeURIComponent(String(edge.from))}\n${prefix}${encodeURIComponent(String(edge.to))}`,
          edge.reason
        )
      }
    }
  }
  const edges: GraphEdge[] = attempt.graph.flatMap((n) =>
    n.deps.map((from) => ({ from, to: n.id, kind: reasons.get(`${from}\n${n.id}`) }))
  )
  const time = at === null ? now : events.filter((e) => e.seq <= at).at(-1)?.emittedAtMs ?? inspection.run.createdAtMs
  const logsByDispatch = new Map<string, JsonValueData[]>()
  const dispatchId = (owner: unknown, generation: unknown, digest: unknown) =>
    JSON.stringify([owner, generation, digest])
  const generations = new Map(records.map((row) => [row.sequence, record(row.payload).generation]))
  // The engine journals what an attempt's body logs to its run, annotated with
  // the dispatch digest settled nodes carry as `stepKeyDigests` (engine-store `StepLogs`).
  for (const event of events) {
    if (event.eventType !== Journal.TelemetryLog.eventType || (at !== null && event.seq > at)) continue
    const annotations = record(record(parsed(event.payload)).annotations)
    const digest = annotations.stepKeyDigest
    if (typeof digest !== "string" || digest.length === 0 || annotations.runId !== event.runId) continue
    const id = dispatchId(event.runId, generations.get(event.seq), digest)
    const values = logsByDispatch.get(id) ?? []
    values.push(event.payload)
    logsByDispatch.set(id, values)
  }
  for (const cell of trace.rows) {
    if (cell.kind !== "cell" || cell.detail.printed === undefined) continue
    const step = record(record(cell.detail.fields).step)
    const id = dispatchId(step.executionId, step.generation, step.stepId)
    const values = logsByDispatch.get(id) ?? []
    values.push(asValue(cell.detail.printed))
    logsByDispatch.set(id, values)
  }
  const steps: PageStep[] = nodes.map((node) => {
    const calls = attempt.steps.filter((s) => s.id === node.id)
    const latest = calls.at(-1)
    const source = trace.rows.find((r) => r.id === latest?.key)
    const nativeId = decodeURIComponent(node.id.slice(node.id.lastIndexOf(":") + 1))
    const coordinate = decodeURIComponent(node.id.split(":")[1]!)
    const ownerId = decodeURIComponent(coordinate.slice(0, coordinate.lastIndexOf(":")))
    const owner = inspections.find((read) => read.run.runId === ownerId)!
    const native = owner.steps.find((step) => step.nodeId === nativeId)
    const nodeFields = record(source?.detail.fields)
    const nodePayload = record(nodeFields.payload)
    const result = record(nodePayload.result)
    const output = typeof result.preview === "string" && typeof result.bytes === "number"
      ? { text: result.preview, bytes: result.bytes, clipped: result.truncated === true }
      : null
    const digests = Array.isArray(nodePayload.stepKeyDigests) ? nodePayload.stepKeyDigests : []
    const logs = digests.flatMap((digest) =>
      logsByDispatch.get(dispatchId(ownerId, nodeFields.generation, digest)) ?? []
    )
    const state: StepRow["state"] = node.state === "done"
      ? "completed"
      : node.state === "current"
      ? "running"
      : node.state === "next"
      ? latest?.state === "skipped" ? "skipped" : "pending"
      : node.state
    const recordedAttempts = at === null ?
      native?.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        state: attempt.state,
        startedAtMs: attempt.startedAtMs,
        finishedAtMs: attempt.finishedAtMs,
        error: attempt.error
      })) :
      trace.rows.filter((span) => {
        const fields = record(span.detail.fields)
        return span.kind === "attempt" && fields.executionId === ownerId &&
          fields.generation === nodeFields.generation && Array.isArray(nodePayload.stepKeyDigests) &&
          nodePayload.stepKeyDigests.includes(record(fields.payload).stepKeyDigest)
      }).map((span) => ({
        attempt: Number(record(record(span.detail.fields).payload).attempt),
        state: span.status,
        startedAtMs: span.startedAt,
        finishedAtMs: span.endedAt ?? null,
        error: span.status === "failed" ? "failed" : null
      }))
    const attempts = recordedAttempts !== undefined && recordedAttempts.length > 0
      ? recordedAttempts
      : calls.map((call) => ({
        attempt: call.k,
        state: call.state,
        startedAtMs: Date.parse(call.started_at),
        finishedAtMs: call.ended_at === undefined ? null : Date.parse(call.ended_at),
        error: call.state === "failed" ? "failed" : null
      }))
    return {
      row: {
        id: node.id,
        label: node.label,
        kind: native?.kind === "FlowCall" ? "Flow" : "Step",
        state,
        startedAtMs: latest === undefined ? time : Date.parse(latest.started_at),
        endedAtMs: latest?.ended_at === undefined ? null : Date.parse(latest.ended_at),
        depth: depthOf(ownerId),
        attempts: attempts.length,
        failedAttempts: attempts.filter((s) => s.state === "failed").length
      },
      input: latest?.input === undefined ? null : asValue(latest.input),
      // Complete journal results preserve the node result shape used by debug readers.
      // Only missing/clipped live previews need the schema-redacted sealed outcome.
      // Replay never discloses a later attempt's output.
      output: at === null && node.state === "done" && (output === null || output.clipped)
        ? native?.output ?? output
        : output,
      attempts,
      wait: null,
      href: ownerId === run.runId ? null : pathOf(ownerId),
      node: { runId: ownerId, nodeId: nativeId },
      logs
    }
  })
  const cells: PageStep[] = trace.rows.filter((row) => row.kind === "cell").map((cell) => ({
    row: {
      id: cell.id,
      label: cell.label,
      kind: "cell",
      state: cell.status === "failed" ? "failed" : cell.endedAt === undefined ? "running" : "completed",
      startedAtMs: cell.startedAt,
      endedAtMs: cell.endedAt ?? null,
      depth: cell.depth,
      attempts: 0,
      failedAttempts: 0
    },
    input: cell.detail.source === undefined ? null : asValue(cell.detail.source),
    output: null,
    logs: cell.detail.printed === undefined ? [] : [asValue(cell.detail.printed)],
    attempts: [],
    wait: null,
    href: null
  }))
  const waits: PageStep[] = monitor.waits.map((wait) => ({
    row: {
      id: wait.id,
      label: wait.label,
      kind: wait.kind,
      state: wait.settled === undefined ? "waiting" : "completed",
      startedAtMs: Date.parse(wait.since),
      endedAtMs: wait.settled === undefined ? null : Date.parse(wait.settled.at),
      depth: 1,
      attempts: 0,
      failedAttempts: 0
    },
    input: null,
    output: null,
    logs: [],
    attempts: [],
    wait: { kind: wait.kind, sinceMs: Date.parse(wait.since), wakeAtMs: null },
    href: null
  }))
  // A terminal inspection proves outstanding work stopped, even if cancellation did not settle each journal node.
  // Replay remains the evidence at its cursor and must not inherit a later cancellation.
  const stoppedAt = at === null && settled(inspection.run.status)
    ? inspection.run.finishedAtMs ?? events.at(-1)?.emittedAtMs ?? inspection.run.createdAtMs
    : null
  for (const rows of [steps, cells, waits]) {
    for (let index = 0; index < rows.length; index++) {
      const step = rows[index]!
      if (stoppedAt === null || (step.row.state !== "running" && step.row.state !== "waiting")) continue
      rows[index] = {
        ...step,
        row: { ...step.row, state: "cancelled", endedAtMs: stoppedAt },
        attempts: step.attempts.map((attempt) => attempt.finishedAtMs === null
          ? { ...attempt, state: "cancelled", finishedAtMs: stoppedAt }
          : attempt),
        wait: null,
      }
    }
  }
  const timeline = [...steps.filter((step) => step.attempts.length > 0), ...cells, ...waits]
  const segments = [
    ...steps.flatMap((step) =>
      step.attempts.map((a) => ({
        stepId: step.row.id,
        startedAtMs: a.startedAtMs,
        endedAtMs: a.finishedAtMs,
        state: a.state
      }))
    ),
    ...waits.map((wait) => ({
      stepId: wait.row.id,
      startedAtMs: wait.row.startedAtMs,
      endedAtMs: wait.row.endedAtMs,
      state: wait.row.state === "cancelled" ? "cancelled" : "waiting"
    }))
  ]
  const shownNodes = nodes.map((node) => stoppedAt !== null && (node.state === "current" || node.state === "waiting")
    ? { ...node, state: "cancelled" as const }
    : node)
  return { nodes: shownNodes, edges, steps: [...steps, ...cells, ...waits], timeline, segments, events, time, trace }
}
