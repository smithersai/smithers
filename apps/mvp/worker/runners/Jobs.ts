import { AgentRunner } from "@smthrs/agent"
import { Effect, Layer, Metric, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"

// The host's job store on Postgres (decision 0136, docs/features/agent-runners.md#the-job-store): `@smthrs/agent`'s
// `AgentRunner.AgentJobs` port, which an external agent's step (`ExternalAgent`) drives. `agent_jobs` is the external
// system that step waits on durably: `start` queues one generation, the runner routes (worker/runners/Api.ts) claim,
// heartbeat and settle it, and `status` reads how it stands. Each operation is one transaction; none retries, sleeps or
// starts anything. The store owns the agent's own limits, its hours and its restarts, so the step needs neither. A
// runner that stops answering keeps its job: a missing heartbeat doesn't prove its agent stopped, so the job reads
// Running until the runner comes back or the agent's hours are up. Nothing here logs a task.

/** Job store operations, by `op` (`start`, `status`, `cancel`) and `outcome`. */
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

/**
 * The job store over `database`, which opens a Postgres client for each operation's scope. A database failure is
 * `AgentJobsUnavailable`, which the engine retries, `cancel` included: a cancellation is never acknowledged unrecorded.
 */
export const make = <E>(database: Layer.Layer<SqlClient.SqlClient, E>) => {
  const start = (task: AgentRunner.Task, key: string) =>
    Effect.gen(function* () {
      const { origin, generation } = AgentRunner.parseKey(key)
      const sql = yield* SqlClient.SqlClient
      // A later generation continues the work so far: on the runner that ran the one before it, after the wait that
      // one's retryable end asked for, by the first generation's deadline.
      const inserted = yield* sql`
        WITH previous AS (
          SELECT runner_id, deadline_at,
            CASE WHEN status = 'retryable' AND outcome ? 'afterSeconds'
              THEN settled_at + (outcome->>'afterSeconds')::int * interval '1 second' END AS not_before
          FROM agent_jobs WHERE key = ${`${origin}#g${generation - 1}`})
        INSERT INTO agent_jobs (key, origin, generation, repo_id, agent, profile, labels, task, pinned_runner, not_before,
          deadline_at)
        VALUES (${key}, ${origin}, ${generation}, ${task.repository}, ${task.agent.name}, ${task.agent.profile},
          ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(task.agent.labels)}::jsonb)),
          ${JSON.stringify(task)}::jsonb,
          (SELECT runner_id FROM previous), (SELECT not_before FROM previous),
          COALESCE((SELECT deadline_at FROM previous), now() + ${task.agent.maxHours}::int * interval '1 hour'))
        ON CONFLICT (key) DO NOTHING RETURNING key`
      return inserted.length > 0
    }).pipe(
      Effect.provide(database),
      recorded("start", key, (queued) => (queued ? "queued" : "existing")),
      Effect.mapError(() => new AgentRunner.AgentJobsUnavailable()),
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
      recorded("status", key, (standing) =>
        (standing._tag === "Ended" ? standing.outcome._tag : standing._tag).toLowerCase()),
      Effect.mapError(() => new AgentRunner.AgentJobsUnavailable()),
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
      recorded("cancel", key, (status) => status),
      Effect.asVoid,
      Effect.mapError(() => new AgentRunner.AgentJobsUnavailable()),
    )

  return AgentRunner.AgentJobs.of({ start: (task, key) => Effect.asVoid(start(task, key)), status, cancel })
}

/** `AgentRunner.AgentJobs` on Postgres through `database`, whose own requirements it captures when built. */
export const layer = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Layer.effect(
    AgentRunner.AgentJobs,
    Effect.map(Effect.context<R>(), (context) => make(Layer.provide(database, Layer.succeedContext(context)))),
  )
