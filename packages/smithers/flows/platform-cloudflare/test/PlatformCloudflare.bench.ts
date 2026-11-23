import { ImmutableCache } from "@smthrs/artifacts"
import * as Dialect from "@smthrs/database/Dialect"
import { OwnerIdentity } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import { afterAll, beforeAll, describe, test } from "vitest"
import { CloudflareHost, EdgeCache, ObjectDatabase } from "../src/index.ts"
import * as SqliteStorage from "./fixtures/SqliteStorage.ts"

const makeMemoryCacheStorage = (): EdgeCache.CacheStorage => {
  const buckets = new Map<string, Map<string, Response>>()
  const makeBucket = (name: string): NonNullable<EdgeCache.CacheStorage["default"]> => {
    let entries = buckets.get(name)
    if (entries === undefined) {
      entries = new Map()
      buckets.set(name, entries)
    }
    const store = entries
    return {
      match: async (request: string | Request) => {
        const key = typeof request === "string" ? request : request.url
        const hit = store.get(key)
        return hit === undefined ? undefined : hit.clone()
      },
      put: async (request: string | Request, response: Response) => {
        const key = typeof request === "string" ? request : request.url
        store.set(key, response.clone())
      }
    }
  }
  return {
    default: makeBucket("default"),
    open: async (name) => makeBucket(name)
  }
}

let dbRuntime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>
let hostRuntime: ManagedRuntime.ManagedRuntime<OwnerIdentity.OwnerIdentity | FileSystem.FileSystem, never>
let cacheRuntime: ManagedRuntime.ManagedRuntime<ImmutableCache.ImmutableCache, unknown>
let rowCounter = 0

const hotCacheKey = ImmutableCache.key("repo.blob", "acme/widgets", "0".repeat(40), "src/index.ts")
const cacheBytes = Uint8Array.from({ length: 1024 }, (_, index) => index & 0xff)

beforeAll(async () => {
  const store = SqliteStorage.make()
  dbRuntime = ManagedRuntime.make(ObjectDatabase.layer(store.storage))
  await dbRuntime.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE bench_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL, value INTEGER NOT NULL)`
      for (let index = 0; index < 100; index++) {
        yield* sql`INSERT INTO bench_rows (id, label, value) VALUES (${index}, ${`row-${index}`}, ${index * 10})`
      }
    })
  )
  hostRuntime = ManagedRuntime.make(CloudflareHost.layer)
  cacheRuntime = ManagedRuntime.make(EdgeCache.layer({ caches: makeMemoryCacheStorage() }))
  await cacheRuntime.runPromise(
    Effect.flatMap(
      ImmutableCache.ImmutableCache,
      (cache) => cache.put(hotCacheKey, { bytes: cacheBytes, metadata: { blobSha: "a".repeat(40) } })
    )
  )
})

afterAll(async () => {
  await dbRuntime.dispose()
  await hostRuntime.dispose()
  await cacheRuntime.dispose()
})

describe("@smthrs/platform-cloudflare", () => {
  test("ObjectDatabase SELECT (indexed row lookup)", async ({ bench }) => {
    const program = Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ readonly id: number; readonly label: string }>`SELECT id, label FROM bench_rows WHERE id = 42`
    )
    await bench("ObjectDatabase SELECT", async () => {
      await dbRuntime.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("ObjectDatabase withTransaction INSERT", async ({ bench }) => {
    await bench("ObjectDatabase tx INSERT", async () => {
      const id = 10_000 + rowCounter++
      await dbRuntime.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.withTransaction(
            sql`INSERT INTO bench_rows (id, label, value) VALUES (${id}, ${`tx-${id}`}, ${id})`
          ))
      )
    }).run({ time: 150, warmupTime: 30 })
  })

  test("ObjectDatabase Dialect.readTransaction", async ({ bench }) => {
    const program = Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Dialect.readTransaction(
        sql,
        sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM bench_rows`
      ))
    await bench("ObjectDatabase readTransaction", async () => {
      await dbRuntime.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("CloudflareHost OwnerIdentity.ownerId + fail-closed FS", async ({ bench }) => {
    const program = Effect.gen(function*() {
      const ids = yield* OwnerIdentity.OwnerIdentity
      const fs = yield* FileSystem.FileSystem
      yield* ids.ownerId("bench-do-1")
      yield* Effect.flip(fs.exists("/blocked"))
    })
    await bench("CloudflareHost identity + refusal", async () => {
      await hostRuntime.runPromise(program)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("EdgeCache.get (1 KiB hit)", async ({ bench }) => {
    const program = Effect.flatMap(ImmutableCache.ImmutableCache, (cache) => cache.get(hotCacheKey))
    await bench("EdgeCache.get 1 KiB hit", async () => {
      const hit = await cacheRuntime.runPromise(program)
      if (Option.isNone(hit)) throw new Error("expected cache hit")
    }).run({ time: 150, warmupTime: 30 })
  })
})
