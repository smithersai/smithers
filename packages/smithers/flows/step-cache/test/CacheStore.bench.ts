import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import { afterAll, beforeAll, describe, test } from "vitest"
import * as CacheStore from "../src/CacheStore.ts"
import * as Migrations from "../src/Migrations.ts"

const storesLayer = Layer.provideMerge(
  CacheStore.layer,
  Layer.provideMerge(Migrations.layer, TestDatabase.layer)
)

const sampleResult = {
  files: ["src/index.ts", "src/Plan.ts", "src/StepKey.ts"],
  metrics: { elapsedMs: 42, tokens: 1_250 },
  summary: "sealed step output payload for cache benchmark"
}

let runtime: ManagedRuntime.ManagedRuntime<CacheStore.CacheStore, unknown>
let putCounter = 0

beforeAll(async () => {
  runtime = ManagedRuntime.make(storesLayer)
  await runtime.runPromise(
    Effect.gen(function*() {
      const store = yield* CacheStore.CacheStore
      for (let index = 0; index < 100; index++) {
        yield* store.put({
          keyDigest: `key1_${index.toString(16).padStart(64, "0")}`,
          result: sampleResult,
          meta: { source: "bench", slot: index },
          createdAtMs: 1_000 + index,
          recordedRunId: "bench-run-1",
          recordedEventSeq: index
        })
      }
    })
  )
})

afterAll(async () => {
  await runtime.dispose()
})

const hotKey = `key1_${(42).toString(16).padStart(64, "0")}`
const missKey = `key1_${"f".repeat(64)}`

describe("CacheStore", () => {
  test("CacheStore.get (SQLite hit + bounded JSON decode)", async ({ bench }) => {
    const program = Effect.flatMap(CacheStore.CacheStore, (store) => store.get(hotKey))
    await bench("CacheStore.get hit", async () => {
      const found = await runtime.runPromise(program)
      if (Option.isNone(found)) throw new Error("expected cache hit")
    }).run({ time: 150, warmupTime: 30 })
  })

  test("CacheStore.get (SQLite miss)", async ({ bench }) => {
    const program = Effect.flatMap(CacheStore.CacheStore, (store) => store.get(missKey))
    await bench("CacheStore.get miss", async () => {
      const found = await runtime.runPromise(program)
      if (Option.isSome(found)) throw new Error("expected cache miss")
    }).run({ time: 150, warmupTime: 30 })
  })

  test("CacheStore.get (fenced provenance lookup)", async ({ bench }) => {
    const program = Effect.flatMap(
      CacheStore.CacheStore,
      (store) => store.get(hotKey, { recordedBy: { runId: "bench-run-1", eventSeq: 42 } })
    )
    await bench("CacheStore.get fenced", async () => {
      const found = await runtime.runPromise(program)
      if (Option.isNone(found)) throw new Error("expected fenced cache hit")
    }).run({ time: 150, warmupTime: 30 })
  })

  test("CacheStore.put (fresh entry insert + admission)", async ({ bench }) => {
    await bench("CacheStore.put insert", async () => {
      const index = putCounter++
      await runtime.runPromise(
        Effect.flatMap(CacheStore.CacheStore, (store) =>
          store.put({
            keyDigest: `key1_${(10_000 + index).toString(16).padStart(64, "0")}`,
            result: sampleResult,
            meta: { source: "bench", slot: index },
            createdAtMs: 10_000 + index,
            recordedRunId: "bench-run-put",
            recordedEventSeq: index
          }))
      )
    }).run({ time: 150, warmupTime: 30 })
  })
})
