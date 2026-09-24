import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as MapReduce from "../src/MapReduce.ts"
import { PatternError } from "../src/PatternError.ts"
import { callsTo } from "./Graphs.ts"

// One member per phase, because a `@smthrs/flow` flow declares the payload it
// takes and the two phases take different ones. Counting calls by tag is also
// what the old `FlowCall` count meant: five map calls and one reduce call.
const step = Flow.make("map", {
  payload: { shard: Schema.Unknown, index: Schema.Unknown, input: Schema.Unknown },
  success: Schema.Unknown,
  body: ({ shard }) => Node.succeed(shard)
})

const reducer = Flow.make("reduce", {
  payload: { input: Schema.Unknown, mapped: Schema.Unknown },
  success: Schema.Unknown,
  body: ({ mapped }) => Node.succeed(mapped)
})

const declaration = (shards: unknown): { readonly shards: unknown } => ({ shards })

describe("MapReduce", () => {
  it("declares deterministic map and reduce phases", () => {
    const mapReduce = MapReduce.make({
      map: step,
      reduce: reducer,
      concurrency: 4,
      onEmpty: "reduce"
    })

    expect(Flow.isFlow(mapReduce)).toBe(true)
    expect(mapReduce.body(declaration(["a", "b"])).ast._tag).toBe("AndThen")
    const graph = Graph.build(mapReduce, { shards: ["a", "b", "c", "d", "e"] })
    expect(callsTo(graph, "map")).toHaveLength(5)
    expect(callsTo(graph, "reduce")).toHaveLength(1)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(2)
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const mapReduce = MapReduce.make({
      name: "shard-the-tree",
      description: "Map every shard and reduce the answers.",
      map: step,
      reduce: reducer,
      concurrency: 1,
      onEmpty: "reduce"
    })

    expect(mapReduce._tag).toBe("shard-the-tree")
    expect(mapReduce.description).toBe("Map every shard and reduce the answers.")
    expect(MapReduce.make({ map: step, reduce: reducer, concurrency: 1, onEmpty: "reduce" }).description)
      .toBeUndefined()
  })

  it("rejects invalid concurrency", () => {
    expect(() => MapReduce.make({ map: step, reduce: reducer, concurrency: 0, onEmpty: "fail" })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "MapReduce concurrency must be a positive safe integer"
      })
    )
  })

  it("declares every empty-shard policy", () => {
    const reduce = MapReduce.make({ map: step, reduce: reducer, concurrency: 1, onEmpty: "reduce" })
    const succeed = MapReduce.make({ map: step, reduce: reducer, concurrency: 1, onEmpty: "succeed" })
    const fail = MapReduce.make({ map: step, reduce: reducer, concurrency: 1, onEmpty: "fail" })

    expect(reduce.body(declaration([])).ast._tag).toBe("FlowCall")
    expect(callsTo(Graph.build(reduce, { shards: [] }), "reduce")).toHaveLength(1)
    expect(succeed.body(declaration([])).ast).toMatchObject({ _tag: "Succeed", value: [] })
    expect(callsTo(Graph.build(succeed, { shards: [] }), "reduce")).toHaveLength(0)
    expect(fail.body(declaration([])).ast).toMatchObject({
      _tag: "Fail",
      error: { code: "exhausted", message: "MapReduce received no shards" }
    })
  })

  it("refuses a declaration input without a shards array", () => {
    const mapReduce = MapReduce.make({ map: step, reduce: reducer, concurrency: 1, onEmpty: "reduce" })

    expect(() => mapReduce.body({ shard: [] } as unknown as { readonly shards: unknown })).toThrow(
      expect.objectContaining({
        code: "invalid_input",
        message: "MapReduce input must contain a shards array"
      })
    )
  })

  it.effect("runs every batch and reduces mapped values in shard order", () =>
    Effect.gen(function*() {
      const result = yield* MapReduce.run({ shards: [1, 2, 3, 4, 5] }, {
        concurrency: 2,
        onEmpty: "reduce",
        map: ({ index, shard }) => Effect.succeed(`${index}:${shard * 2}`),
        reduce: ({ mapped }) => Effect.succeed(mapped.join("|"))
      })

      expect(result).toBe("0:2|1:4|2:6|3:8|4:10")
    }))

  it.effect("returns mapped values in declaration order rather than completion order", () =>
    Effect.gen(function*() {
      const gates = yield* Effect.all([Latch.make(), Latch.make(), Latch.make()])
      const finished = yield* Effect.all([Latch.make(), Latch.make(), Latch.make()])
      const allStarted = yield* Latch.make()
      const completionOrder: Array<number> = []
      let started = 0

      const running = yield* MapReduce.run({ shards: ["a", "b", "c"] }, {
        concurrency: 3,
        onEmpty: "reduce",
        map: ({ index, shard }) =>
          Effect.gen(function*() {
            started += 1
            if (started === 3) yield* Latch.open(allStarted)
            yield* Latch.await(gates[index]!)
            completionOrder.push(index)
            yield* Latch.open(finished[index]!)
            return `${index}:${shard}`
          }),
        reduce: ({ mapped }) => Effect.succeed(mapped)
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Latch.await(allStarted)
      for (const index of [2, 1, 0]) {
        yield* Latch.open(gates[index]!)
        yield* Latch.await(finished[index]!)
      }
      const result = yield* Fiber.join(running)

      expect(completionOrder).toEqual([2, 1, 0])
      expect(result).toEqual(["0:a", "1:b", "2:c"])
    }))

  it.effect("applies every runtime empty-input policy and validates concurrency", () =>
    Effect.gen(function*() {
      const callbacks = {
        map: ({ shard }: { readonly shard: number }) => Effect.succeed(shard * 2),
        reduce: ({ mapped }: { readonly mapped: ReadonlyArray<number> }) => Effect.succeed(mapped.length)
      }
      const invalid = yield* MapReduce.run({ shards: [] as ReadonlyArray<number> }, {
        ...callbacks,
        concurrency: 0,
        onEmpty: "reduce"
      }).pipe(Effect.flip)
      const failed = yield* MapReduce.run({ shards: [] as ReadonlyArray<number> }, {
        ...callbacks,
        concurrency: 1,
        onEmpty: "fail"
      }).pipe(Effect.flip)
      const succeeded = yield* MapReduce.run({ shards: [] as ReadonlyArray<number> }, {
        ...callbacks,
        concurrency: 1,
        onEmpty: "succeed"
      })
      const reduced = yield* MapReduce.run({ shards: [] as ReadonlyArray<number> }, {
        ...callbacks,
        concurrency: 1,
        onEmpty: "reduce"
      })

      expect(invalid).toBeInstanceOf(PatternError)
      expect(invalid.code).toBe("invalid_decorator")
      expect(invalid.message).toBe("MapReduce concurrency must be a positive safe integer")
      expect(failed).toBeInstanceOf(PatternError)
      expect(failed.code).toBe("exhausted")
      expect(failed.message).toBe("MapReduce received no shards")
      expect(succeeded).toEqual([])
      expect(reduced).toBe(0)
    }))

  it.effect("defers empty-shard reduction and rebuilds it for every execution", () =>
    Effect.gen(function*() {
      let constructions = 0
      const reduced = MapReduce.run({ shards: [] as ReadonlyArray<number> }, {
        concurrency: 1,
        onEmpty: "reduce",
        map: ({ shard }) => Effect.succeed(shard * 2),
        reduce: ({ mapped }) => {
          constructions += 1
          return Effect.succeed(mapped.length + constructions)
        }
      })

      expect(constructions).toBe(0)
      expect(yield* reduced).toBe(1)
      expect(constructions).toBe(1)
      expect(yield* reduced).toBe(2)
      expect(constructions).toBe(2)
    }))
})
