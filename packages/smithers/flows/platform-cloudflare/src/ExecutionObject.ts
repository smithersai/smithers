/**
 * The per-execution Durable Object, as functions a Durable Object delegates to.
 *
 * One Durable Object runs one flow execution and is named by its execution
 * id. It stores what to run (the {@link Intent}) and owns one thing the
 * engine cannot: an alarm that wakes it. {@link start} records the intent and
 * arms the alarm; {@link alarm} builds the durable runtime, drives the
 * execution until it settles, parks or spends its {@link driveBudget}, hands
 * every execution the drive left for another object to that object through the caller's {@link Router}, and
 * arms the next wake; {@link wake} moves the alarm to now. Leases, attempts,
 * timers, retries and results stay in the engine's Postgres store; the
 * object's storage holds the intent, a failure count and, once the execution
 * settles, when it did. A settled object keeps its intent for
 * {@link settledRetentionMs}, then forgets it. A cancellation tombstone is retained permanently.
 *
 * The functions take the object's storage as a structural slice, so the
 * same code runs under any Effect-native Durable Object (an Alchemy
 * `DurableObjectState`'s `storage` satisfies it as is) and under the
 * in-memory stand-in a test supplies.
 *
 * @since 1.0.0
 */

import { canonicalize } from "@smthrs/canonical"
import { DatabaseMetrics } from "@smthrs/database"
import { type DurableEngineState, EngineStore, WakeBus } from "@smthrs/engine-store"
import { type Flow, FlowRuntime, RetryPolicy, RunMetrics } from "@smthrs/flow"
import { JournalMetrics } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as FailureDetail from "./internal/FailureDetail.ts"
import * as Routing from "./internal/Routing.ts"

/**
 * What a Durable Object runs: the flow, by tag; the execution, by id; and
 * the payload, encoded with the flow's own JSON codec.
 *
 * Build one with {@link intent}, which encodes the payload the way
 * {@link alarm} decodes it.
 *
 * @category models
 * @since 1.0.0
 */
export const Intent = Schema.Struct({
  flow: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  requestedAtMs: Schema.optionalKey(Schema.Number),
  payload: Schema.Json,
  /**
   * The door and actor kind the caller started the execution with, which the
   * engine keeps for the run's usage metrics (`@smthrs/flow` `RunMetrics`).
   * Not part of the intent's identity: a second start with another origin is
   * the same intent.
   */
  origin: Schema.optionalKey(Schema.Struct({ door: Schema.String, actor: Schema.String }))
})

/**
 * The value form of {@link Intent}.
 *
 * @category models
 * @since 1.0.0
 */
export type Intent = typeof Intent.Type

/**
 * The slice of Durable Object storage these functions use.
 *
 * `R` is whatever the object's storage methods require. An Alchemy
 * `DurableObjectState`'s `storage` satisfies it with `R = RuntimeContext`; a
 * test's in-memory stand-in satisfies it with `R = never`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Storage<R = never> {
  readonly get: <A = unknown>(key: string) => Effect.Effect<A | undefined, never, R>
  readonly put: <A>(key: string, value: A) => Effect.Effect<void, never, R>
  readonly delete: (key: string) => Effect.Effect<boolean, never, R>
  readonly setAlarm: (scheduledTime: number) => Effect.Effect<void, never, R>
  readonly deleteAlarm: () => Effect.Effect<void, never, R>
}

/**
 * {@link start} was asked to run an execution this object already holds a
 * different intent for. The stored intent is unchanged and the caller's
 * effect did not run.
 *
 * @category errors
 * @since 1.0.0
 */
export class IntentConflict extends Schema.TaggedError<IntentConflict>()(
  "@smthrs/platform-cloudflare/IntentConflict",
  {
    executionId: Schema.String,
    message: Schema.String
  }
) {}

/**
 * What one {@link alarm} did.
 *
 * - `Idle`: no intent is stored, so there was nothing to run; the alarm is
 *   deleted.
 * - `Settled`: the execution completed, failed or was cancelled. The object
 *   keeps the intent until `forgetAtMs`, the settlement plus the retention
 *   window, and the alarm is armed for it.
 * - `Parked`: the execution waits. `wakeAtMs` is when the engine must next
 *   drive it (`EngineStore.nextWake`), usually its earliest pending
 *   `DurableClock`, and the alarm is armed for it; `null` means it waits on
 *   an event, and the alarm is deleted until whoever delivers the event arms
 *   it.
 * - `Yielded`: the drive spent its budget ({@link driveBudget}) and released
 *   the execution at a step boundary with work still due. The alarm is armed
 *   for now, so the next alarm goes on at once in a fresh invocation.
 * - `Retrying`: building the runtime or driving the execution failed; the
 *   alarm is armed at `retryAtMs`. `attempt` counts consecutive alarms that
 *   made no progress, those that died included, and `failure` is the tag of
 *   what failed, never its message. `detail` names a failed schema
 *   migration's cause (the migration, its failed statement, the SQL error's
 *   kind, SQLSTATE code and the database's message) and, for any other
 *   failure that reached the database, only the SQL error's kind and code,
 *   and for a lost or refused connection the driver's text for it.
 * - `Forgotten`: the execution settled and its retention window has passed;
 *   the object deleted its intent, its count and its settlement, and the
 *   alarm is deleted. Any cancellation tombstone remains to reject delayed admission.
 *
 * @category models
 * @since 1.0.0
 */
export type Outcome =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Settled"; readonly forgetAtMs: number }
  | { readonly _tag: "Parked"; readonly wakeAtMs: number | null }
  | { readonly _tag: "Yielded" }
  | {
    readonly _tag: "Retrying"
    readonly attempt: number
    readonly retryAtMs: number
    readonly failure: string
    /** What the alarm's log adds to `failure`: a failed migration's cause, never a flow's content. */
    readonly detail: Readonly<Record<string, string>>
  }
  | { readonly _tag: "Forgotten" }

/**
 * The services {@link alarm} reads from the runtime it builds:
 * `@smthrs/engine-store`'s `EngineStore.Driver`, which drives the execution
 * once, and the `RunStore` and `DurableEngineState` it reads the next wake
 * and the other objects' work from. A `CloudflareRuntime.layer` provides all
 * three.
 *
 * @category models
 * @since 1.0.0
 */
export type Services =
  | EngineStore.Driver
  | RunStore.RunStore
  | DurableEngineState.DurableEngineState
  | FlowRuntime.FlowRuntime

/**
 * How one Durable Object reaches another, both named by execution id. The
 * Durable Object class supplies it over its namespace binding.
 *
 * - `start` calls {@link start} on the object named by `intent.executionId`,
 *   with nothing for the caller's effect: the store already holds the
 *   execution, so the intent only tells that object what to run.
 * - `wake` calls {@link wake} on the object named by `executionId`.
 *
 * Both must be idempotent, as `start` and `wake` are: an alarm that dies
 * after routing routes again. A failure re-arms the routing object's alarm
 * with backoff, and the failure's tag is what it logs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Router<E = never, R = never> {
  readonly start: (intent: Intent) => Effect.Effect<void, E, R>
  readonly wake: (executionId: string) => Effect.Effect<void, E, R>
}

/**
 * The storage key the intent lives under.
 *
 * @category constants
 * @since 1.0.0
 */
export const intentKey = "smithers/intent"

/**
 * The storage key the count of consecutive alarms without progress lives
 * under.
 *
 * @category constants
 * @since 1.0.0
 */
export const failuresKey = "smithers/failures"

/**
 * The storage key the time the execution settled, in epoch milliseconds,
 * lives under. An object that holds it never drives its execution again.
 *
 * @category constants
 * @since 1.0.0
 */
export const settledKey = "smithers/settled"

/**
 * How long a settled object keeps its intent, in milliseconds, unless
 * {@link alarm} is given another window: one day.
 *
 * Within the window a duplicate {@link start} or a {@link wake} is answered
 * from the object alone, with no drive, and another payload under the same
 * execution id fails with {@link IntentConflict}. After it the object forgets
 * the execution: a late {@link wake} answers `false`, and a late `start`
 * stores the intent again, whose next alarm finds the run settled in the
 * engine's store, runs no step and forgets it again a window later. The run's
 * history and result stay in the engine's store under the engine's own
 * retention.
 *
 * @category constants
 * @since 1.0.0
 */
export const settledRetentionMs = 86_400_000

/**
 * How long after {@link start} records an intent the alarm fires on its own,
 * in milliseconds, if `start` never reaches the line that moves it to now.
 *
 * @category constants
 * @since 1.0.0
 */
export const startGraceMs = 5_000

/**
 * How long one alarm's drive keeps starting steps, in milliseconds, unless
 * {@link alarm} is given another budget: ten minutes.
 *
 * Cloudflare ends an alarm invocation after fifteen minutes of wall time, and
 * a run with enough work never parks by itself. Past the budget the drive
 * starts no new step, lets the running ones finish and record their results,
 * and yields (`EngineStore.drive`'s `budgetMs`); the next alarm goes on at
 * once. The five minutes left are for the step running when the budget runs
 * out, building the runtime and routing.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultDriveBudgetMs = 600_000

/**
 * `EXECUTION_DRIVE_BUDGET_SECONDS`: the drive budget {@link alarm} takes as
 * `driveBudgetMs`, in milliseconds. Whole seconds from 1 to 899, under
 * Cloudflare's 900-second alarm limit; {@link defaultDriveBudgetMs} when
 * unset. Any other value fails with a `ConfigError`.
 *
 * The Durable Object class reads it once, where it reads its other settings,
 * and passes it to every alarm.
 *
 * @category constants
 * @since 1.0.0
 */
export const driveBudget: Config.Config<number> = Config.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 899 })),
  "EXECUTION_DRIVE_BUDGET_SECONDS"
).pipe(
  Config.withDefault(defaultDriveBudgetMs / 1000),
  Config.map((seconds) => seconds * 1000)
)

/**
 * The backoff between consecutive alarms that make no progress, whether they
 * failed or died: one second, doubling, at most five seconds, and never
 * giving up.
 *
 * @category constants
 * @since 1.0.0
 */
export const retryPolicy: RetryPolicy.RetryPolicy = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 5_000 })

/**
 * {@link start} calls, by `outcome`: `accepted`, `duplicate`, `conflict` or
 * `failed` (the caller's effect failed after the intent was stored).
 *
 * @category metrics
 * @since 1.0.0
 */
export const starts = Metric.counter("smithers_cloudflare_execution_starts", {
  description: "Durable Object execution starts, by outcome",
  incremental: true
})

/**
 * {@link alarm} invocations, by `outcome`: `idle`, `settled`, `parked`,
 * `yielded`, `retrying` or `forgotten`.
 *
 * @category metrics
 * @since 1.0.0
 */
export const alarms = Metric.counter("smithers_cloudflare_execution_alarms", {
  description: "Durable Object execution alarms, by outcome",
  incremental: true
})

/**
 * How long {@link alarm}'s drive (`EngineStore.drive`) ran, in milliseconds,
 * by `outcome`: `settled`, `parked`, `yielded`, `unfinished` (work due that the
 * drive did not do) or `failed`. The buckets run to Cloudflare's 900-second
 * alarm limit, so a drive nearing it shows in the top ones. An alarm that
 * drives nothing (no intent, a settled execution, an unknown flow, a runtime
 * that cannot be built) records nothing.
 *
 * @category metrics
 * @since 1.0.0
 */
export const driveDuration = Metric.timer("smithers_cloudflare_execution_drive_duration", {
  description: "How long a Durable Object alarm drove its execution, by outcome",
  boundaries: [1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 450_000, 600_000, 720_000, 840_000, 900_000]
})

/**
 * Executions {@link alarm} handed to another object, by `route`: `start` or
 * `wake` after the drive, or `admitted` for a child started the moment its
 * admission committed, during the drive. Counted when the {@link Router} call
 * succeeds.
 *
 * @category metrics
 * @since 1.0.0
 */
export const routed = Metric.counter("smithers_cloudflare_execution_routed", {
  description: "Executions a Durable Object alarm handed to another object, by route",
  incremental: true
})

/**
 * {@link wake} calls, by `outcome`: `armed`, or `idle` when no intent is
 * stored.
 *
 * @category metrics
 * @since 1.0.0
 */
export const wakes = Metric.counter("smithers_cloudflare_execution_wakes", {
  description: "Durable Object execution wakes, by outcome",
  incremental: true
})

const encodeIntent = Schema.encodeSync(Intent)
const decodeIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(Intent))

/** The stored form of an intent: its canonical JSON, so equal intents are equal strings. */
const stored = (value: Intent): string => canonicalize(encodeIntent(value))

/** What a second start must match: the flow, the execution and the payload, never the origin. */
const identity = (value: Pick<Intent, "flow" | "executionId" | "payload">): string =>
  canonicalize({ flow: value.flow, executionId: value.executionId, payload: value.payload })

/** The identity of a stored intent; a stored value that is not one is its own identity. */
const storedIdentity = (raw: string): string => {
  try {
    return identity(JSON.parse(raw) as Intent)
  } catch {
    return raw
  }
}

/**
 * The ids an alarm's span and log line carry: the execution and its flow,
 * never the payload. None when nothing is stored or the stored value is not an
 * intent.
 */
const idsOf = (raw: string | undefined): Effect.Effect<Readonly<Record<string, string>>> =>
  raw === undefined ? Effect.succeed({}) : decodeIntent(raw).pipe(
    Effect.map((value) => ({ "smithers.execution.id": value.executionId, "smithers.flow": value.flow })),
    Effect.orElseSucceed(() => ({}))
  )

/**
 * Builds an intent, encoding the payload with the flow's own JSON codec.
 *
 * @category constructors
 * @since 1.0.0
 */
export const intent = <F extends Flow.Any>(
  flow: F,
  options: { readonly executionId: string; readonly payload: Flow.PayloadSchema<F>["Type"] }
): Effect.Effect<Intent, Schema.SchemaError, Flow.PayloadSchema<F>["EncodingServices"]> =>
  Schema.encodeEffect(Schema.toCodecJson(flow.payloadSchema))(options.payload).pipe(
    Effect.flatMap((payload) =>
      Effect.gen(function*() {
        // The caller's door and actor kind, kept for the run's usage metrics.
        const origin = yield* RunMetrics.CurrentOrigin
        return yield* Schema.decodeUnknownEffect(Intent)({
          flow: flow._tag,
          executionId: options.executionId,
          payload,
          requestedAtMs: yield* Clock.currentTimeMillis,
          origin: { door: origin.door, actor: origin.actor }
        })
      })
    )
  )

/**
 * Records an intent, then runs the caller's effect, so the execution runs
 * even when the caller dies partway.
 *
 * 1. Stores the intent and arms the alarm at now plus {@link startGraceMs}.
 *    The Durable Object's output gate commits both before the caller hears
 *    an answer.
 * 2. Runs `effect`, the caller's own idempotent write (for example, the row
 *    that shows the execution is under way).
 * 3. Moves the alarm to now.
 *
 * If the isolate dies in step 2, the alarm armed in step 1 still fires and
 * runs the flow; the flow's first step must therefore do the same write
 * idempotently. If `effect` fails, its failure is returned unchanged and the
 * alarm stays armed.
 *
 * Starting the same intent again is safe: nothing new is stored, `effect`
 * runs again, and the alarm is moved to now, so a settled execution answers
 * with its settlement once more. A different intent fails with
 * {@link IntentConflict} before anything is stored or run. Both hold while
 * the object holds the intent: until a settled execution's retention window
 * passes ({@link settledRetentionMs}).
 *
 * @category operations
 * @since 1.0.0
 */
export const start = <A, E, R, RS>(
  storage: Storage<RS>,
  value: Intent,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | IntentConflict, R | RS> =>
  Effect.gen(function*() {
    const ids = { "smithers.execution.id": value.executionId, "smithers.flow": value.flow }
    const requestedAtMs = value.requestedAtMs ?? (yield* Clock.currentTimeMillis)
    yield* Effect.logInfo("cloudflare.execution.request").pipe(Effect.annotateLogs({ ...ids, requestedAtMs }))
    const next = stored(value)
    const previous = yield* storage.get<string>(intentKey)
    if (previous !== undefined && storedIdentity(previous) !== identity(value)) {
      yield* Effect.annotateCurrentSpan({ "smithers.execution.start": "conflict" })
      yield* Metric.update(Metric.withAttributes(starts, { outcome: "conflict" }), 1)
      yield* Effect.logWarning("cloudflare.execution.start").pipe(Effect.annotateLogs({ ...ids, outcome: "conflict" }))
      return yield* new IntentConflict({
        executionId: value.executionId,
        message: `Execution ${value.executionId} already holds a different intent`
      })
    }
    if (previous === undefined) yield* storage.put(intentKey, next)
    yield* storage.setAlarm((yield* Clock.currentTimeMillis) + (previous === undefined ? startGraceMs : 0))
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) yield* storage.setAlarm(yield* Clock.currentTimeMillis)
    const outcome = Exit.isFailure(exit) ? "failed" : previous === undefined ? "accepted" : "duplicate"
    yield* Effect.annotateCurrentSpan({ "smithers.execution.start": outcome })
    yield* Metric.update(Metric.withAttributes(starts, { outcome }), 1)
    yield* (Exit.isFailure(exit)
      ? Effect.logWarning("cloudflare.execution.start").pipe(
        Effect.annotateLogs({ ...ids, outcome, "error.type": RetryPolicy.failureType(exit.cause) })
      )
      : Effect.logInfo("cloudflare.execution.start").pipe(Effect.annotateLogs({ ...ids, outcome })))
    return exit
  }).pipe(
    Effect.withSpan("cloudflare.execution.start", {
      attributes: { "smithers.execution.id": value.executionId, "smithers.flow": value.flow }
    }),
    // The caller's exit is the span's value, never its failure: the span ends
    // with the outcome alone, because the caller's failure may quote the
    // payload.
    Effect.flatMap((exit) => exit)
  )

/**
 * Moves the alarm to now, so the object drives its execution again as soon
 * as no other handler runs: what another object's {@link alarm} calls,
 * through its {@link Router}, when its drive made this execution due (a child
 * it waits on settled, or a cancellation reached it).
 *
 * Answers `true` when the alarm was armed and `false` when no intent is
 * stored, which leaves the object idle: an object that never held this
 * execution has nothing to drive. Waking an object whose execution has
 * nothing due costs one alarm that parks it again.
 *
 * @category operations
 * @since 1.0.0
 */
export const wake = <RS>(storage: Storage<RS>): Effect.Effect<boolean, never, RS> =>
  Effect.gen(function*() {
    const stored = (yield* storage.get<string>(intentKey)) !== undefined
    if (stored) yield* storage.setAlarm(yield* Clock.currentTimeMillis)
    const outcome = stored ? "armed" : "idle"
    yield* Effect.annotateCurrentSpan({ "smithers.execution.wake": outcome })
    yield* Metric.update(Metric.withAttributes(wakes, { outcome }), 1)
    yield* Effect.logInfo("cloudflare.execution.wake").pipe(Effect.annotateLogs({ outcome }))
    return stored
  }).pipe(Effect.withSpan("cloudflare.execution.wake"))

/**
 * A flow this object was not given. The stored intent names it, so the alarm
 * retries with backoff until a deploy that registers it again.
 */
class UnknownFlow extends Schema.TaggedError<UnknownFlow>()("@smthrs/platform-cloudflare/UnknownFlow", {
  flow: Schema.String
}) {}

/**
 * The drive stopped with work still due now: the runtime would not claim the
 * execution (it is configured for another one), or the store became
 * unavailable during the drive. Counted as a failed attempt, so an alarm that
 * cannot make progress backs off instead of firing again at once, forever.
 */
class Undriven extends Schema.TaggedError<Undriven>()("@smthrs/platform-cloudflare/Undriven", {}) {}

/** The short admission/cancellation critical section of one object incarnation. */
class AdmissionControl extends Context.Service<AdmissionControl, {
  readonly gate: Semaphore.Semaphore
  readonly activate: (cancel: Effect.Effect<void, FlowRuntime.CancelRequestFailed>) => void
  readonly allowed: (value: Intent) => Effect.Effect<boolean>
}>()("@smthrs/platform-cloudflare/AdmissionControl") {}

/**
 * Permanent cancellation tombstone. It survives intent retention so a delayed
 * replay of a cancelled start can never resurrect the execution.
 * @category constants
 * @since 1.0.0
 */
export const cancelledKey = "smithers/cancelled"

/**
 * Drives the execution once (`EngineStore.drive`) within `budgetMs` and
 * answers what that left it as.
 *
 * Only an execution the store does not hold yet is admitted with the intent's
 * payload, so only then is the payload decoded. A held run resumes from the
 * payload the store recorded, and the engine settles one the deployed flow's
 * schema no longer decodes as `payload_changed`: decoding the intent first
 * would fail every alarm of that run, forever.
 */
const drive = <RS>(storage: Storage<RS>, flow: Flow.Any, value: Intent, budgetMs: number) =>
  Effect.gen(function*() {
    const control = yield* Effect.serviceOption(AdmissionControl)
    const prepare = Effect.gen(function*() {
      const held = yield* (yield* RunStore.RunStore).get(value.executionId).pipe(
        Effect.as(true),
        Effect.catchIf((error) => error.code === "not_found_row", () => Effect.succeed(false))
      )
      let cancelled = (yield* storage.get<number>(cancelledKey)) !== undefined
      if (!held && !cancelled && Option.isSome(control) && !(yield* control.value.allowed(value))) {
        yield* storage.put(cancelledKey, yield* Clock.currentTimeMillis)
        yield* Metric.update(cancellations, 1)
        yield* Effect.logInfo("cloudflare.execution.cancel").pipe(Effect.annotateLogs({
          "smithers.execution.id": value.executionId,
          "smithers.flow": value.flow,
          outcome: "admission_refused"
        }))
        cancelled = true
      }
      if (cancelled && !held) return false
      if (!held) {
        const payload = yield* (Schema.decodeUnknownEffect(Schema.toCodecJson(flow.payloadSchema))(
          value.payload
        ) as Effect.Effect<object, Schema.SchemaError>)
        const admission = (yield* EngineStore.Driver).admit(flow, { executionId: value.executionId, payload })
        yield* value.origin === undefined ? admission : RunMetrics.withOrigin(admission, value.origin)
      }
      const context = yield* Effect.context<Services>()
      const cancel = (yield* FlowRuntime.FlowRuntime).interrupt(flow, value.executionId).pipe(Effect.provide(context))
      if (Option.isSome(control)) control.value.activate(cancel)
      if (cancelled) yield* cancel
      return true
    })
    // Persist admission before exposing cancellation to an active runtime. No
    // action runs in this critical section, and cancellation can never miss a
    // run between the tombstone check and row creation.
    const admitted = yield* Option.isSome(control) ? control.value.gate.withPermit(prepare) : prepare
    if (!admitted) return { _tag: "Settled" } as const
    return yield* EngineStore.drive(flow, { executionId: value.executionId, payload: {}, budgetMs })
  })

/** Where one alarm's time went, in milliseconds: building its runtime, driving, and routing what the drive left. */
interface Timing {
  buildMs?: number
  driveMs?: number
  routeMs?: number
}

/**
 * Drives the execution within `budgetMs`, records how long the drive took by
 * its outcome ({@link driveDuration}) and in `timing`, and reads what it left
 * the execution as: `Unfinished` is a failure, so the alarm backs off.
 */
const timedDrive = <RS>(
  storage: Storage<RS>,
  flow: Flow.Any,
  value: Intent,
  budgetMs: number,
  timing: Timing
) =>
  Effect.gen(function*() {
    const startedMs = yield* Clock.currentTimeMillis
    const exit = yield* Effect.exit(drive(storage, flow, value, budgetMs))
    const driveMs = (yield* Clock.currentTimeMillis) - startedMs
    timing.driveMs = driveMs
    const outcome = Exit.isSuccess(exit) ? exit.value._tag.toLowerCase() : "failed"
    yield* Metric.update(Metric.withAttributes(driveDuration, { outcome }), Duration.millis(driveMs))
    const driven = yield* exit
    if (driven._tag === "Unfinished") return yield* new Undriven()
    return driven
  })

/**
 * Hands every execution the drive left for another object to that object:
 * starts the ones no object holds yet and wakes the ones that are due.
 */
const route = <E, R>(executionId: string, router: Router<E, R>) =>
  Effect.gen(function*() {
    const routes = yield* Routing.routes(executionId)
    for (const next of routes.start) {
      yield* router.start(yield* Schema.decodeUnknownEffect(Intent)(next))
      yield* Metric.update(Metric.withAttributes(routed, { route: "start" }), 1)
    }
    for (const id of routes.wake) {
      yield* router.wake(id)
      yield* Metric.update(Metric.withAttributes(routed, { route: "wake" }), 1)
    }
    yield* Effect.annotateCurrentSpan({
      "smithers.execution.started": routes.start.length,
      "smithers.execution.woken": routes.wake.length
    })
  })

/**
 * How long {@link admitted} waits for the child's object to take its intent
 * before it leaves the start to the routing after the drive: two seconds.
 *
 * @category constants
 * @since 1.0.0
 */
export const admittedStartTimeoutMs = 2_000

/**
 * Starts a child on its own object as soon as its admission commits, while the
 * parent's drive goes on (`WakeBus.Admitted`), so the child's own alarm runs
 * beside the rest of the parent's drive instead of after it parks. A TODO's
 * agent session waited about two seconds for that drive on smithers.sh.
 *
 * It is a shortcut and never the record: {@link route} reads the store after
 * every drive and starts the same child again, which its object answers as a
 * duplicate. So a start that fails or outlasts {@link admittedStartTimeoutMs}
 * is logged and left to the routing; it never fails the drive.
 */
const admitted = <RE, RR>(router: Router<RE, RR>, context: Context.Context<RR>) => (admission: WakeBus.Admission) =>
  Schema.decodeUnknownEffect(Intent)(admission).pipe(
    Effect.flatMap(router.start),
    Effect.timeout(admittedStartTimeoutMs),
    Effect.andThen(Metric.update(Metric.withAttributes(routed, { route: "admitted" }), 1)),
    Effect.catchCause((cause) =>
      Effect.logWarning("cloudflare.execution.admitted").pipe(Effect.annotateLogs({
        "smithers.execution.id": admission.executionId,
        "smithers.flow": admission.flow,
        outcome: "deferred",
        "error.type": RetryPolicy.failureType(cause)
      }))
    ),
    Effect.provideContext(context)
  )

/**
 * Arms the alarm for a parked execution, then reads the store once more.
 *
 * Another object's {@link wake} can land while this alarm runs: Durable
 * Objects interleave events while a handler waits on I/O. A wake that landed
 * before this line is overwritten by it, so the store is read again after it:
 * a waker records its work in the store before it wakes, so any wake this
 * overwrote shows here as due work, and the alarm moves up to it. A wake that
 * lands later arms the alarm itself. Without the second read a child that
 * settles while its parent's alarm is still routing it leaves the parent
 * parked for good.
 */
const arm = <RS>(storage: Storage<RS>, executionId: string, wakeAtMs: number | null) =>
  Effect.gen(function*() {
    yield* wakeAtMs === null ? storage.deleteAlarm() : storage.setAlarm(wakeAtMs)
    const due = Option.getOrNull(yield* EngineStore.nextWake(executionId))
    if (due === null || (wakeAtMs !== null && due >= wakeAtMs)) return wakeAtMs
    yield* storage.setAlarm(due)
    return due
  })

/** How long after attempt `attempt` started the next one may: {@link retryPolicy}'s delay. */
const backoff = (attempt: number): number => Option.getOrThrow(RetryPolicy.nextDelay(retryPolicy, attempt))

/**
 * Drives the stored execution, hands what the drive left for other objects to
 * them, then arms the next wake.
 *
 * 1. Counts this alarm as an attempt and arms the alarm for the next one,
 *    {@link retryPolicy}'s delay away. This is the watchdog: an alarm that
 *    dies mid-drive (an isolate reset, an eviction, a crash in a step) leaves
 *    both behind, so the next incarnation drives the execution after the
 *    backoff, and a step that kills its isolate every time backs off further
 *    each time. Cloudflare runs one alarm handler at a time per object, so the
 *    watchdog never fires beside a handler that is still running.
 * 2. Builds `runtime(intent)` in this alarm's scope, so its connections
 *    close when the alarm ends.
 * 3. Drives the execution once with `EngineStore.drive`, which claims the
 *    run (or takes it from an earlier, dead incarnation of this object),
 *    replays what is recorded and drives the rest until it settles or parks,
 *    or until it spends `driveBudgetMs` ({@link driveBudget}) and yields at a
 *    step boundary. How long the drive took is recorded by its outcome
 *    ({@link driveDuration}) and logged as `smithers.execution.drive_ms`.
 *    A child the drive admits is started on its own object as soon as its
 *    admission commits, so it runs beside the rest of the drive; step 4
 *    starts it again, which changes nothing.
 * 4. Routes: reads from the store which executions the drive left for other
 *    objects, and hands each to `router`. A child the drive admitted and the
 *    round a `.to()` handoff admitted are started on their own objects; a
 *    parent waiting on this execution's settlement, and a child or next
 *    round asked to cancel, are woken. Reading the store rather than the
 *    drive's report is what makes this durable: an alarm that died after the
 *    drive and before routing routes the same executions on its next attempt,
 *    and starting or waking an object twice changes nothing.
 * 5. On progress, records when the execution settled and arms the alarm for
 *    the end of its retention window if it settled, arms it for when the
 *    engine must next drive it if it parked, reading the store again after
 *    arming so a wake that landed meanwhile is kept, or arms it for now if
 *    the drive yielded; then clears the count.
 *
 * An object that recorded its execution's settlement never drives it again.
 * Its alarm, whether the final one or one a duplicate `start` or a `wake`
 * moved up, builds no runtime: before `retain` has passed since the
 * settlement it arms the alarm for that moment and answers `Settled`; after,
 * it deletes the intent, the count and the settlement, deletes the alarm and
 * answers `Forgotten`. One final alarm per object, and no sweep.
 *
 * Any failure, a router call's included, re-arms the alarm with the backoff
 * and returns `Retrying`, so the alarm never fails and Cloudflare's own retry
 * limit never drops an execution. The failure is logged by its tag, and a
 * failed schema migration by its cause as well (`Outcome`'s `detail`).
 *
 * Every alarm logs `cloudflare.execution.alarm` with its outcome and what it
 * cost: `durationMs`, the journal entries it committed (`events`), its write
 * transactions (`transactions`), how many of those held the whole schema's
 * writer lock (`schemaWide`), and their summed wait for their locks
 * (`lockWaitMs`), the same on the alarm's span; and where its time went:
 * building the runtime (`smithers.execution.build_ms`, also on the
 * `cloudflare.execution.ready` line), the drive (`drive_ms`) and routing
 * what the drive left (`route_ms`), each once the alarm got that far.
 *
 * `flows` lists the declarations this object may run; an intent naming
 * another flow is a failure like any other. Every object routes executions
 * to objects of the same class, so `flows` lists every flow an execution may
 * start as a child or hand off to.
 *
 * `settledRetentionMs` is how long a settled object keeps its intent; it
 * defaults to {@link settledRetentionMs}. `driveBudgetMs` is how long the
 * drive keeps starting steps; it defaults to {@link defaultDriveBudgetMs},
 * and the class passes {@link driveBudget}.
 *
 * @category operations
 * @since 1.0.0
 */
export const alarm = <E, R, RS, RE = never, RR = never>(
  storage: Storage<RS>,
  options: {
    readonly flows: ReadonlyArray<Flow.Any>
    readonly runtime: (intent: Intent) => Layer.Layer<Services, E, R>
    readonly router: Router<RE, RR>
    readonly settledRetentionMs?: number | undefined
    readonly driveBudgetMs?: number | undefined
  }
): Effect.Effect<Outcome, never, R | RS | RR> =>
  Effect.gen(function*() {
    const raw = yield* storage.get<string>(intentKey)
    const ids = yield* idsOf(raw)
    yield* Effect.annotateCurrentSpan(ids)
    const timing: Timing = {}
    const [elapsed, [writes, [written, outcome]]] = yield* Effect.timed(
      DatabaseMetrics.tally(JournalMetrics.tally(settleOrDrive(storage, raw, options, timing)))
    )
    const tag = outcome._tag.toLowerCase()
    const failure = outcome._tag === "Retrying"
      ? {
        "error.type": outcome.failure,
        "smithers.execution.attempt": outcome.attempt,
        retryAtMs: outcome.retryAtMs,
        delayMs: backoff(outcome.attempt),
        ...outcome.detail
      }
      : {}
    const drove = {
      ...(timing.buildMs === undefined ? {} : { "smithers.execution.build_ms": timing.buildMs }),
      ...(timing.driveMs === undefined ? {} : { "smithers.execution.drive_ms": timing.driveMs }),
      ...(timing.routeMs === undefined ? {} : { "smithers.execution.route_ms": timing.routeMs })
    }
    const cost = {
      durationMs: Math.round(Duration.toMillis(elapsed)),
      events: written.events,
      transactions: writes.transactions,
      schemaWide: writes.schemaWide,
      lockWaitMs: Math.round(Duration.toMillis(writes.lockWait)),
      maxLockWaitMs: Math.round(Duration.toMillis(writes.maxLockWait))
    }
    yield* Effect.annotateCurrentSpan({ "smithers.execution.alarm": tag, ...failure, ...drove, ...cost })
    yield* Metric.update(Metric.withAttributes(alarms, { outcome: tag }), 1)
    yield* (outcome._tag === "Retrying" ? Effect.logWarning : Effect.logInfo)("cloudflare.execution.alarm").pipe(
      Effect.annotateLogs({ outcome: tag, ...ids, ...failure, ...drove, ...cost })
    )
    return outcome
  }).pipe(Effect.withSpan("cloudflare.execution.alarm"))

/** What one {@link alarm} does with the stored intent `raw`, before it records the outcome. */
const settleOrDrive = <E, R, RS, RE, RR>(
  storage: Storage<RS>,
  raw: string | undefined,
  options: {
    readonly flows: ReadonlyArray<Flow.Any>
    readonly runtime: (intent: Intent) => Layer.Layer<Services, E, R>
    readonly router: Router<RE, RR>
    readonly settledRetentionMs?: number | undefined
    readonly driveBudgetMs?: number | undefined
  },
  timing: Timing
): Effect.Effect<Outcome, never, R | RS | RR> =>
  Effect.gen(function*() {
    if (raw === undefined) {
      yield* storage.deleteAlarm()
      return { _tag: "Idle" } as const
    }
    const retain = options.settledRetentionMs ?? settledRetentionMs
    const settledAt = yield* storage.get<number>(settledKey)
    if (settledAt !== undefined) {
      const forgetAtMs = settledAt + retain
      if ((yield* Clock.currentTimeMillis) < forgetAtMs) {
        yield* storage.setAlarm(forgetAtMs)
        return { _tag: "Settled", forgetAtMs } as const
      }
      yield* storage.delete(intentKey)
      yield* storage.delete(failuresKey)
      yield* storage.delete(settledKey)
      yield* storage.deleteAlarm()
      return { _tag: "Forgotten" } as const
    }
    const routerContext = yield* Effect.context<RR>()
    const attempt = ((yield* storage.get<number>(failuresKey)) ?? 0) + 1
    yield* storage.put(failuresKey, attempt)
    yield* storage.setAlarm((yield* Clock.currentTimeMillis) + backoff(attempt))
    const [outcome, failedStatement] = yield* FailureDetail.withFailedStatement(Effect.gen(function*() {
      const value = yield* decodeIntent(raw)
      const flow = options.flows.find((candidate) => candidate._tag === value.flow)
      if (flow === undefined) return yield* new UnknownFlow({ flow: value.flow })
      // Building the runtime is the layer's acquisition, which `Effect.provide` runs before the body: the ready line
      // says how long it took, so a slow start shows whether the runtime or the drive held it.
      const buildingAtMs = yield* Clock.currentTimeMillis
      return yield* Effect.gen(function*() {
        const readyAtMs = yield* Clock.currentTimeMillis
        timing.buildMs = readyAtMs - buildingAtMs
        yield* Effect.logInfo("cloudflare.execution.ready").pipe(Effect.annotateLogs({
          "smithers.execution.id": value.executionId,
          "smithers.flow": value.flow,
          readyAtMs,
          "smithers.execution.build_ms": timing.buildMs
        }))
        const driven = yield* timedDrive(storage, flow, value, options.driveBudgetMs ?? defaultDriveBudgetMs, timing)
        const routingAtMs = yield* Clock.currentTimeMillis
        // A cancelled intent may have no engine row at all.
        const exists = yield* (yield* RunStore.RunStore).get(value.executionId).pipe(
          Effect.as(true),
          Effect.catchIf((error) => error.code === "not_found_row", () => Effect.succeed(false))
        )
        if (exists) yield* route(value.executionId, options.router)
        timing.routeMs = (yield* Clock.currentTimeMillis) - routingAtMs
        if (driven._tag === "Settled") {
          const now = yield* Clock.currentTimeMillis
          yield* storage.put(settledKey, now)
          yield* storage.setAlarm(now + retain)
          return { _tag: "Settled", forgetAtMs: now + retain } as const
        }
        // A yielded run has work due now: the next alarm goes on at once.
        if (driven._tag === "Yielded") {
          yield* storage.setAlarm(yield* Clock.currentTimeMillis)
          return { _tag: "Yielded" } as const
        }
        return { _tag: "Parked", wakeAtMs: yield* arm(storage, value.executionId, driven.wakeAtMs ?? null) } as const
      }).pipe(
        Effect.provide(options.runtime(value)),
        Effect.provideService(WakeBus.Admitted, admitted(options.router, routerContext))
      )
    }))
    if (Exit.isSuccess(outcome)) {
      yield* storage.delete(failuresKey)
      return outcome.value
    }
    const retryAtMs = (yield* Clock.currentTimeMillis) + backoff(attempt)
    yield* storage.setAlarm(retryAtMs)
    return {
      _tag: "Retrying",
      attempt,
      retryAtMs,
      failure: RetryPolicy.failureType(outcome.cause),
      detail: FailureDetail.detail(outcome.cause, failedStatement)
    } as const
  })

/**
 * Compose one object's handlers, including durable cancellation. Keep one
 * instance for the lifetime of the object incarnation. Cancellation records a
 * tombstone before interrupting the active engine, or wakes an idle object to
 * finish the engine's cancellation on its next alarm. No action is started by
 * the cancellation handler and no application retry loop is needed.
 * `driveBudgetMs` bounds each drive; `afterAlarm` runs after every outcome,
 * once the active cancellation handler has been cleared.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = <E, R, RS, RE = never, RR = never, RA = never>(storage: Storage<RS>, options: {
  readonly flows: ReadonlyArray<Flow.Any>
  readonly runtime: (intent: Intent) => Layer.Layer<Services, E, R>
  readonly router: Router<RE, RR>
  readonly settledRetentionMs?: number | undefined
  readonly driveBudgetMs?: number | undefined
  readonly afterAlarm?: Effect.Effect<void, never, RA> | undefined
  /** Recheck domain admission before a delayed start reaches the engine. Failure retries the alarm. */
  readonly canStart?: ((intent: Intent) => Effect.Effect<boolean, never, R>) | undefined
}) => {
  const gate = Semaphore.makeUnsafe(1)
  let active: Effect.Effect<void, FlowRuntime.CancelRequestFailed> | undefined
  return {
    start: (value: Intent) => gate.withPermit(start(storage, value, Effect.void)),
    wake: () => wake(storage),
    cancel: () =>
      gate.withPermit(Effect.gen(function*() {
        yield* storage.put(cancelledKey, yield* Clock.currentTimeMillis)
        yield* storage.setAlarm(yield* Clock.currentTimeMillis)
        if (active !== undefined) yield* active
        const ids = yield* idsOf(yield* storage.get<string>(intentKey))
        yield* Metric.update(cancellations, 1)
        yield* Effect.annotateCurrentSpan(ids)
        yield* Effect.logInfo("cloudflare.execution.cancel").pipe(Effect.annotateLogs({ ...ids, outcome: "accepted" }))
      })).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Exit.isFailure(exit)
            ? Effect.logWarning("cloudflare.execution.cancel").pipe(Effect.annotateLogs({
              outcome: "failed",
              "error.type": RetryPolicy.failureType(exit.cause)
            }))
            : Effect.void
        ),
        // Storage and engine failures may contain content. The span exports
        // only the sanitized outcome; the caller still receives the failure.
        Effect.withSpan("cloudflare.execution.cancel"),
        Effect.flatMap((exit) => exit)
      ),
    alarm: () =>
      Effect.flatMap(Effect.context<R>(), (context) =>
        alarm(storage, options).pipe(
          Effect.provideService(AdmissionControl, {
            gate,
            activate: (cancel) => {
              active = cancel
            },
            allowed: (value) =>
              options.canStart === undefined ?
                Effect.succeed(true) :
                options.canStart(value).pipe(Effect.provide(context))
          }),
          Effect.ensuring(Effect.sync(() => {
            active = undefined
          }))
        )).pipe(Effect.tap(() => options.afterAlarm ?? Effect.void))
  }
}

/**
 * Durable cancellation requests accepted by an execution object.
 * @category metrics
 * @since 1.0.0
 */
export const cancellations = Metric.counter("smithers_cloudflare_execution_cancellations", { incremental: true })
