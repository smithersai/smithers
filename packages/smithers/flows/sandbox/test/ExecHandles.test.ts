import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { collectEvery, started } from "../src/internal/execHandles.ts"
import { GarbageCollector, layerGarbageCollectorNoop } from "../src/MicrosandboxSandbox/GarbageCollector.ts"

/** A collector that counts its collections. */
const counting = () => {
  const counted = { collections: 0 }
  const collector: GarbageCollector = {
    collect: Effect.sync(() => {
      counted.collections++
    })
  }
  return { counted, collector }
}

describe("exec handle release", () => {
  it.effect("collects through the host's collector every so many starts", () =>
    Effect.gen(function*() {
      const { collector, counted } = counting()
      for (let start = 0; start < 7; start++) yield* started(collector, 3)
      expect(counted.collections).toBe(2)
    }))

  it.effect("counts each collector's starts on their own, so one heap's count is never another's", () =>
    Effect.gen(function*() {
      const first = counting()
      const second = counting()
      for (let start = 0; start < 2; start++) yield* started(first.collector, 3)
      yield* started(second.collector, 3)
      expect([first.counted.collections, second.counted.collections]).toEqual([0, 0])
      yield* started(first.collector, 3)
      expect([first.counted.collections, second.counted.collections]).toEqual([1, 0])
    }))

  it.effect("collects every collectEvery starts by default, far below the handles a machine refuses at", () =>
    Effect.gen(function*() {
      const { collector, counted } = counting()
      for (let start = 1; start < collectEvery; start++) yield* started(collector)
      expect(counted.collections).toBe(0)
      yield* started(collector)
      expect(counted.collections).toBe(1)
      expect(collectEvery).toBeLessThan(140)
    }))

  it.effect("provides a collector that collects nothing, for a host without one", () =>
    Effect.gen(function*() {
      const collector = yield* GarbageCollector
      expect(collector.collect).toBe(Effect.void)
      expect(yield* Effect.exit(collector.collect)).toEqual(Exit.void)
      for (let start = 0; start < collectEvery; start++) yield* started(collector)
    }).pipe(Effect.provide(layerGarbageCollectorNoop)))
})
