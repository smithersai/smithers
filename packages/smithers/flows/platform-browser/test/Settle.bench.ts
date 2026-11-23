/**
 * What one run costs the leader's engine, from admission to settlement, over
 * the leader's store in OPFS (`test/fixtures/MemoryOpfs.ts`, wa-sqlite's
 * access-handle pool over in-memory files).
 *
 * Run: `pnpm exec vitest bench --run` in this package.
 */
import { FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as ManagedRuntime from "effect/ManagedRuntime"
import { afterAll, beforeAll, describe, test } from "vitest"
import { BrowserRuntime } from "../src/index.ts"
import { registration, Steps } from "./fixtures/Flows.ts"
import * as MemoryOpfs from "./fixtures/MemoryOpfs.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"

let remove: () => void = () => undefined
let runtime: ManagedRuntime.ManagedRuntime<FlowRuntime.FlowRuntime, unknown>
let next = 0

beforeAll(async () => {
  remove = MemoryOpfs.install()
  runtime = ManagedRuntime.make(
    BrowserRuntime.layerHost({ name: "settle-bench", sqlite: MemorySqlite.build }, registration(Effect.succeed))
  )
  await runtime.runPromise(settle(1))
})

afterAll(async () => {
  await runtime.dispose()
  remove()
})

/** Admits `count` runs at once and waits for every one to settle. */
const settle = (count: number) =>
  Effect.flatMap(FlowRuntime.FlowRuntime, (flows) =>
    Effect.forEach(
      Array.from({ length: count }, () => `run-${next++}`),
      (executionId) => flows.execute(Steps, { executionId, payload: { prefix: executionId } }),
      { concurrency: "unbounded", discard: true }
    ))

describe("a run from admission to settlement", () => {
  test("one run at a time", async ({ bench }) => {
    await bench("settle 1 run", async () => {
      await runtime.runPromise(settle(1))
    }).run({ iterations: 5, warmupIterations: 1, time: 0, warmupTime: 0 })
  })

  test("ten runs at once", async ({ bench }) => {
    await bench("settle 10 concurrent runs", async () => {
      await runtime.runPromise(settle(10))
    }).run({ iterations: 2, warmupIterations: 1, time: 0, warmupTime: 0 })
  })
})
