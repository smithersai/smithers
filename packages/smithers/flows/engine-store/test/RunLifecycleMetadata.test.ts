import { describe, expect, it } from "@effect/vitest"
import { RunStore } from "@smthrs/run-store"
import { Effect, Layer } from "effect"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunLifecycle from "../src/internal/RunLifecycle.ts"
import * as TestStores from "../src/test/TestStores.ts"

const layer = Layer.mergeAll(RunStore.layer, DurableEngineState.layer).pipe(Layer.provideMerge(TestStores.database))

describe("lifecycle lineage projection", () => {
  it.effect("reads metadata for historical rounds and preserves descendant discovery", () =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const state = yield* DurableEngineState.DurableEngineState
      yield* store.create("root", "{}")
      yield* store.create("round", "{\"payload\":\"historical state\"}", {
        lineageId: "root",
        roundOrdinal: 1,
        parentRunId: "root"
      })
      yield* store.create("child", "{}", { parentRunId: "root" })
      yield* state.recordRunParent("child", "root")
      const lifecycle = RunLifecycle.make(store, state)
      const rounds = yield* lifecycle.rounds("round")
      expect(rounds.map((row) => row.runId)).toEqual(["root", "round"])
      expect(rounds.every((row) => !Object.hasOwn(row, "stateJson"))).toBe(true)
      expect(yield* lifecycle.descendants("round")).toEqual(["root", "child"])
      expect(yield* lifecycle.rounds("missing")).toEqual([])
    }).pipe(Effect.provide(layer)))
})
