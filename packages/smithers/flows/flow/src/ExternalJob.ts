/**
 * Durable external work as ordinary actions, handoffs and parked timers.
 *
 * @since 1.0.0
 */

import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Action from "./Action/index.ts"
import * as Fault from "./Fault.ts"
import * as Flow from "./Flow/index.ts"
import { DriveDeadline } from "./FlowRuntime/DriveDeadline.ts"
import { FlowInstance } from "./FlowRuntime/FlowInstance.ts"
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"
import { ExecutionMiddleware } from "./internal/ExecutionMiddleware.ts"
import * as Interpreter from "./Interpreter.ts"
import * as Sleep from "./Sleep.ts"

/**
 * External process observation.
 * @category schemas
 * @since 1.0.0
 */
export const Status = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Running") }),
  Schema.Struct({ _tag: Schema.Literal("Exited"), exitCode: Schema.Int }),
  Schema.Struct({ _tag: Schema.Literal("Lost") })
])
/**
 * Decoded external process observation.
 * @category models
 * @since 1.0.0
 */
export type Status = typeof Status.Type
/**
 * Decoded external process observation.
 * @category models
 * @since 1.0.0
 */
export type Exited = Extract<Status, { readonly _tag: "Exited" }>
/**
 * A collected exit that can be replaced.
 *
 * @category errors
 * @since 1.0.0
 */
export class Again extends Schema.TaggedError<Again>()("@smthrs/flow/ExternalJobAgain", { message: Schema.String }) {}
/**
 * No worker or exit receipt remains.
 *
 * @category errors
 * @since 1.0.0
 */
export class ExternalJobLost extends Schema.TaggedError<ExternalJobLost>()("@smthrs/flow/ExternalJobLost", {
  key: Schema.String,
  message: Schema.String
}) {}
/**
 * The deadline anchored before initial start elapsed.
 *
 * @category errors
 * @since 1.0.0
 */
export class ExternalJobTimedOut extends Schema.TaggedError<ExternalJobTimedOut>()("@smthrs/flow/ExternalJobTimedOut", {
  key: Schema.String,
  message: Schema.String
}) {}
Fault.register("@smthrs/flow/ExternalJobLost", "infra")
Fault.register("@smthrs/flow/ExternalJobTimedOut", "dependency")
Fault.register("@smthrs/flow/ExternalJobAgain", "dependency")

const millis = (value: Duration.Input, field: string): number => {
  const parsed = Duration.fromInput(value)
  const result = Option.isSome(parsed) ? Duration.toMillis(parsed.value) : NaN
  if (!Number.isFinite(result) || result <= 0) {
    throw new RangeError(`ExternalJob.make: ${field} must be a finite positive duration`)
  }
  return result
}

/** `run`'s wait in milliseconds: finite and not negative, 0 meaning the work goes to the job at once. */
const waitMillis = (value: Duration.Input): number => {
  const parsed = Duration.fromInput(value)
  const result = Option.isSome(parsed) ? Duration.toMillis(parsed.value) : NaN
  if (!Number.isFinite(result) || result < 0) {
    throw new RangeError("ExternalJob.run: wait must be a finite duration, 0 or more")
  }
  return result
}
/**
 * How long `run` waited on a job's work inside the step that asked, in
 * milliseconds, by `job` (its tag) and `outcome`: `collected` (the work ended
 * and was collected there), `handed_off` (it was still running when the wait
 * ended, or was lost or refused, and went to the job's execution), or
 * `interrupted` (the step was). The step holds its run's drive while it
 * waits: on a host that bills by wall time, such as a Durable Object's alarm,
 * this is that time.
 *
 * @category metrics
 * @since 1.0.0
 */
export const stepWaits = Metric.histogram("flows_external_job_step_wait_ms", {
  description: "Milliseconds an ExternalJob's run waited on its work inside the step that asked",
  boundaries: [100, 1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000]
})

/**
 * What a status read may do before it answers: wait up to `waitMs`
 * milliseconds for the work to end, answering as soon as it does, and with
 * what it sees once the wait is over otherwise. An adapter that can't wait
 * answers at once; the job's schedule then does the waiting.
 *
 * @category models
 * @since 1.0.0
 */
export interface StatusOptions {
  readonly waitMs: number
}

/**
 * The adapter's full typed failure union belongs in make's error schema.
 *
 * `abandon` stops the work of a generation key whose `start` never returned a
 * handle: the run was cancelled, the deadline passed, or `start` failed after
 * the provider may already have admitted it. A provider that implements it
 * must let `abandon` of a key it has not admitted yet win over a later `start`
 * of that key. Without it, such a generation is left to the provider.
 *
 * `cancel` and `abandon` may fail with the adapter's error: inside a step the
 * engine retries them as it retries `start`, so a stop the provider could not
 * record is never journaled as done. Only the rollback of an interrupted run,
 * which has no step to retry, runs them once and logs a failure.
 *
 * @category models
 * @since 1.0.0
 */
export interface Operations<P, H, A, E, R> {
  readonly start: (payload: P, key: string) => Effect.Effect<H, E, R>
  readonly status: (handle: H, key: string, options?: StatusOptions) => Effect.Effect<Status, E, R>
  readonly collect: (handle: H, key: string, exited: Exited) => Effect.Effect<A, E | Again, R>
  readonly cancel: (handle: H, key: string) => Effect.Effect<void, E, R>
  readonly abandon?: ((payload: P, key: string) => Effect.Effect<void, E, R>) | undefined
}

/**
 * Create-or-get by execution id and generation. Private ordinary flows carry
 * journaled state; initial callers cannot supply a key or continuation handle.
 * `restarts` counts replacement generations; zero permits only g1. The
 * journaled deadline bounds every provider call: a start or collect still
 * running at the deadline, or reached after it, cancels or abandons its
 * generation and fails `ExternalJobTimedOut`, and no start runs after it.
 *
 * `flows` lists the job's declarations: the job itself and its two private
 * continuations. A host that resolves an execution's flow by its tag, such
 * as a Durable Object per execution, must list all three, because `call`
 * runs the job as its own child execution and a round hands off to the
 * continuations.
 * @category constructors
 * @since 1.0.0
 */
export const make = <
  const Tag extends string,
  P extends Schema.Struct.Fields | Flow.AnyStructSchema,
  H extends Schema.Top,
  A extends Schema.Top,
  E extends Schema.Top = typeof Schema.Never
>(tag: Tag, options: {
  readonly payload: P
  readonly handle: H
  readonly success: A
  readonly error?: E
  readonly probe: { readonly every: Duration.Input; readonly max: Duration.Input }
  readonly timeout: Duration.Input
  readonly restarts?: number
}) => {
  const every = millis(options.probe.every, "probe.every")
  const maximum = millis(options.probe.max, "probe.max")
  const timeout = millis(options.timeout, "timeout")
  const restarts = options.restarts ?? 0
  if (maximum < every) throw new RangeError("ExternalJob.make: probe.max must be at least probe.every")
  if (!Number.isSafeInteger(restarts) || restarts < 0) {
    throw new RangeError("ExternalJob.make: restarts must be a nonnegative safe integer")
  }
  type Input = P extends Schema.Struct.Fields ? Schema.Struct<P> : P
  // Erase field modifiers at nesting boundaries: these are required values,
  // even when the author's schema contains optional fields internally.
  const input =
    (Schema.isSchema(options.payload) ? options.payload : Schema.Struct(options.payload)) as unknown as Schema.Codec<
      Input["Type"],
      Input["Encoded"],
      Input["DecodingServices"],
      Input["EncodingServices"]
    >
  const handle = options.handle as Schema.Codec<H["Type"], H["Encoded"], H["DecodingServices"], H["EncodingServices"]>
  const providerError = (options.error ?? Schema.Never) as E
  const failure = Schema.Union([providerError, ExternalJobLost, ExternalJobTimedOut, Sleep.SleepRequestInvalid])
  const state = Schema.Struct({
    input,
    origin: Schema.String,
    startedAt: Schema.Number,
    generation: Schema.Int,
    probe: Schema.Int
  })
  const observed = Schema.Struct({ ...state.fields, handle })
  type State = typeof state.Type
  type Observed = typeof observed.Type
  const keyOf = (job: { readonly origin: string; readonly generation: number }) => `${job.origin}#g${job.generation}`
  const captures = { tag, every, maximum, timeout, restarts, version: "external-job/v1" }
  // The generation a round is responsible for: admitted with a handle, or
  // being admitted, which an interruption or failure must abandon by key.
  type Current =
    | { readonly key: string; readonly started: true; readonly handle: H["Type"] }
    | { readonly key: string; readonly started: false; readonly input: State["input"] }
  type Active = { executionId: string; current: Current | undefined }
  const active = Context.Service<Active>(`${tag}/ExternalJobActive`)
  interface Lifecycle {
    readonly cancel: (handle: H["Type"], key: string) => Effect.Effect<void>
    readonly abandon: (input: State["input"], key: string) => Effect.Effect<void>
  }
  // Registry tables wrap get() for module isolation but retain add(), the
  // scoped registration owner. Anchor lifecycle bindings to that owner.
  const lifecycles = new WeakMap<object, Lifecycle>()
  const annotations = Context.make(ExecutionMiddleware, {
    wrap: (payload, body) =>
      Effect.gen(function*() {
        const instance = yield* FlowInstance
        const table = yield* Action.Implementations
        const lifecycle = lifecycles.get(table.add)
        if (lifecycle === undefined) {
          return yield* Effect.die(
            new Interpreter.InterpreterError({
              code: "unresolved_action",
              flow: tag,
              node: `${tag}/cancel`,
              message: `ExternalJob ${tag} has no cancellation implementation; provide its toLayer`
            })
          )
        }
        const current: Active = {
          executionId: instance.executionId,
          current: instance.flow._tag === `${tag}/observe`
            ? { key: keyOf(payload as Observed), started: true, handle: (payload as Observed).handle } :
            undefined
        }
        yield* Flow.withRollback(Effect.succeed(current), (value, cause) => {
          const job = value.current
          // A host that stops leaves the external work to the next host.
          if (Cause.hasInterruptsOnly(cause) && !instance.interrupted && !instance.suspended || job === undefined) {
            return Effect.void
          }
          return job.started ? lifecycle.cancel(job.handle, job.key) : lifecycle.abandon(job.input, job.key)
        })
        return yield* body.pipe(Effect.provideService(active, current))
      })
  })
  const Initialize = Action.make(`${tag}/initialize`, { payload: { input }, success: state })
  const Start = Action.make(`${tag}/start`, {
    payload: state,
    success: options.handle,
    error: Schema.Union([providerError, ExternalJobTimedOut]),
    tier: "irreversible",
    idempotencyKey: keyOf
  })
  const Probe = Action.make(`${tag}/status`, {
    payload: observed,
    success: Schema.Struct({
      status: Status,
      timedOut: Schema.Boolean,
      wakeAt: Schema.Number,
      next: observed,
      restart: state
    }),
    error: providerError,
    implementationVersion: "external-job/status/v1",
    effects: { reads: [], writes: [], mode: "expected", onConflict: "fail" },
    tier: "sealed",
    idempotencyKey: (job) => `${keyOf(job)}/probe/${job.probe}`
  })
  const Collect = Action.make(`${tag}/collect`, {
    payload: { job: observed, exited: Schema.Struct({ _tag: Schema.Literal("Exited"), exitCode: Schema.Int }) },
    success: options.success,
    error: Schema.Union([providerError, Again, ExternalJobTimedOut]),
    tier: "irreversible",
    idempotencyKey: ({ job }) => `${keyOf(job)}/collect`
  })
  const Cancel = Action.make(`${tag}/cancel`, {
    payload: observed,
    success: Schema.Void,
    error: providerError,
    tier: "irreversible",
    idempotencyKey: (job) => `${keyOf(job)}/cancel`
  })
  const Fail = Action.make(`${tag}/fail`, {
    payload: { job: observed, timedOut: Schema.Boolean },
    success: Schema.Never,
    error: Schema.Union([ExternalJobLost, ExternalJobTimedOut])
  })
  const Ready = Action.make(`${tag}/ready`, { payload: state, success: Schema.Boolean })
  const LaunchFailure = Action.make(`${tag}/launch-timeout`, {
    payload: state,
    success: Schema.Never,
    error: ExternalJobTimedOut
  })
  const launched = Node.capture(
    captures,
    (job: State | Action.PlannedPayload<State>) =>
      Start.call(job as Action.PlannedPayload<State>).pipe(
        Node.bindPlanned(Node.capture(captures, (handle: Action.PlannedPayload<H["Type"]>) =>
          observe.to({
            input: job.input,
            origin: job.origin,
            startedAt: job.startedAt,
            generation: job.generation,
            probe: job.probe,
            handle
          })))
      )
  )
  // Pin the declared union through recursive bodies: cross-package inference
  // otherwise narrows the error schema to the provider-only generic E.
  const launch: Flow.Flow<string, typeof state, A, typeof failure, Action.Requirement<string>> = Flow.make<
    `${Tag}/launch`,
    typeof state,
    A,
    typeof failure,
    Action.Requirement<string>
  >(
    `${tag}/launch`,
    {
      payload: state,
      success: options.success,
      error: failure,
      annotations,
      body: Node.capture(
        captures,
        (job) =>
          Ready.call(job).pipe(Node.branch({
            if: Node.capture(captures, (ready) => ready),
            then: () => launched(job),
            else: () => LaunchFailure.call(job)
          }))
      )
    }
  )
  const recover = (job: Observed, result: Action.PlannedPayload<{ restart: State; wakeAt: number }>) =>
    Cancel.call(job).pipe(Node.andThen(
      Node.succeed(job).pipe(Node.branch({
        if: Node.capture(captures, (current) => current.generation <= restarts),
        then: () => Sleep.action.call({ until: result.wakeAt }).pipe(Node.andThen(launch.to(result.restart))),
        else: () => Fail.call({ job, timedOut: false })
      }))
    ))
  const observe: Flow.Flow<string, typeof observed, A, typeof failure, Action.Requirement<string>> = Flow.make<
    `${Tag}/observe`,
    typeof observed,
    A,
    typeof failure,
    Action.Requirement<string>
  >(
    `${tag}/observe`,
    {
      payload: observed,
      success: options.success,
      error: failure,
      annotations,
      body: Node.capture(
        captures,
        (job) =>
          Probe.call(job).pipe(
            Node.bindPlanned(Node.capture(captures, (result: Action.PlannedPayload<typeof Probe.successSchema.Type>) =>
              Node.succeed(result).pipe(Node.branch({
                if: Node.capture(captures, (value) =>
                  value.timedOut),
                then: () =>
                  Cancel.call(job).pipe(Node.andThen(Fail.call({ job, timedOut: true }))),
                else: () =>
                  Node.succeed(result.status).pipe(Node.branch({
                    if: Node.capture(captures, (status) => status._tag === "Running"),
                    then: () => Sleep.action.call({ until: result.wakeAt }).pipe(Node.andThen(observe.to(result.next))),
                    else: (status) =>
                      Node.succeed(status).pipe(Node.branch({
                        if: Node.capture(captures, (value) => value._tag === "Lost"),
                        then: () => recover(job, result),
                        else: (exited) =>
                          Collect.call({ job, exited: exited as unknown as Exited }).pipe(
                            Node.catch({ error: Schema.Struct(Again.fields), onFailure: () => recover(job, result) })
                          )
                      }))
                  }))
              }))))
          )
      )
    }
  )
  const flow = Flow.make<Tag, P, A, typeof failure, Action.Requirement<string>>(tag, {
    payload: options.payload,
    success: options.success,
    error: failure,
    annotations,
    body: Node.capture(captures, (payload) => Initialize.call({ input: payload }).pipe(Node.bindPlanned(launched)))
  })
  /**
   * Runs `effect` until the job's journaled deadline: `None` when the deadline
   * comes first, and without running it at all once the deadline has passed.
   */
  const untilDeadline = <B, F, R>(job: { readonly startedAt: number }, effect: Effect.Effect<B, F, R>) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      const remaining = job.startedAt + timeout - Math.floor(now)
      return remaining <= 0
        ? Effect.succeedNone :
        Effect.raceFirst(Effect.asSome(effect), Effect.as(Effect.sleep(remaining), Option.none<B>()))
    })
  const toLayer = <R>(operations: Operations<typeof input.Type, H["Type"], A["Type"], E["Type"], R>) => {
    const abandon = (payload: typeof input.Type, key: string): Effect.Effect<void, E["Type"], R> =>
      operations.abandon === undefined ? Effect.void : operations.abandon(payload, key)
    // The rollback of an interrupted run has no step to retry a failed stop in: it runs once, and a failure is logged
    // by its operation and key, never its cause, which can carry the provider's text.
    const once = (operation: "cancel" | "abandon", key: string) => <X>(effect: Effect.Effect<void, X, R>) =>
      effect.pipe(
        Effect.catch(() =>
          Effect.logWarning("ExternalJob rollback could not stop its job").pipe(
            Effect.annotateLogs({ job: tag, operation, key })
          )
        )
      )
    const bindCancellation = Layer.effectDiscard(Effect.gen(function*() {
      const table = yield* Action.Implementations
      const context = yield* Effect.context<R>()
      const lifecycle: Lifecycle = {
        cancel: (handle, key) =>
          operations.cancel(handle, key).pipe(once("cancel", key), Effect.provideContext(context)),
        abandon: (payload, key) => abandon(payload, key).pipe(once("abandon", key), Effect.provideContext(context))
      }
      lifecycles.set(table.add, lifecycle)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (lifecycles.get(table.add) === lifecycle) lifecycles.delete(table.add)
        })
      )
    }))
    const interpreter = Layer.mergeAll(Interpreter.layer(flow), Interpreter.layer(launch), Interpreter.layer(observe))
    const layer = Layer.mergeAll(
      interpreter,
      bindCancellation,
      Sleep.layer,
      Initialize.toLayer(({ input }) =>
        Effect.gen(function*() {
          const instance = yield* active
          return {
            input,
            origin: instance.executionId,
            startedAt: Math.floor(yield* Clock.currentTimeMillis),
            generation: 1,
            probe: 1
          }
        })
      ),
      Start.toLayer((job) =>
        Effect.gen(function*() {
          const key = keyOf(job)
          const execution = yield* active
          // Recorded before the provider call: from here on the provider may
          // have admitted the key, so an interruption or failure abandons it.
          execution.current = { key, started: false, input: job.input }
          const handle = yield* untilDeadline(job, operations.start(job.input, key))
          if (Option.isNone(handle)) {
            yield* abandon(job.input, key)
            execution.current = undefined
            return yield* new ExternalJobTimedOut({ key, message: `Job ${key} timed out before it started` })
          }
          execution.current = { key, started: true, handle: handle.value }
          return handle.value
        })
      ),
      Probe.toLayer((job) =>
        Effect.gen(function*() {
          const begunAt = Math.floor(yield* Clock.currentTimeMillis)
          const deadline = job.startedAt + timeout
          const delay = Math.min(maximum, every * 2 ** Math.min(job.probe - 1, 1023))
          let timedOut = begunAt >= deadline
          // The read may wait for the work to end until the next probe is due (`StatusOptions`), so an adapter that
          // can wait answers an exit when it happens, and the park after it is over at once.
          const status = timedOut ? { _tag: "Running" as const } : yield* Effect.raceFirst(
            operations.status(job.handle, keyOf(job), { waitMs: Math.min(delay, deadline - begunAt) }),
            Effect.sleep(deadline - begunAt).pipe(Effect.as({ _tag: "Running" as const }))
          )
          const now = Math.floor(yield* Clock.currentTimeMillis)
          timedOut ||= now >= deadline
          return {
            status,
            timedOut,
            wakeAt: Math.min(deadline, Math.max(now, Math.ceil(begunAt + delay))),
            next: { ...job, probe: job.probe + 1 },
            restart: {
              input: job.input,
              origin: job.origin,
              startedAt: job.startedAt,
              generation: job.generation + 1,
              probe: 1
            }
          }
        }), { implementationVersion: "external-job/status/v1" }),
      Collect.toLayer(({ exited, job }) =>
        Effect.gen(function*() {
          const key = keyOf(job)
          const execution = yield* active
          const collected = yield* untilDeadline(job, operations.collect(job.handle, key, exited))
          if (Option.isNone(collected)) {
            yield* operations.cancel(job.handle, key)
            execution.current = undefined
            return yield* new ExternalJobTimedOut({ key, message: `Job ${key} timed out while collecting` })
          }
          execution.current = undefined
          return collected.value
        })
      ),
      Cancel.toLayer((job) =>
        Effect.tap(operations.cancel(job.handle, keyOf(job)), () =>
          Effect.map(active, (value) => {
            value.current = undefined
          }))
      ),
      Fail.toLayer(({ job, timedOut }) =>
        Effect.fail(
          timedOut
            ? new ExternalJobTimedOut({ key: keyOf(job), message: `Job ${keyOf(job)} timed out` })
            : new ExternalJobLost({
              key: keyOf(job),
              message: `Job ${keyOf(job)} exhausted its replacement generations`
            })
        )
      ),
      Ready.toLayer((job) => Effect.map(Clock.currentTimeMillis, (now) => now < job.startedAt + timeout)),
      LaunchFailure.toLayer((job) =>
        Effect.fail(
          new ExternalJobTimedOut({ key: keyOf(job), message: `Job ${keyOf(job)} timed out before replacement start` })
        )
      )
    )
    // Active is supplied by the execution middleware, never by the host.
    return layer as Layer.Layer<
      Layer.Success<typeof layer>,
      Layer.Error<typeof layer>,
      Exclude<Layer.Services<typeof layer>, Active>
    >
  }
  // A job requires its own execution scope and identity even when composed
  // through call; reuse the existing child boundary rather than inline it.
  const call: typeof flow.child = (payload) => flow.child(payload)
  /**
   * The first generation, done inside the calling step: `None` unless it
   * exits within `waitMs` and collects, when it answers what it collected.
   * Anything else (a failure, a lost generation, one still running) is the
   * job's to decide, under the same key. Interrupted, it stops the work only
   * when the caller's run was cancelled: a host that stops leaves it to the
   * step's next attempt, which asks for the same key again.
   */
  const inline = <R>(
    operations: Operations<State["input"], H["Type"], A["Type"], E["Type"], R>,
    payload: State["input"],
    executionId: string,
    waitMs: number
  ) =>
    Effect.gen(function*() {
      const key = keyOf({ origin: executionId, generation: 1 })
      const caller = yield* Effect.serviceOption(FlowInstance)
      const until = Math.floor(yield* Clock.currentTimeMillis) + waitMs
      let handle: Option.Option<H["Type"]> = Option.none()
      const attempt = Effect.gen(function*() {
        const started = yield* operations.start(payload, key)
        handle = Option.some(started)
        for (let probe = 1;; probe++) {
          const begunAt = Math.floor(yield* Clock.currentTimeMillis)
          const status = yield* operations.status(started, key, { waitMs: Math.max(0, until - begunAt) })
          if (status._tag === "Exited") return Option.some(yield* operations.collect(started, key, status))
          if (status._tag === "Lost") return Option.none<A["Type"]>()
          const now = Math.floor(yield* Clock.currentTimeMillis)
          if (now >= until) return Option.none<A["Type"]>()
          // The next read is due on the job's schedule from this one's start: at once after a read that waited that
          // long, as one that can wait does, and after the rest of the delay otherwise.
          const dueAt = Math.min(until, begunAt + Math.min(maximum, every * 2 ** Math.min(probe - 1, 1023)))
          yield* Effect.sleep(Math.max(0, dueAt - now))
        }
      })
      const stop = (): Effect.Effect<void, E["Type"], R> =>
        Option.isSome(handle)
          ? operations.cancel(handle.value, key)
          : operations.abandon === undefined
          ? Effect.void
          : operations.abandon(payload, key)
      return yield* attempt.pipe(
        Effect.catch(() => Effect.succeedNone),
        Effect.onInterrupt(() =>
          Option.isSome(caller) && caller.value.interrupted
            ? stop().pipe(
              Effect.catch(() =>
                Effect.logWarning("ExternalJob inline run could not stop its job").pipe(
                  Effect.annotateLogs({ job: tag, operation: Option.isSome(handle) ? "cancel" : "abandon", key })
                )
              )
            )
            : Effect.void
        )
      )
    })
  /**
   * Runs the job from inside a step (an action's body) as execution
   * `executionId` over `operations` (the ones its `toLayer` was given), and
   * answers its success as `execute` does. Work that ends within `wait`
   * (`probe.max` unless set, at most `timeout`, and never past the drive's
   * budget, `FlowRuntime.DriveDeadline`) is started, waited on and
   * collected in the step itself, under the key its first generation would
   * use, so the step's run never parks for it and no execution of the job is
   * made. Anything else, or work still running then, goes to the job's own
   * execution under the same key, which the step then waits on as `execute`
   * does: the provider answers the same handle and starts nothing. A step
   * asked again joins a job an earlier attempt handed its work to.
   *
   * A `wait` of 0 hands the work to the job at once. Each wait is recorded on
   * {@link stepWaits}. Throws a `RangeError` for a `wait` that is negative or
   * not finite.
   */
  const run = <R>(
    payload: State["input"],
    options: {
      readonly executionId: string
      readonly operations: Operations<State["input"], H["Type"], A["Type"], E["Type"], R>
      readonly wait?: Duration.Input | undefined
    }
  ) => {
    const waitMs = Math.min(timeout, options.wait === undefined ? maximum : waitMillis(options.wait))
    return Effect.gen(function*() {
      const executed = flow.execute(payload, { executionId: options.executionId })
      // The job's actions are the caller's to register, as `toLayer` does: `run` is asked with its operations.
      const execute = executed as Effect.Effect<
        A["Type"],
        Effect.Error<typeof executed>,
        Exclude<Effect.Services<typeof executed>, Action.Requirement<string>>
      >
      const handedOff = yield* (yield* FlowRuntime).poll(flow, options.executionId).pipe(
        Effect.as(true),
        Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(false))
      )
      if (handedOff) return yield* execute
      // A drive with a budget is waited on no later than its end: work still going then goes on as the job.
      const deadline = yield* DriveDeadline
      const left = deadline === undefined
        ? waitMs
        : Math.min(waitMs, deadline - Math.floor(yield* Clock.currentTimeMillis))
      if (left <= 0) return yield* execute
      const begunAt = yield* Clock.currentTimeMillis
      const waited = (outcome: "collected" | "handed_off" | "interrupted") =>
        Effect.flatMap(
          Clock.currentTimeMillis,
          (now) => Metric.update(Metric.withAttributes(stepWaits, { job: tag, outcome }), now - begunAt)
        )
      const done = yield* inline(options.operations, payload, options.executionId, left).pipe(
        Effect.onInterrupt(() => waited("interrupted"))
      )
      yield* waited(Option.isSome(done) ? "collected" : "handed_off")
      return Option.isSome(done) ? done.value : yield* execute
    })
  }
  const flows: ReadonlyArray<Flow.Any> = [flow, launch, observe]
  return Object.assign(flow, { call, run, toLayer, flows }) as {
    readonly call: typeof call
    readonly run: typeof run
    readonly toLayer: typeof toLayer
    readonly flows: ReadonlyArray<Flow.Any>
  } & typeof flow
}
