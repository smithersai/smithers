/**
 * The tab's decoder of the leader's run reads: `@smthrs/engine-store`'s
 * `RunInspection.Inspection` and `RunList`, as they travel on the engine's
 * channel.
 *
 * The tab never loads `@smthrs/engine-store` (its SQL reads and the journal's
 * redactor have no business in a tab bundle), so the wire shape is declared
 * here again. The two type assertions at the bottom tie it to the engine's
 * declaration: a field added there without one here, or of another type,
 * fails this package's typecheck.
 *
 * @since 1.0.0
 */

import type { RunInspection } from "@smthrs/engine-store"
import * as Schema from "effect/Schema"

const Value = Schema.Struct({ text: Schema.String, bytes: Schema.Number, clipped: Schema.Boolean })

const Waiting = Schema.Struct({
  kind: Schema.Literals(["timer", "signal", "approval", "quota", "human", "other"]),
  reason: Schema.String,
  wakeAtMs: Schema.NullOr(Schema.Number)
})

const summary = {
  runId: Schema.String,
  flowName: Schema.String,
  status: Schema.Literals(["pending", "running", "suspended", "completed", "failed", "cancelled"]),
  createdAtMs: Schema.Number,
  startedAtMs: Schema.NullOr(Schema.Number),
  finishedAtMs: Schema.NullOr(Schema.Number),
  parentRunId: Schema.NullOr(Schema.String),
  cancelRequestedAtMs: Schema.NullOr(Schema.Number),
  waiting: Schema.NullOr(Waiting),
  lastSeq: Schema.Number,
  origin: Schema.NullOr(Schema.Struct({ door: Schema.String, actor: Schema.String }))
}

const RunSummary = Schema.Struct(summary)

const detailed = { ...summary, input: Value, result: Schema.NullOr(Value) }

const Attempt = Schema.Struct({
  attempt: Schema.Number,
  state: Schema.String,
  startedAtMs: Schema.Number,
  finishedAtMs: Schema.NullOr(Schema.Number),
  outcome: Schema.NullOr(Value),
  error: Schema.NullOr(Schema.String)
})

const Step = Schema.Struct({
  nodeId: Schema.String,
  action: Schema.NullOr(Schema.String),
  kind: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "waiting", "skipped"]),
  scheduledAtMs: Schema.Number,
  settledAtMs: Schema.NullOr(Schema.Number),
  seq: Schema.Number,
  output: Schema.NullOr(Value),
  attempts: Schema.Array(Attempt)
})

const Event = Schema.Struct({
  seq: Schema.Number,
  eventType: Schema.String,
  emittedAtMs: Schema.Number,
  payload: Value
})

/**
 * One run as `Inspect` reads it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Inspection = Schema.Struct({
  run: Schema.Struct(detailed),
  steps: Schema.Array(Step),
  children: Schema.Array(Schema.Struct(detailed)),
  journal: Schema.Struct({
    events: Schema.Array(Event),
    afterSeq: Schema.Number,
    nextSeq: Schema.Number,
    hasMore: Schema.Boolean
  })
})

/**
 * A page of runs as `List` reads it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RunList = Schema.Struct({ runs: Schema.Array(RunSummary), cursor: Schema.NullOr(Schema.String) })

/** The wire shapes are exactly the engine's: each assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const sameInspection: Same<typeof Inspection.Type, RunInspection.Inspection> = true
const sameList: Same<typeof RunList.Type, RunInspection.RunList> = true
void sameInspection
void sameList

/**
 * Decodes an `Inspect` reply's result.
 *
 * @category decoding
 * @since 1.0.0
 */
export const decodeInspection = Schema.decodeUnknownEffect(Inspection)

/**
 * Decodes a `List` reply's result.
 *
 * @category decoding
 * @since 1.0.0
 */
export const decodeRunList = Schema.decodeUnknownEffect(RunList)
