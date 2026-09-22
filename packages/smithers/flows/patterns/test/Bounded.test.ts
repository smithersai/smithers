import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Bounded from "../src/Bounded.ts"
import { PatternError } from "../src/PatternError.ts"
import { callsTo } from "./Graphs.ts"

const worker = Flow.make("worker", {
  payload: { input: Schema.Unknown },
  success: Schema.Unknown,
  body: ({ input }) => Node.succeed(input)
})

const members = (names: ReadonlyArray<string>): Record<string, Node.Any> =>
  Object.fromEntries(names.map((name) => [name, worker.call({ input: name }) as Node.Any]))

const invalidPriorities = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 2 ** 53]

const graphOf = (node: Node.Node<unknown, unknown, any>): Graph.Graph =>
  Graph.build(
    Flow.make("bounded/host", { payload: { input: Schema.Unknown }, success: Schema.Unknown, body: () => node }),
    { input: undefined }
  )

const memberNode = (graph: Graph.Graph, name: string): Graph.GraphNode | undefined =>
  Graph.nodes(graph).find((node) => node.id.endsWith(`.all.${name}`))

describe("Bounded", () => {
  it("splits members into sequential batches of the declared width", () => {
    const graph = graphOf(Bounded.all(members(["a", "b", "c", "d", "e"]), { concurrency: 2 }))
    const joins = Graph.nodes(graph).filter((node) => node.kind === "All")

    expect(joins).toHaveLength(3)
    expect(callsTo(graph, "worker")).toHaveLength(5)
  })

  it("runs a higher priority member in an earlier batch", () => {
    const graph = graphOf(
      Bounded.all(
        { ...members(["a", "b", "c"]), late: Node.priority(worker.call({ input: "late" }) as Node.Any, 9) },
        { concurrency: 2 }
      )
    )
    const batchOf = (name: string): string | undefined => memberNode(graph, name)?.id.split(".all.")[0]

    expect(batchOf("late")).toBe(batchOf("a"))
    expect(batchOf("b")).toBe(batchOf("c"))
    expect(batchOf("late")).not.toBe(batchOf("b"))
  })

  it("applies the container priority only to members that declare none", () => {
    const graph = graphOf(
      Bounded.all(
        { ...members(["a"]), urgent: Node.priority(worker.call({ input: "urgent" }) as Node.Any, 9) },
        { concurrency: 2, priority: 3 }
      )
    )

    expect(memberNode(graph, "a")?.draft.priority).toBe(3)
    expect(memberNode(graph, "urgent")?.draft.priority).toBe(9)
  })

  it("rejects an empty record and an invalid width", () => {
    expect(() => Bounded.all({}, { concurrency: 2 })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Bounded requires at least one member" })
    )
    expect(() => Bounded.all(members(["a"]), { concurrency: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Bounded concurrency must be a positive safe integer, received 0"
      })
    )
  })

  it("refuses every unsafe effective member priority at declaration time", () => {
    for (const priority of invalidPriorities) {
      expect(() => Bounded.all(members(["unstable"]), { concurrency: 1, priority })).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: `Bounded priority for member "unstable" must be a safe integer, received ${priority}`
        })
      )
    }
  })

  it.effect("keeps run within the concurrency bound and starts the highest priority first", () =>
    Effect.gen(function*() {
      // Both admitted members park on a gate the test holds shut, so the third
      // cannot start until the test opens it. What `started` reports is the
      // bound, not a yield ordering.
      const gate = yield* Latch.make(false)
      const admitted = yield* Latch.make(false)
      const started: Array<string> = []
      let live = 0
      let peak = 0
      const member = (name: string) =>
        Effect.gen(function*() {
          started.push(name)
          live = live + 1
          peak = Math.max(peak, live)
          if (started.length === 2) yield* admitted.open
          yield* gate.await
          live = live - 1
          return name.toUpperCase()
        })

      const fiber = yield* Effect.forkChild(
        Bounded.run(
          { a: member("a"), b: member("b"), c: member("c"), d: member("d"), e: member("e") },
          { concurrency: 2, priorities: { e: 9 } }
        ),
        { startImmediately: true }
      )
      yield* admitted.await
      expect(started).toHaveLength(2)
      expect(started[0]).toBe("e")

      yield* gate.open
      const values = yield* Fiber.join(fiber)

      expect(peak).toBe(2)
      expect(values).toEqual({ a: "A", b: "B", c: "C", d: "D", e: "E" })
    }))

  it.effect("reads only own per-member priorities for prototype-shaped names", () =>
    Effect.gen(function*() {
      const starts: Array<string> = []
      const member = (name: string) => Effect.sync(() => (starts.push(name), name))
      const declared = Object.fromEntries([
        ["low", member("low")],
        ["constructor", member("constructor")],
        ["high", member("high")]
      ])

      yield* Bounded.run(declared, { concurrency: 1, priorities: { low: 1, high: 10 } })
      expect(starts).toEqual(["high", "low", "constructor"])

      starts.length = 0
      yield* Bounded.run(declared, { concurrency: 1, priorities: { low: 1, constructor: 5, high: 10 } })
      expect(starts).toEqual(["high", "constructor", "low"])
    }))

  it.effect("returns own data properties for prototype-shaped member names", () =>
    Effect.gen(function*() {
      const names = ["__proto__", "constructor", "toString", "normal"]
      const result = yield* Bounded.run(
        Object.fromEntries(names.map((name) => [name, Effect.succeed(`${name}-value`)])),
        { concurrency: 2 }
      )

      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      for (const name of names) {
        expect(Object.hasOwn(result, name)).toBe(true)
        expect(result[name]).toBe(`${name}-value`)
      }
    }))

  it.effect("round-trips generated record keys as own properties", () =>
    Effect.gen(function*() {
      const candidates = ["__proto__", "constructor", "toString", "", "0", "10", "雪", "é", "💾"]
      let seed = 0x51a7e
      const generated = Array.from({ length: 64 }, () => {
        const remaining = [...candidates]
        const ids: Array<string> = []
        while (remaining.length > 0) {
          seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
          ids.push(remaining.splice(seed % remaining.length, 1)[0]!)
        }
        return ids
      })

      for (const ids of generated) {
        const expected = new Map(ids.map((id, index) => [id, `${index}:${id}`]))
        const declared = Object.create(null) as Record<string, Effect.Effect<string>>
        for (const [id, value] of expected) {
          Object.defineProperty(declared, id, {
            configurable: true,
            enumerable: true,
            value: Effect.succeed(value),
            writable: true
          })
        }

        const result = yield* Bounded.run(declared, { concurrency: 3 })

        for (const [id, value] of expected) {
          expect(Object.hasOwn(result, id)).toBe(true)
          expect(result[id]).toBe(value)
        }
      }
    }))

  it.effect("refuses every unsafe member priority before running a member", () =>
    Effect.gen(function*() {
      let ran = 0
      for (const priority of invalidPriorities) {
        const failure = yield* Effect.flip(
          Bounded.run(
            { unstable: Effect.sync(() => (ran += 1)) },
            { concurrency: 1, priorities: { unstable: priority } }
          )
        )

        expect(failure).toBeInstanceOf(PatternError)
        expect(failure.code).toBe("invalid_decorator")
        expect(failure.message).toBe(
          `Bounded priority for member "unstable" must be a safe integer, received ${priority}`
        )
      }
      expect(ran).toBe(0)
    }))

  it.effect("refuses a priority for an unknown member", () =>
    Effect.gen(function*() {
      let ran = 0
      const failure = yield* Effect.flip(
        Bounded.run(
          { known: Effect.sync(() => (ran += 1, "done")) },
          { concurrency: 1, priorities: { typo: 10 } }
        )
      )

      expect(failure).toBeInstanceOf(PatternError)
      expect(failure.code).toBe("invalid_decorator")
      expect(failure.message).toBe("Bounded declares a priority for the unknown member \"typo\"")
      expect(ran).toBe(0)
    }))

  // `run` refuses with a TYPED failure, not a defect: a caller that composes it
  // has `PatternError` in the error channel and must be able to recover with
  // `Effect.catchTag`. A thrown refusal would be a `Die` no handler can claim.
  it.effect("fails run with a typed PatternError for an empty record or an invalid width", () =>
    Effect.gen(function*() {
      const none: Readonly<Record<string, Effect.Effect<number>>> = {}
      const empty = yield* Effect.flip(Bounded.run(none, { concurrency: 1 }))
      const width = yield* Effect.flip(Bounded.run({ a: Effect.succeed(1) }, { concurrency: -1 }))

      expect(empty).toBeInstanceOf(PatternError)
      expect(empty.code).toBe("invalid_decorator")
      expect(empty.message).toBe("Bounded requires at least one member")
      expect(width).toBeInstanceOf(PatternError)
      expect(width.code).toBe("invalid_decorator")
      expect(width.message).toBe("Bounded concurrency must be a positive safe integer, received -1")
    }))

  it.effect("lets a caller recover the run refusal by tag", () =>
    Effect.gen(function*() {
      const none: Readonly<Record<string, Effect.Effect<number>>> = {}
      const recovered = yield* Effect.catchTag(
        Bounded.run(none, { concurrency: 1 }),
        "flows/patterns/PatternError",
        (error) => Effect.succeed(error.code)
      )

      expect(recovered).toBe("invalid_decorator")
    }))
})
