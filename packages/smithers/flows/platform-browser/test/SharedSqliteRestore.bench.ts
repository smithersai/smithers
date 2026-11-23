/**
 * What restoring the app's persisted collections at boot costs over the
 * shared database: 40 collections of 20 rows, each request to the leader
 * delayed 2 ms first, as a round trip over a browser's channel to the engine
 * worker costs. Each case restores them from a stored database in a new
 * program, as a page load does, with TanStack DB's persistence sending
 * batches (`executeBatch`) or, as before batches, one request per statement.
 *
 * Run: `pnpm exec vitest bench --run` in this package.
 */
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { afterAll, beforeAll, describe, test } from "vitest"
import { SharedSqlite } from "../src/index.ts"
import * as Engines from "./fixtures/Engines.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"
import * as Restore from "./fixtures/Restore.ts"

const name = Engines.name()
const { expected, ids } = Restore.fixture(40, 20)
let leader: Fiber.Fiber<unknown, unknown> | undefined

beforeAll(async () => {
  // The leader serves until the benchmarks end.
  leader = Effect.runFork(
    Effect.gen(function*() {
      const pool = yield* MemorySqlite.pool
      yield* Engines.leader(name, Engines.engineWithApp(name, yield* MemorySqlite.open, Engines.steps(), pool))
      return yield* Effect.never
    }).pipe(Effect.scoped)
  )
  const database = await SharedSqlite.open({ name })
  const writer = Restore.program(database, name, ids)
  await writer.restore()
  await writer.store(expected)
  await writer.dispose()
  await database.close()
})

afterAll(async () => {
  if (leader !== undefined) await Effect.runPromise(Fiber.interrupt(leader))
})

const restoreOnce = async (batching: Restore.Batching) => {
  const { database } = Restore.counted(await SharedSqlite.open({ name }), { latencyMs: 2, batching })
  const reader = Restore.program(database, name, ids)
  await reader.restore()
  if (JSON.stringify(reader.rows()) !== JSON.stringify(expected)) throw new Error("restored other rows")
  await reader.dispose()
  await database.close()
}

describe("restoring 40 persisted collections with 2 ms round trips", () => {
  test("one request per statement", async ({ bench }) => {
    await bench("restore unbatched", async () => {
      await restoreOnce("one request per statement")
    }).run({ iterations: 1, warmupIterations: 0, time: 0, warmupTime: 0 })
  })

  test("batched", async ({ bench }) => {
    await bench("restore batched", async () => {
      await restoreOnce("batched")
    }).run({ iterations: 1, warmupIterations: 0, time: 0, warmupTime: 0 })
  })
})
