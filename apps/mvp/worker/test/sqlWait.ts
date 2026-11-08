import { Deferred, Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { testFile } from "./harness.ts"

/** A real transaction held until the test releases it; its writes are always rolled back. */
export const holdSql = async (runtime: ReturnType<typeof testFile>, lock: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>) => {
  const ready = Deferred.makeUnsafe<number>()
  const release = Deferred.makeUnsafe<void>()
  const holder = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
    yield* lock(sql)
    const [row] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`
    yield* Deferred.succeed(ready, row!.pid)
    yield* Deferred.await(release)
    return yield* Effect.fail("test-lock-rollback" as const)
  }))).pipe(Effect.catch(error => error === "test-lock-rollback" ? Effect.void : Effect.fail(error))))
  void holder.catch(() => {})
  const pid = await Promise.race([runtime.runPromise(Deferred.await(ready)), holder.then(() => { throw new Error("lock ended before ready") })])
  return { pid, release: async () => { await runtime.runPromise(Deferred.succeed(release, undefined)); await holder } }
}
