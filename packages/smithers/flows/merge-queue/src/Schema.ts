/**
 * Schemas for the queue's durable values.
 *
 * The kernel's types (`Basic.ts`) are plain data; these schemas are what a
 * flow payload, a journal or an API uses to read and write them.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * One revision of one change.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Part = Schema.Struct({ id: Natural, rev: Natural })

/**
 * One check's outcome.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Verdict = Schema.Literals(["pass", "fail"])

/**
 * One streamed check result.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Result = Schema.Struct({ check: Natural, verdict: Verdict })

/**
 * Why a change is unmergeable.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Reason = Schema.Struct({
  kind: Schema.Literals(["attemptsExhausted", "agentVerdict"]),
  detail: Schema.String,
  failures: Schema.Array(Natural),
  attempts: Natural
})

/**
 * Where a change is.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Status = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("queued") }),
  Schema.Struct({ _tag: Schema.Literal("fixing"), run: Natural }),
  Schema.Struct({ _tag: Schema.Literal("merged") }),
  Schema.Struct({ _tag: Schema.Literal("unmergeable"), reason: Reason }),
  Schema.Struct({ _tag: Schema.Literal("withdrawn") })
])

/**
 * One change handed to the queue.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Change = Schema.Struct({
  id: Natural,
  priority: Natural,
  seq: Natural,
  rev: Natural,
  attempts: Natural,
  status: Status
})

/**
 * One CI run on one exact tree.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Run = Schema.Struct({
  id: Natural,
  base: Schema.Array(Part),
  batch: Schema.Array(Part),
  results: Schema.Array(Result)
})

/**
 * The audit record of one landing.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Landing = Schema.Struct({
  run: Natural,
  base: Schema.Array(Part),
  batch: Schema.Array(Part),
  results: Schema.Array(Result),
  foreign: Schema.Boolean
})

/**
 * One remembered check duration.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Sample = Schema.Struct({ check: Natural, duration: Natural })

/**
 * The queue's settings.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Config = Schema.Struct({
  required: Schema.Array(Natural),
  maxAttempts: Natural,
  maxBatch: Natural,
  maxRuns: Natural,
  window: Natural,
  defaultDuration: Natural
})

/**
 * Everything the queue remembers.
 *
 * @category schemas
 * @since 0.1.0
 */
export const State = Schema.Struct({
  main: Schema.Array(Part),
  changes: Schema.Array(Change),
  runs: Schema.Array(Run),
  nextRun: Natural,
  nextSeq: Natural,
  landed: Schema.Array(Landing),
  history: Schema.Array(Sample),
  pushing: Schema.NullOr(Natural)
})

/**
 * What happens to the queue.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Event = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("enqueue"), id: Natural, priority: Natural }),
  Schema.Struct({ _tag: Schema.Literal("withdraw"), id: Natural }),
  Schema.Struct({
    _tag: Schema.Literal("result"),
    run: Natural,
    check: Natural,
    verdict: Verdict,
    duration: Natural
  }),
  Schema.Struct({ _tag: Schema.Literal("fixed"), id: Natural, attempt: Natural }),
  Schema.Struct({ _tag: Schema.Literal("gaveUp"), id: Natural, attempt: Natural, detail: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("foreign"), id: Natural }),
  Schema.Struct({ _tag: Schema.Literal("start"), count: Natural }),
  Schema.Struct({ _tag: Schema.Literal("push"), run: Natural }),
  Schema.Struct({ _tag: Schema.Literal("probe"), id: Natural }),
  Schema.Struct({ _tag: Schema.Literal("land"), run: Natural }),
  Schema.Struct({ _tag: Schema.Literal("blame"), run: Natural }),
  Schema.Struct({ _tag: Schema.Literal("cancel"), run: Natural })
])
