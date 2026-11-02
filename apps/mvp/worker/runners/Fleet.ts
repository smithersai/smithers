import { AgentRunner } from "@smthrs/agent"
import { Cause, Config, Effect, Metric, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"

// The fleet's projection and its alerts' rules (decision 0143, docs/features/fleet.md). `agent_runs` is one row per
// generation of an external agent's job, written only under the job's own key: `queue` when the job store starts it,
// `claimed` and `settled` in the runner routes (the settle's in its transaction), `stopping` when the store cancels it,
// and `probe` each time the step's parked probe reads the job (at most every 30 s), which projects what the heartbeats
// and the transcript recorded on `agent_jobs` and finds the alerts that came due. Nothing sweeps: a job nobody probes is a job
// whose step ended. The rules are `project`, a pure function, so the thresholds are tested without a clock.

/** The fleet's thresholds, from the deployment's environment. */
export interface Settings {
  /** A working run with no sign of work this long reads Stalled and alerts (`AGENT_STALL_MINUTES`, 10). */
  readonly stallMinutes: number
  /** A run queued this long alerts that it waits for a runner (`AGENT_WAIT_MINUTES`, 5). */
  readonly waitMinutes: number
  /** A runner unseen this long, with a job claimed, alerts that it is offline (`RUNNER_OFFLINE_SECONDS`, 45). */
  readonly offlineSeconds: number
  /** A run whose reported cost passes this alerts (`MAX_RUN_USD`); unset, cost never alerts. */
  readonly maxRunUsd: number | undefined
}

/**
 * The defaults: 10-minute stalls, 5-minute waits, a runner offline as soon as the view reads it, no cost alert. An
 * outage reaches the bell within 90 s of the runner's death: this, then the next probe, up to 38 s apart on production.
 */
export const DEFAULTS: Settings = { stallMinutes: 10, waitMinutes: 5, offlineSeconds: 45, maxRunUsd: undefined }

/** CPU seconds an agent's process tree must use, past the last mark, to count as working: a quiet build isn't a stall. */
export const CPU_ACTIVE_SECONDS = 5

/** How long after its last request a runner reads Offline in the fleet, and the soonest it may alert (docs/features/fleet.md). */
export const UNREACHABLE_SECONDS = 45

/** The settings from the environment; each bound is checked, and an out-of-bounds value fails the deploy's start. */
export const settings = Effect.gen(function* () {
  const stallMinutes = yield* Config.Int("AGENT_STALL_MINUTES").pipe(Config.withDefault(DEFAULTS.stallMinutes))
  const waitMinutes = yield* Config.Int("AGENT_WAIT_MINUTES").pipe(Config.withDefault(DEFAULTS.waitMinutes))
  const offlineSeconds = yield* Config.Int("RUNNER_OFFLINE_SECONDS").pipe(Config.withDefault(DEFAULTS.offlineSeconds))
  const maxRunUsd = yield* Config.Number("MAX_RUN_USD").pipe(Config.option)
  if (stallMinutes < 1 || stallMinutes > 720) return yield* Effect.fail(new Error("AGENT_STALL_MINUTES must be 1 to 720"))
  if (waitMinutes < 1 || waitMinutes > 720) return yield* Effect.fail(new Error("AGENT_WAIT_MINUTES must be 1 to 720"))
  if (offlineSeconds < UNREACHABLE_SECONDS || offlineSeconds > 3600) {
    return yield* Effect.fail(new Error(`RUNNER_OFFLINE_SECONDS must be ${UNREACHABLE_SECONDS} to 3600`))
  }
  const cap = maxRunUsd._tag === "Some" ? maxRunUsd.value : undefined
  if (cap !== undefined && !(cap > 0)) return yield* Effect.fail(new Error("MAX_RUN_USD must be above 0"))
  return { stallMinutes, waitMinutes, offlineSeconds, maxRunUsd: cap } satisfies Settings
})

/** What an alert is about. */
export const KINDS = ["failed", "stalled", "offline", "waiting", "cost"] as const
export type Kind = (typeof KINDS)[number]

/**
 * One alert to raise: its id (the incident, its `ops/FleetAlert` execution and its receipts' key), what it is, its
 * repository and its subject (a job's key, a runner's id, or a TODO attempt's id for `failed`).
 */
export const Alert = Schema.Struct({
  alertId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  kind: Schema.Literals(KINDS),
  repoId: Schema.String.check(Schema.isMinLength(1)),
  subject: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
})
export type Alert = typeof Alert.Type

/** Alerts started, by `kind` and `outcome` (`started`, `not_started`). */
export const raised = Metric.counter("smithers_fleet_alerts_raised", {
  description: "Fleet alerts the job probe or a runner health window started, by kind and outcome",
  incremental: true,
})

/** `agent_runs` writes, by `op` (`queue`, `claim`, `settle`, `stop`, `probe`). */
export const writes = Metric.counter("smithers_agent_runs_writes", {
  description: "Writes to the agent_runs projection, by op",
  incremental: true,
})

/** The alert ids: one incident each. A stall is one per stretch of quiet; an outage one per runner's last sighting. */
export const alertId = {
  failed: (attemptId: string) => `fleet-failed-${attemptId}`,
  stalled: (key: string, since: number) => `fleet-stalled-${key}-${since}`,
  waiting: (key: string) => `fleet-waiting-${key}`,
  cost: (key: string) => `fleet-cost-${key}`,
  offline: (runnerId: string, seenAt: number) => `fleet-offline-${runnerId}-${seenAt}`,
} as const

/** A run's state, as people read it: Queued is Waiting for a runner. */
export type State = "queued" | "working" | "stalled" | "stopping" | "stopped" | "failed" | "done" | "retried"

/** The job as the probe reads it, with its runner and the database's clock. */
export interface Job {
  readonly key: string
  readonly repoId: string
  readonly status: "queued" | "claimed" | "done" | "failed" | "cancelled" | "retryable"
  readonly outcome: unknown
  readonly cancelRequested: boolean
  readonly claimedAt: Date | null
  readonly settledAt: Date | null
  readonly accountLabel: string | null
  readonly cpuSeconds: number | null
  readonly usage: unknown
  readonly firstEventAt: Date | null
  readonly lastEventAt: Date | null
  readonly transcriptBytes: number | null
  readonly runnerId: string | null
  readonly runner: string | null
  readonly runnerSeenAt: Date | null
  readonly now: Date
}

/** The fields of `agent_runs` the probe keeps. */
export interface Run {
  readonly state: State
  readonly reason: string | null
  readonly runner: string | null
  readonly accountLabel: string | null
  readonly queuedAt: Date
  readonly claimedAt: Date | null
  readonly firstEventAt: Date | null
  readonly lastEventAt: Date | null
  readonly activityAt: Date | null
  readonly endedAt: Date | null
  readonly contextTokens: number | null
  readonly costUsd: number | null
  readonly transcriptBytes: number | null
  readonly cpuSeconds: number | null
  readonly cpuMark: number | null
  readonly alerted: ReadonlyArray<string>
}

/** What the probe does: the run's next row, the alerts due that it hasn't started, and the incidents that recovered. */
export interface Projected {
  readonly next: Run
  readonly due: ReadonlyArray<Alert>
  readonly recovered: ReadonlyArray<"stalled" | "waiting">
}

const isUsage = Schema.is(AgentRunner.Usage)

/** The usage the run reported: its settled outcome's when it finished, else the latest heartbeat's. */
const usageOf = (job: Job): AgentRunner.Usage => {
  const settled = (job.outcome as { readonly _tag?: unknown; readonly usage?: unknown } | null)?.usage
  if (isUsage(settled)) return settled
  return isUsage(job.usage) ? job.usage : {}
}

const latest = (...dates: ReadonlyArray<Date | null>): Date | null =>
  dates.reduce<Date | null>((best, date) => (date !== null && (best === null || date > best) ? date : best), null)

/**
 * The run's next row from its job, and what comes due (docs/features/fleet.md#alerts). Pure: `job.now` is the
 * database's clock.
 *
 * - **Activity** is the latest of the claim, the agent's last transcript event, and the last time its process tree's
 *   CPU seconds passed the mark by `CPU_ACTIVE_SECONDS` (which moves the mark; with none yet, the mark is 0, where the
 *   tree's time starts). A runner that reports no CPU time gives
 *   no CPU evidence, so its run stalls on events alone.
 * - **Stalled**: claimed, not stopping, and no activity for `stallMinutes`. One incident per stretch of quiet.
 * - **Waiting**: queued for `waitMinutes`.
 * - **Offline**: claimed on a runner unseen for `offlineSeconds`. One incident per runner per last sighting.
 * - **Cost**: reported cost past `maxRunUsd`.
 */
export const project = (job: Job, run: Run, settings: Settings): Projected => {
  const now = job.now.getTime()
  // The tree's CPU time counts from 0 when the runner starts the agent, so a run with no mark yet measures from 0.
  const cpuGrew = job.cpuSeconds !== null && job.cpuSeconds >= (run.cpuMark ?? 0) + CPU_ACTIVE_SECONDS
  const cpuMark = job.cpuSeconds === null ? run.cpuMark : run.cpuMark === null || cpuGrew ? job.cpuSeconds : run.cpuMark
  const activityAt = job.status === "queued"
    ? null
    : latest(run.activityAt, job.claimedAt, job.lastEventAt, cpuGrew ? job.now : null)
  const quiet = activityAt !== null && now - activityAt.getTime() >= settings.stallMinutes * 60_000
  const state: State = job.status === "queued"
    ? "queued"
    : job.status === "claimed"
    ? (job.cancelRequested ? "stopping" : quiet ? "stalled" : "working")
    : job.status === "done"
    ? "done"
    : job.status === "failed"
    ? "failed"
    : job.status === "cancelled"
    ? "stopped"
    : "retried"
  const reason = job.status === "failed"
    ? String((job.outcome as { readonly reason?: unknown } | null)?.reason ?? "failed").slice(0, 40)
    : null
  const usage = usageOf(job)
  const next: Run = {
    ...run,
    state,
    reason,
    runner: job.runner ?? run.runner,
    accountLabel: job.accountLabel ?? run.accountLabel,
    claimedAt: job.claimedAt ?? run.claimedAt,
    firstEventAt: job.firstEventAt ?? run.firstEventAt,
    lastEventAt: job.lastEventAt ?? run.lastEventAt,
    activityAt,
    endedAt: job.settledAt,
    contextTokens: usage.contextTokens ?? run.contextTokens,
    costUsd: usage.costUsd ?? run.costUsd,
    transcriptBytes: job.transcriptBytes ?? run.transcriptBytes,
    cpuSeconds: job.cpuSeconds ?? run.cpuSeconds,
    cpuMark,
  }
  const due: Array<Alert> = []
  const raise = (kind: Kind, id: string, subject = job.key) => {
    if (!run.alerted.includes(id)) due.push({ alertId: id, kind, repoId: job.repoId, subject })
  }
  if (state === "stalled") raise("stalled", alertId.stalled(job.key, activityAt!.getTime()))
  if (state === "queued" && now - run.queuedAt.getTime() >= settings.waitMinutes * 60_000) {
    raise("waiting", alertId.waiting(job.key))
  }
  if (
    job.status === "claimed" && job.runnerId !== null && job.runnerSeenAt !== null &&
    now - job.runnerSeenAt.getTime() >= settings.offlineSeconds * 1000
  ) {
    raise("offline", alertId.offline(job.runnerId, job.runnerSeenAt.getTime()), job.runnerId)
  }
  if (settings.maxRunUsd !== undefined && next.costUsd !== null && next.costUsd > settings.maxRunUsd) {
    raise("cost", alertId.cost(job.key))
  }
  const recovered: Array<"stalled" | "waiting"> = []
  if (run.state === "stalled" && state !== "stalled") recovered.push("stalled")
  if (run.state === "queued" && state !== "queued" && run.alerted.includes(alertId.waiting(job.key))) {
    recovered.push("waiting")
  }
  return { next, due, recovered }
}

/** Whether the probe's row changed anything a person or a later probe reads. */
export const changed = (before: Run, after: Run): boolean =>
  (Object.keys(after) as Array<keyof Run>).some((field) => {
    const a = before[field]
    const b = after[field]
    if (a instanceof Date || b instanceof Date) {
      return (a as Date | null)?.getTime() !== (b as Date | null)?.getTime()
    }
    return JSON.stringify(a) !== JSON.stringify(b)
  })

const count = (op: string) => Metric.update(Metric.withAttributes(writes, { op }), 1)

/** The reason of a run whose TODO's run died. */
const CRASHED = "crashed"

/**
 * Inserts the run of job `key`, just queued, in the job store's start transaction: its repository, agent and
 * generation, and the TODO its task's `context.attemptId` names, when it names one (its run, number and title).
 */
export const queue = (key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`
      INSERT INTO agent_runs (key, repo_id, agent, generation, run_id, todo_id, number, title, queued_at, updated_at)
      SELECT j.key, j.repo_id, j.agent, j.generation,
        CASE WHEN a.id IS NULL THEN NULL ELSE 'todo:' || a.id::text END, t.id, t.number, t.title, j.created_at, now()
      FROM agent_jobs j
      LEFT JOIN todo_attempts a ON a.id::text = j.task->'context'->>'attemptId'
      LEFT JOIN todos t ON t.id = a.todo_id
      WHERE j.key = ${key} AND j.repo_id IS NOT NULL
      ON CONFLICT (key) DO NOTHING RETURNING key`
    if (rows.length > 0) yield* count("queue")
  })

/** A runner claimed job `key`: it works, on `runner`. The claim route runs it once the claim is made. */
export const claimed = (key: string, runner: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`
      UPDATE agent_runs SET state = 'working', runner = ${runner},
        claimed_at = coalesce(claimed_at, now()), activity_at = greatest(activity_at, now()), updated_at = now()
      WHERE key = ${key} AND state IN ('queued', 'working', 'stalled') RETURNING key`
    if (rows.length > 0) yield* count("claim")
  })

/** Job `key` settled with `outcome`: the run ends now, with its usage. Run in the settle's own transaction. */
export const settled = (key: string, outcome: AgentRunner.Outcome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const state: State = outcome._tag === "Done"
      ? "done"
      : outcome._tag === "Failed"
      ? "failed"
      : outcome._tag === "Cancelled"
      ? "stopped"
      : "retried"
    const usage = outcome._tag === "Done" ? outcome.usage : {}
    // A run that died keeps saying so: the runner's late settle adds only its usage.
    const rows = yield* sql`
      UPDATE agent_runs SET state = CASE WHEN reason = ${CRASHED} THEN state ELSE ${state}::text END,
        reason = CASE WHEN reason = ${CRASHED} THEN reason ELSE ${outcome._tag === "Failed" ? outcome.reason : null}::text END,
        ended_at = CASE WHEN reason = ${CRASHED} THEN ended_at ELSE now() END,
        context_tokens = coalesce(${usage.contextTokens ?? null}::bigint, context_tokens),
        cost_usd = coalesce(${usage.costUsd ?? null}::numeric, cost_usd), updated_at = now()
      WHERE key = ${key} RETURNING key`
    if (rows.length > 0) yield* count("settle")
  })

/**
 * The TODO run of attempt `attemptId` died (`crashed`, docs/features/todos.md): each of its generations still open reads
 * Failed `crashed` now, because no probe is left to project it. One that already ended keeps how it ended.
 */
export const crashed = (attemptId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`
      UPDATE agent_runs SET state = 'failed', reason = ${CRASHED}, ended_at = now(), updated_at = now()
      WHERE state IN ('queued', 'working', 'stalled', 'stopping')
        AND key IN (SELECT key FROM agent_jobs WHERE task->'context'->>'attemptId' = ${attemptId})
      RETURNING key`
    if (rows.length > 0) yield* count("crash")
  })

/** Job `key` was asked to stop: queued, it is Stopped now; claimed, Stopping until its runner settles it. */
export const stopping = (key: string, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`
      UPDATE agent_runs SET state = ${status === "cancelled" ? "stopped" : "stopping"},
        ended_at = CASE WHEN ${status} = 'cancelled' THEN coalesce(ended_at, now()) ELSE ended_at END, updated_at = now()
      WHERE key = ${key} AND state IN ('queued', 'working', 'stalled') RETURNING key`
    if (rows.length > 0) yield* count("stop")
  })

interface RunRow extends Run {
  readonly key: string
}

const toNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

/**
 * Reads job `key` and its run, projects it (`project`), writes the run back when it changed, and closes the incidents
 * that recovered: the probe's one write, under the job's key. Answers the alerts that came due, which the caller
 * starts and then marks (`alertedOn`). A job with no run (queued before the fleet existed) has nothing to project.
 */
export const probe = (key: string, settings: Settings) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function* () {
      const [row] = yield* sql<Record<string, unknown>>`
        SELECT j.key, j.repo_id AS "repoId", j.status, j.outcome, j.cancel_requested AS "cancelRequested",
          j.claimed_at AS "claimedAt", j.settled_at AS "settledAt", j.account_label AS "accountLabel",
          j.cpu_seconds AS "cpuSeconds", j.usage, j.first_event_at AS "firstEventAt", j.last_event_at AS "lastEventAt",
          j.transcript_bytes AS "transcriptBytes", j.runner_id::text AS "runnerId", rn.name AS runner,
          rn.seen_at AS "runnerSeenAt", now() AS now,
          r.state AS "r_state", r.reason AS "r_reason", r.runner AS "r_runner", r.account_label AS "r_accountLabel",
          r.queued_at AS "r_queuedAt", r.claimed_at AS "r_claimedAt", r.first_event_at AS "r_firstEventAt",
          r.last_event_at AS "r_lastEventAt", r.activity_at AS "r_activityAt", r.ended_at AS "r_endedAt",
          r.context_tokens AS "r_contextTokens", r.cost_usd AS "r_costUsd", r.transcript_bytes AS "r_transcriptBytes",
          r.cpu_seconds AS "r_cpuSeconds", r.cpu_mark AS "r_cpuMark", r.alerted AS "r_alerted"
        FROM agent_jobs j JOIN agent_runs r ON r.key = j.key LEFT JOIN runners rn ON rn.id = j.runner_id
        WHERE j.key = ${key} AND j.repo_id IS NOT NULL
        FOR UPDATE OF r`
      if (row === undefined) return []
      const date = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string))
      const job: Job = {
        key,
        repoId: row.repoId as string,
        status: row.status as Job["status"],
        outcome: row.outcome,
        cancelRequested: row.cancelRequested as boolean,
        claimedAt: date(row.claimedAt),
        settledAt: date(row.settledAt),
        accountLabel: row.accountLabel as string | null,
        cpuSeconds: toNumber(row.cpuSeconds),
        usage: row.usage,
        firstEventAt: date(row.firstEventAt),
        lastEventAt: date(row.lastEventAt),
        transcriptBytes: toNumber(row.transcriptBytes),
        runnerId: row.runnerId as string | null,
        runner: row.runner as string | null,
        runnerSeenAt: date(row.runnerSeenAt),
        now: date(row.now)!,
      }
      const run: RunRow = {
        key,
        state: row.r_state as State,
        reason: row.r_reason as string | null,
        runner: row.r_runner as string | null,
        accountLabel: row.r_accountLabel as string | null,
        queuedAt: date(row.r_queuedAt)!,
        claimedAt: date(row.r_claimedAt),
        firstEventAt: date(row.r_firstEventAt),
        lastEventAt: date(row.r_lastEventAt),
        activityAt: date(row.r_activityAt),
        endedAt: date(row.r_endedAt),
        contextTokens: toNumber(row.r_contextTokens),
        costUsd: toNumber(row.r_costUsd),
        transcriptBytes: toNumber(row.r_transcriptBytes),
        cpuSeconds: toNumber(row.r_cpuSeconds),
        cpuMark: toNumber(row.r_cpuMark),
        alerted: row.r_alerted as ReadonlyArray<string>,
      }
      const { next, due, recovered } = project(job, run, settings)
      if (changed(run, next)) {
        yield* sql`
          UPDATE agent_runs SET state = ${next.state}, reason = ${next.reason}, runner = ${next.runner},
            account_label = ${next.accountLabel}, claimed_at = ${next.claimedAt}, first_event_at = ${next.firstEventAt},
            last_event_at = ${next.lastEventAt}, activity_at = ${next.activityAt}, ended_at = ${next.endedAt},
            context_tokens = ${next.contextTokens}, cost_usd = ${next.costUsd}, transcript_bytes = ${next.transcriptBytes},
            cpu_seconds = ${next.cpuSeconds}, cpu_mark = ${next.cpuMark}, updated_at = now()
          WHERE key = ${key}`
        yield* count("probe")
      }
      for (const kind of recovered) {
        yield* sql`UPDATE fleet_alerts SET closed_at = now() WHERE kind = ${kind} AND subject = ${key} AND closed_at IS NULL`
      }
      return due
    }))
  })

/** Marks alert `alertId` started for job `key`, so a later probe doesn't start it again. */
export const alertedOn = (key: string, alertId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE agent_runs SET alerted = array_append(alerted, ${alertId})
      WHERE key = ${key} AND NOT (${alertId} = ANY(alerted))`)

/**
 * Starts each alert through `raise`, then marks it on the run. A start that fails is logged by code and counted, and
 * the next probe starts it again; it never fails the probe, whose job goes on.
 */
export const raiseAll = <E, R, DE, DR>(
  key: string,
  due: ReadonlyArray<Alert>,
  raise: (alert: Alert) => Effect.Effect<void, E, R>,
  mark: (effect: Effect.Effect<unknown, unknown, SqlClient.SqlClient>) => Effect.Effect<unknown, DE, DR>,
) =>
  Effect.forEach(due, (alert) =>
    raise(alert).pipe(
      Effect.andThen(mark(alertedOn(key, alert.alertId))),
      Effect.andThen(Metric.update(Metric.withAttributes(raised, { kind: alert.kind, outcome: "started" }), 1)),
      Effect.andThen(Effect.logWarning("fleet.alert").pipe(
        Effect.annotateLogs({ alertId: alert.alertId, kind: alert.kind, repoId: alert.repoId, outcome: "started" }),
      )),
      Effect.catchCause((cause) =>
        Effect.andThen(
          Metric.update(Metric.withAttributes(raised, { kind: alert.kind, outcome: "not_started" }), 1),
          Effect.logError("fleet.alert").pipe(Effect.annotateLogs({
            alertId: alert.alertId,
            kind: alert.kind,
            outcome: "not_started",
            errorCode: codeOf(Cause.squash(cause)),
          })),
        )
      ),
    ), { discard: true })
