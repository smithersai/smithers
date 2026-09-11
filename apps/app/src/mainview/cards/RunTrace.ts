/*
 * The run trace model (factory spec 06, "the run trace": one card shows every
 * run).
 *
 * A run is a recursive program: the agent writes REPL cells in a code
 * container, every `ctx.call` is a durable span, and each turn is a frame. The
 * control journal already records exactly that (`@smthrs/agent` AgentSession
 * journals turn-opened, model-settled, cell-produced, cell-call-started,
 * cell-call-settled, cell-printed, cell-settled, resolved), and the gateway
 * serves it as the `run-events` projection the run card already reads. This
 * module folds those records into a span tree, run → frame → cell → call, and
 * the geometry of one bar per span on a shared time axis. No second data
 * source: what the journal does not carry (realm variables, child runs' own
 * frames) the model does not invent.
 *
 * Pure: the card renders the model, the tests read it from a fixture.
 */
import { engineTraceFromJournal } from "./EngineTrace"

/** One control journal record, as the run card stores it (the run-events projection's row shape). */
export interface JournalRecord {
  readonly sequence?: number
  readonly kind?: string
  readonly occurredAt?: number
  readonly payload?: unknown
}

/**
 * What kind of node a span is in the tree. `fork` is the row 0 of a forked run
 * (spec 06 §1); no journal record folds into it yet, so no fold produces one.
 */
export type SpanKind = "run" | "frame" | "model" | "cell" | "call" | "approval" | "resolved" | "event" | "fork" | "execution" | "attempt"

/** What the journal said about the span; the run root wears the run's own status word. */
export type SpanStatus = "running" | "completed" | "failed" | "waiting" | "approved" | "denied" | string

/** The facts the details pane shows for one span: only what its journal records carry. */
export interface SpanDetail {
  /** The journal sequence that opened the span. */
  readonly sequence?: number
  /** The journal kind that opened the span. */
  readonly event?: string
  readonly seat?: string
  /** A cell's source text. */
  readonly source?: string
  /** What a cell printed for the next model turn. */
  readonly printed?: string
  /** A call's input, as journaled. */
  readonly input?: unknown
  /** A call's settled value, a model's text, or a resolved text. */
  readonly output?: string
  /** A detached child's recorded execution id; only the agent/spawn result establishes this edge. */
  readonly childRunId?: string
  /** A failure's message. */
  readonly message?: string
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
  /** Every other payload field the opening record carried, as the journal bound it. */
  readonly fields?: Readonly<Record<string, unknown>>
}

export interface TraceSpan {
  readonly id: string
  readonly kind: SpanKind
  readonly label: string
  readonly status: SpanStatus
  readonly startedAt: number
  /** Absent while the span is open. */
  readonly endedAt?: number
  readonly depth: number
  readonly children: ReadonlyArray<TraceSpan>
  readonly detail: SpanDetail
}

/** The run the trace belongs to, as the run card knows it. */
export interface TraceRun {
  readonly runId: string
  readonly flowId: string
  /** The run card's phase word (running, completed, failed, cancelled, waiting-approval, ...). */
  readonly status: string
  readonly kind?: string
}

export interface TraceExtent {
  readonly start: number
  readonly end: number
}

export interface TraceModel {
  readonly root: TraceSpan
  /** Every span in tree order, with its depth: the tree's rows and the waterfall's rows. */
  readonly rows: ReadonlyArray<TraceSpan>
  readonly extent: TraceExtent
  readonly counts: { readonly spans: number; readonly running: number; readonly failed: number }
}

/** Mutable draft shared by the control and native journal folds; never persisted. */
export interface TraceBuilder {
  readonly id: string
  readonly kind: SpanKind
  label: string
  status: SpanStatus
  startedAt: number
  endedAt?: number
  readonly children: Array<TraceBuilder>
  detail: SpanDetail
}
type Builder = TraceBuilder

const TERMINAL_RUN: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "no-capacity"])

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined
const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** The record's time: the agent's own `at` stamp when it carries one, the journal's otherwise (the gateway's rule). */
const timeOf = (record: JournalRecord, payload: Record<string, unknown>): number =>
  asNumber(payload.at) ?? asNumber(record.occurredAt) ?? 0

/** One line of text for a value the journal traced, or nothing. */
const textOf = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** The payload fields the pane does not already show by name. */
const restOf = (
  payload: Record<string, unknown>,
  shown: ReadonlyArray<string>
): Record<string, unknown> | undefined => {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (shown.includes(key) || key === "at" || key === "journalVersion") continue
    rest[key] = value
  }
  return Object.keys(rest).length === 0 ? undefined : rest
}

const builder = (
  id: string,
  kind: SpanKind,
  label: string,
  status: SpanStatus,
  startedAt: number,
  detail: SpanDetail
): Builder => ({ id, kind, label, status, startedAt, children: [], detail })

/** A settlement takes the oldest open call with its flow name; an unnamed one takes the oldest open call. */
const takeOpenCall = (
  open: Array<{ readonly flowName: string; readonly span: Builder }>,
  flowName: string | undefined
) => {
  if (flowName === undefined) return open.shift()
  const found = open.findIndex((call) => call.flowName === flowName)
  return found < 0 ? undefined : open.splice(found, 1)[0]
}

/**
 * Folds a run's journal into its trace.
 *
 * Frames open on `turn-opened` and close when the next opens or the run ends;
 * cells open on `cell-produced` and close on `cell-settled`; calls open on
 * `cell-call-started` under the open cell (or the frame, when a call is
 * journaled outside a cell) and settle by flow name the way the gateway's own
 * `run-tree` pairs them, so a call's `call-N` id is the node id the
 * `node-output` projection knows it by. A journal with no records yields the
 * run root alone, wearing the run's status: the honest empty trace.
 *
 * @param run the run as its card knows it
 * @param records the run's journal, in sequence order
 */
export const traceFromJournal = (run: TraceRun, records: ReadonlyArray<JournalRecord>): TraceModel => {
  const ordered = [...records].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
  const firstAt = ordered.length === 0 ? 0 : timeOf(ordered[0]!, asRecord(ordered[0]!.payload))
  const root = builder(`run:${run.runId}`, "run", `run ${run.runId} · ${run.flowId}`, run.status, firstAt, {
    ...(run.kind === undefined ? {} : { fields: { kind: run.kind } })
  })
  let frame: Builder | undefined
  let cell: Builder | undefined
  let frames = 0
  let calls = 0
  let seat: string | undefined
  let lastAt = firstAt
  const openCalls: Array<{ readonly flowName: string; readonly span: Builder }> = []
  const approvals = new Map<string, Builder>()

  /** Where a new span attaches: the open cell, else the open frame, else the run. */
  const parent = (): Builder => cell ?? frame ?? root
  const closeCell = (at: number, status: SpanStatus): void => {
    if (cell === undefined) return
    cell.endedAt = at
    cell.status = status
    cell = undefined
  }
  const closeFrame = (at: number): void => {
    if (frame === undefined) return
    closeCell(at, cell?.children.some((child) => child.status === "failed") === true ? "failed" : "completed")
    frame.endedAt = at
    frame.status = frame.children.some((child) => child.status === "failed") ? "failed" : "completed"
    frame = undefined
  }

  for (const record of ordered) {
    const kind = record.kind ?? ""
    const payload = asRecord(record.payload)
    const at = timeOf(record, payload)
    lastAt = Math.max(lastAt, at)
    const opened = { sequence: record.sequence, event: kind }
    switch (kind) {
      case "control.engine.event":
      case "control.engine.projection-gap":
      case "control.engine.projection-started":
      case "control.engine.projection-settled":
        // Native records have their own identities and lifecycle. Never put
        // them under whichever agent frame happened to be open at ingestion.
        break
      case "control.agent.turn-opened": {
        closeFrame(at)
        frames += 1
        seat = asString(payload.seat) ?? seat
        frame = builder(
          `frame-${frames}`,
          "frame",
          `frame ${frames}${seat === undefined ? "" : ` · ${seat}`}`,
          "running",
          at,
          {
            ...opened,
            ...(seat === undefined ? {} : { seat }),
            fields: restOf(payload, ["seat"])
          }
        )
        root.children.push(frame)
        break
      }
      case "control.agent.model-settled": {
        const usage = asRecord(payload.usage)
        const duration = asNumber(payload.durationMillis)
        const span = builder(
          `model-${record.sequence ?? at}`,
          "model",
          "model",
          "completed",
          duration === undefined ? at : at - duration,
          {
            ...opened,
            ...(seat === undefined ? {} : { seat }),
            output: textOf(payload.text),
            usage: { inputTokens: asNumber(usage.inputTokens), outputTokens: asNumber(usage.outputTokens) },
            fields: restOf(payload, ["text", "usage", "durationMillis"])
          }
        )
        span.endedAt = at
        ;(frame ?? root).children.push(span)
        break
      }
      case "control.agent.cell-produced": {
        closeCell(at, "completed")
        const language = asString(payload.language)
        cell = builder(
          `cell-${record.sequence ?? at}`,
          "cell",
          `cell${language === undefined ? "" : ` · ${language}`}`,
          "running",
          at,
          {
            ...opened,
            source: asString(payload.text),
            fields: restOf(payload, ["text", "language"])
          }
        )
        ;(frame ?? root).children.push(cell)
        break
      }
      case "control.agent.cell-call-started": {
        calls += 1
        const flowName = asString(payload.flowName) ?? `call-${calls}`
        const span = builder(`call-${calls}`, "call", flowName, "running", at, {
          ...opened,
          input: payload.input,
          fields: restOf(payload, ["flowName", "input"])
        })
        openCalls.push({ flowName, span })
        parent().children.push(span)
        break
      }
      case "control.agent.cell-call-settled": {
        const settled = takeOpenCall(openCalls, asString(payload.flowName))
        if (settled === undefined) break
        const failed = asString(payload.outcome) === "failure"
        settled.span.endedAt = at
        settled.span.status = failed ? "failed" : "completed"
        settled.span.detail = {
          ...settled.span.detail,
          ...(failed ? { message: textOf(payload.message) } : { output: textOf(payload.value) }),
          ...(!failed && settled.flowName === "agent/spawn" && asString(asRecord(payload.value).child) !== undefined
            ? { childRunId: asString(asRecord(payload.value).child) }
            : {})
        }
        break
      }
      case "control.agent.cell-printed": {
        if (cell === undefined) {
          parent().children.push(
            builder(`printed-${record.sequence ?? at}`, "event", "printed", "completed", at, {
              ...opened,
              printed: textOf(payload.text)
            })
          )
          break
        }
        cell.detail = {
          ...cell.detail,
          printed: [cell.detail.printed, textOf(payload.text)].filter((text) => text !== undefined).join("\n")
        }
        break
      }
      case "control.agent.cell-settled": {
        closeCell(at, asString(payload.outcome) === "failure" ? "failed" : "completed")
        break
      }
      case "control.agent.resolved": {
        const span = builder(`resolved-${record.sequence ?? at}`, "resolved", "resolved", "completed", at, {
          ...opened,
          output: textOf(payload.text)
        })
        span.endedAt = at
        ;(frame ?? root).children.push(span)
        break
      }
      case "control.approval.requested": {
        const requestId = asString(payload.requestId) ?? `approval-${record.sequence ?? at}`
        const question = asString(payload.question)
        const span = builder(
          `approval-${requestId}`,
          "approval",
          `approval${question === undefined ? "" : ` · ${question}`}`,
          "waiting",
          at,
          {
            ...opened,
            fields: restOf(payload, ["question", "requestId", "payload", "runId"])
          }
        )
        approvals.set(requestId, span)
        ;(frame ?? root).children.push(span)
        break
      }
      case "control.approval.approved":
      case "control.approval.denied": {
        const decided = kind === "control.approval.approved" ? "approved" : "denied"
        const key = asString(payload.tokenId) ?? asString(payload.requestId)
        const span = key === undefined
          ? [...approvals.values()].find((entry) => entry.status === "waiting")
          : approvals.get(key)
        if (span === undefined) break
        span.status = decided
        span.endedAt = at
        break
      }
      case "control.run.completed":
      case "control.run.failed":
      case "control.run.cancelled": {
        closeFrame(at)
        root.endedAt = at
        // The journal's own verdict outranks the card's phase word: a scrub to this record shows the run settled.
        root.status = kind.slice("control.run.".length)
        break
      }
      default: {
        if (!kind.startsWith("control.")) break
        const span = builder(
          `event-${record.sequence ?? at}`,
          "event",
          kind.slice("control.".length),
          "completed",
          at,
          {
            ...opened,
            fields: restOf(payload, [])
          }
        )
        span.endedAt = at
        parent().children.push(span)
      }
    }
  }
  root.children.push(...engineTraceFromJournal(ordered))
  // A settled run leaves no frame open: the last frame ends where the journal does.
  if (TERMINAL_RUN.has(run.status)) {
    closeFrame(lastAt)
    if (root.endedAt === undefined && ordered.length > 0) root.endedAt = lastAt
  }

  const freeze = (node: Builder, depth: number): TraceSpan => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    status: node.status,
    startedAt: node.startedAt,
    ...(node.endedAt === undefined ? {} : { endedAt: node.endedAt }),
    depth,
    children: node.children.map((child) => freeze(child, depth + 1)),
    detail: node.detail
  })
  const frozenRoot = freeze(root, 0)
  const rows: Array<TraceSpan> = []
  const walk = (span: TraceSpan): void => {
    rows.push(span)
    for (const child of span.children) walk(child)
  }
  walk(frozenRoot)
  let start = Number.POSITIVE_INFINITY
  let end = 0
  for (const span of rows) {
    start = Math.min(start, span.startedAt)
    end = Math.max(end, span.endedAt ?? span.startedAt)
  }
  const extent = ordered.length === 0 || !Number.isFinite(start)
    ? { start: 0, end: 0 }
    : { start, end: Math.max(end, start) }
  return {
    root: frozenRoot,
    rows,
    extent,
    counts: {
      spans: rows.length - 1,
      running: rows.filter((span) => span.kind !== "run" && span.status === "running").length,
      failed: rows.filter((span) => span.kind !== "run" && span.status === "failed").length
    }
  }
}

/**
 * One span's bar on the shared axis, as percentages. An open span runs to the
 * axis end; an instant span is zero width and renders as a marker.
 *
 * @param span the span
 * @param extent the axis
 */
export const waterfallGeometry = (
  span: TraceSpan,
  extent: TraceExtent
): { readonly left: number; readonly width: number } => {
  const width = Math.max(extent.end - extent.start, 1)
  const from = span.startedAt
  const to = span.endedAt ?? extent.end
  const left = ((from - extent.start) / width) * 100
  const bar = Math.max(((to - from) / width) * 100, 0)
  return { left: Math.round(left * 100) / 100, width: Math.round(bar * 100) / 100 }
}

/** The flows whose spans are messages between a coordinator and its workers (spec 06 §3). */
const MESSAGE_FLOWS: ReadonlySet<string> = new Set(["agent/send", "agent/await"])

/** Whether a span, or any span under it, passes the filter. */
export const spanMatches = (span: TraceSpan, filter: TraceFilter): boolean => {
  const own = filter === "all"
    ? true
    : filter === "running"
    ? span.status === "running" || span.status === "waiting"
    : filter === "failed"
    ? span.status === "failed"
    : filter === "model"
    ? span.kind === "model"
    : filter === "flow"
    ? span.kind === "call" || span.kind === "execution" || span.kind === "attempt"
    : filter === "forks"
    ? span.kind === "fork"
    : span.kind === "call" && MESSAGE_FLOWS.has(span.label)
  return own || span.children.some((child) => spanMatches(child, filter))
}

/** The tree's filters, in the slash grammar's words (spec 06 §6: `runs.trace.filter <runId> <filter>`). */
export type TraceFilter = "all" | "running" | "failed" | "model" | "flow" | "forks" | "messages"

export const TRACE_FILTER_IDS: ReadonlyArray<TraceFilter> = [
  "all",
  "running",
  "failed",
  "model",
  "flow",
  "forks",
  "messages"
]

const FILTER_LABELS: Readonly<Record<TraceFilter, string>> = {
  all: "all",
  running: "running",
  failed: "failed",
  model: "model calls",
  flow: "flow calls",
  forks: "forks",
  messages: "messages"
}

/**
 * The filter chips a run of this kind shows (spec 06 §2 and §3): a prototype
 * has `all | messages | failed` and nothing else; every other run has the
 * shared set. `messages` is a prototype's conversation across workers, so it
 * is not offered elsewhere.
 *
 * @param kind the run's kind
 */
export const traceFiltersFor = (kind: string | undefined): ReadonlyArray<readonly [TraceFilter, string]> =>
  (kind === "prototype"
    ? (["all", "messages", "failed"] as const)
    : (["all", "running", "failed", "model", "flow", "forks"] as const)).map((id) => [id, FILTER_LABELS[id]] as const)

/** Whether a filter word is one the trace knows. */
export const isTraceFilter = (value: string): value is TraceFilter =>
  (TRACE_FILTER_IDS as ReadonlyArray<string>).includes(value)

/** The two presentations of the same persisted run card. */
export type TraceView = "turns" | "timeline"

/** A concise projection of one recorded turn, never a generated claim about intent or correctness. */
export interface TurnNarrative {
  readonly frame: TraceSpan
  readonly number: number
  readonly text: string
  readonly source: "model" | "calls" | "journal"
}

/** The first prose line outside fenced code, bounded for the cheap turn list. Full text stays in the model span. */
const proseLine = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined
  let fence: string | undefined
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    const marker = /^(?:`{3,}|~{3,})/.exec(trimmed)?.[0]
    if (marker !== undefined) {
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (fence !== undefined || trimmed === "") continue
    // A code-only response or the journal's truncated-field object is not explanatory prose.
    if (/^(?:[\[{]|(?:const|let|var|await|import|export|function|return)\b)/.test(trimmed)) return undefined
    const words = trimmed.replace(/^#{1,6}\s+|^[-*+]\s+|^>\s+/, "").replace(/\s+/g, " ")
    if (words === "") continue
    const sentence = words.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? `${words}.`
    return sentence.length <= 180 ? sentence : `${sentence.slice(0, 179).trimEnd()}…`
  }
  return undefined
}

/** One cheap line per turn; falls back to actual call names when the model recorded only code. */
export const turnNarratives = (model: TraceModel): ReadonlyArray<TurnNarrative> =>
  model.root.children.filter((span) => span.kind === "frame").map((frame, index) => {
    const text = frame.children.filter((span) => span.kind === "model").map((span) => proseLine(span.detail.output))
      .find((value) => value !== undefined)
    if (text !== undefined) return { frame, number: index + 1, text, source: "model" }
    const names: Array<string> = []
    const walk = (span: TraceSpan): void => {
      if (span.kind === "call" && !names.includes(span.label)) names.push(span.label)
      for (const child of span.children) walk(child)
    }
    walk(frame)
    return names.length > 0
      ? {
        frame,
        number: index + 1,
        text: `The agent called ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} other flows` : ""}.`,
        source: "calls"
      }
      : { frame, number: index + 1, text: frame.children.some((span) => span.kind === "cell")
          ? "The agent produced a script; no flow calls were recorded in this turn."
          : frame.children.some((span) => span.kind === "model")
          ? "The model responded; no script or flow calls were recorded in this turn."
          : "The turn started; no model response or flow calls have been recorded.", source: "journal" }
  })

/** The recorded ancestry of a selection, for breadcrumbs and the selected turn's scoped call tree. */
export const spanPath = (model: TraceModel, id: string): ReadonlyArray<TraceSpan> => {
  const visit = (span: TraceSpan): ReadonlyArray<TraceSpan> | undefined => {
    if (span.id === id) return [span]
    for (const child of span.children) {
      const path = visit(child)
      if (path !== undefined) return [span, ...path]
    }
    return undefined
  }
  return visit(model.root) ?? [model.root]
}

/** A duration in the trace's units: milliseconds under a second, seconds under a minute, minutes and seconds after. */
export const durationWords = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms - minutes * 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, "0")}s`
}
