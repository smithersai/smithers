import { AgentRunner } from "@smthrs/agent"
import { Cause, Effect, Layer, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"
import * as Fleet from "./Fleet.ts"
import * as Overflow from "./Overflow.ts"

// The host's job store on Postgres (decision 0136, docs/features/agent-runners.md#the-job-store): `@smthrs/agent`'s
// `AgentRunner.AgentJobs` port, which an external agent's step (`ExternalAgent`) drives. `agent_jobs` is the external
// system that step waits on durably: `start` queues one generation, the runner routes (worker/runners/Api.ts) claim,
// heartbeat and settle it, and `status` reads how it stands. Each operation is one transaction; none retries, sleeps or
// starts anything. The store owns the agent's own limits, its hours and its restarts, so the step needs neither. A
// runner that stops answering keeps its job: a missing heartbeat doesn't prove its agent stopped, so the job reads
// Running until the runner comes back or the agent's hours are up. Nothing here logs a task.
//
// The store also keeps the fleet's projection, `agent_runs` (worker/runners/Fleet.ts, docs/features/fleet.md), under
// the job's own key: `start` queues the run in its transaction, `cancel` marks it Stopping, and each `status`, the
// step's parked probe, projects the job and starts the alerts that came due through `alerts.raise`.
//
// With `wake`, the probe also wakes the repository's overflow box (decision 0144, worker/runners/Overflow.ts) when a
// queued job has waited past its overflow's `minQueuedSeconds` and the overflow runner isn't awake. The box's wake goes
// through the sandbox admission, so the awake cap and the spend alert hold; a wake that can't happen now is logged, and
// the next probe asks again.

/** Job store operations, by `op` (`start`, `status`, `cancel`, `stop`) and `outcome`. */
export const operations = Metric.counter("smithers_agent_jobs", {
  description: "Agent job store operations, by op and outcome",
  incremental: true,
})

/** How long past its agent's hours a claimed job's runner has to settle before the store ends it `timeout`. */
export const SETTLE_GRACE_SECONDS = 300

const decodeOutcome = Schema.decodeUnknownEffect(AgentRunner.Outcome)
const decodeTask = Schema.decodeUnknownEffect(AgentRunner.Task)

type Status = "queued" | "claimed" | "done" | "failed" | "cancelled" | "retryable"

/** How a row stands for the step that waits on it. */
const standingOf = (row: { readonly status: Status; readonly outcome: unknown; readonly task: unknown; readonly generation: number }) =>
  Effect.gen(function* () {
    if (row.status === "queued" || row.status === "claimed") return { _tag: "Running" } as AgentRunner.Standing
    if (row.status === "retryable") {
      // A retryable end gets another generation while the agent has restarts left: generation g is the (g-1)th restart.
      const task = yield* Effect.orDie(decodeTask(row.task))
      return row.generation <= task.agent.restarts
        ? { _tag: "Again" } as AgentRunner.Standing
        : { _tag: "Ended", outcome: { _tag: "Failed", reason: "exhausted" } } as AgentRunner.Standing
    }
    return { _tag: "Ended", outcome: yield* Effect.orDie(decodeOutcome(row.outcome)) } as AgentRunner.Standing
  })

/** One operation's records: a span `agent.jobs.<op>`, a count by outcome, and a log line on failure. */
const recorded = <A, E, R>(op: "start" | "status" | "cancel", key: string, outcomeOf: (value: A) => string) =>
(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tap((value) => Metric.update(Metric.withAttributes(operations, { op, outcome: outcomeOf(value) }), 1)),
    Effect.tapError((error) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(operations, { op, outcome: "error" }), 1),
        Effect.logWarning(`agent.jobs.${op}`).pipe(Effect.annotateLogs({ key, outcome: "error", errorCode: codeOf(error) })),
      )
    ),
    Effect.withSpan(`agent.jobs.${op}`, { attributes: { "smithers.agent.job.key": key } }),
  )

/** How the probe raises the fleet's alerts: its thresholds, and the start of one alert's `ops/FleetAlert`. */
export interface Alerts {
  readonly settings: Fleet.Settings
  readonly raise: (alert: Fleet.Alert) => Effect.Effect<void, unknown>
}

/**
 * The job store over `database`, which opens a Postgres client for each operation's scope. A database failure is
 * `AgentJobsUnavailable`, which the engine retries, `cancel` included: a cancellation is never acknowledged unrecorded.
 * The fleet's projection is kept with `alerts`' thresholds (the defaults unless given); without `alerts.raise`, the
 * probe raises none. A projection or alert that fails is logged and never fails the operation, whose job goes on.
 */
export const make = <E>(
  database: Layer.Layer<SqlClient.SqlClient, E>,
  alerts?: Alerts,
  wake?: (due: Overflow.Due) => Effect.Effect<void, unknown>,
) => {
  const settings = alerts?.settings ?? Fleet.DEFAULTS
  /** The fleet's part of an operation: its failure is a log line by code, never the operation's. */
  const projected = (op: string, key: string, effect: Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
    effect.pipe(
      Effect.provide(database),
      Effect.catchCause((cause) =>
        Effect.logWarning("fleet.project").pipe(
          Effect.annotateLogs({ op, key, outcome: "error", errorCode: codeOf(Cause.squash(cause)) }),
        )
      ),
      Effect.asVoid,
    )
  /** The probe's projection, then the alerts it found due. */
  const probe = (key: string) =>
    Effect.gen(function* () {
      // A run whose start's projection failed is queued now, so the probe still keeps it.
      const due = yield* Fleet.queue(key).pipe(Effect.andThen(Fleet.probe(key, settings)), Effect.provide(database))
      if (wake !== undefined) {
        const overflow = yield* Overflow.due(key).pipe(Effect.provide(database))
        if (Option.isSome(overflow)) {
          yield* wake(overflow.value).pipe(
            Effect.tap(() => Effect.logInfo("agent.overflow").pipe(Effect.annotateLogs({ key, repoId: overflow.value.repoId, outcome: "woken" }))),
            Effect.catchCause((cause) =>
              Effect.logWarning("agent.overflow").pipe(
                Effect.annotateLogs({ key, repoId: overflow.value.repoId, outcome: "not_woken", errorCode: codeOf(Cause.squash(cause)) }),
              )
            ),
          )
        }
      }
      if (alerts === undefined || due.length === 0) return
      yield* Fleet.raiseAll(key, due, alerts.raise, (mark) => Effect.provide(mark, database))
    })
  const start = (task: AgentRunner.Task, key: string) =>
    Effect.gen(function* () {
      const { origin, generation } = AgentRunner.parseKey(key)
      const sql = yield* SqlClient.SqlClient
      // A later generation continues the work so far: on the runner that ran the one before it, after the wait that
      // one's retryable end asked for, by the first generation's deadline. One whose step was stopped (`stop`, which
      // ends the generation before it cancelled) is cancelled as it is queued, so nothing claims it.
      const inserted = yield* sql`
        WITH previous AS (
          SELECT runner_id, deadline_at, status = 'cancelled' AS stopped,
            CASE WHEN status = 'retryable' AND outcome ? 'afterSeconds'
              THEN settled_at + (outcome->>'afterSeconds')::int * interval '1 second' END AS not_before
          FROM agent_jobs WHERE key = ${`${origin}#g${generation - 1}`})
        INSERT INTO agent_jobs (key, origin, generation, repo_id, agent, profile, labels, task, pinned_runner, not_before,
          deadline_at, status, outcome, cancel_requested, settled_at)
        SELECT ${key}, ${origin}, ${generation}, ${task.repository}, ${task.agent.name}, ${task.agent.profile},
          ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(task.agent.labels)}::jsonb)),
          ${JSON.stringify(task)}::jsonb,
          (SELECT runner_id FROM previous), (SELECT not_before FROM previous),
          COALESCE((SELECT deadline_at FROM previous), now() + ${task.agent.maxHours}::int * interval '1 hour'),
          CASE WHEN stopped THEN 'cancelled' ELSE 'queued' END,
          CASE WHEN stopped THEN '{"_tag":"Cancelled","processTreeGone":true}'::jsonb END,
          stopped, CASE WHEN stopped THEN now() END
        FROM (SELECT COALESCE((SELECT stopped FROM previous), false) AS stopped) AS ended
        ON CONFLICT (key) DO NOTHING RETURNING key`
      return inserted.length > 0
    }).pipe(
      Effect.tap((queued) => (queued ? projected("queue", key, Fleet.queue(key)) : Effect.void)),
      Effect.provide(database),
      recorded("start", key, (queued) => (queued ? "queued" : "existing")),
      Effect.catch(() => Effect.fail(new AgentRunner.AgentJobsUnavailable())),
    )

  const status = (key: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // One statement: an open job past its agent's hours ends `timeout` (a claimed one after the runner's grace to
      // settle it, which its next heartbeat learns), then the row as it stands.
      const [row] = yield* sql<{ readonly status: Status; readonly outcome: unknown; readonly task: unknown; readonly generation: number }>`
        WITH expired AS (
          UPDATE agent_jobs SET status = 'failed', outcome = '{"_tag":"Failed","reason":"timeout"}'::jsonb,
            claim = NULL, lease_until = NULL, cancel_requested = true, settled_at = now(), updated_at = now()
          WHERE key = ${key} AND (
            (status = 'queued' AND deadline_at <= now())
            OR (status = 'claimed' AND deadline_at + ${SETTLE_GRACE_SECONDS}::int * interval '1 second' <= now()))
          RETURNING status, outcome, task, generation)
        SELECT status, outcome, task, generation FROM expired
        UNION ALL
        SELECT status, outcome, task, generation FROM agent_jobs WHERE key = ${key} AND NOT EXISTS (SELECT 1 FROM expired)`
      // A key with no row was never queued: another generation.
      return row === undefined ? { _tag: "Again" } as AgentRunner.Standing : yield* standingOf(row)
    }).pipe(
      Effect.provide(database),
      Effect.tap(() => projected("probe", key, probe(key))),
      recorded("status", key, (standing) =>
        (standing._tag === "Ended" ? standing.outcome._tag : standing._tag).toLowerCase()),
      Effect.catch(() => Effect.fail(new AgentRunner.AgentJobsUnavailable())),
    )

  const cancel = (key: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { origin, generation } = AgentRunner.parseKey(key)
      // A queued job ends now; a claimed one ends when its runner, told at its next heartbeat, settles it. A key not
      // started yet ends as a cancelled row with no task, which the key's start, arriving later, finds taken.
      const [row] = yield* sql<{ readonly status: Status }>`
        INSERT INTO agent_jobs (key, origin, generation, status, outcome, cancel_requested, settled_at)
        VALUES (${key}, ${origin}, ${generation}, 'cancelled', '{"_tag":"Cancelled","processTreeGone":true}'::jsonb,
          true, now())
        ON CONFLICT (key) DO UPDATE SET cancel_requested = true,
          status = CASE WHEN agent_jobs.status = 'queued' THEN 'cancelled' ELSE agent_jobs.status END,
          outcome = CASE WHEN agent_jobs.status = 'queued' THEN '{"_tag":"Cancelled","processTreeGone":true}'::jsonb
            ELSE agent_jobs.outcome END,
          settled_at = CASE WHEN agent_jobs.status = 'queued' THEN now() ELSE agent_jobs.settled_at END,
          updated_at = now()
        RETURNING status`
      return row!.status
    }).pipe(
      Effect.provide(database),
      Effect.tap((status) => projected("stop", key, Fleet.stopping(key, status))),
      recorded("cancel", key, (status) => status),
      Effect.asVoid,
      Effect.catch(() => Effect.fail(new AgentRunner.AgentJobsUnavailable())),
    )

  return AgentRunner.AgentJobs.of({ start: (task, key) => Effect.asVoid(start(task, key)), status, cancel })
}

/**
 * Stops the step `origin` names, every generation of it, for a person's Stop: a queued generation, or one that ended
 * retryable and waits for the next, ends cancelled now; a claimed one ends when its runner, told at its next
 * heartbeat, has stopped the agent's whole process tree and settled. A later generation's start finds its predecessor
 * cancelled and queues nothing. Answers how many generations were still open: none means the step had ended.
 */
export const stop = (origin: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly key: string; readonly status: Status }>`
      UPDATE agent_jobs SET cancel_requested = true,
        status = CASE WHEN status IN ('queued', 'retryable') THEN 'cancelled' ELSE status END,
        outcome = CASE WHEN status IN ('queued', 'retryable')
          THEN '{"_tag":"Cancelled","processTreeGone":true}'::jsonb ELSE outcome END,
        settled_at = CASE WHEN status IN ('queued', 'retryable') THEN now() ELSE settled_at END,
        updated_at = now()
      WHERE origin = ${origin} AND status IN ('queued', 'claimed', 'retryable')
      RETURNING key, status`
    // The fleet reads each generation it stopped as Stopping, or Stopped when no runner held it (Fleet.ts `stopping`).
    yield* Effect.forEach(rows, (row) => Fleet.stopping(row.key, row.status), { discard: true })
    yield* Metric.update(Metric.withAttributes(operations, { op: "stop", outcome: rows.length === 0 ? "ended" : "stopping" }), 1)
    return rows.length
  }).pipe(Effect.withSpan("agent.jobs.stop", { attributes: { "smithers.agent.job.origin": origin } }))

/**
 * `AgentRunner.AgentJobs` on Postgres through `database`, whose own requirements it captures when built, raising the
 * fleet's alerts through `alerts` when given.
 */
export const layer = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  alerts?: Alerts,
  wake?: (due: Overflow.Due) => Effect.Effect<void, unknown>,
) =>
  Layer.effect(
    AgentRunner.AgentJobs,
    Effect.map(Effect.context<R>(), (context) => make(Layer.provide(database, Layer.succeedContext(context)), alerts, wake)),
  )
