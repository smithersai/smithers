// Remote executions in a Node test (worker/ExecutionHost.ts): each execution's Durable Object handlers over an
// in-memory stand-in for its storage, the one Cloudflare binding they take, on a fresh engine schema of the compose
// Postgres. worker/ExecutionHost.test.ts drives single objects the same way; this keeps one per execution, as ChatApi's
// namespace does, and reaches them through the services ChatApi's routes use (`FlowStarter`, `TaskAnswers`).
import * as Pg from "@effect/sql-pg"
import { TestSchemas } from "@smthrs/database"
import { Cause, Context, Effect, Layer, Predicate, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { codeOf } from "../ErrorCode.vibe"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as Flows from "../Flows.vibe"

/** A Durable Object's storage in memory: values cross it by structured clone, and it holds one alarm. */
export const memory = () => {
  const values = new Map<string, unknown>()
  let alarm: number | null = null
  const storage: ExecutionHost.Storage = {
    get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
    put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
    delete: (key) => Effect.sync(() => values.delete(key)),
    setAlarm: (at) => Effect.sync(() => void (alarm = at)),
    deleteAlarm: () => Effect.sync(() => void (alarm = null)),
  }
  return { storage, values, alarm: () => alarm }
}

/**
 * A fresh engine schema on the compose Postgres for the caller's scope, dropped when it closes: its URL, its name, the
 * engine's `database` over it, and a client outside it.
 */
export const engineSchema = Effect.gen(function* () {
  const url = (yield* TestDatabase.serverUrl).toString()
  const admin = yield* Layer.build(Pg.PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
  const sql = Context.get(admin, SqlClient.SqlClient)
  const name = TestSchemas.schemaName("flows")
  yield* Effect.addFinalizer(() => Effect.orDie(sql`DROP SCHEMA IF EXISTS ${sql(name)} CASCADE`))
  return { url, name, sql, database: ExecutionHost.database(url, name) }
})

/** A run's status in the engine's schema `name`, or `undefined` before the engine knows it. */
export const status = (sql: SqlClient.SqlClient, name: string, executionId: string) =>
  Effect.orDie(sql<{ readonly status: string }>`SELECT status FROM ${sql(name)}.flows_runs WHERE run_id = ${executionId}`)
    .pipe(Effect.map((rows) => rows[0]?.status))

/**
 * Every execution of `queue/ask` (over the app's tables in `app`) on an object of its own, its engine over `database`,
 * as ChatApi's namespace keeps them: `starter` records a start on the execution's object, `answers` reaches its
 * `answer`, `alarm` runs its alarm, and `restart` replaces every object's handlers over the same storage, as a new
 * incarnation of each would.
 */
export const executions = (
  database: Layer.Layer<SqlClient.SqlClient>,
  app: Layer.Layer<SqlClient.SqlClient, unknown>,
) => {
  const flows = ExecutionHost.withAsks({ flows: [], registration: Layer.empty }, app)
  const storages = new Map<string, ReturnType<typeof memory>>()
  let hosts = new Map<string, ReturnType<typeof make>>()
  const make = (executionId: string) =>
    ExecutionHost.make(storages.get(executionId)!.storage, {
      hostId: `object-${executionId}`,
      database,
      flows,
      router: { start: () => Effect.void, wake: () => Effect.void },
    })
  const hostOf = (executionId: string) => {
    if (!storages.has(executionId)) storages.set(executionId, memory())
    const host = hosts.get(executionId) ?? make(executionId)
    hosts.set(executionId, host)
    return host
  }
  return {
    starter: Flows.FlowStarter.of({
      start: (flow, { executionId, payload }) =>
        ExecutionHost.intent(flow, { executionId, payload: payload as never }).pipe(
          Effect.flatMap((intent) => hostOf(executionId).start(intent)),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            return Effect.fail(
              Predicate.isTagged(error, "@smthrs/platform-cloudflare/IntentConflict")
                ? new Flows.StartConflict()
                : new Flows.StartUnavailable({ errorCode: codeOf(error) }),
            )
          }),
        ),
    }),
    answers: Flows.TaskAnswers.of({ answer: (executionId, task, value) => hostOf(executionId).answer(task, value) }),
    alarm: (executionId: string) => hostOf(executionId).alarm(),
    /** The object's storage: its next alarm, and whether it holds anything. */
    object: (executionId: string) => storages.get(executionId),
    restart: () => void (hosts = new Map()),
  }
}
