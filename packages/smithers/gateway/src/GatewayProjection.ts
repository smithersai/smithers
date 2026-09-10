/**
 * The stable wire rows the gateway serves for each projection, and the pure
 * folds that compute them from control-plane facts.
 *
 * These rows are the whole read contract. Nothing here exposes a store row, a
 * database column, or an engine type: every field is either a
 * `@smthrs/control` projection value or something folded out of the ordered
 * `ControlEvent` deltas `Control.watch` publishes. Wire names are the flows
 * names (`flowId`, `createdAt`, and the `ApprovalTarget.Node` envelope), so a
 * client written against the control plane reads these rows without a
 * translation table.
 *
 * @since 1.0.0
 */
import { ControlSchema } from "@smthrs/control"
import { Schema } from "effect"
import * as Diagnosis from "./Diagnosis.ts"

/**
 * One run, everything a run card displays, and the diagnosis of what happened
 * to it.
 *
 * `flowId` carries what the old wire split across `run.workflowKey` and
 * `run.workflow`, and `createdAt` carries `run.createdAtMs`: one flows name
 * each, rather than two spellings of one fact.
 *
 * @since 1.0.0
 * @category models
 */
export const RunSummaryRow = Schema.Struct({
  runId: Schema.String,
  flowId: Schema.String,
  status: ControlSchema.RunStatus,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  planId: Schema.optional(Schema.String),
  planDigest: Schema.optional(Schema.String),
  parentRunId: Schema.optional(Schema.String),
  lineageId: Schema.optional(Schema.String),
  roundOrdinal: Schema.optional(Schema.Number),
  waitingReason: Schema.optional(Schema.String),
  steeringPending: Schema.optional(Schema.Number),
  cancellation: Schema.optional(ControlSchema.Cancellation),
  /** The model seat the run's last opened turn ran on. */
  seat: Schema.optional(Schema.String),
  turns: Schema.Number,
  calls: Schema.Number,
  callsFailed: Schema.Number,
  editsAttempted: Schema.Number,
  editsSucceeded: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /**
   * One line: the run row's status plus the reason that most explains it.
   *
   * The status is the control plane's, not one folded from the journal: a
   * fenced status write does not always journal an event, so a verdict read
   * from events alone can name the run's previous state.
   */
  verdict: Schema.String,
  /** The whole diagnosis card, which the old wire called `whatHappened`. */
  diagnosis: Schema.String,
  finalOutput: Schema.optional(Schema.String)
})

/**
 * One run, everything a run card displays, and its diagnosis.
 *
 * @since 1.0.0
 * @category models
 */
export type RunSummaryRow = typeof RunSummaryRow.Type

/**
 * One node of a run, as a tree view renders it.
 *
 * `label` carries what the old wire called `node.cardLabel`, and `seat`
 * carries `node.agent`: the model seat is the flows name for who ran a node.
 *
 * `nodeId` is the ordinal the call opened on, because the emitter names no
 * node. {@link runTree} says why.
 *
 * @since 1.0.0
 * @category models
 */
export const RunTreeRow = Schema.Struct({
  runId: Schema.String,
  nodeId: Schema.String,
  label: Schema.String,
  status: Schema.Literals(["running", "completed", "failed"]),
  seat: Schema.optional(Schema.String),
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  parentRunId: Schema.optional(Schema.String)
})

/**
 * One node of a run, as a tree view renders it.
 *
 * @since 1.0.0
 * @category models
 */
export type RunTreeRow = typeof RunTreeRow.Type

/**
 * One approval a run is parked on, carrying the exact payload that decides it.
 *
 * `title` carries the old `approval.requestTitle` and `request` the old
 * `approval.request`; `payload` is the `ApprovalTarget.Node` envelope a client
 * submits back unchanged, so no client reconstructs authority.
 *
 * @since 1.0.0
 * @category models
 */
export const ApprovalRow = Schema.Struct({
  runId: Schema.String,
  requestId: Schema.String,
  title: Schema.String,
  request: Schema.Json,
  payload: ControlSchema.ApprovalPayload,
  requestedAt: Schema.Number,
  status: Schema.Literals(["pending", "approved", "denied"])
})

/**
 * One approval a run is parked on.
 *
 * @since 1.0.0
 * @category models
 */
export type ApprovalRow = typeof ApprovalRow.Type

/**
 * The output one node produced.
 *
 * @since 1.0.0
 * @category models
 */
export const NodeOutputRow = Schema.Struct({
  runId: Schema.String,
  nodeId: Schema.String,
  outcome: Schema.Literals(["success", "failure"]),
  output: Schema.String,
  settledAt: Schema.Number
})

/**
 * The output one node produced.
 *
 * @since 1.0.0
 * @category models
 */
export type NodeOutputRow = typeof NodeOutputRow.Type

/**
 * One line of a run's turn-by-turn transcript.
 *
 * @since 1.0.0
 * @category models
 */
export const TranscriptRow = Schema.Struct({
  runId: Schema.String,
  sequence: Schema.Number,
  turn: Schema.Number,
  at: Schema.Number,
  kind: Schema.String,
  text: Schema.String
})

/**
 * One line of a run's turn-by-turn transcript.
 *
 * @since 1.0.0
 * @category models
 */
export type TranscriptRow = typeof TranscriptRow.Type

/** Copies only the optional fields a run summary actually carries. */
const optional = <A>(key: string, value: A | undefined): Record<string, A> =>
  value === undefined ? {} : { [key]: value }

/**
 * Folds one run's summary and events into the served `run-summary` row.
 *
 * @param run the control-plane run summary
 * @param events that run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const runSummary = (
  run: ControlSchema.RunSummary,
  events: ReadonlyArray<ControlSchema.ControlEvent>
): RunSummaryRow => {
  // The run row is the authority on status; the journal is the evidence for
  // everything else. A status written under a fence does not always journal an
  // event of its own, so a verdict folded from events alone can lag the row it
  // describes by a whole transition.
  const facts = { ...Diagnosis.digest(events), status: run.status }
  return {
    runId: run.runId,
    flowId: run.flowId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...optional("planId", run.planId),
    ...optional("planDigest", run.planDigest),
    ...optional("parentRunId", run.parentRunId),
    ...optional("lineageId", run.lineageId),
    ...optional("roundOrdinal", run.roundOrdinal),
    ...optional("waitingReason", run.waitingReason),
    ...optional("steeringPending", run.steering?.pending),
    ...optional("cancellation", run.cancellation),
    ...optional("seat", facts.seat),
    turns: facts.turns,
    calls: facts.calls,
    callsFailed: facts.callsFailed,
    editsAttempted: facts.editsAttempted,
    editsSucceeded: facts.editsSucceeded,
    inputTokens: facts.inputTokens,
    outputTokens: facts.outputTokens,
    verdict: Diagnosis.verdict(facts),
    diagnosis: Diagnosis.render({ runId: run.runId, ...optional("flowId", run.flowId) }, facts),
    ...optional("finalOutput", facts.finalOutput)
  }
}

/**
 * Claims the open agent call a settlement belongs to. A named settlement
 * takes the oldest open call with that flow name and is dropped when none
 * matches. Only an unnamed settlement takes the oldest open call.
 */
const takeOpenCall = <A extends { readonly flowName: string }>(
  open: Array<A>,
  flowName: string | undefined
): A | undefined => {
  if (flowName === undefined) return open.shift()
  const found = open.findIndex((call) => call.flowName === flowName)
  return found < 0 ? undefined : open.splice(found, 1)[0]
}

/**
 * Folds one run's events into its node rows.
 *
 * A node opens on `control.agent.cell-call-started` and settles on the
 * matching `control.agent.cell-call-settled`.
 *
 * Neither record names a node: `@smthrs/agent` `AgentSession` journals
 * `{flowName, input}` when a call starts and `{flowName, outcome, message,
 * value}` when it settles. The ordinal the call opened on is therefore its
 * published key rather than a fallback, and a settlement is paired with the
 * oldest open call of the same flow name, which is the only pairing those
 * fields support.
 *
 * The durable engine's own `flows.engine.*` records are not folded here, and
 * cannot be: a host keeps the control plane and the engine in two databases
 * with two journals (`@smthrs/cli` `NodeControl.databasePath` and
 * `executionDatabasePath`), and `Control.watch` reads one run's partition of
 * the control journal alone (`@smthrs/control` `ControlLive.streamForRun`).
 * What an engine step did reaches a client as the agent call that made it.
 *
 * A node that never settled stays `running`, which is how a live tree renders
 * work in flight.
 *
 * @param run the control-plane run summary
 * @param events that run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const runTree = (
  run: ControlSchema.RunSummary,
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<RunTreeRow> => {
  const rows = new Map<string, RunTreeRow>()
  const openCalls: Array<{ readonly flowName: string; readonly row: RunTreeRow }> = []
  let seat: string | undefined
  let ordinal = 0

  for (const event of events) {
    const payload = Diagnosis.asRecord(event.payload)
    const at = Diagnosis.timeOf(event)
    if (event.kind === "control.agent.turn-opened") {
      seat = Diagnosis.asString(payload.seat) ?? seat
      continue
    }
    if (event.kind === "control.agent.cell-call-started") {
      ordinal += 1
      const nodeId = `call-${ordinal}`
      const flowName = Diagnosis.asString(payload.flowName) ?? nodeId
      const row: RunTreeRow = {
        runId: run.runId,
        nodeId,
        label: flowName,
        status: "running",
        ...optional("seat", seat),
        startedAt: at,
        ...optional("parentRunId", run.parentRunId)
      }
      openCalls.push({ flowName, row })
      rows.set(nodeId, row)
      continue
    }
    if (event.kind !== "control.agent.cell-call-settled") continue
    const settled = takeOpenCall(openCalls, Diagnosis.asString(payload.flowName))
    if (settled === undefined) continue
    rows.set(settled.row.nodeId, {
      ...settled.row,
      status: Diagnosis.asString(payload.outcome) === "failure" ? "failed" : "completed",
      endedAt: at
    })
  }
  return [...rows.values()]
}

/**
 * Folds one run's events into its approval rows.
 *
 * A request opens a pending row carrying the submit-ready payload; the
 * matching `control.approval.approved` or `control.approval.denied` closes it
 * without discarding the request, so a decided gate stays readable.
 *
 * A decision names the gate it closed by `tokenId`. `@smthrs/control`
 * `SqlControlRuntime.lookupApproval` mints that token id from the target, and
 * for the `Node` target a run parks on it is the request id itself, so the two
 * records join on one field. A decision whose `tokenId` or `requestId` names
 * no row is ignored. Only a decision that names neither field closes the
 * oldest pending row, because two gates open at once must not both flip on one
 * decision.
 *
 * @param events the run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const approvals = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<ApprovalRow> => {
  const rows = new Map<string, ApprovalRow>()
  for (const event of events) {
    const payload = Diagnosis.asRecord(event.payload)
    if (event.kind === "control.approval.requested") {
      const requestId = Diagnosis.asString(payload.requestId)
      const runId = Diagnosis.asString(payload.runId) ?? event.runId
      const submitted = payload.payload
      if (requestId === undefined || runId === undefined || submitted === undefined) continue
      const question = Diagnosis.asString(payload.question) ?? `Approval needed — ${requestId}`
      rows.set(requestId, {
        runId,
        requestId,
        title: question,
        request: payload as never,
        payload: submitted as ControlSchema.ApprovalPayload,
        requestedAt: Diagnosis.timeOf(event),
        status: "pending"
      })
      continue
    }
    if (event.kind === "control.approval.approved" || event.kind === "control.approval.denied") {
      const decided = event.kind === "control.approval.approved" ? "approved" as const : "denied" as const
      const tokenId = Diagnosis.asString(payload.tokenId) ?? Diagnosis.asString(payload.requestId)
      if (tokenId !== undefined) {
        const named = rows.get(tokenId)
        if (named === undefined) continue
        rows.set(tokenId, { ...named, status: decided })
        continue
      }
      const oldest = [...rows.entries()].find(([, row]) => row.status === "pending")
      if (oldest !== undefined) rows.set(oldest[0], { ...oldest[1], status: decided })
    }
  }
  return [...rows.values()]
}

/**
 * Folds one run's events into its node outputs, keyed the way {@link runTree}
 * keys its rows: by the ordinal the call opened on.
 *
 * A settled call carries the value it produced, so the row carries that value.
 * A run's own result reaches a client as `RunSummaryRow.finalOutput` instead.
 *
 * @param events the run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const nodeOutput = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<NodeOutputRow> => {
  const rows = new Map<string, NodeOutputRow>()
  const openCalls: Array<{ readonly nodeId: string; readonly flowName: string }> = []
  let ordinal = 0

  for (const event of events) {
    const payload = Diagnosis.asRecord(event.payload)
    const runId = Diagnosis.asString(payload.runId) ?? event.runId
    // The ordinal and the open-call list are kept unconditionally, exactly as
    // `runTree` keeps them. Skipping an event before the ordinal advanced
    // shifted this fold's `call-N` keys relative to that one, so the two folds
    // disagreed about which node produced which output.
    if (event.kind === "control.agent.cell-call-started") {
      ordinal += 1
      const nodeId = `call-${ordinal}`
      openCalls.push({ nodeId, flowName: Diagnosis.asString(payload.flowName) ?? nodeId })
      continue
    }
    if (event.kind !== "control.agent.cell-call-settled") continue
    const settled = takeOpenCall(openCalls, Diagnosis.asString(payload.flowName))
    if (settled === undefined) continue
    // A row names the run it belongs to. A settlement that names none closes
    // its call without producing one.
    if (runId === undefined) continue
    const failed = Diagnosis.asString(payload.outcome) === "failure"
    rows.set(settled.nodeId, {
      runId,
      nodeId: settled.nodeId,
      outcome: failed ? "failure" : "success",
      output: failed
        ? Diagnosis.asString(payload.message) ?? ""
        : Diagnosis.asString(payload.value) ?? JSON.stringify(payload.value ?? null),
      settledAt: Diagnosis.timeOf(event)
    })
  }
  return [...rows.values()]
}

/** Events the transcript reports verbatim rather than as agent activity. */
const transcriptKinds: ReadonlySet<string> = new Set(["control.approval.requested"])

/**
 * Folds one run's events into a turn-numbered transcript.
 *
 * A row is reported for every `control.run.*` and `control.agent.*` event and
 * for an approval request, and for nothing else: the transcript is what a
 * reader follows, not the whole journal, which `run-events` already serves.
 * The turn counter advances on `control.agent.turn-opened`, so every row
 * carries the turn it belongs to, and each row's text is one display line, so
 * a multi-line seat, message, or question cannot split one row into several.
 *
 * @param events the run's ordered control events
 * @since 1.0.0
 * @category projections
 */
export const transcript = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<TranscriptRow> => {
  const rows: Array<TranscriptRow> = []
  let turn = 0
  for (const event of events) {
    const payload = Diagnosis.asRecord(event.payload)
    const runId = Diagnosis.asString(payload.runId) ?? event.runId
    if (runId === undefined) continue
    const reported = event.kind.startsWith("control.run.") ||
      event.kind.startsWith("control.agent.") ||
      transcriptKinds.has(event.kind)
    if (!reported) continue
    if (event.kind === "control.agent.turn-opened") turn += 1
    rows.push({
      runId,
      sequence: event.sequence,
      turn,
      at: Diagnosis.timeOf(event),
      kind: event.kind,
      text: line(event.kind, payload)
    })
  }
  return rows
}

/** One event as a single transcript line. */
const line = (kind: string, payload: Record<string, unknown>): string => {
  switch (kind) {
    case "control.agent.turn-opened":
      return `turn opened · ${Diagnosis.firstLine(Diagnosis.asString(payload.seat) ?? "")}`
    case "control.agent.model-settled": {
      const usage = Diagnosis.asRecord(payload.usage)
      return `model ${Diagnosis.asNumber(usage.inputTokens) ?? 0} in / ${
        Diagnosis.asNumber(usage.outputTokens) ?? 0
      } out`
    }
    case "control.agent.cell-call-started":
      return `call ${Diagnosis.firstLine(Diagnosis.asString(payload.flowName) ?? "?")}`
    case "control.agent.cell-call-settled":
      return Diagnosis.asString(payload.outcome) === "failure"
        ? `  -> FAIL ${Diagnosis.clip(Diagnosis.firstLine(Diagnosis.asString(payload.message) ?? ""), 100)}`
        : "  -> ok"
    case "control.agent.resolved":
      return `resolved ${Diagnosis.clip(Diagnosis.firstLine(Diagnosis.asString(payload.text) ?? ""), 100)}`
    case "control.approval.requested":
      return `approval requested: ${Diagnosis.firstLine(Diagnosis.asString(payload.question) ?? "")}`
    default:
      return kind.slice("control.".length)
  }
}
