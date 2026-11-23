/**
 * The leader's preparation of the app's shared database: the work an app
 * runs once per build before any tab reads the database, such as bringing
 * its stores to the build's versions. The leader runs it as the durable flow
 * `device/prepare` over its own connection, after it wakes unfinished runs
 * and before it answers any tab's statement. A preparation that failed fences
 * the database for that leadership: the leader refuses every tab's statement
 * with {@link PrepareFailed}. The next leader, such as the next page load,
 * tries again, unless the failure was marked `permanent`: that one fences
 * every leader until a build with a new `epoch` prepares.
 *
 * @since 1.0.0
 */

import { Action, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as SharedSqlite from "../SharedSqlite.ts"
import { preparations } from "./Metrics.ts"
import { SqlConnection } from "./SqlConnection.ts"

/**
 * What the leader runs before it serves the app's shared database: `run`
 * over the database, once per `epoch`, whose result `success` records in the
 * journal. `@smthrs/effect-tanstack-db`'s `Migrations.prepare(registry)` is
 * one.
 *
 * @category models
 * @since 1.0.0
 */
export interface Prepare<A = any> {
  readonly epoch: number
  readonly success: Schema.Codec<A, any>
  readonly run: (database: SharedSqlite.Service) => Effect.Effect<A, unknown>
}

/**
 * The preparation failed: `error` is the tag of what it failed with, never
 * its message. The leader refuses every tab's statement with it, so nothing
 * reads or writes a database this build could not bring to its versions.
 *
 * A preparation that fails with a `PrepareFailed` of its own is recorded as
 * that one. With `permanent: true` the failure holds for the whole `epoch`:
 * no later leader tries again. Every other failure is transient, so the next
 * leader tries again.
 *
 * @category errors
 * @since 1.0.0
 */
export class PrepareFailed extends Schema.TaggedError<PrepareFailed>()("@smthrs/platform-browser/PrepareFailed", {
  error: Schema.String,
  permanent: Schema.optionalKey(Schema.Boolean)
}) {}

/** The owner the preparation's statements run as on the leader's connection. */
const OWNER = "@smthrs/platform-browser/prepare"

/** Three attempts, 200 ms apart, then 400 ms: a preparation that keeps failing fences the database quickly. */
const retryPolicy = RetryPolicy.make({ initialMs: 200, factor: 2, maxMs: 1000, maxAttempts: 3 })

/** One preparation's flow and its step. */
interface Declared {
  readonly flow: Flow.Flow<"device/prepare", Flow.AnyStructSchema, Schema.Top, typeof PrepareFailed, any>
  readonly registration: Layer.Layer<never, never, SqlConnection>
}

const declared = new WeakMap<Prepare, Declared>()

/** The tag of what `cause` failed with, never its message. */
const tagOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return RetryPolicy.errorTag(error) ?? "unknown"
}

/** What the step records for `cause`: the preparation's own `PrepareFailed` as it is, else one naming its tag. */
const failureOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof PrepareFailed ? error : new PrepareFailed({ error: tagOf(cause) })
}

/**
 * The execution id of `epoch`'s preparation attempt `attempt`. Attempt 0
 * keeps the id earlier builds wrote, so their receipts still answer.
 */
const executionId = (epoch: number, attempt: number) =>
  // Version 2 repairs workers whose split module graph mixed Schema sentinels.
  attempt === 0 ? `device/prepare/v2/${epoch}` : `device/prepare/v2/${epoch}/${attempt}`

/**
 * The app's database as a `SharedSqlite` service over the leader's own
 * connection, under `owner`: a transaction it opens is its own until a
 * statement ends it, and the tabs' statements wait meanwhile. The preparation
 * and the activation check (`Engine.layerHost`) each use it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const database = (connection: SqlConnection["Service"], owner: string): SharedSqlite.Service => ({
  // Nothing else runs on the connection until its user ends, so its transaction is never lost.
  execute: (sql, params = []) =>
    connection.run(owner, sql, params, false).pipe(
      Effect.map((result) => result.rows),
      Effect.catchTag("@smthrs/platform-browser/TransactionLost", Effect.die)
    )
})

/**
 * The flow `device/prepare` for `prepare`, and its registration: one step,
 * `device/prepare/run`, which runs `prepare.run` over the leader's connection
 * and rolls back any transaction it left open. The same `prepare` always
 * gives the same declaration, so the engine and the leader share it.
 *
 * @category declarations
 * @since 1.0.0
 */
export const declare = (prepare: Prepare): Declared => {
  const known = declared.get(prepare)
  if (known !== undefined) return known
  const payload = { epoch: Schema.Number }
  const Run = Action.make("device/prepare/run", {
    payload,
    success: prepare.success,
    error: PrepareFailed,
    retryPolicy
  })
  const flow = Flow.make("device/prepare", {
    description: "Prepare this device's app database for the running build before any tab reads it.",
    payload,
    success: prepare.success,
    error: PrepareFailed,
    // Captured, so the plan's identity holds across builds and leaders.
    body: Node.capture({ action: Run.name }, (input) => Run.call(input))
  })
  const run = () =>
    Effect.gen(function*() {
      const connection = yield* SqlConnection
      return yield* prepare.run(database(connection, OWNER)).pipe(
        Effect.ensuring(connection.abandon(OWNER)),
        Effect.catchCause((cause) => Effect.fail(failureOf(cause)))
      )
    })
  const registration = Interpreter.layerWithImplementations(flow, Run.toLayer(run)) as unknown as Layer.Layer<
    never,
    never,
    SqlConnection
  >
  const result: Declared = { flow: flow as unknown as Declared["flow"], registration }
  declared.set(prepare, result)
  return result
}

/**
 * Runs `prepare` on the engine in `context`, and waits for it. Each leader
 * walks the epoch's attempts, `device/prepare/v2/<epoch>` then
 * `device/prepare/v2/<epoch>/<n>`: a finished attempt answers from the
 * journal, a transiently failed one is passed over, and the first attempt
 * not yet settled runs, or resumes when a crashed leader left it unfinished.
 * So a preparation that failed is tried again by the next leader, such as
 * the next page load, while a failure marked `permanent` answers for the
 * epoch. It never fails: how it went is logged as `browser.runtime.prepare`
 * and counted in `preparations` by `outcome` (`prepared`, `failed`, or
 * `skipped` when the engine serves no app database). It succeeds with the
 * {@link PrepareFailed} the leader fences the database with when the
 * preparation failed, and with `undefined` when the tabs may use the
 * database.
 *
 * @category running
 * @since 1.0.0
 */
export const run = (prepare: Prepare, context: Context.Context<FlowRuntime.FlowRuntime>) =>
  Effect.gen(function*() {
    if (Option.isNone(Context.getOption(context as Context.Context<unknown>, SqlConnection))) return "skipped" as const
    const runtime = Context.get(context, FlowRuntime.FlowRuntime)
    const { flow } = declare(prepare)
    for (let attempt = 0;; attempt++) {
      const id = executionId(prepare.epoch, attempt)
      const recorded = yield* runtime.poll(flow, id).pipe(
        Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeedNone)
      ) as Effect.Effect<Option.Option<Flow.Result<unknown, unknown>>>
      if (Option.isSome(recorded) && recorded.value._tag === "Complete") {
        const exit = recorded.value.exit
        if (Exit.isSuccess(exit)) return "prepared" as const
        const failure = Cause.squash(exit.cause)
        // A transient failure an earlier leader recorded: this leader tries again.
        if (!(failure instanceof PrepareFailed && failure.permanent === true)) continue
        return yield* Effect.failCause(exit.cause)
      }
      yield* runtime.execute(flow, { executionId: id, payload: { epoch: prepare.epoch } }) as Effect.Effect<
        unknown,
        unknown
      >
      return "prepared" as const
    }
  }).pipe(
    Effect.exit,
    Effect.flatMap((exit) => {
      const outcome = Exit.isSuccess(exit) ? exit.value : "failed"
      const failure = Exit.isFailure(exit) ? { "error.type": tagOf(exit.cause) } : {}
      return Metric.update(Metric.withAttributes(preparations, { outcome }), 1).pipe(
        Effect.andThen(
          (outcome === "failed" ? Effect.logWarning : Effect.logInfo)("browser.runtime.prepare").pipe(
            Effect.annotateLogs({ outcome, epoch: prepare.epoch, ...failure })
          )
        ),
        Effect.as(Exit.isFailure(exit) ? new PrepareFailed({ error: tagOf(exit.cause) }) : undefined)
      )
    }),
    Effect.withSpan("browser.runtime.prepare", { attributes: { epoch: prepare.epoch } })
  )
