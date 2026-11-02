/**
 * What restoring TanStack DB's persisted collections costs over the shared
 * database. Every `execute` or `executeBatch` a tab calls is one request to
 * the leader, a round trip over the channel of about 2 ms in a browser, and
 * the app restores about 40 collections as it starts, so each restore must
 * take a handful of requests, not one per statement. Before batches, each of
 * these collections took 38.75 requests (310 for 8).
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { SharedSqlite } from "../src/index.ts"
import * as Engines from "./fixtures/Engines.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"
import * as Restore from "./fixtures/Restore.ts"

describe("restoring persisted collections over SharedSqlite", () => {
  it.live("takes about five requests per collection, and restores every row", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      yield* Engines.leader(
        name,
        Engines.engineWithApp(name, yield* MemorySqlite.open, Engines.steps(), yield* MemorySqlite.pool)
      )
      const { expected, ids } = Restore.fixture(8, 5)

      // The first program stores the rows.
      const first = yield* Effect.promise(() => SharedSqlite.open({ name }))
      const writer = Restore.program(first, name, ids)
      yield* Effect.promise(async () => {
        await writer.restore()
        await writer.store(expected)
        await writer.dispose()
        await first.close()
      })

      // The next program restores them: the schema once per adapter, then per collection its registration, its
      // tables, its leadership term, its stream position and its rows.
      const { count, database } = Restore.counted(yield* Effect.promise(() => SharedSqlite.open({ name })))
      const reader = Restore.program(database, name, ids)
      yield* Effect.promise(() => reader.restore())
      expect(reader.rows()).toEqual(expected)
      yield* Effect.promise(async () => {
        await reader.dispose()
        await database.close()
      })
      expect(count.requests / ids.length).toBeLessThanOrEqual(6)
    }).pipe(Effect.scoped))
})
