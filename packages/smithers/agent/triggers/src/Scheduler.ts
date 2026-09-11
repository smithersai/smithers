/**
 * Durable, Clock-driven trigger scheduling.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 *
 * @since 0.1.0
 */
import * as Control from "@smthrs/control/Control"
import type { PlanCard, Receipt, RunStatus } from "@smthrs/control/ControlSchema"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as CatchUp from "./CatchUp.ts"
import * as Cron from "./Cron.ts"
import { TriggerError } from "./TriggerError.ts"
import {
  type Claim,
  type Held,
  isReservation,
  type Registered,
  reservationOccurrence,
  TriggerStore
} from "./TriggerStore.ts"

/**
 * Arguments used to launch one scheduled flow.
 *
 * @category models
 * @since 0.1.0
 */
export interface StartInput {
  readonly flowId: string
  readonly input: unknown
  readonly idempotencyKey: string
}

/**
 * Runtime operations required by the scheduler.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunnerService {
  readonly start: (input: StartInput) => Effect.Effect<string, TriggerError>
  readonly isActive: (runId: string) => Effect.Effect<boolean, TriggerError>
  readonly cancel: (runId: string) => Effect.Effect<void, TriggerError>
}

/**
 * Injectable scheduled-run launcher.
 *
 * Constructed with {@link makeRunner}, {@link makeNoopRunner}, or
 * {@link layerNoopRunner}; the tag itself carries no constructors, so there is
 * one spelling of each and the module's own `make`/`makeNoop` can only mean
 * the scheduler.
 *
 * @category services
 * @since 0.1.0
 */
export class Runner extends Context.Service<Runner, RunnerService>()("flows/triggers/Scheduler/Runner") {}

/**
 * Constructs a scheduled-run launcher.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeRunner = (implementation: RunnerService): RunnerService => Runner.of(implementation)

/**
 * Constructs a launcher that returns the idempotency key as a terminal run.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoopRunner = (overrides: Partial<RunnerService> = {}): RunnerService =>
  makeRunner({
    start: (input) => Effect.succeed(input.idempotencyKey),
    isActive: () => Effect.succeed(false),
    cancel: () => Effect.void,
    ...overrides
  })

/**
 * Provides the terminal no-op launcher.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoopRunner = (
  overrides: Partial<RunnerService> = {}
): Layer.Layer<Runner> => Layer.succeed(Runner)(makeNoopRunner(overrides))

const runnerError = (message: string, cause?: unknown): TriggerError =>
  new TriggerError({
    code: "runner",
    message,
    ...(cause === undefined ? {} : { cause })
  })

const translateRunnerFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  message: string
): Effect.Effect<A, TriggerError, R> =>
  effect.pipe(
    Effect.mapError((error) => error instanceof TriggerError ? error : runnerError(message, error)),
    Effect.catchDefect((defect) => Effect.fail(runnerError(message, defect)))
  )

const invalidOption = (field: string, requirement: string): TriggerError =>
  new TriggerError({
    code: "invalid_options",
    message: `${field} must be ${requirement}`,
    path: field
  })

const duration = (
  input: Duration.Input,
  field: string
): Effect.Effect<Duration.Duration, TriggerError> =>
  Option.match(Duration.fromInput(input), {
    onNone: () => Effect.fail(invalidOption(field, "a valid Effect duration")),
    onSome: (value) =>
      // Zero polls a CPU-tight loop and an infinite interval never completes,
      // and `Duration.fromInput` accepts both.
      Duration.isFinite(value) && Duration.toMillis(value) > 0
        ? Effect.succeed(value)
        : Effect.fail(invalidOption(field, "a finite positive duration"))
  })

const runIdFromReceipt = (
  receipt: Exclude<Receipt, { readonly _tag: "Parked" }>
): Effect.Effect<string, TriggerError> => {
  switch (receipt._tag) {
    case "Accepted":
    case "AlreadyApplied":
      return receipt.runId === undefined
        ? Effect.fail(runnerError(`Control ${receipt._tag} receipt did not include a run id`))
        : Effect.succeed(receipt.runId)
    case "Terminal":
      return Effect.succeed(receipt.runId)
    case "Conflict":
      return Effect.fail(runnerError(`Control rejected the scheduled run: ${receipt.message}`))
  }
}

/**
 * How many times a parked plan is re-offered before the launch is abandoned.
 *
 * The delay doubles from one second, so the eighth attempt lands a little over
 * two minutes in. A plan nobody approves used to be re-offered once a second
 * for the life of the scope while the launch reservation behind it expired.
 *
 * @category constants
 * @since 0.1.0
 */
export const parkedAttempts = 8

const runApprovedPlan = (
  control: Control.Service,
  plan: PlanCard,
  key: string,
  attempt: number
): Effect.Effect<string, TriggerError> =>
  control.run({
    _tag: "Plan",
    planId: plan.planId,
    digest: plan.digest,
    envelope: plan.envelope,
    idempotencyKey: key
  }).pipe(
    Effect.mapError((error) => runnerError("Control could not launch the scheduled run", error)),
    Effect.flatMap((receipt) => {
      if (receipt._tag !== "Parked") return runIdFromReceipt(receipt)
      if (attempt >= parkedAttempts) {
        return Effect.fail(
          runnerError(
            `Control plan ${plan.planId} is still parked awaiting approval after ${attempt} attempts`
          )
        )
      }
      return Effect.logInfo(`A scheduled plan is parked awaiting approval, attempt ${attempt}`).pipe(
        Effect.andThen(Effect.sleep(Duration.millis(1000 * 2 ** (attempt - 1)))),
        Effect.andThen(Effect.suspend(() => runApprovedPlan(control, plan, key, attempt + 1)))
      )
    })
  )

/**
 * The statuses that mean a run has stopped for good.
 *
 * Liveness is stated as the complement of this set rather than as a list of
 * live statuses, so a status Control adds later is treated as live until this
 * package says otherwise. Reading it the other way round is what dropped
 * `accepted`, the status every run holds between its claim and its first
 * executed step (`packages/smithers/control/src/ControlLive.ts`).
 */
const settled: ReadonlySet<RunStatus> = new Set<RunStatus>(["cancelled", "completed", "failed"])

/**
 * Runner layer backed by the authoritative Control plan/run/list/cancel API.
 *
 * A parked plan waits for approval and retries the same idempotent run request
 * a bounded number of times; this adapter never approves it or reconstructs an
 * execution envelope.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerControlRunner: Layer.Layer<Runner, never, Control.Control> = Layer.effect(
  Runner,
  Effect.gen(function*() {
    const control = yield* Control.Control
    return makeRunner({
      start: (input) =>
        translateRunnerFailure(
          control.plan(input).pipe(
            Effect.flatMap((plan) => runApprovedPlan(control, plan, input.idempotencyKey, 1))
          ),
          "Control could not launch the scheduled run"
        ),
      isActive: (runId) =>
        translateRunnerFailure(
          control.list({ _tag: "runs", filters: { runId }, limit: 1 }).pipe(
            Effect.map((response) => {
              if (response._tag !== "runs") return false
              const run = response.items.find((candidate) => candidate.runId === runId)
              return run !== undefined && !settled.has(run.status)
            })
          ),
          `Control could not inspect run ${runId}`
        ),
      cancel: (runId) =>
        translateRunnerFailure(
          control.cancel({
            runId,
            idempotencyKey: `trigger-cancel:${runId}`
          }).pipe(
            Effect.flatMap((receipt): Effect.Effect<void, TriggerError> => {
              switch (receipt._tag) {
                case "Accepted":
                case "AlreadyApplied":
                case "Terminal":
                  return Effect.void
                case "Conflict":
                  return Effect.fail(runnerError(`Control refused scheduled cancellation: ${receipt.message}`))
                case "Parked":
                  return Effect.fail(runnerError(`Control returned a Parked receipt for cancellation of run ${runId}`))
              }
            })
          ),
          `Control could not cancel run ${runId}`
        )
    })
  })
)

/**
 * Scheduler timing configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly pollInterval?: Duration.Input | undefined
  readonly runPollInterval?: Duration.Input | undefined
  /**
   * How many triggers one tick processes at the same time. Defaults to
   * {@link defaultConcurrency}. Triggers are independent once claimed, so a
   * launch waiting on a parked plan holds one slot, not the tick.
   */
  readonly concurrency?: number | undefined
  /**
   * How long one `Runner.start` may take before the launch is abandoned with
   * `runner_timeout`. Defaults to four minutes: above the Control adapter's
   * bounded parked-approval retries and below the five-minute reservation
   * lease, so an abandoned launch still owns its reservation and re-arms the
   * occurrence itself. The next tick retries it under the same idempotency
   * key. A deadline above the lease is allowed; a start that answers after
   * its lease is reconciled as a late launch.
   */
  readonly startTimeout?: Duration.Input | undefined
  /**
   * How long one `Runner.isActive` may take. Defaults to thirty seconds. A
   * timeout is an inspection failure: the monitor retries and then detaches,
   * retaining the durable owner.
   */
  readonly inspectTimeout?: Duration.Input | undefined
  /**
   * How long one `Runner.cancel` may take. Defaults to thirty seconds. A
   * timeout fails the supersede, which restores the prior run as active and
   * queues the replacement.
   */
  readonly cancelTimeout?: Duration.Input | undefined
  /**
   * The name this scheduler records its heartbeat under, so a listing can say
   * which host last polled the store. Defaults to {@link defaultHost}.
   */
  readonly host?: string | undefined
}

/**
 * The heartbeat host name a scheduler records under when its options name
 * none.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultHost = "local"

/**
 * How many triggers one tick processes at the same time when its options name
 * no `concurrency`.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultConcurrency = 4

const deadline = <A>(
  effect: Effect.Effect<A, TriggerError>,
  limit: Duration.Duration,
  what: string
): Effect.Effect<A, TriggerError> =>
  Effect.timeoutOrElse(effect, {
    duration: limit,
    orElse: () =>
      Effect.fail(
        new TriggerError({
          code: "runner_timeout",
          message: `${what} did not answer within ${Duration.toMillis(limit)} ms`
        })
      )
  })

/**
 * Scheduler operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly runOnce: Effect.Effect<void, TriggerError>
}

/**
 * The live trigger scheduler.
 *
 * @category services
 * @since 0.1.0
 */
export class Scheduler extends Context.Service<Scheduler, Service>()("flows/triggers/Scheduler") {}

/**
 * What this process knows about the run one trigger currently owns: which
 * occurrence claimed it, the reservation or run id the store holds for it, and
 * the monitor fiber when this process is the one watching it.
 *
 * `runId` is always known. A claim that hands out work names the reservation it
 * wrote, and a recovered entry is read back from the store, so an entry with
 * nothing to release cannot be constructed.
 */
interface Active {
  readonly occurrence: number
  readonly runId: string
  readonly fiber?: Fiber.Fiber<void> | undefined
}

interface Due {
  readonly occurrences: ReadonlyArray<number>
  readonly watermark: number
}

/** Stable Control request identity for one manual or scheduled occurrence.
 * @category constructors
 * @since 0.1.0
 */
export const idempotencyKey = (triggerId: string, occurrence: number): string =>
  `${triggerId}:${new Date(occurrence).toISOString()}`

/**
 * Runs one trigger's work and reports whether it finished.
 *
 * A tick walks the due triggers in id order, so an aborting trigger used to
 * take every trigger after it alphabetically down with it, and the supervisor
 * above discarded the error unread. The cause is logged where the trigger it
 * belongs to is still known. Interruption is re-raised: it is the scope
 * closing, not a trigger failing.
 */
const attempted = (
  annotations: Record<string, string>,
  work: string,
  effect: Effect.Effect<void, TriggerError>
): Effect.Effect<boolean, TriggerError> =>
  Effect.catchCause(Effect.as(effect, true), (cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.as(
        Effect.annotateLogs(Effect.logWarning(`A trigger ${work} failed`, cause), annotations),
        false
      ))

const isolate = (
  annotations: Record<string, string>,
  work: string,
  effect: Effect.Effect<void, TriggerError>
): Effect.Effect<void, TriggerError> => Effect.asVoid(attempted(annotations, work, effect))

/**
 * Constructs a scheduler service in the current Scope.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options = {}
): Effect.Effect<Service, TriggerError, Runner | Scope.Scope | TriggerStore> =>
  Effect.gen(function*() {
    const parentScope = yield* Effect.scope
    const store = yield* TriggerStore
    const active = yield* Ref.make<ReadonlyMap<string, Active>>(new Map())
    const observedAt = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
    const semaphore = yield* Semaphore.make(1)
    const runPollInterval = yield* duration(options.runPollInterval ?? "15 seconds", "runPollInterval")
    const concurrency = options.concurrency ?? defaultConcurrency
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      return yield* Effect.fail(invalidOption("concurrency", "a positive integer"))
    }
    const startTimeout = yield* duration(options.startTimeout ?? "4 minutes", "startTimeout")
    const inspectTimeout = yield* duration(options.inspectTimeout ?? "30 seconds", "inspectTimeout")
    const cancelTimeout = yield* duration(options.cancelTimeout ?? "30 seconds", "cancelTimeout")
    // Every runner call carries a deadline. A runtime that never answers used
    // to hold the launch, and the tick waiting on it, for the life of the
    // scope with nothing written down.
    const provided = yield* Runner
    const runner: RunnerService = {
      start: (input) => deadline(provided.start(input), startTimeout, `Runner.start for ${input.idempotencyKey}`),
      isActive: (runId) => deadline(provided.isActive(runId), inspectTimeout, `Runner.isActive for run ${runId}`),
      cancel: (runId) => deadline(provided.cancel(runId), cancelTimeout, `Runner.cancel for run ${runId}`)
    }

    // The watermark only moves forward, and only past occurrences this process
    // finished dispatching. Advancing it before the work is what silently lost
    // an occurrence whenever a claim or a dispatch failed.
    const observe = (triggerId: string, occurrence: number): Effect.Effect<void> =>
      Ref.update(observedAt, (current) => {
        const existing = current.get(triggerId)
        if (existing !== undefined && existing >= occurrence) return current
        return new Map(current).set(triggerId, occurrence)
      })

    // Every write to an entry is fenced on the occurrence that claimed it, so
    // one guard states the rule once: a launch that has been superseded, or
    // whose run already settled, no longer owns the entry and must not write to
    // it. Spelling the fence out at each site is how the three copies of it
    // drifted apart.
    const updateActive = (
      triggerId: string,
      occurrence: number,
      change: (entry: Active) => Active | undefined
    ): Effect.Effect<void> =>
      Ref.update(active, (current) => {
        const entry = current.get(triggerId)
        if (entry?.occurrence !== occurrence) return current
        const next = new Map(current)
        const updated = change(entry)
        if (updated === undefined) next.delete(triggerId)
        else next.set(triggerId, updated)
        return next
      })

    const removeActive = (triggerId: string, occurrence: number): Effect.Effect<void> =>
      updateActive(triggerId, occurrence, () => undefined)

    // A reservation is not a run: the Runner has never heard of it, and asking
    // answers "not active" for a launch that is still in flight. Its lease is
    // the only thing entitled to release it, in either branch.
    const stillRunning = (runId: string): Effect.Effect<boolean, TriggerError> =>
      isReservation(runId) ? Effect.succeed(true) : runner.isActive(runId)

    const occurrenceOf = (
      triggerId: string,
      runId: string
    ): Effect.Effect<number, TriggerError> => {
      const reserved = reservationOccurrence(runId)
      if (reserved !== undefined) return Effect.succeed(reserved)
      return store.activeOccurrence(triggerId, runId).pipe(
        Effect.map((occurrence) => Option.isSome(occurrence) ? occurrence.value : Number.NEGATIVE_INFINITY)
      )
    }

    // A recovered monitor cannot report the runtime's detailed terminal
    // status, but the same poll ending in this process records `completed`.
    // Recording that result also clears the matching active run atomically.
    const settleRecovered = (
      triggerId: string,
      occurrence: number,
      runId: string
    ): Effect.Effect<void, TriggerError> =>
      Number.isFinite(occurrence)
        ? store.recordResult({ triggerId, occurrence, outcome: "completed", runId })
        : store.clearActive(triggerId, runId)

    // The listed row already answers what the store would: with no run and no
    // reservation on it, `activeRun` reads an idle lease, writes nothing, and
    // answers `None`. Asking anyway cost one write transaction per trigger per
    // tick, on the tick where every trigger is idle.
    const storedActive = (
      triggerId: string,
      held: Held | undefined
    ): Effect.Effect<Option.Option<string>, TriggerError> =>
      held !== undefined && held.activeRunId === undefined
        ? Effect.succeed(Option.none())
        : store.activeRun(triggerId)

    const resolveActive = (
      trigger: Registered,
      held: Held | undefined
    ): Effect.Effect<Active | undefined, TriggerError> =>
      Effect.gen(function*() {
        const local = (yield* Ref.get(active)).get(trigger.id)
        if (local !== undefined) {
          // The finalizer detaches the fiber when monitoring ends. An entry
          // without a fiber was recovered or could no longer be inspected;
          // only the runtime can say whether that run is still going.
          if (local.fiber !== undefined) return local
          if (!isReservation(local.runId)) {
            if (yield* stillRunning(local.runId)) return local
            yield* settleRecovered(trigger.id, local.occurrence, local.runId)
            yield* removeActive(trigger.id, local.occurrence)
          } else {
            // A recovered reservation has no monitor that can remove it. Ask
            // the store on every tick so its lease can expire and re-arm the
            // occurrence instead of pinning this local cache forever.
            const stored = yield* storedActive(trigger.id, held)
            if (Option.isNone(stored)) {
              yield* removeActive(trigger.id, local.occurrence)
              return undefined
            }
            if (stored.value === local.runId) return local
            yield* removeActive(trigger.id, local.occurrence)
            const occurrence = yield* occurrenceOf(trigger.id, stored.value)
            if (!(yield* stillRunning(stored.value))) {
              yield* settleRecovered(trigger.id, occurrence, stored.value)
              return undefined
            }
            const recovered: Active = { occurrence, runId: stored.value }
            yield* Ref.update(active, (current) => new Map(current).set(trigger.id, recovered))
            return recovered
          }
        }
        const stored = yield* storedActive(trigger.id, held)
        if (Option.isNone(stored)) return undefined
        const occurrence = yield* occurrenceOf(trigger.id, stored.value)
        if (!(yield* stillRunning(stored.value))) {
          yield* settleRecovered(
            trigger.id,
            occurrence,
            stored.value
          )
          return undefined
        }
        const recovered: Active = {
          occurrence,
          runId: stored.value
        }
        yield* Ref.update(active, (current) => new Map(current).set(trigger.id, recovered))
        return recovered
      })

    const recordFailed = (
      trigger: Registered,
      occurrence: number,
      error: TriggerError,
      runId?: string | undefined
    ): Effect.Effect<void, TriggerError> =>
      store.recordResult({
        triggerId: trigger.id,
        occurrence,
        outcome: "failed",
        error: error.message,
        runId
      })

    // An inspection error is not evidence that a run stopped. Retry three
    // times, doubling the poll interval up to a minute, then let the next tick
    // inspect the durable owner again. Interruption must still close the scope.
    const inspectRun = (triggerId: string, runId: string): Effect.Effect<Option.Option<boolean>, TriggerError> =>
      Effect.gen(function*() {
        for (let attempt = 0;; attempt++) {
          const inspected = yield* runner.isActive(runId).pipe(
            Effect.map(Option.some),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause) ?
                Effect.failCause(cause) :
                Effect.logWarning("A trigger run inspection failed", cause).pipe(
                  Effect.annotateLogs({ triggerId, runId, attempt: String(attempt + 1) }),
                  Effect.as(Option.none<boolean>())
                )
            )
          )
          if (Option.isSome(inspected)) return inspected
          if (attempt === 3) {
            yield* Effect.logWarning("A trigger run monitor detached after inspection retries").pipe(
              Effect.annotateLogs({ triggerId, runId })
            )
            return Option.none<boolean>()
          }
          yield* Effect.sleep(Math.min(Duration.toMillis(runPollInterval) * 2 ** attempt, 60_000))
        }
      })

    const launch = (
      trigger: Registered,
      occurrence: number,
      reservation: string,
      preserveBuffered: boolean
    ): Effect.Effect<void, TriggerError> =>
      Effect.gen(function*() {
        let runId: string | undefined
        let launchRecorded = false
        let completed = false
        const started = yield* Deferred.make<void, TriggerError>()
        const lifecycle = Effect.gen(function*() {
          runId = yield* runner.start({
            flowId: trigger.flowId,
            input: trigger.input,
            idempotencyKey: idempotencyKey(trigger.id, occurrence)
          })
          const startedRunId = runId
          yield* updateActive(trigger.id, occurrence, (entry) => ({ ...entry, runId: startedRunId }))
          yield* store.recordResult({
            triggerId: trigger.id,
            occurrence,
            outcome: "launched",
            runId,
            reservationId: reservation
          })
          launchRecorded = true
          yield* Deferred.succeed(started, undefined)
          while (true) {
            const inspected = yield* inspectRun(trigger.id, runId)
            if (Option.isNone(inspected)) return
            if (!inspected.value) break
            yield* Effect.sleep(runPollInterval)
          }
          yield* store.recordResult({
            triggerId: trigger.id,
            occurrence,
            outcome: "completed",
            runId
          })
          completed = true
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function*() {
              if (launchRecorded) {
                yield* Effect.logWarning("A trigger run monitor could not persist completion", error).pipe(
                  Effect.annotateLogs({ triggerId: trigger.id, runId: runId! })
                )
                return
              }
              if (error.code === "stale_owner" && runId !== undefined) {
                yield* Effect.logWarning("A trigger launch lost its reservation", error).pipe(
                  Effect.annotateLogs({ triggerId: trigger.id, occurrence: String(occurrence) })
                )
                const losingRunId = runId
                yield* isolate(
                  { triggerId: trigger.id, runId },
                  "losing run reconciliation",
                  Effect.gen(function*() {
                    const held = yield* store.inspect(trigger.id)
                    // An idempotent retry may have committed this same run.
                    // An unfinished retry of the same occurrence will adopt it.
                    if (
                      held.activeRunId === losingRunId ||
                      (held.activeRunId !== undefined && reservationOccurrence(held.activeRunId) === occurrence)
                    ) return
                    yield* runner.cancel(losingRunId)
                  })
                ).pipe(Effect.ignore)
                yield* Deferred.succeed(started, undefined)
                return
              }
              if (!preserveBuffered) {
                // A start that answered too late is ambiguous: the runtime may
                // hold the run. Keep the occurrence pending exactly as when the
                // launched result failed to persist, so the next tick retries
                // under the same idempotency key and the runtime's durable
                // deduplication answers with the same run.
                if (runId !== undefined || error.code === "runner_timeout") {
                  yield* isolate(
                    { triggerId: trigger.id },
                    "launch compensation",
                    store.restorePending({
                      triggerId: trigger.id,
                      occurrence,
                      reservationId: reservation
                    })
                  ).pipe(Effect.ignore)
                } else {
                  yield* recordFailed(trigger, occurrence, error, reservation).pipe(Effect.ignore)
                }
              }
              // Buffered dispatch is compensated once by resumePending. Until
              // its atomic write commits the original lease stays recoverable.
              yield* Deferred.fail(started, error)
            })
          ),
          // Interrupting this fiber detaches the monitor; it never cancels the
          // run. The run is durable and outlives this process, so a deploy or
          // any other scope closure must leave it alone: the next incarnation
          // re-attaches through `resolveActive`. Cancellation is a deliberate
          // act and belongs to `cancelActive` alone.
          Effect.ensuring(Effect.suspend(() =>
            launchRecorded && !completed
              ? updateActive(trigger.id, occurrence, (entry) => ({ ...entry, fiber: undefined }))
              : removeActive(trigger.id, occurrence)
          ))
        )
        const fiber = yield* Effect.forkIn(
          Effect.scoped(lifecycle).pipe(
            // A defect or interruption before acknowledgement must reach the
            // waiting tick with its full cause and release the semaphore.
            Effect.onExit((exit) =>
              Effect.gen(function*() {
                yield* Deferred.done(started, exit)
                if (launchRecorded && exit._tag === "Failure" && !Cause.hasInterrupts(exit.cause)) {
                  yield* Effect.logWarning("A trigger run monitor failed", exit.cause).pipe(
                    Effect.annotateLogs({ triggerId: trigger.id, runId: runId! })
                  )
                }
              })
            )
          ),
          parentScope,
          { startImmediately: true }
        )
        // The monitor is recorded against the entry this occurrence claimed.
        // `startImmediately` can finish or detach before the fork returns.
        // Never attach a finished fiber to an entry awaiting tick recovery.
        if (fiber.pollUnsafe() === undefined) {
          yield* updateActive(trigger.id, occurrence, (entry) => ({ ...entry, fiber }))
        }
        yield* Deferred.await(started)
      })

    // Only a claim that named the run it is superseding gets here, so the run
    // id is known. The monitor, on the other hand, may not exist: the run can
    // belong to a scheduler this one only knows through the store. Cancelling
    // is a deliberate act and happens here alone; a reservation has no run for
    // the runtime to cancel, and an occurrence this process never saw has none
    // of its own to record the supersession against.
    const cancelActive = (
      trigger: Registered,
      prior: Active,
      replacementOccurrence: number,
      replacementReservation: string,
      queueReplacement: boolean
    ): Effect.Effect<void, TriggerError> =>
      Effect.gen(function*() {
        if (!isReservation(prior.runId)) {
          yield* runner.cancel(prior.runId).pipe(
            Effect.catch((error) => {
              // The claim already replaced the prior run with the new launch
              // reservation. If cancellation fails, restore that run as active
              // and queue the replacement so neither side of the hand-off is
              // lost. Keep its monitor attached: it is still running.
              const restore = queueReplacement
                ? isolate(
                  { triggerId: trigger.id },
                  "supersede compensation",
                  store.restorePending({
                    triggerId: trigger.id,
                    occurrence: replacementOccurrence,
                    reservationId: replacementReservation
                  })
                )
                : Effect.void
              return restore.pipe(
                Effect.andThen(Effect.fail(error))
              )
            })
          )
        }
        if (Number.isFinite(prior.occurrence) && !isReservation(prior.runId)) {
          yield* store.recordResult({
            triggerId: trigger.id,
            occurrence: prior.occurrence,
            outcome: "superseded",
            runId: prior.runId
          })
        }
        // Keep the monitor attached until the terminal write succeeds. If the
        // store refuses it after cancellation, the monitor can still observe
        // the stopped run and record a terminal result on its next poll.
        if (prior.fiber !== undefined) yield* Fiber.interrupt(prior.fiber)
        yield* removeActive(trigger.id, prior.occurrence)
      })

    const dispatchClaimed = (
      trigger: Registered,
      occurrence: number,
      claim: Exclude<Claim, { readonly claimed: false }>,
      resumeBuffered = false
    ): Effect.Effect<void, TriggerError> =>
      Effect.gen(function*() {
        switch (claim.action) {
          case "fire":
            yield* Ref.update(
              active,
              (current) =>
                new Map(current).set(trigger.id, {
                  occurrence,
                  runId: claim.reservationId
                })
            )
            yield* launch(trigger, occurrence, claim.reservationId, resumeBuffered)
            return
          case "skip":
            yield* store.recordResult({
              triggerId: trigger.id,
              occurrence,
              outcome: "skipped"
            })
            return
          case "buffer":
            yield* store.recordResult({
              triggerId: trigger.id,
              occurrence,
              outcome: "buffered"
            })
            return
          case "supersede": {
            const superseded = claim.activeRunId
            if (superseded !== undefined) {
              const local = (yield* Ref.get(active)).get(trigger.id)
              yield* cancelActive(
                trigger,
                local !== undefined && local.runId === superseded
                  ? { ...local, runId: superseded }
                  : {
                    occurrence: yield* occurrenceOf(trigger.id, superseded),
                    runId: superseded
                  },
                occurrence,
                claim.reservationId,
                !resumeBuffered
              )
            }
            yield* Ref.update(
              active,
              (current) =>
                new Map(current).set(trigger.id, {
                  occurrence,
                  runId: claim.reservationId
                })
            )
            yield* launch(trigger, occurrence, claim.reservationId, resumeBuffered)
            return
          }
        }
      })

    const claimOnce = (
      trigger: Registered,
      occurrence: number
    ): Effect.Effect<void, TriggerError> =>
      store.claimFire({
        triggerId: trigger.id,
        occurrence,
        expectedRevision: trigger.revision
      }).pipe(
        Effect.flatMap((claim) => claim.claimed ? dispatchClaimed(trigger, occurrence, claim) : Effect.void)
      )

    // A claim is fenced on the revision its occurrence was computed from. One
    // refresh and one retry is enough because the next tick reads again.
    const withRevisionRefresh = <A>(
      trigger: Registered,
      claim: (current: Registered) => Effect.Effect<A, TriggerError>
    ): Effect.Effect<A, TriggerError> =>
      claim(trigger).pipe(
        Effect.catch((error) =>
          error.code !== "revision_mismatch"
            ? Effect.fail(error)
            : store.get(trigger.id).pipe(
              Effect.flatMap((refreshed) =>
                Option.isNone(refreshed) || refreshed.value.revision === trigger.revision
                  ? Effect.fail(error)
                  : claim(refreshed.value)
              )
            )
        )
      )

    // The store reads, claims, and clears a buffer in one transaction. A
    // dispatch failure happens after that commit, so this process can safely
    // re-arm the occurrence before it reports the failure.
    const resumePending = (trigger: Registered, held?: Held): Effect.Effect<void, TriggerError> =>
      // A listed row holding neither a buffered occurrence nor a run has
      // nothing for `claimPending` to take: only expiring a reservation
      // re-arms a pending occurrence, and there is no reservation to expire.
      held !== undefined && held.pendingAt === undefined && held.activeRunId === undefined
        ? Effect.void
        : withRevisionRefresh(trigger, (current) =>
          store.claimPending({
            triggerId: current.id,
            expectedRevision: current.revision
          }).pipe(
            Effect.flatMap((pending) => {
              if (Option.isNone(pending)) return Effect.void
              const occurrence = pending.value.occurrence
              const claim = pending.value.claim
              if (!claim.claimed) return Effect.void
              return dispatchClaimed(
                current,
                occurrence,
                claim,
                true
              ).pipe(
                Effect.onError(() =>
                  isolate(
                    { triggerId: current.id },
                    "buffered launch compensation",
                    claim.action === "fire" || claim.action === "supersede"
                      ? store.restorePending({ triggerId: current.id, occurrence, reservationId: claim.reservationId })
                      : store.setPending({ triggerId: current.id, occurrence })
                  ).pipe(Effect.ignore)
                )
              )
            })
          ))

    // A bound the declaration cannot honour is a statement about how much
    // history to replay, not a reason to stop scheduling: the backlog beyond
    // the bound is abandoned, loudly, and the current occurrence still fires.
    const withinBound = (
      triggerId: string,
      owed: Effect.Effect<ReadonlyArray<Date>, TriggerError>
    ): Effect.Effect<ReadonlyArray<Date>, TriggerError> =>
      Effect.catch(owed, (error) =>
        error.code === "catch_up_bound_exceeded"
          ? Effect.as(
            Effect.annotateLogs(
              Effect.logWarning("A trigger abandoned catch-up work beyond its bound", error),
              { triggerId }
            ),
            [] as ReadonlyArray<Date>
          )
          : Effect.fail(error))

    const dueOccurrences = (
      trigger: Registered,
      now: number
    ): Effect.Effect<Due, TriggerError> =>
      Effect.gen(function*() {
        const cron = yield* Cron.parse(trigger.cron, trigger.timezone)
        const observed = (yield* Ref.get(observedAt)).get(trigger.id)
        const current = (yield* Cron.previousAtOrBefore(cron, new Date(now))).getTime()
        if (observed === undefined) {
          // First sight of this trigger in this process. A trigger that has
          // never fired starts from here rather than from whatever occurrence
          // last passed: registering a weekly trigger on a Sunday evening owes
          // nothing for the Monday six days gone, which is what `catchUp` says.
          if (trigger.lastFiredAt === undefined) return { occurrences: [], watermark: current }
          const owed = yield* withinBound(
            trigger.id,
            CatchUp.occurrences(
              trigger.catchUp,
              trigger.maxCatchUp,
              new Date(trigger.lastFiredAt),
              new Date(now),
              cron
            )
          )
          return { occurrences: owed.map((occurrence) => occurrence.getTime()), watermark: current }
        }
        if (current <= observed) return { occurrences: [], watermark: observed }
        const backlog = yield* withinBound(
          trigger.id,
          CatchUp.occurrences(
            trigger.catchUp,
            trigger.maxCatchUp,
            new Date(observed),
            new Date(current - 1),
            cron
          )
        )
        return {
          occurrences: [...backlog.map((occurrence) => occurrence.getTime()), current],
          watermark: current
        }
      })

    const processTrigger = (
      trigger: Registered,
      held: Held | undefined,
      refreshed = false
    ): Effect.Effect<void, TriggerError> =>
      Effect.gen(function*() {
        // Each trigger reads the clock itself. One instant captured before the
        // tick fanned out aged by every launch that finished ahead of it.
        const now = yield* Clock.currentTimeMillis
        const running = yield* resolveActive(trigger, held)
        // Disable prevents future claims, not recovery of an already active
        // occurrence (including a plan waiting for a human decision).
        if (!trigger.enabled) return
        if (running === undefined || trigger.overlap === "supersede") yield* resumePending(trigger, held)
        const due = yield* dueOccurrences(trigger, now)
        let dispatched: number | undefined
        let interrupted = false
        let stale = false
        for (const occurrence of due.occurrences) {
          const settledHere = yield* attempted(
            { triggerId: trigger.id },
            `dispatch of occurrence ${occurrence}`,
            claimOnce(trigger, occurrence).pipe(
              Effect.catch((error) =>
                error.code === "revision_mismatch"
                  ? Effect.sync(() => {
                    stale = true
                  })
                  : Effect.fail(error)
              )
            )
          )
          if (stale) break
          if (settledHere && !interrupted) dispatched = occurrence
          if (!settledHere) interrupted = true
        }
        if (stale) {
          // The occurrences were computed from a declaration the store has
          // since replaced, so the schedule decision is what went stale: a
          // trigger edited to fire at noon owes nothing for the hourly
          // boundary its old cron produced. Keep the boundary already
          // dispatched, re-read once, and decide again from the refreshed cron
          // and watermark. A second mismatch waits for the next tick, which
          // reads again anyway. A buffered occurrence is store state rather
          // than a computed decision, so `resumePending` retries it as is.
          if (dispatched !== undefined) yield* observe(trigger.id, dispatched)
          if (refreshed) return
          const current = yield* store.get(trigger.id)
          if (Option.isNone(current) || current.value.revision === trigger.revision) return
          // The refreshed declaration comes from the store, not the listing,
          // so the held snapshot no longer describes it.
          return yield* processTrigger(current.value, undefined, true)
        }
        if (!interrupted) return yield* observe(trigger.id, due.watermark)
        if (dispatched !== undefined) yield* observe(trigger.id, dispatched)
      })

    const host = options.host ?? defaultHost

    const runOnce = semaphore.withPermits(1)(
      Effect.gen(function*() {
        // The heartbeat is observability, not dispatch: a store that cannot
        // record it is logged and the tick goes on, so a listing's "nothing is
        // listening" can never be caused by the row that reports it.
        yield* isolate({ host }, "heartbeat", store.heartbeat(host))
        // Every trigger, not only the enabled ones: a disabled trigger can
        // still hold an active occurrence that has to recover, and the enabled
        // check below it stops the new claims.
        const listing = yield* store.list()
        // Triggers are independent once claimed: the store fences each claim
        // on its own row. Walking them in series let one launch waiting on a
        // parked plan hold every trigger after it for the whole wait. A row
        // the store could not decode is one more isolated failure, so one
        // corrupt declaration cannot stop the healthy schedules beside it.
        yield* Effect.forEach(
          listing,
          (row) =>
            isolate(
              { triggerId: row.triggerId },
              "tick",
              Result.isFailure(row.trigger)
                ? Effect.fail(row.trigger.failure)
                : processTrigger(row.trigger.success, row)
            ),
          { concurrency, discard: true }
        )
      })
    )

    return Scheduler.of({ runOnce })
  })

/**
 * Constructs a scheduler that performs no work.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (): Service => Scheduler.of({ runOnce: Effect.void })

/**
 * Scoped scheduler layer. Its supervisor sleeps only through the Effect Clock,
 * so scope closure interrupts the poll loop and detaches every run monitor.
 * Detaching is all it does: the runs themselves are durable and keep going,
 * and the next incarnation re-attaches to them from the store.
 *
 * The loop recovers from the whole cause rather than the typed error alone. A
 * defect raised anywhere under a tick, which `Effect.catch` by contract leaves
 * alone, would otherwise kill this fiber and stop every trigger in the process
 * with nothing written down.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options = {}
): Layer.Layer<Scheduler, TriggerError, Runner | TriggerStore> =>
  Layer.effect(
    Scheduler,
    Effect.gen(function*() {
      const scheduler = yield* make(options)
      const pollInterval = yield* duration(options.pollInterval ?? "1 minute", "pollInterval")
      yield* Effect.forkScoped(
        Effect.forever(
          scheduler.runOnce.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("A trigger scheduler tick failed", cause)
            ),
            Effect.andThen(Effect.sleep(pollInterval))
          )
        )
      )
      return scheduler
    })
  )

/**
 * Provides an inert scheduler without allocating a supervisor fiber.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Scheduler> = Layer.succeed(Scheduler)(makeNoop())
