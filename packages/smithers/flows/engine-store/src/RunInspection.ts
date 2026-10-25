/**
 * One run as a person debugging it reads it: what it was given, what it
 * answered, each step it took with its attempts and output, the runs it
 * started, and a page of its journal.
 *
 * `RunInspection` is the display read of the engine's own tables
 * (`flows_runs`, `flows_attempts`, `flows_run_parents` and
 * `flows_journal_events`), never a copy of them. Every value it releases
 * passes through `@smthrs/journal`'s `Redaction.redact` first and is then cut
 * to {@link valueLimitBytes} of UTF-8, so a credential-shaped string never
 * leaves it and a large value costs a reader a known number of bytes. A
 * failure is reduced to a closed code, the failure's tag, so neither a
 * provider's error text nor a defect's message is released.
 *
 * Built with the engine's flows (`layerWith({ flows })`), the reads know each
 * flow's payload and success schemas and, from each flow's plan, each action's
 * success schema. Every value with a known schema is decoded with it and
 * encoded again for display, so a `Schema.Redacted` value at any depth reads
 * as {@link redactedMarker}; one its schema no longer decodes reads as
 * {@link withheldMarker}, never as the stored text. A value whose flow or
 * action is not reachable from those flows, such as an action a body reaches
 * only with its real input, has the redactor's rules alone between it and the
 * reader: return a secret from such a step only inside a field the rules name.
 *
 * {@link Service.payload} is the one read that is not for display: it hands
 * back the run's encoded payload as the engine stored it, so a host can run
 * the same flow again. It belongs inside the engine and never on a wire.
 *
 * Every read runs in one read transaction (`Dialect.readTransaction`), on
 * SQLite and on PostgreSQL alike.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import { Flow, Graph } from "@smthrs/flow"
import { EngineEvent, Redaction } from "@smthrs/journal"
import { Node, Planned } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Read from "./internal/ExecutionSnapshotRead.ts"
import { RunState } from "./RunState.ts"

/**
 * The most bytes of UTF-8 one released value holds: 16 KiB.
 *
 * @category constants
 * @since 1.0.0
 */
export const valueLimitBytes = 16 * 1024

/**
 * The most journal events one {@link Service.inspect} returns.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumJournalPage = 500

/**
 * The most runs one {@link Service.list} returns.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumListPage = 200

/**
 * The most flow tags one {@link Service.list} filters by.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumListFlows = 64

/**
 * The most child runs one {@link Service.inspect} returns, oldest first.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumChildren = 200

/**
 * One value as it is released: redacted JSON text, cut to
 * {@link valueLimitBytes}. `bytes` is the size of the whole redacted text, and
 * `clipped` says the cut happened, so `text` is then a prefix that no longer
 * parses.
 *
 * @category models
 * @since 1.0.0
 */
export interface Value {
  readonly text: string
  readonly bytes: number
  readonly clipped: boolean
}

/**
 * A run's durable wait: its structured kind, the engine's reason and when it
 * wakes. The token that resolves it is never released.
 *
 * @category models
 * @since 1.0.0
 */
export interface Waiting {
  readonly kind: "timer" | "signal" | "approval" | "quota" | "human" | "other"
  readonly reason: string
  readonly wakeAtMs: number | null
}

/**
 * One run's lifecycle. `parentRunId` is the effective parent: `parent_run_id`,
 * else the earliest spawn edge. `lastSeq` is the run's latest journal
 * sequence, `-1` with none: an act on the run carries it, so a reader can tell
 * whether the run moved since it looked.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunSummary {
  readonly runId: string
  readonly flowName: string
  readonly status: RunStore.RunStatus
  readonly createdAtMs: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly parentRunId: string | null
  readonly cancelRequestedAtMs: number | null
  readonly waiting: Waiting | null
  readonly lastSeq: number
  /**
   * How the run started, as its caller said when the engine admitted it
   * (`@smthrs/flow` `RunMetrics.CurrentOrigin`): the door and the actor kind,
   * never who. `null` for a run admitted before the engine kept it.
   */
  readonly origin: Origin | null
}

/**
 * How a run started: the door it came through (such as `button`, `agent` or
 * `flow` for a run another run started) and the kind of actor behind it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Origin {
  readonly door: string
  readonly actor: string
}

/**
 * One attempt of a step. `error` is a closed code, the failure's tag, or
 * `defect`, `interrupted` or `failed`; never a message.
 *
 * @category models
 * @since 1.0.0
 */
export interface Attempt {
  readonly attempt: number
  readonly state: string
  readonly startedAtMs: number
  readonly finishedAtMs: number | null
  readonly outcome: Value | null
  readonly error: string | null
}

/**
 * One plan node, folded from its `flows.engine.node-scheduled` and
 * `flows.engine.node-settled` events. A node's attempts are the
 * `flows_attempts` rows whose step key digest its settlement names, so a node
 * still running lists none yet. `output` is its last attempt's outcome, else
 * the result preview its settlement recorded.
 *
 * @category models
 * @since 1.0.0
 */
export interface Step {
  readonly nodeId: string
  readonly action: string | null
  readonly kind: string
  readonly status: "running" | "completed" | "failed" | "waiting" | "skipped"
  readonly scheduledAtMs: number
  readonly settledAtMs: number | null
  readonly seq: number
  readonly output: Value | null
  readonly attempts: ReadonlyArray<Attempt>
}

/**
 * A run this run started: an explicit child boundary, or an agent's cell call,
 * whose input and result are that step's input and output.
 *
 * @category models
 * @since 1.0.0
 */
export interface Child extends RunSummary {
  readonly input: Value
  readonly result: Value | null
}

/**
 * One journal event of the run, its payload redacted and cut.
 *
 * @category models
 * @since 1.0.0
 */
export interface Event {
  readonly seq: number
  readonly eventType: string
  readonly emittedAtMs: number
  readonly payload: Value
}

/**
 * One page of a run's journal: the events after `afterSeq`, ascending.
 * `nextSeq` is the last one returned, or `afterSeq` when none were; pass it
 * as the next page's `afterSeq`. `hasMore` says more events exist now.
 *
 * @category models
 * @since 1.0.0
 */
export interface JournalPage {
  readonly events: ReadonlyArray<Event>
  readonly afterSeq: number
  readonly nextSeq: number
  readonly hasMore: boolean
}

/**
 * What {@link Service.inspect} reads of one run.
 *
 * @category models
 * @since 1.0.0
 */
export interface Inspection {
  readonly run: RunSummary & { readonly input: Value; readonly result: Value | null }
  readonly steps: ReadonlyArray<Step>
  readonly children: ReadonlyArray<Child>
  readonly journal: JournalPage
}

/**
 * One page of runs, newest first, and the cursor of the next, `null` at the
 * end.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunList {
  readonly runs: ReadonlyArray<RunSummary>
  readonly cursor: string | null
}

/**
 * The engine holds no run with this id.
 *
 * @category errors
 * @since 1.0.0
 */
export class RunNotFound extends Schema.TaggedError<RunNotFound>()("@smthrs/engine-store/RunNotFound", {
  runId: Schema.String
}) {}

/**
 * The run reads.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  /**
   * The run, its steps, its children and the journal page after `afterSeq`
   * (default `-1`), at most `limit` events (default and most
   * {@link maximumJournalPage}).
   */
  readonly inspect: (
    runId: string,
    options?: { readonly afterSeq?: number; readonly limit?: number }
  ) => Effect.Effect<Inspection, RunNotFound | RunStore.RunStoreError>
  /**
   * Runs newest first, `limit` at a time (default 50, at most
   * {@link maximumListPage}), from `cursor`. `roots`, the default, keeps the
   * runs with no parent. `runIds` keeps only those runs, at most
   * {@link maximumListPage} of them (more fail `invalid_run`); a run the
   * engine doesn't hold is left out, so a caller that knows its runs by
   * another index reads their state in one round trip. `flows` keeps only
   * the runs of those flows, by tag, at most {@link maximumListFlows} of them.
   */
  readonly list: (
    options?: {
      readonly limit?: number
      readonly cursor?: string
      readonly roots?: boolean
      readonly runIds?: ReadonlyArray<string>
      readonly flows?: ReadonlyArray<string>
    }
  ) => Effect.Effect<RunList, RunStore.RunStoreError>
  /**
   * The run's flow and its payload exactly as the engine stored it: encoded
   * and unredacted. It exists to run the same flow again inside the engine,
   * and must never reach a reader or a wire.
   */
  readonly payload: (
    runId: string
  ) => Effect.Effect<{ readonly flowName: string; readonly payload: unknown }, RunNotFound | RunStore.RunStoreError>
}

/**
 * The run reads, over the engine's database.
 *
 * @category services
 * @since 1.0.0
 */
export class RunInspection extends Context.Service<RunInspection, Service>()("@smthrs/engine-store/RunInspection") {}

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

/**
 * Cuts `text` to {@link valueLimitBytes} of UTF-8 at a character boundary.
 *
 * @category values
 * @since 1.0.0
 */
export const clip = (text: string): Value => {
  const encoded = utf8.encode(text)
  if (encoded.length <= valueLimitBytes) return { text, bytes: encoded.length, clipped: false }
  let end = valueLimitBytes
  // A continuation byte is 10xxxxxx: back off to the start of its character.
  while ((encoded[end]! & 0xc0) === 0x80) end--
  return { text: fromUtf8.decode(encoded.subarray(0, end)), bytes: encoded.length, clipped: true }
}

/** Wrappers a cause or an exit is made of, which are never the failure itself. */
const wrappers = new Set(["Fail", "Failure", "Cause", "Sequential", "Parallel", "Then", "Both", "Empty"])

/** A tag that is an identifier, not text: a closed code. */
const identifier = /^[A-Za-z0-9_@$./:-]{1,200}$/

/**
 * The closed code of a stored failure: the first tag in it that names a
 * failure, `defect` for a defect, `interrupted` for an interruption, else
 * `failed`. Nothing else of the failure is read.
 *
 * @category values
 * @since 1.0.0
 */
export const codeOf = (failure: unknown): string => {
  const seen = new Set<unknown>()
  const visit = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null || seen.has(value)) return undefined
    seen.add(value)
    const tag = (value as { readonly _tag?: unknown })._tag
    if (tag === "Die") return "defect"
    if (tag === "Interrupt") return "interrupted"
    if (typeof tag === "string" && !wrappers.has(tag)) return identifier.test(tag) ? tag : "failed"
    for (const member of Array.isArray(value) ? value : Object.values(value)) {
      const found = visit(member)
      if (found !== undefined) return found
    }
    return undefined
  }
  return visit(failure) ?? "failed"
}

/**
 * Replaces each failure inside `value` with its closed code: an encoded exit's
 * `Failure` cause, a `Fail`'s error and a `Die`'s defect. Everything else is
 * kept for the redactor.
 */
const scrubFailures = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrubFailures)
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  if (record._tag === "Failure" && "cause" in record) return { _tag: "Failure", failure: codeOf(record.cause) }
  if (record._tag === "Fail" && "error" in record) return { _tag: "Fail", failure: codeOf(record) }
  if (record._tag === "Die") return { _tag: "Die", failure: "defect" }
  return Object.fromEntries(Object.entries(record).map(([key, member]) => [key, scrubFailures(member)]))
}

/**
 * A value as it is released: failures reduced to codes, redacted, encoded as
 * JSON and cut.
 *
 * @category values
 * @since 1.0.0
 */
export const valueOf = (value: unknown): Value =>
  clip(JSON.stringify(Redaction.redact(scrubFailures(value), { onTooDeep: "name" })) ?? "null")

/**
 * What Effect writes for a `Redacted` value when it encodes one for display
 * (its `toJSON`): the reads put it wherever a schema-known value held one.
 *
 * @category values
 * @since 1.0.0
 */
export const redactedMarker = "<redacted>"

/**
 * What the reads release in place of a value they cannot show safely: one
 * whose schema is known but no longer decodes it, a cut preview of a schema
 * that holds a `Redacted` value, and the output of a node with no action.
 *
 * @category values
 * @since 1.0.0
 */
export const withheldMarker = "<withheld>"

/** A withheld value, as it is released. */
const withheld: Value = clip(JSON.stringify(withheldMarker))

/**
 * Whether `schema` holds a `Schema.Redacted` value anywhere: in a field, an
 * element, a union member, a recursive reference or an encoding step.
 *
 * @category values
 * @since 1.0.0
 */
export const holdsRedacted = (schema: Schema.Top): boolean => {
  const seen = new Set<unknown>()
  const visit = (node: unknown): boolean => {
    if (typeof node !== "object" || node === null || seen.has(node)) return false
    seen.add(node)
    const ast = node as {
      readonly _tag?: unknown
      readonly thunk?: unknown
      readonly annotations?: { readonly representation?: { readonly id?: unknown } }
    }
    if (ast.annotations?.representation?.id === "effect/schema/Redacted") return true
    if (ast._tag === "Suspend" && typeof ast.thunk === "function") return visit(ast.thunk())
    return (Array.isArray(node) ? node : Object.values(node)).some(visit)
  }
  return visit(schema.ast)
}

/**
 * The schemas the reads know: each flow's payload, and each flow's and each
 * action's success, by tag.
 */
interface Schemas {
  readonly payloadOf: (flowName: string) => Schema.Top | undefined
  readonly successOf: (tag: string) => Schema.Top | undefined
}

/** No schemas: every value read as stored, behind the redactor's rules. */
const noSchemas: Schemas = { payloadOf: () => undefined, successOf: () => undefined }

/**
 * The schemas reachable from `flows`: each flow's own, and each action's
 * success schema, read off the flow's plan the way `Graph.inspect` builds it,
 * against a placeholder input. A child boundary's flow is walked as well. A
 * flow whose body cannot be planned without its real input contributes only
 * its own schemas.
 */
const schemasOf = (flows: ReadonlyArray<Flow.Any>): Schemas => {
  const payloads = new Map<string, Schema.Top>()
  const successes = new Map<string, Schema.Top>()
  const queue = [...flows]
  for (let flow = queue.shift(); flow !== undefined; flow = queue.shift()) {
    if (payloads.has(flow._tag)) continue
    payloads.set(flow._tag, flow.payloadSchema)
    successes.set(flow._tag, flow.successSchema)
    let graph: Graph.Graph
    try {
      graph = Graph.build(flow, Planned.make("input"))
    } catch {
      continue
    }
    for (const { ast } of graph.nodes) {
      if (ast._tag === "ActionCall" && !successes.has(ast.action)) {
        successes.set(ast.action, (Node.declaration(ast) as { readonly successSchema: Schema.Top }).successSchema)
      }
    }
    // A child boundary is one node whose flow runs on its own: walk that flow too.
    queue.push(
      ...graph.nodes.flatMap(({ ast }) => ast._tag === "FlowCall" ? [Node.declaration(ast)] : []).filter(Flow.isFlow)
    )
  }
  return { payloadOf: (flowName) => payloads.get(flowName), successOf: (tag) => successes.get(tag) }
}

/** Display JSON keeps a big integer as its digits. */
const displayReplacer = (_: string, value: unknown) => typeof value === "bigint" ? value.toString() : value

/**
 * An encoded value as it is shown: decoded with its schema's JSON codec, then
 * encoded for display, so a `Redacted` value at any depth reads as
 * {@link redactedMarker}. Without a schema the value is as stored. With one
 * that no longer decodes it, or a decoded value with no JSON form, it is
 * {@link withheldMarker}: never the stored text.
 */
const displayed = (schema: Schema.Top | undefined, encoded: unknown): unknown => {
  if (schema === undefined) return encoded
  const decoded = Schema.decodeUnknownOption(Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>)(
    encoded
  )
  if (Option.isNone(decoded)) return withheldMarker
  try {
    // Wrapped, so a value JSON has no text for (`undefined`) reads as `null`.
    return JSON.parse(JSON.stringify([decoded.value], displayReplacer))[0]
  } catch {
    return withheldMarker
  }
}

/** A stored JSON text that does not parse. */
const unparsed = Symbol("unparsed")

/** Parsed JSON, or {@link unparsed}. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return unparsed
  }
}

/**
 * A node's settled result preview as it is released. A failed node's is its
 * failure, so only the code. A node with no action passes on a value one of
 * its steps made, so it is withheld. A known action's or flow's preview is
 * parsed and shown through its schema; one that was cut, or no longer parses,
 * is withheld when that schema holds a `Redacted` value. An unknown one passes
 * the redactor's rules again and keeps the writer's size and flag.
 */
const previewOf = (
  schemas: Schemas,
  action: string | null,
  outcome: typeof NodeSettled.Type["outcome"],
  result: typeof NodeResult.Type
): Value => {
  if (outcome === "failed") return valueOf({ failure: codeOf(parseOr(result.preview)) })
  if (action === null) return withheld
  const schema = schemas.successOf(action)
  const parsed = result.truncated ? unparsed : parseJson(result.preview)
  if (schema !== undefined && parsed !== unparsed) return valueOf(displayed(schema, parsed))
  if (schema !== undefined && holdsRedacted(schema)) return withheld
  const cut = clip(String(Redaction.redact(result.preview)))
  return { text: cut.text, bytes: result.bytes, clipped: result.truncated || cut.clipped }
}

/**
 * A run's stored result as it is released: a success's value, a failure's
 * code, a suspension or handoff by its tag, `null` before it has one.
 */
const resultOf = (result: unknown, success: Schema.Top | undefined): Value | null => {
  if (result === undefined || result === null) return null
  const envelope = result as {
    readonly _tag?: unknown
    readonly exit?: { readonly _tag?: unknown } & Record<string, unknown>
  }
  if (envelope._tag === "Complete" && envelope.exit?._tag === "Success") {
    return valueOf(displayed(success, envelope.exit.value))
  }
  if (envelope._tag === "Complete") return valueOf({ failure: codeOf(envelope.exit?.cause) })
  return valueOf({ _tag: envelope._tag })
}

/**
 * A journal event's payload as it is released. A run decision's `state`
 * carries the run's payload and result as stored, so they show through the
 * run's flow; a settled node's result preview shows as {@link previewOf} says.
 */
const eventPayloadOf = (eventType: string, text: string, schemas: Schemas): Value => {
  const parsed = parseOr(text)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return valueOf(parsed)
  const record = parsed as Record<string, unknown>
  const state = record.state as Record<string, unknown> | undefined
  if (typeof state === "object" && state !== null && typeof state.flowName === "string") {
    const flowName = state.flowName
    const result = state.result as { readonly exit?: Record<string, unknown> } | undefined
    record.state = {
      ...state,
      payload: displayed(schemas.payloadOf(flowName), state.payload),
      ...(result?.exit?._tag === "Success"
        ? {
          result: {
            ...result,
            exit: { ...result.exit, value: displayed(schemas.successOf(flowName), result.exit.value) }
          }
        }
        : {})
    }
  }
  if (eventType === EngineEvent.nodeEventTypes.nodeSettled) {
    const settled = decodeSettledValue(record)
    if (Option.isSome(settled) && settled.value.result !== undefined) {
      const shown = previewOf(schemas, settled.value.action ?? null, settled.value.outcome, settled.value.result)
      record.result = { ...settled.value.result, preview: shown.text, truncated: shown.clipped }
    }
  }
  return valueOf(record)
}

const RunRow = Schema.Struct({
  run_id: Read.Identifier,
  status: Schema.Literals(["pending", "running", "suspended", "completed", "failed", "cancelled"]),
  created_at_ms: Read.Natural,
  started_at_ms: Schema.NullOr(Read.Natural),
  finished_at_ms: Schema.NullOr(Read.Natural),
  parent_run_id: Schema.NullOr(Read.Identifier),
  spawn_parent_id: Schema.NullOr(Read.Identifier),
  cancel_requested_at_ms: Schema.NullOr(Read.Natural),
  waiting_reason: Schema.NullOr(Schema.NonEmptyString),
  waiting_wake_at_ms: Schema.NullOr(Read.Natural),
  state_json: Schema.fromJsonString(RunState),
  last_seq: Schema.NullOr(Read.Natural)
})
type RunRow = typeof RunRow.Type

const AttemptRow = Schema.Struct({
  step_key_digest: Schema.NonEmptyString,
  attempt: Read.Natural,
  state: Schema.NonEmptyString,
  started_at_ms: Read.Natural,
  finished_at_ms: Schema.NullOr(Read.Natural),
  error_json: Schema.NullOr(Schema.String),
  outcome_json: Schema.NullOr(Schema.String)
})

const EventRow = Schema.Struct({
  seq: Read.Natural,
  event_type: Schema.NonEmptyString,
  emitted_at_ms: Read.Natural,
  payload_json: Schema.String
})

const NodeScheduled = Schema.Struct({
  nodeId: Schema.NonEmptyString,
  kind: Schema.String,
  action: Schema.optionalKey(Schema.String)
})
const NodeResult = Schema.Struct({ preview: Schema.String, bytes: Schema.Number, truncated: Schema.Boolean })
const NodeSettled = Schema.Struct({
  nodeId: Schema.NonEmptyString,
  outcome: Schema.Literals(["built", "clean", "failed", "skipped", "deferred"]),
  action: Schema.optionalKey(Schema.String),
  stepKeyDigests: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  result: Schema.optionalKey(NodeResult)
})
const decodeScheduled = Schema.decodeUnknownOption(Schema.fromJsonString(NodeScheduled))
const decodeSettled = Schema.decodeUnknownOption(Schema.fromJsonString(NodeSettled))
const decodeSettledValue = Schema.decodeUnknownOption(NodeSettled)

const Cursor = Schema.fromJsonString(Schema.Struct({ createdAtMs: Read.Natural, runId: Read.Identifier }))
const decodeCursor = Schema.decodeUnknownEffect(Cursor)
const encodeCursor = Schema.encodeSync(Cursor)

/** A run with no parent: no `parent_run_id` and no spawn edge. */
const rootCondition =
  "r.parent_run_id IS NULL AND NOT EXISTS (SELECT 1 FROM flows_run_parents p WHERE p.child_id = r.run_id)"

/** One run row's columns, with its earliest spawn parent and its latest journal sequence. */
const runColumns = `r.run_id, r.status, r.created_at_ms, r.started_at_ms, r.finished_at_ms, r.parent_run_id,
  r.cancel_requested_at_ms, r.waiting_reason, r.waiting_wake_at_ms, r.state_json,
  (SELECT parent_id FROM flows_run_parents WHERE child_id = r.run_id ORDER BY seq, parent_id LIMIT 1) AS spawn_parent_id,
  (SELECT MAX(seq) FROM flows_journal_events WHERE run_id = r.run_id) AS last_seq`

/** A run row as a summary. */
const summaryOf = (row: RunRow): RunSummary => ({
  runId: row.run_id,
  flowName: row.state_json.flowName,
  status: row.status,
  createdAtMs: row.created_at_ms,
  startedAtMs: row.started_at_ms,
  finishedAtMs: row.finished_at_ms,
  parentRunId: row.parent_run_id ?? row.spawn_parent_id,
  cancelRequestedAtMs: row.cancel_requested_at_ms,
  waiting: row.waiting_reason === null ? null : {
    kind: Read.waitingKind(row.waiting_reason),
    reason: row.waiting_reason,
    wakeAtMs: row.waiting_wake_at_ms
  },
  lastSeq: row.last_seq ?? -1,
  origin: row.state_json.origin === undefined
    ? null
    : { door: row.state_json.origin.door, actor: row.state_json.origin.actor }
})

/** A run row with what it was given and what it answered, shown through its flow. */
const detailOf = (row: RunRow, schemas: Schemas) => {
  const { flowName, payload, result } = row.state_json
  return {
    ...summaryOf(row),
    input: valueOf(displayed(schemas.payloadOf(flowName), payload)),
    result: resultOf(result, schemas.successOf(flowName))
  }
}

/** How a node settled, in the words a step uses. */
const settledStatus = (outcome: typeof NodeSettled.Type["outcome"]): Step["status"] => {
  switch (outcome) {
    case "built":
    case "clean":
      return "completed"
    case "failed":
      return "failed"
    case "deferred":
      return "waiting"
    case "skipped":
      return "skipped"
  }
}

interface StepDraft {
  nodeId: string
  action: string | null
  kind: string
  status: Step["status"]
  scheduledAtMs: number
  settledAtMs: number | null
  seq: number
  preview: Value | null
  digests: ReadonlyArray<string>
}

/**
 * Folds node events into steps, in the order they were scheduled. A node
 * scheduled again after it settled is a new step; one scheduled again while
 * open is the same step. A settlement with no scheduling opens its own step.
 */
const foldSteps = (events: ReadonlyArray<typeof EventRow.Type>, schemas: Schemas): Array<StepDraft> => {
  const steps: Array<StepDraft> = []
  const open = new Map<string, StepDraft>()
  for (const event of events) {
    if (event.event_type === EngineEvent.nodeEventTypes.nodeScheduled) {
      const scheduled = decodeScheduled(event.payload_json)
      if (Option.isNone(scheduled)) continue
      const { action, kind, nodeId } = scheduled.value
      const opened = open.get(nodeId)
      if (opened !== undefined) {
        // Scheduled again while open, as a retried dispatch is: the same step.
        opened.action = action ?? opened.action
        continue
      }
      const step: StepDraft = {
        nodeId,
        action: action ?? null,
        kind,
        status: "running",
        scheduledAtMs: event.emitted_at_ms,
        settledAtMs: null,
        seq: event.seq,
        preview: null,
        digests: []
      }
      steps.push(step)
      open.set(nodeId, step)
      continue
    }
    const settled = decodeSettled(event.payload_json)
    if (Option.isNone(settled)) continue
    const { action, nodeId, outcome, result, stepKeyDigests } = settled.value
    let step = open.get(nodeId)
    if (step === undefined) {
      step = {
        nodeId,
        action: null,
        kind: "unknown",
        status: "running",
        scheduledAtMs: event.emitted_at_ms,
        settledAtMs: null,
        seq: event.seq,
        preview: null,
        digests: []
      }
      steps.push(step)
    }
    open.delete(nodeId)
    step.action = action ?? step.action
    step.status = settledStatus(outcome)
    step.settledAtMs = event.emitted_at_ms
    step.digests = stepKeyDigests ?? []
    if (result !== undefined) step.preview = previewOf(schemas, step.action, outcome, result)
  }
  return steps
}

/** The page size `limit` asks for. */
const pageSize = (limit: number | undefined, maximum: number, fallback: number) =>
  Math.max(1, Math.min(maximum, Math.floor(limit ?? fallback)))

/**
 * What the reads know of the flows whose runs they read. With `flows`, a run's
 * payload, its result and each step's output show through their schemas (the
 * flow's, and each action's read off the flow's plan), so a `Schema.Redacted`
 * value reads as `<redacted>` at any depth and a value its schema no longer
 * decodes as `<withheld>`; without, every value is read as stored and only the
 * redactor's rules stand between it and the reader.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly flows?: ReadonlyArray<Flow.Any> | undefined
}

/**
 * Builds the reads over `SqlClient`; the engine's migrations must already be
 * applied.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options = {}): Effect.Effect<Service, never, SqlClient.SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const schemas = options.flows === undefined ? noSchemas : schemasOf(options.flows)
    const decode = <S extends Schema.Top>(schema: S, rows: ReadonlyArray<unknown>) =>
      Effect.forEach(rows, (row) => Read.decode(schema, row))

    const runRow = (runId: string) =>
      Dialect.query(sql, `SELECT ${runColumns} FROM flows_runs r WHERE r.run_id = ?`, [runId]).pipe(
        Effect.flatMap((rows) => decode(RunRow, rows)),
        Effect.flatMap(([row]) => row === undefined ? Effect.fail(new RunNotFound({ runId })) : Effect.succeed(row))
      )

    const inspect: Service["inspect"] = (runId, options = {}) => {
      const afterSeq = Math.max(-1, Math.floor(options.afterSeq ?? -1))
      const limit = pageSize(options.limit, maximumJournalPage, maximumJournalPage)
      return Read.boundary(
        "RunInspection.inspect",
        Dialect.readTransaction(
          sql,
          Effect.gen(function*() {
            const row = yield* runRow(runId)
            const attempts = yield* Dialect.query(
              sql,
              `SELECT step_key_digest, attempt, state, started_at_ms, finished_at_ms, error_json, outcome_json
            FROM flows_attempts WHERE run_id = ? ORDER BY started_at_ms, step_key_digest, attempt`,
              [runId]
            ).pipe(Effect.flatMap((rows) => decode(AttemptRow, rows)))
            const nodes = yield* Dialect.query(
              sql,
              `SELECT seq, event_type, emitted_at_ms, payload_json FROM flows_journal_events
            WHERE run_id = ? AND event_type IN (?, ?) ORDER BY seq`,
              [runId, EngineEvent.nodeEventTypes.nodeScheduled, EngineEvent.nodeEventTypes.nodeSettled]
            ).pipe(Effect.flatMap((rows) => decode(EventRow, rows)))
            const children = yield* Dialect.query(
              sql,
              `SELECT ${runColumns} FROM flows_runs r
            WHERE r.parent_run_id = ? OR r.run_id IN (SELECT child_id FROM flows_run_parents WHERE parent_id = ?)
            ORDER BY r.created_at_ms, r.run_id LIMIT ${maximumChildren}`,
              [runId, runId]
            ).pipe(Effect.flatMap((rows) => decode(RunRow, rows)))
            const page = yield* Dialect.query(
              sql,
              `SELECT seq, event_type, emitted_at_ms, payload_json FROM flows_journal_events
            WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ${limit + 1}`,
              [runId, afterSeq]
            ).pipe(Effect.flatMap((rows) => decode(EventRow, rows)))

            const attemptsOf = new Map<string, Array<typeof AttemptRow.Type>>()
            for (const attempt of attempts) {
              attemptsOf.set(attempt.step_key_digest, [...(attemptsOf.get(attempt.step_key_digest) ?? []), attempt])
            }
            const steps = foldSteps(nodes, schemas).map(({ digests, preview, ...step }): Step => {
              // An attempt's outcome is its step's success value, shown through that action's schema.
              const schema = step.action === null ? undefined : schemas.successOf(step.action)
              const owned = digests.flatMap((digest) => attemptsOf.get(digest) ?? []).map((attempt): Attempt => ({
                attempt: attempt.attempt,
                state: attempt.state,
                startedAtMs: attempt.started_at_ms,
                finishedAtMs: attempt.finished_at_ms,
                outcome: attempt.outcome_json === null
                  ? null
                  : valueOf(displayed(schema, parseOr(attempt.outcome_json))),
                error: attempt.error_json === null ? null : codeOf(parseOr(attempt.error_json))
              }))
              const last = owned.at(-1)
              return { ...step, output: last?.outcome ?? preview, attempts: owned }
            })
            const events = page.slice(0, limit).map((event): Event => ({
              seq: event.seq,
              eventType: event.event_type,
              emittedAtMs: event.emitted_at_ms,
              payload: eventPayloadOf(event.event_type, event.payload_json, schemas)
            }))
            return {
              run: detailOf(row, schemas),
              steps,
              children: children.map((child) => detailOf(child, schemas)),
              journal: {
                events,
                afterSeq,
                nextSeq: events.at(-1)?.seq ?? afterSeq,
                hasMore: page.length > limit
              }
            } satisfies Inspection
          })
        )
      ).pipe(rethrowNotFound)
    }

    const list: Service["list"] = (options = {}) => {
      const limit = pageSize(options.limit, maximumListPage, 50)
      const roots = options.roots ?? true
      return Read.boundary(
        "RunInspection.list",
        Effect.gen(function*() {
          const after = options.cursor === undefined ? undefined : yield* decodeCursor(options.cursor).pipe(
            Effect.mapError((cause) =>
              new RunStore.RunStoreError({
                method: "RunInspection.list",
                code: "invalid_run",
                message: "run list cursor is malformed",
                cause
              })
            )
          )
          const { flows, runIds } = options
          const tooMany = () =>
            new RunStore.RunStoreError({
              method: "RunInspection.list",
              code: "invalid_run",
              message: `at most ${maximumListPage} run ids and ${maximumListFlows} flows per list`,
              cause: null
            })
          if (runIds !== undefined && runIds.length > maximumListPage) return yield* tooMany()
          if (flows !== undefined && flows.length > maximumListFlows) return yield* tooMany()
          if (runIds?.length === 0 || flows?.length === 0) return { runs: [], cursor: null } satisfies RunList
          const placeholders = (values: ReadonlyArray<string>) => values.map(() => "?").join(", ")
          // The flow's tag lives in the run's state, read the same way on either store.
          const flowName = Dialect.isPostgres(sql)
            ? "(r.state_json::jsonb #>> '{flowName}')"
            : "json_extract(r.state_json, '$.flowName')"
          const conditions = [
            ...(roots ? [rootCondition] : []),
            ...(runIds === undefined ? [] : [`r.run_id IN (${placeholders(runIds)})`]),
            ...(flows === undefined ? [] : [`${flowName} IN (${placeholders(flows)})`]),
            ...(after === undefined ? [] : ["(r.created_at_ms < ? OR (r.created_at_ms = ? AND r.run_id < ?))"])
          ]
          const values = [
            ...(runIds ?? []),
            ...(flows ?? []),
            ...(after === undefined ? [] : [after.createdAtMs, after.createdAtMs, after.runId])
          ]
          const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`
          const rows = yield* Dialect.readTransaction(
            sql,
            Dialect.query(
              sql,
              `SELECT ${runColumns} FROM flows_runs r ${where}
            ORDER BY r.created_at_ms DESC, r.run_id DESC LIMIT ${limit + 1}`,
              values
            ).pipe(Effect.flatMap((rows) => decode(RunRow, rows)))
          )
          const runs = rows.slice(0, limit).map(summaryOf)
          const last = runs[runs.length - 1]!
          return {
            runs,
            cursor: rows.length > limit ? encodeCursor({ createdAtMs: last.createdAtMs, runId: last.runId }) : null
          } satisfies RunList
        })
      )
    }

    const payload: Service["payload"] = (runId) =>
      Read.boundary(
        "RunInspection.payload",
        Dialect.readTransaction(sql, runRow(runId)).pipe(
          Effect.map((row) => ({ flowName: row.state_json.flowName, payload: row.state_json.payload }))
        )
      ).pipe(rethrowNotFound)

    return { inspect, list, payload }
  })

/** Parsed JSON, or the text itself when it is not JSON. */
const parseOr = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * `Read.boundary` wraps every failure as `RunStoreError`; a missing run keeps
 * its own error, which travels as that error's cause.
 */
const rethrowNotFound = <A, R>(
  effect: Effect.Effect<A, RunStore.RunStoreError, R>
): Effect.Effect<A, RunNotFound | RunStore.RunStoreError, R> =>
  Effect.catch(effect, (error) => Effect.fail(error.cause instanceof RunNotFound ? error.cause : error))

/**
 * Provides the run reads over `SqlClient`.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<RunInspection, never, SqlClient.SqlClient> = Layer.effect(RunInspection)(make())

/**
 * Provides the run reads over `SqlClient`, rendering each run's values through
 * its flow in `flows` (see {@link Options}).
 *
 * @category layers
 * @since 1.0.0
 */
export const layerWith = (options: Options): Layer.Layer<RunInspection, never, SqlClient.SqlClient> =>
  Layer.effect(RunInspection)(make(options))
