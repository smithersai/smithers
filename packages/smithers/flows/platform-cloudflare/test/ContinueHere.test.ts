/**
 * A lineage that runs in one Durable Object: `continueHere` keeps a `.to()` handoff's next round in the object that
 * drove the round before it, over that object's own SQLite (`fixtures/SqliteStorage.ts`), instead of routing it to an
 * object of its own. A singleton object, such as a repository's, drives one lineage forever this way; every round is
 * still the engine's own execution, journaled and resumed by the engine.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { CloudflareRuntime, ExecutionObject, ObjectDatabase } from "../src/index.ts"
import * as MemoryStorage from "./fixtures/MemoryStorage.ts"
import { Counter, flows, registration } from "./fixtures/NestedFlows.ts"
import * as SqliteStorage from "./fixtures/SqliteStorage.ts"

const hostId = "repository-object"

/** Every start or wake a router was asked for: nothing a kept lineage does reaches another object. */
const routedTo: Array<string> = []
const unrouted: ExecutionObject.Router = {
  start: (intent) => Effect.sync(() => void routedTo.push(`start ${intent.flow}`)),
  wake: (executionId) => Effect.sync(() => void routedTo.push(`wake ${executionId}`))
}

const object = (options: { readonly continueHere?: ExecutionObject.ContinueHere; readonly router?: ExecutionObject.Router } = {}) => {
  const store = SqliteStorage.make()
  const memory = MemoryStorage.make()
  const steps: Array<string> = []
  const host = ExecutionObject.make(memory.storage, {
    flows,
    runtime: (intent) =>
      CloudflareRuntime.layer(
        { hostId, executionId: intent.executionId, flow: intent.flow },
        registration((label) => Effect.sync(() => steps.push(label)).pipe(Effect.as(label)))
      ).pipe(Layer.provide(ObjectDatabase.layer(store.storage))),
    router: options.router ?? unrouted,
    settledRetentionMs: 0,
    ...(options.continueHere === undefined ? {} : { continueHere: options.continueHere })
  })
  const runs = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ readonly status: string }>`SELECT status FROM flows_runs ORDER BY created_at_ms, round_ordinal`
  }).pipe(Effect.provide(ObjectDatabase.layer(store.storage)))
  return { host, memory, steps, runs }
}

describe("ExecutionObject continueHere", () => {
  it.effect("keeps each next round in the object that drove the one before it, and settles the last", () => {
    const o = object({ continueHere: (intent) => intent.flow === Counter._tag })
    routedTo.length = 0
    return Effect.gen(function*() {
      const intent = yield* ExecutionObject.intent(Counter, { executionId: "lineage", payload: { value: 0, target: 3 } })
      yield* o.host.start(intent)
      const outcomes: Array<string> = []
      const held: Array<string> = []
      for (let alarm = 0; alarm < 4; alarm++) {
        const outcome = yield* o.host.alarm()
        outcomes.push(outcome._tag)
        const raw = o.memory.values.get(ExecutionObject.intentKey) as string | undefined
        held.push(raw === undefined ? "" : JSON.parse(raw).executionId)
        if (outcome._tag === "Continued") {
          expect(outcome.executionId).toBe(held.at(-1))
          expect(o.memory.alarm()).not.toBeNull()
        }
      }
      expect(outcomes).toEqual(["Continued", "Continued", "Settled", "Forgotten"])
      // The settled last round is forgotten at its next alarm; the object holds nothing.
      expect(held[3]).toBe("")
      expect(o.steps).toEqual(["bump:0", "bump:1", "bump:2"])
      // Neither the admission shortcut nor the routing after the drive started a round elsewhere.
      expect(routedTo).toEqual([])
      // Each round is its own execution in the object's one store, the first under the id it was started with.
      expect(held[0]).not.toBe("lineage")
      expect(held[1]).not.toBe(held[0])
      expect(held[2]).toBe(held[1])
      expect((yield* o.runs).map((run) => run.status)).toEqual(["completed", "completed", "completed"])
    })
  })

  it.effect("refuses a second start of the lineage while it runs: nothing runs twice", () => {
    const o = object({ continueHere: (intent) => intent.flow === Counter._tag })
    return Effect.gen(function*() {
      const intent = yield* ExecutionObject.intent(Counter, { executionId: "lineage", payload: { value: 0, target: 5 } })
      yield* o.host.start(intent)
      expect((yield* o.host.alarm())._tag).toBe("Continued")
      const again = yield* Effect.flip(o.host.start(intent))
      expect(again._tag).toBe("@smthrs/platform-cloudflare/IntentConflict")
      expect(o.steps).toEqual(["bump:0"])
    })
  })

  it.effect("routes a next round it does not claim, as before", () => {
    const routed: Array<string> = []
    const o = object({
      continueHere: () => false,
      router: { start: (intent) => Effect.sync(() => void routed.push(intent.flow)), wake: () => Effect.void }
    })
    return Effect.gen(function*() {
      yield* TestClock.setTime(Date.now())
      const intent = yield* ExecutionObject.intent(Counter, { executionId: "lineage", payload: { value: 0, target: 3 } })
      yield* o.host.start(intent)
      expect((yield* o.host.alarm())._tag).toBe("Settled")
      expect(routed).toEqual([Counter._tag])
    })
  })
})
