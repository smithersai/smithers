/**
 * The run diagnosis: what happened to a run, computed from its own control
 * events.
 *
 * The old gateway answered this question with a `whatHappened` RPC that read
 * run rows, node-iteration rows, and attempt rows out of the engine database
 * and optionally asked an agent to narrate them. The rc.0 gateway serves the
 * same answer as a field of the `run-summary` projection, computed from the
 * ordered `ControlEvent` deltas `Control.watch` already publishes. Nothing
 * here opens a database, so a diagnosis read through a relay is the same
 * diagnosis a local reader computes.
 *
 * This is the one fold both surfaces read. `@smthrs/cli` `Forensics` calls
 * `digest` and adds what a terminal card needs on top of it: duplicate calls,
 * per-flow counts, the parked approval payload, and the declined-launch state
 * the wire vocabulary does not carry. The counts, the refusal aggregation, and
 * the clipping are therefore one implementation, not two that drift.
 *
 * @since 1.0.0
 */
import { ControlSchema } from "@smthrs/control"

/**
 * The run statuses a digest may report.
 *
 * `@smthrs/control` `ControlSchema.RunStatus` is the vocabulary; this is the
 * runtime set the fold checks a journaled kind against.
 *
 * @since 1.0.0
 * @category models
 */
export type RunStatus = ControlSchema.RunStatus

/**
 * Every `control.run.*` suffix that names a status rather than an operation.
 *
 * `@smthrs/control` journals `control.run.lineage`, `control.run.resume`,
 * `control.run.resumed`, `control.run.cancel-requested`, and
 * `control.run.pending` under the same prefix as the status transitions, and
 * `Lineage.derive` adds one more to every followed stream. Reading a status
 * off the prefix alone made a live run's verdict read `lineage` or `resume`,
 * so the fold accepts only the schema statuses a client may render.
 */
const runStatuses: ReadonlySet<string> = new Set(ControlSchema.RunStatus.literals)

/**
 * One refused flow call, aggregated by its refusal message.
 *
 * @since 1.0.0
 * @category models
 */
export interface Refusal {
  readonly message: string
  readonly count: number
}

/**
 * Everything the diagnosis computes from one run's events.
 *
 * @since 1.0.0
 * @category models
 */
export interface Digest {
  /** The last run status seen, or undefined before launch. */
  readonly status: RunStatus | undefined
  /** The journaled failure cause, when the run failed and recorded one. */
  readonly cause: string | undefined
  /** The model seat the last opened turn ran on. */
  readonly seat: string | undefined
  readonly turns: number
  readonly calls: number
  readonly callsFailed: number
  readonly editsAttempted: number
  readonly editsSucceeded: number
  /** Refusal messages, descending by count. */
  readonly refusals: ReadonlyArray<Refusal>
  readonly inputTokens: number
  readonly outputTokens: number
  /** The final assistant output, when the run resolved. */
  readonly finalOutput: string | undefined
  /** The pending ask's question, when the run parked for approval. */
  readonly parkedQuestion: string | undefined
  /** The earliest time a kind this fold handles occurred at. */
  readonly startedAt: number | undefined
  /** The latest time a kind this fold handles occurred at. */
  readonly endedAt: number | undefined
}

/** Flows whose calls count as edit attempts. */
const editFlows: ReadonlySet<string> = new Set(["write", "edit", "apply_patch"])

/**
 * Reads a payload as a record. Wire payloads are `Json`, so every field read
 * tolerates absence and the digest of a malformed journal is a sparse digest,
 * never a throw.
 *
 * @param value the payload to read
 * @since 1.0.0
 * @category conversions
 */
export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

/**
 * Reads a payload field as a string, or nothing when it is not one.
 *
 * @param value the field to read
 * @since 1.0.0
 * @category conversions
 */
export const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

/**
 * Reads a payload field as a number, or nothing when it is not one.
 *
 * @param value the field to read
 * @since 1.0.0
 * @category conversions
 */
export const asNumber = (value: unknown): number | undefined => typeof value === "number" ? value : undefined

/**
 * Occurrence time: the payload's own stamp, else journal admission time.
 *
 * @param event the event to time
 * @since 1.0.0
 * @category conversions
 */
export const timeOf = (event: ControlSchema.ControlEvent): number =>
  asNumber(asRecord(event.payload).at) ?? event.occurredAt

/**
 * The first line, whichever line ending produced it. Splitting on `\n` alone
 * left the `\r` of a CRLF cause on the wire, and every reader of a one-line
 * field, here and in `@smthrs/cli` `Forensics`, wants the same answer.
 *
 * @param text the text to read one line of
 * @since 1.0.0
 * @category conversions
 */
export const firstLine = (text: string): string => {
  const index = text.search(/[\r\n]/)
  return index < 0 ? text : text.slice(0, index)
}

/**
 * Truncates to a display width, marking the cut.
 *
 * The cut is made on code points, never on UTF-16 code units. Slicing code
 * units splits an astral character in half and puts a lone surrogate on the
 * wire, where a Go decoder silently replaces it with U+FFFD and a strict
 * decoder rejects the whole frame; the result of this function is always well
 * formed. A clipped result is exactly `width` code points, so `width` 1 is the
 * ellipsis alone and `width` 0, or any negative width, is the empty string.
 *
 * @param text the text to clip
 * @param width the greatest number of code points to keep
 * @since 1.0.0
 * @category rendering
 */
export const clip = (text: string, width: number): string => {
  if (width <= 0) return ""
  const points = [...text]
  return points.length <= width ? text : `${points.slice(0, width - 1).join("")}…`
}

/** The mutable accumulator the fold below writes into. */
interface Accumulator {
  status: RunStatus | undefined
  cause: string | undefined
  seat: string | undefined
  turns: number
  calls: number
  callsFailed: number
  editsAttempted: number
  editsSucceeded: number
  inputTokens: number
  outputTokens: number
  finalOutput: string | undefined
  parkedQuestion: string | undefined
}

const handlers: Readonly<
  Record<string, (accumulator: Accumulator, payload: Record<string, unknown>) => void>
> = {
  "control.agent.turn-opened": (accumulator, payload) => {
    accumulator.turns += 1
    accumulator.seat = asString(payload.seat) ?? accumulator.seat
  },
  "control.agent.model-settled": (accumulator, payload) => {
    const usage = asRecord(payload.usage)
    accumulator.inputTokens += asNumber(usage.inputTokens) ?? 0
    accumulator.outputTokens += asNumber(usage.outputTokens) ?? 0
  },
  "control.agent.cell-call-started": (accumulator, payload) => {
    accumulator.calls += 1
    if (editFlows.has(asString(payload.flowName) ?? "")) accumulator.editsAttempted += 1
  },
  "control.agent.resolved": (accumulator, payload) => {
    accumulator.finalOutput = asString(payload.text)
  },
  "control.approval.requested": (accumulator, payload) => {
    accumulator.parkedQuestion = asString(payload.question)
  }
}

/**
 * Computes the diagnosis facts for one run from its ordered control events.
 *
 * Total on purpose: an event this vocabulary does not know contributes
 * nothing rather than failing the fold.
 *
 * @param events the run's ordered control events
 * @since 1.0.0
 * @category constructors
 */
export const digest = (events: ReadonlyArray<ControlSchema.ControlEvent>): Digest => {
  const accumulator: Accumulator = {
    status: undefined,
    cause: undefined,
    seat: undefined,
    turns: 0,
    calls: 0,
    callsFailed: 0,
    editsAttempted: 0,
    editsSucceeded: 0,
    inputTokens: 0,
    outputTokens: 0,
    finalOutput: undefined,
    parkedQuestion: undefined
  }
  const refusalCounts = new Map<string, number>()
  let startedAt: number | undefined
  let endedAt: number | undefined

  /**
   * Widens the span this digest reports.
   *
   * Only a kind this fold handles widens it. The gateway merges a keepalive
   * event whose kind no emitter uses into every followed `Watch` stream
   * (`GatewayServer.watchHeartbeatKind`), and a fold that let an unhandled kind
   * contribute its timestamp reported a run that ran for as long as it was
   * watched.
   */
  const observe = (at: number): void => {
    startedAt = startedAt === undefined ? at : Math.min(startedAt, at)
    endedAt = endedAt === undefined ? at : Math.max(endedAt, at)
  }

  for (const event of events) {
    const payload = asRecord(event.payload)
    const at = timeOf(event)
    const handler = Object.hasOwn(handlers, event.kind) ? handlers[event.kind] : undefined
    if (handler !== undefined) {
      observe(at)
      handler(accumulator, payload)
      continue
    }
    if (event.kind === "control.agent.cell-call-settled") {
      observe(at)
      if (asString(payload.outcome) === "failure") {
        accumulator.callsFailed += 1
        const message = firstLine(asString(payload.message) ?? "unknown refusal")
        refusalCounts.set(message, (refusalCounts.get(message) ?? 0) + 1)
      } else if (editFlows.has(asString(payload.flowName) ?? "")) {
        accumulator.editsSucceeded += 1
      }
      continue
    }
    if (event.kind.startsWith("control.run.")) {
      const status = event.kind.slice("control.run.".length)
      if (!runStatuses.has(status)) continue
      observe(at)
      accumulator.status = status as RunStatus
      if (status === "failed") accumulator.cause = asString(payload.cause)
    }
  }

  return {
    ...accumulator,
    refusals: [...refusalCounts.entries()]
      .map(([message, count]) => ({ message, count }))
      .sort((left, right) => right.count - left.count),
    startedAt,
    endedAt
  }
}

/**
 * The wall-clock span the events cover, rendered for a reader.
 *
 * Only the span is read, so a caller carrying a wider digest of its own, as
 * `@smthrs/cli` `Forensics` does, measures it with this rather than a copy.
 *
 * @param value the span to measure
 * @since 1.0.0
 * @category rendering
 */
export const duration = (value: Pick<Digest, "startedAt" | "endedAt">): string => {
  if (value.startedAt === undefined || value.endedAt === undefined) return "0s"
  const seconds = Math.max(0, Math.round((value.endedAt - value.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

/**
 * The one-line verdict: the status plus the reason that most explains it.
 *
 * Priority order mirrors what a reader needs first: a recorded failure cause,
 * then a park's question, then the "worked but never edited" pathology a green
 * status would otherwise hide, then the resolved output.
 *
 * @param value the digest to judge
 * @since 1.0.0
 * @category rendering
 */
export const verdict = (value: Digest): string => {
  const status = value.status ?? "unlaunched"
  if (status === "failed") {
    return value.cause === undefined
      ? "failed — no cause recorded in the journal"
      : `failed — ${clip(firstLine(value.cause), 100)}`
  }
  if (status === "waiting-approval") {
    return value.parkedQuestion === undefined
      ? "waiting-approval — a permission gate is pending"
      : `waiting-approval — asks: ${clip(value.parkedQuestion, 90)}`
  }
  if (status === "completed" && value.calls > 0 && value.editsAttempted === 0) {
    return `completed — but 0 of ${value.calls} calls attempted an edit; the run only read`
  }
  if (status === "completed" && value.finalOutput !== undefined && value.finalOutput.length > 0) {
    return `completed — ${clip(firstLine(value.finalOutput), 100)}`
  }
  return status
}

const label = (name: string): string => name.padEnd(10)

/**
 * Identity a diagnosis is rendered for.
 *
 * @since 1.0.0
 * @category models
 */
export interface Subject {
  readonly runId: string
  readonly flowId?: string | undefined
}

/**
 * Renders the diagnosis card for one run: verdict, activity evidence, tokens,
 * refusals, cause, and output.
 *
 * @param subject the run being diagnosed
 * @param value the digest computed from its events
 * @since 1.0.0
 * @category rendering
 */
export const render = (subject: Subject, value: Digest): string => {
  const lines: Array<string> = [
    `${label("Verdict")}${verdict(value)}`,
    `${label("Run")}${subject.runId}${subject.flowId === undefined ? "" : ` · ${subject.flowId}`}${
      value.seat === undefined ? "" : ` · ${value.seat}`
    } · ${duration(value)}`,
    `${
      label("Activity")
    }${value.turns} turns · ${value.calls} calls (${value.callsFailed} refused) · edits ${value.editsSucceeded}/${value.editsAttempted}`,
    `${label("Tokens")}${value.inputTokens} in / ${value.outputTokens} out`
  ]
  for (const [index, refusal] of value.refusals.slice(0, 3).entries()) {
    lines.push(`${label(index === 0 ? "Refusals" : "")}${refusal.count}× ${clip(refusal.message, 110)}`)
  }
  if (value.cause !== undefined) lines.push(`${label("Cause")}${clip(firstLine(value.cause), 120)}`)
  if (value.finalOutput !== undefined && value.finalOutput.length > 0) {
    lines.push(`${label("Output")}${clip(firstLine(value.finalOutput), 120)}`)
  }
  return lines.join("\n")
}
