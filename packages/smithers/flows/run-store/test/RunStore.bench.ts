import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { afterAll, beforeAll, describe, test } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/Ownership.ts"
import * as RunStore from "../src/RunStore.ts"

const storesLayer = Layer.provideMerge(
  RunStore.layer,
  Layer.provideMerge(Migrations.layer, TestDatabase.layer)
)

const owner: OwnerId = { hostId: "bench-host", pid: 4242, nonce: "bench-nonce" }
const statePayload = JSON.stringify({ step: 12, status: "active", items: ["a", "b", "c", "d"] })

let runtime: ManagedRuntime.ManagedRuntime<RunStore.RunStore, unknown>
let createCounter = 0

beforeAll(async () => {
  runtime = ManagedRuntime.make(storesLayer)
  await runtime.runPromise(
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const now = yield* Clock.currentTimeMillis
      yield* store.create("bench-active-run", statePayload)
      const pending = yield* store.get("bench-active-run")
      const snapshot = { status: pending.status, owner: pending.owner, heartbeatAtMs: pending.heartbeatAtMs }
      yield* store.claimAndOwn("bench-active-run", snapshot, owner, now)
      for (let round = 0; round < 10; round++) {
        yield* store.create(
          round === 0 ? "bench-lineage-root" : `bench-lineage-r${round}`,
          statePayload,
          round === 0
            ? undefined
            : {
              parentRunId: round === 1 ? "bench-lineage-root" : `bench-lineage-r${round - 1}`,
              lineageId: "bench-lineage-root",
              roundOrdinal: round
            }
        )
      }
    })
  )
})

afterAll(async () => {
  await runtime.dispose()
})

describe("RunStore", () => {
  test("RunStore.get (single row + JSON admission)", async ({ bench }) => {
    const program = Effect.flatMap(RunStore.RunStore, (store) => store.get("bench-active-run"))
    await bench("RunStore.get", async () => {
      await runtime.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("RunStore.heartbeat (fenced lease renewal)", async ({ bench }) => {
    const program = Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const now = yield* Clock.currentTimeMillis
      const outcome = yield* store.heartbeat("bench-active-run", owner, now)
      if (outcome._tag !== "Updated") throw new Error(`unexpected outcome: ${outcome._tag}`)
    })
    await bench("RunStore.heartbeat", async () => {
      await runtime.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })

  test("RunStore.create + claimAndOwn (full activation lifecycle)", async ({ bench }) => {
    await bench("RunStore.create + claimAndOwn", async () => {
      const runId = `bench-life-${createCounter++}`
      await runtime.runPromise(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const now = yield* Clock.currentTimeMillis
          yield* store.create(runId, statePayload)
          const outcome = yield* store.claimAndOwn(
            runId,
            { status: "pending", owner: null, heartbeatAtMs: null },
            owner,
            now
          )
          if (outcome._tag !== "Activated") throw new Error(`unexpected outcome: ${outcome._tag}`)
        })
      )
    }).run({ time: 150, warmupTime: 30 })
  })

  test("RunStore.lineage (10-round metadata scan)", async ({ bench }) => {
    const program = Effect.flatMap(
      RunStore.RunStore,
      (store) => store.lineage("bench-lineage-root", { includeState: false })
    )
    await bench("RunStore.lineage 10 rounds", async () => {
      await runtime.runPromise(program)
    }).run({ time: 150, warmupTime: 30 })
  })
})
