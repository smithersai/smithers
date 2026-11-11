import { digestSync } from "@smthrs/crypto"
import { DurableWriter } from "@smthrs/database"
import { Action, Flow, Interpreter, RetryPolicy, Sleep } from "@smthrs/flow"
import { GitHub } from "@smthrs/integrations"
import { Node } from "@smthrs/plan"
import { Scheduler, SqlTriggerStore, Trigger, TriggerError, TriggerStore } from "@smthrs/triggers"
import { Cause, Duration, Effect, Layer, Metric, Option, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"
import * as Flows from "../Flows.ts"
import * as RepoRuns from "../RepoRuns.ts"
import * as Dispatch from "./Dispatch.ts"
import * as RepoFlow from "./RepoFlow.ts"
import * as Triggers from "./Triggers.ts"

// A repository's schedules (docs/features/ci.md#schedules): the `cron` rows of its `.smithers/factory.json` start its
// flows on time through `@smthrs/triggers`, on Cloudflare, with no process between ticks.
//
//   triggers/Sync   a push to the default branch (worker/github/Api.ts), `triggers/sync:<delivery>`:
//                   triggers/Register  the default branch's cron rows of active flows, registered in the trigger store;
//                                      the repository's stored triggers the manifest no longer has, disabled
//   triggers/Tick   one per minute window, `triggers/tick:<from>`, started by every FlowExecution alarm (`ticker`):
//                   triggers/Since     the last tick's instant, from the store's heartbeat
//                   triggers/Fire      `Scheduler.tick` from it: each due occurrence starts `repo/Run` (`runner`)
//                   then a durable sleep to the window's end, whose alarm starts the next window's tick
//
// Triggers come from the default branch only, as a push's or a pull request's do (worker/ci/Dispatch.ts), so a change
// can't schedule itself. The store keeps `@smthrs/triggers`' tables in their own schema (`TRIGGERS_SCHEMA`), apart from
// the app's migrations and the engine's. Records carry ids, names and outcomes, never a payload.

/** The Postgres schema the trigger store keeps its tables in, beside the engine's and the app's. */
export const TRIGGERS_SCHEMA = "smithers_triggers"

/** The host name every tick records its heartbeat under. */
export const HOST = "cloudflare"

/** How long one tick waits for one run to start before it leaves the occurrence pending for the next. */
export const START_TIMEOUT = Duration.seconds(30)

/** One tick a minute: the tightest schedule cron can say. */
export const WINDOW = Duration.minutes(1)

/**
 * The trigger store over `database`, a client on `TRIGGERS_SCHEMA` (worker/ExecutionHost.ts `database`): every write
 * through the durable writer. Building it applies the package's migrations.
 */
export const storeOn = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  SqlTriggerStore.layer.pipe(Layer.provide(DurableWriter.layer().pipe(Layer.provideMerge(database))))

/** A default-branch push's sync: its delivery and the repository. */
export const SyncRequest = Schema.Struct({
  delivery: Dispatch.DispatchRequest.fields.delivery,
  repo: Dispatch.DispatchRequest.fields.repo,
  defaultBranch: Dispatch.DispatchRequest.fields.defaultBranch,
})
export type SyncRequest = typeof SyncRequest.Type

/** The sync a dispatch asks for: a push to the repository's default branch; none for anything else. */
export const syncRequestOf = (request: Dispatch.DispatchRequest): Option.Option<SyncRequest> =>
  request.event === "push" && request.branch === request.defaultBranch
    ? Option.some({ delivery: request.delivery, repo: request.repo, defaultBranch: request.defaultBranch })
    : Option.none()

/** A sync's execution id: one per delivery, apart from its `triggers/dispatch:<delivery>`. */
export const syncExecutionId = (delivery: string): string => `triggers/sync:${delivery}`

/** A minute window's tick. */
export const tickExecutionId = (window: Flows.Window): string => `triggers/tick:${window.from}`

/** What a registered trigger's `input` holds: the run it starts. */
export const ScheduledRun = Schema.Struct({
  repo: Dispatch.DispatchRequest.fields.repo,
  flow: Schema.String.check(Schema.isPattern(RepoFlow.FLOW_NAME)),
  defaultBranch: Dispatch.DispatchRequest.fields.defaultBranch,
  cron: Schema.String,
  timezone: Schema.optionalKey(Schema.String),
})
export type ScheduledRun = typeof ScheduledRun.Type
const decodeScheduledRun = Schema.decodeUnknownOption(ScheduledRun)

/** A schedule row's trigger id: `<owner/name, lower case>#<flow>#<cron>#<timezone or empty>`. */
export const triggerId = (repo: string, row: Pick<Triggers.CronTrigger, "flow" | "cron" | "timezone">): string =>
  `${repo.toLowerCase()}#${row.flow}#${row.cron}#${row.timezone ?? ""}`

/** The occurrence `idempotencyKey` names (`<trigger id>:<ISO instant>`, `Scheduler.idempotencyKey`), as `YYYYMMDDTHHMMZ`. */
const occurrenceOf = (idempotencyKey: string): Option.Option<{ readonly triggerId: string; readonly stamp: string }> => {
  const iso = idempotencyKey.slice(-24)
  const at = new Date(iso)
  if (idempotencyKey.length < 26 || Number.isNaN(at.getTime()) || at.toISOString() !== iso) return Option.none()
  const stamp = iso.slice(0, 16).replace(/[-:]/g, "") + "Z"
  return Option.some({ triggerId: idempotencyKey.slice(0, -25), stamp })
}

/**
 * A scheduled run's execution id: one per trigger and occurrence, `<flow>:cron-<16 hex of the trigger id's SHA-256>-
 * <occurrence>`, so every tick that starts the same occurrence starts the same run.
 */
export const runExecutionId = (flow: string, trigger: string, stamp: string): string =>
  Dispatch.runExecutionId(flow, `cron-${digestSync(trigger).slice(0, 16)}-${stamp}`)

/** GitHub, Postgres or the store couldn't answer, or a tick left a trigger undispatched: retried. */
export class ScheduleUnavailable extends Schema.TaggedError<ScheduleUnavailable>()(
  "@smthrs/mvp/ci/ScheduleUnavailable",
  { reason: Schema.Literals(["unavailable", "unclean"]) },
) {}

/** A tick's retries, inside its own minute: 1 s doubling to 8 s, five attempts. */
export const TICK_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 8_000, maxAttempts: 5 })

/** What `triggers/Register` did. */
export const Registered = Schema.Struct({
  outcome: Schema.Literals(["registered", "unreadable", "not_allowed"]),
  registered: Schema.Int,
  unchanged: Schema.Int,
  disabled: Schema.Int,
  refused: Schema.Int,
})
export type Registered = typeof Registered.Type

export const Register = Action.make("triggers/Register", {
  payload: { request: SyncRequest },
  success: Registered,
  error: ScheduleUnavailable,
  retryPolicy: Dispatch.RETRY,
})

/** `triggers/Sync`: a repository's schedules, as its default branch declares them. */
export const Sync = Flow.make("triggers/Sync", {
  description: "Register a repository's cron triggers from its default branch's .smithers/factory.json, and disable " +
    "the ones it no longer declares.",
  modelInvocable: false,
  payload: SyncRequest,
  success: Registered,
  error: ScheduleUnavailable,
  body: Node.capture({ register: Register.name }, (request: SyncRequest) => Register.call({ request })),
})

const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** One minute window, as `Flows.startEachWindow` gives it. */
const window = { from: nonNegative, until: Schema.Int.check(Schema.isGreaterThan(0)) }

export const Since = Action.make("triggers/Since", {
  payload: { from: nonNegative },
  success: Schema.NullOr(nonNegative),
  error: ScheduleUnavailable,
  retryPolicy: TICK_RETRY,
})

/** What one tick answered: when it read the clock, and what the next tick may start from. */
export const Fired = Schema.Struct({ at: nonNegative, watermark: nonNegative })
export type Fired = typeof Fired.Type

export const Fire = Action.make("triggers/Fire", {
  payload: { from: nonNegative, since: Schema.NullOr(nonNegative) },
  success: Fired,
  error: ScheduleUnavailable,
  retryPolicy: TICK_RETRY,
})

/**
 * `triggers/Tick { from, until }`: one tick of every repository's schedules, from where the last one stopped, then a
 * durable sleep to the window's end. The alarm that ends the sleep starts the next window's tick.
 */
export const Tick = Flow.make("triggers/Tick", {
  description: "Start every repository flow whose cron schedule came due since the last tick, then sleep to the end " +
    "of the minute.",
  modelInvocable: false,
  payload: window,
  success: Schema.Void,
  error: Schema.Union([ScheduleUnavailable, Sleep.SleepRequestInvalid]),
  body: Node.capture({ since: Since.name, fire: Fire.name }, ({ from, until }: Flows.Window) =>
    Since.call({ from }).pipe(
      Node.bindPlanned(Node.capture(
        { fire: Fire.name, from },
        function(this: { readonly from: number }, since) {
          return Fire.call({ from: this.from, since })
        },
      )),
      Node.andThen(Sleep.action.call({ until })),
    )),
})

/** Sync deliveries, by `outcome` (`registered`, `unreadable`, `not_allowed`). */
export const registrations = Metric.counter("smithers_ci_schedule_registrations", {
  description: "Default-branch pushes whose cron triggers were registered, by outcome",
  incremental: true,
})

/** Ticks, by `outcome`: `clean`, `unclean` (retried), `failed`, and `not_started` when an alarm couldn't start one. */
export const ticks = Metric.counter("smithers_ci_schedule_ticks", {
  description: "Scheduler ticks of repositories' cron triggers, by outcome",
  incremental: true,
})

/** Scheduled runs, by `outcome`: `started`, `not_allowed`, `refused` and `unavailable`. */
export const starts = Metric.counter("smithers_ci_schedule_starts", {
  description: "Repository flow runs cron triggers started, by outcome",
  incremental: true,
})

/** What schedules need: dispatching's services, the trigger store, and how a run's execution is cancelled. */
export interface Services<E, R> extends Dispatch.Services<E, R> {
  /** The trigger store (`storeOn`). */
  readonly store: Layer.Layer<TriggerStore.TriggerStore, unknown, R>
  /** Stops a run's execution, as Stop does: an `overlap: "supersede"` schedule's predecessor. */
  readonly cancel: (executionId: string) => Effect.Effect<void, unknown>
}

/** A trigger's declaration, without what the store adds: what registering it again writes. */
const declarationOf = (trigger: Trigger.Trigger): Trigger.Trigger => ({
  id: trigger.id,
  flowId: trigger.flowId,
  input: trigger.input,
  cron: trigger.cron,
  ...(trigger.timezone === undefined ? {} : { timezone: trigger.timezone }),
  overlap: trigger.overlap,
  catchUp: trigger.catchUp,
  maxCatchUp: trigger.maxCatchUp,
  enabled: trigger.enabled,
})

const sameDeclaration = (left: Trigger.Trigger, right: Trigger.Trigger) =>
  JSON.stringify(declarationOf(left)) === JSON.stringify(declarationOf(right))

const runnerError = (message: string, code: "runner" | "runner_unavailable" = "runner") =>
  new TriggerError.TriggerError({ code, message })

/**
 * The runs a tick starts: `repo/Run` at the default branch's head, as the App, recorded as `schedule` runs. A start
 * GitHub, Postgres or the host couldn't make now fails `runner_unavailable`, so the occurrence waits for the next tick.
 */
export const runner = <E, R>(services: Services<E, R>): Effect.Effect<Scheduler.RunnerService, never, R> => {
  const record = (outcome: "started" | "not_allowed" | "refused" | "unavailable", fields: Record<string, string>) =>
    Effect.andThen(
      Metric.update(Metric.withAttributes(starts, { outcome }), 1),
      Effect.logWithLevel(outcome === "started" ? "Info" : "Warn")("ci.schedule.start").pipe(
        Effect.annotateLogs({ ...fields, outcome }),
      ),
    )
  const start = ({ input, idempotencyKey }: Scheduler.StartInput) =>
    Effect.gen(function* () {
      const scheduled = decodeScheduledRun(input)
      const occurrence = occurrenceOf(idempotencyKey)
      if (Option.isNone(scheduled) || Option.isNone(occurrence)) {
        yield* record("refused", { reason: "input" })
        return yield* runnerError("The trigger's input names no scheduled run")
      }
      const { repo, flow, defaultBranch, cron } = scheduled.value
      const executionId = runExecutionId(flow, occurrence.value.triggerId, occurrence.value.stamp)
      const fields = { repo, flow, executionId }
      if (!services.repositories.has(repo.toLowerCase())) {
        yield* record("not_allowed", fields)
        return yield* runnerError("The repository's flows aren't allowed")
      }
      // A start tried again runs at the commit the first recorded; a new one at the default branch's head now.
      const recorded = yield* RepoRuns.recordedSha(executionId)
      const sha = Option.isSome(recorded) ? Option.some(recorded.value) : yield* Effect.gen(function* () {
        const app = yield* Dispatch.asApp(services, repo)
        if (Option.isNone(app)) return Option.none<string>()
        const head = yield* app.value.call(GitHub.Refs.getBranch(app.value.repository.owner, app.value.repository.name, defaultBranch))
        return Option.map(head, (branch) => branch.sha)
      })
      if (Option.isNone(sha)) {
        yield* record("refused", fields)
        return yield* runnerError("The App can't read the repository's default branch")
      }
      const ref = `refs/heads/${defaultBranch}`
      const payload: RepoFlow.RunRequest = {
        run: executionId, repo, flow, sha: sha.value, ref, event: "schedule", secrets: true, input: { schedule: cron },
      }
      yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(RepoRuns.record({
        execution: executionId, repoId: `github/${repo.toLowerCase()}`, flow, sha: sha.value, ref, event: "schedule",
        launchedBy: "github",
      }).pipe(Effect.andThen(services.start(RepoFlow.Run, { executionId, payload })))))
      yield* record("started", fields)
      return executionId
    }).pipe(
      Effect.provide(services.database),
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        return error instanceof TriggerError.TriggerError
          ? Effect.fail(error)
          : Effect.andThen(
            record("unavailable", { errorCode: codeOf(error) }),
            Effect.fail(runnerError("GitHub, Postgres or the host couldn't start the run", "runner_unavailable")),
          )
      }),
      Effect.withSpan("ci.schedule.start"),
    )
  const inspect = (runId: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly status: string }>`
      SELECT status FROM runs WHERE execution = ${runId}`).pipe(
      Effect.map((rows): Scheduler.RunState => {
        const status = rows[0]?.status
        return status === undefined ? "missing"
          : status === "done" ? "completed"
          : status === "failed" ? "failed"
          : status === "stopped" ? "cancelled"
          : "active"
      }),
      Effect.provide(services.database),
      Effect.mapError(() => runnerError("Postgres couldn't read the run")),
      Effect.withSpan("ci.schedule.inspect"),
    )
  const cancel = (runId: string) =>
    services.cancel(runId).pipe(
      Effect.mapError(() => runnerError("The host couldn't stop the run")),
      Effect.withSpan("ci.schedule.cancel"),
    )
  return Effect.map(Effect.context<R>(), (context) =>
    Scheduler.makeRunner({
      start: (input) => Effect.provide(start(input), context),
      inspect: (runId) => Effect.provide(inspect(runId), context),
      cancel,
    }))
}

/** The steps over `services`. */
export const steps = <E, R>(services: Services<E, R>) => {
  const register = ({ request }: typeof Register.payloadSchema.Type) =>
    Effect.gen(function* () {
      const repo = request.repo.toLowerCase()
      const none = { registered: 0, unchanged: 0, disabled: 0, refused: 0 }
      if (!services.repositories.has(repo)) return { outcome: "not_allowed", ...none } satisfies Registered
      const app = yield* Dispatch.asApp(services, request.repo)
      if (Option.isNone(app)) return { outcome: "unreadable", ...none } satisfies Registered
      const manifest = yield* app.value.read(Triggers.MANIFEST_PATH, request.defaultBranch)
      const rows = Option.match(manifest, { onNone: () => [], onSome: Triggers.schedulesOf })
      // As a push's: a flow is active once its flow.ts is on the default branch.
      const active = new Set<string>()
      for (const flow of new Set(rows.map((row) => row.flow))) {
        if (Option.isSome(yield* app.value.read(RepoFlow.flowPath(flow), request.defaultBranch))) active.add(flow)
      }
      const wanted = new Map<string, Trigger.Trigger>()
      let refused = 0
      for (const row of rows) {
        const id = triggerId(repo, row)
        if (!active.has(row.flow) || wanted.has(id)) continue
        const input: ScheduledRun = {
          repo: request.repo,
          flow: row.flow,
          defaultBranch: request.defaultBranch,
          cron: row.cron,
          ...(row.timezone === undefined ? {} : { timezone: row.timezone }),
        }
        const made = yield* Effect.result(Trigger.make({
          id, flowId: row.flow, input, cron: row.cron, ...(row.timezone === undefined ? {} : { timezone: row.timezone }),
          overlap: row.overlap, catchUp: row.catchUp, maxCatchUp: row.maxCatchUp, enabled: true,
        }))
        if (Result.isFailure(made)) {
          refused++
          yield* Effect.logWarning("ci.schedule.refused").pipe(
            Effect.annotateLogs({ delivery: request.delivery, repo, flow: row.flow, errorCode: made.failure.code }),
          )
          continue
        }
        wanted.set(id, made.success)
      }
      const store = yield* TriggerStore.TriggerStore
      const stored = new Map((yield* store.list()).flatMap((listed) =>
        listed.triggerId.startsWith(`${repo}#`) && Result.isSuccess(listed.trigger)
          ? [[listed.triggerId, listed.trigger.success] as const]
          : []
      ))
      let registered = 0
      let unchanged = 0
      let disabled = 0
      for (const [id, trigger] of wanted) {
        const prior = stored.get(id)
        if (prior !== undefined && sameDeclaration(prior, trigger)) unchanged++
        else {
          yield* store.register(trigger)
          registered++
        }
      }
      // The store keeps every trigger it was given: one the manifest dropped stays, disabled.
      for (const [id, prior] of stored) {
        if (wanted.has(id) || !prior.enabled) continue
        yield* store.register({ ...declarationOf(prior), enabled: false })
        disabled++
      }
      return { outcome: "registered", registered, unchanged, disabled, refused } satisfies Registered
    }).pipe(
      Effect.provide(Layer.merge(services.database, services.store)),
      Effect.mapError(() => new ScheduleUnavailable({ reason: "unavailable" })),
      Effect.tap((done) =>
        Effect.andThen(
          Metric.update(Metric.withAttributes(registrations, { outcome: done.outcome }), 1),
          Effect.logInfo("ci.schedule.register").pipe(Effect.annotateLogs({
            delivery: request.delivery,
            repo: request.repo,
            outcome: done.outcome,
            registered: done.registered,
            unchanged: done.unchanged,
            disabled: done.disabled,
            refused: done.refused,
          })),
        )
      ),
      Effect.withSpan("ci.schedule.register", { attributes: { "smithers.ci.delivery": request.delivery } }),
    )

  const since = ({ from }: typeof Since.payloadSchema.Type) =>
    Effect.flatMap(TriggerStore.TriggerStore, (store) => store.lastHeartbeat()).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: (beat) => beat.tickedAt })),
      Effect.provide(services.store),
      Effect.mapError(() => new ScheduleUnavailable({ reason: "unavailable" })),
      Effect.tap((at) =>
        Effect.logInfo("ci.schedule.since").pipe(Effect.annotateLogs({ from, since: at === null ? "none" : at }))
      ),
      Effect.withSpan("ci.schedule.since", { attributes: { "smithers.ci.window": from } }),
    )

  const fire = ({ from, since }: typeof Fire.payloadSchema.Type) =>
    Effect.flatMap(runner(services), (built) =>
      Scheduler.tick({ since: since ?? undefined, host: HOST, startTimeout: START_TIMEOUT }).pipe(
        Effect.provideService(Scheduler.Runner, built),
      )).pipe(
      Effect.provide(services.store),
      Effect.mapError(() => new ScheduleUnavailable({ reason: "unavailable" })),
      // A trigger that didn't finish dispatching: the same interval again, which the claim protocol keeps to once.
      Effect.filterOrFail(
        (ticked) => ticked.watermark >= ticked.at,
        () => new ScheduleUnavailable({ reason: "unclean" }),
      ),
      Effect.tapCause((cause) => {
        const error = Cause.squash(cause)
        const outcome = error instanceof ScheduleUnavailable && error.reason === "unclean" ? "unclean" : "failed"
        return Effect.andThen(
          Metric.update(Metric.withAttributes(ticks, { outcome }), 1),
          Effect.logWarning("ci.schedule.tick").pipe(Effect.annotateLogs({ from, outcome })),
        )
      }),
      Effect.tap((ticked) =>
        Effect.andThen(
          Metric.update(Metric.withAttributes(ticks, { outcome: "clean" }), 1),
          Effect.logInfo("ci.schedule.tick").pipe(Effect.annotateLogs({ from, outcome: "clean", at: ticked.at })),
        )
      ),
      Effect.map((ticked) => ({ at: ticked.at, watermark: ticked.watermark })),
      Effect.withSpan("ci.schedule.fire", { attributes: { "smithers.ci.window": from } }),
    )

  return { register, since, fire }
}

/** Registers `triggers/Sync` and `triggers/Tick` over `services`. */
export const registration = <E, R>(services: Services<E, R>) => {
  const implementation = steps(services)
  return Layer.mergeAll(
    Interpreter.layerWithImplementations(Sync, Register.toLayer(implementation.register)),
    Interpreter.layerWithImplementations(
      Tick,
      Layer.merge(Since.toLayer(implementation.since), Fire.toLayer(implementation.fire)),
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}

/**
 * Returns what each `FlowExecution` alarm runs once it is done (worker/Executions.ts): it starts the current minute's
 * `triggers/Tick` through `FlowStarter`, once a window in this isolate (`Flows.startEachWindow`). A start the host can't
 * record is an Error `ci.schedule.tick` line and a count, `not_started`; the next alarm starts it again.
 */
export const ticker = Flows.startEachWindow(
  WINDOW,
  (window) => ({ flow: Tick, executionId: tickExecutionId(window), payload: window }),
  (errorCode) =>
    Effect.andThen(
      Metric.update(Metric.withAttributes(ticks, { outcome: "not_started" }), 1),
      Effect.logError("ci.schedule.tick").pipe(Effect.annotateLogs({ outcome: "not_started", errorCode })),
    ),
)
