import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Effect, Layer, Metric, Option } from "effect"
import { SqlClient } from "effect/sql"
import {
  LINEAGE_DEPTH,
  REPO_RUN_NAMESPACE,
  type RunEvent,
  settledState,
} from "../src/features/actions/contract.ts"

// A repository's runs (docs/features/actions.md): each run of a repository's own flow on Cloudflare is a `runs` row
// (decision 0009 §2), so `/$owner/$repo/actions` lists them through Electric and the run page reads each through the
// engine. Three things touch a row:
//
//   record   whoever starts the run (a trigger, a person's Run, a Retry), before the start, once per execution
//   settle   the run's Durable Object, when its alarm finds the run settled: done, failed or stopped, from the
//            engine's own status, never a step's say
//   admit    the run routes: is this run, or a run it descends from, a recorded repository run, and whose
//
// Records carry ids and states, never a run's payload.

/** One run of a repository's flow, as its row records it. */
export interface RepoRun {
  /** The engine's run id. */
  readonly execution: string
  /** `github/<owner>/<name>`, lower case (src/features/repo/contract.ts `repoId`). */
  readonly repoId: string
  /** The repository flow's name: its directory under `.smithers/flows/`. */
  readonly flow: string
  readonly sha: string
  readonly ref: string
  readonly event: RunEvent
  /** The person who started it, or `github` for a trigger. */
  readonly launchedBy: string
}

/** Repository runs' rows written, by `op` (`record`, `settle`) and `outcome`. */
export const writes = Metric.counter("smithers_repo_run_writes", {
  description: "Repository run rows recorded and settled, by op and outcome",
  incremental: true,
})

/** A repository run's row id: the version 5 UUID of its execution id. */
export const rowIdOf = (execution: string) =>
  Uuid.v5(REPO_RUN_NAMESPACE, execution).pipe(Effect.provide(WebCrypto.layer))

/** Records `run` working, once: a start sent again records nothing new. Answers whether it was new. */
export const record = (run: RepoRun) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const id = yield* rowIdOf(run.execution)
    const rows = yield* sql<{ readonly id: string }>`
      INSERT INTO runs (id, flow, status, launched_by, repo_id, sha, ref, event, execution)
      VALUES (${id}::uuid, ${run.flow}, 'working', ${run.launchedBy}, ${run.repoId}, ${run.sha}, ${run.ref},
        ${run.event}, ${run.execution})
      ON CONFLICT (id) DO NOTHING
      RETURNING id::text`
    const outcome = rows.length === 1 ? "recorded" : "existing"
    yield* Metric.update(Metric.withAttributes(writes, { op: "record", outcome }), 1)
    yield* Effect.logInfo("repo.run.record").pipe(
      Effect.annotateLogs({ runId: run.execution, repoId: run.repoId, flow: run.flow, event: run.event, outcome }),
    )
    return rows.length === 1
  }).pipe(Effect.withSpan("repo.run.record"))

/**
 * Settles `execution`'s row, if it is a repository run still working, from the engine's status of the run in
 * `engine`: `done`, `failed`, or `stopped` for a cancelled run. Its object calls this once it settled the run, so a run
 * the engine never began was stopped before it started: `stopped`. A run the engine hasn't settled, or a row already
 * settled, changes nothing; so a settlement seen twice writes once.
 */
export const settle = <E, R>(execution: string, engine: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const working = yield* sql<{ readonly id: string }>`
      SELECT id::text FROM runs WHERE execution = ${execution} AND status = 'working'`
    if (working.length === 0) return Option.none<string>()
    const status = yield* Effect.flatMap(SqlClient.SqlClient, (engineSql) =>
      engineSql<{ readonly status: string }>`SELECT status FROM flows_runs WHERE run_id = ${execution}`).pipe(
        Effect.provide(engine),
        Effect.map((rows) => rows[0]?.status),
      )
    if (status !== undefined && status !== "completed" && status !== "failed" && status !== "cancelled") {
      return Option.none<string>()
    }
    const state = status === undefined ? "stopped" : settledState(status)
    yield* sql`
      UPDATE runs SET status = ${state}, updated_at = now() WHERE execution = ${execution} AND status = 'working'`
    yield* Metric.update(Metric.withAttributes(writes, { op: "settle", outcome: state }), 1)
    yield* Effect.logInfo("repo.run.settle").pipe(Effect.annotateLogs({ runId: execution, outcome: state }))
    return Option.some(state)
  }).pipe(Effect.withSpan("repo.run.settle"))

/** The recorded repository run a run route's run belongs to: its execution and repository. */
export interface Admitted {
  readonly execution: string
  readonly repoId: string
}

/**
 * `runId`'s ancestors nearest first, one generation at a time, at most `LINEAGE_DEPTH` generations of parents in
 * `engine`, `runId` itself first. A run's parents are its `parent_run_id` and every run that spawned it
 * (`flows_run_parents`), as the engine's own inspection reads them. `found` ends the walk with its answer.
 */
export const firstAncestor = <A, E, R, E2, R2>(
  runId: string,
  engine: Layer.Layer<SqlClient.SqlClient, E, R>,
  found: (generation: ReadonlyArray<string>) => Effect.Effect<Option.Option<A>, E2, R2>,
  depth = LINEAGE_DEPTH,
) =>
  Effect.gen(function* () {
    const parentsOf = (ids: ReadonlyArray<string>) =>
      Effect.flatMap(SqlClient.SqlClient, (engineSql) =>
        engineSql<{ readonly id: string }>`
          SELECT parent_run_id AS id FROM flows_runs WHERE run_id IN ${engineSql.in(ids)} AND parent_run_id IS NOT NULL
          UNION
          SELECT parent_id AS id FROM flows_run_parents WHERE child_id IN ${engineSql.in(ids)}`).pipe(
          Effect.provide(engine),
          Effect.map((rows) => rows.map((row) => row.id)),
        )
    const seen = new Set<string>()
    let generation: ReadonlyArray<string> = [runId]
    for (let walked = 0; generation.length > 0; walked++) {
      for (const id of generation) seen.add(id)
      const answer = yield* found(generation)
      if (Option.isSome(answer)) return answer
      generation = walked === depth ? [] : (yield* parentsOf(generation)).filter((id) => !seen.has(id))
    }
    return Option.none<A>()
  })

/**
 * The recorded repository run `runId` is, or descends from (a job it started, and the runs those started); none for
 * any other run. A recorded run the engine hasn't begun is admitted as itself.
 */
export const admit = <E, R>(runId: string, engine: Layer.Layer<SqlClient.SqlClient, E, R>, depth = LINEAGE_DEPTH) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    firstAncestor(runId, engine, (generation) =>
      Effect.map(
        sql<{ readonly execution: string; readonly repo_id: string }>`
          SELECT execution, repo_id FROM runs WHERE execution IN ${sql.in(generation)} ORDER BY execution LIMIT 1`,
        (rows) => rows[0] === undefined
          ? Option.none<Admitted>()
          : Option.some<Admitted>({ execution: rows[0].execution, repoId: rows[0].repo_id }),
      ), depth))
