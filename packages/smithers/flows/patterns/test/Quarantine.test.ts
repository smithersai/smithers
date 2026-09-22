import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as Quarantine from "../src/Quarantine.ts"
import { execute } from "./Execute.ts"

class Boom extends Schema.TaggedError<Boom>()("Boom", { member: Schema.String }) {}

// A member is any node, so the join's declared shape is read off three
// ordinary calls.
const model = (tag: string) =>
  Flow.make(tag, {
    payload: { model: Schema.String },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: ({ model }) => Node.succeed(model)
  })

const members = {
  alpha: model("alpha").call({ model: "a" }) as Node.Any,
  beta: model("beta").call({ model: "b" }) as Node.Any,
  gamma: model("gamma").call({ model: "c" }) as Node.Any
}

const joined = (node: Node.Node<unknown, unknown, any>) =>
  Graph.build(
    Flow.make("quarantine/host", {
      payload: { input: Schema.Unknown },
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: () => node
    }),
    { input: undefined }
  )

describe("Quarantine", () => {
  it("declares one catch per member", () => {
    const graph = joined(Quarantine.all(members, { policy: "quarantine" }))

    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "Map")).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
    // The marker a recovery arm produces lives on the node's payload; the
    // error inside it is the planned reference to the member it recovers.
    const recovery = Graph.nodes(graph).find((node) => node.id.endsWith(".all.alpha.failure"))
    expect(recovery?.draft.material.body).toEqual({ _tag: "Succeed" })
    expect(recovery?.payload).toMatchObject({ _tag: "Quarantined", member: "alpha" })
  })

  it("declares a plain join under the halt policy", () => {
    const graph = joined(Quarantine.all(members, { policy: "halt" }))

    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(0)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
  })

  it("rejects an empty member record", () => {
    expect(() => Quarantine.all({}, { policy: "quarantine" })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Quarantine requires at least one member" })
    )
  })

  it.effect("isolates a failing member and lets its siblings finish", () =>
    Effect.gen(function*() {
      const finished: Array<string> = []
      const settle = (name: string, yields: number) =>
        Effect.gen(function*() {
          for (let index = 0; index < yields; index++) yield* Effect.yieldNow
          finished.push(name)
          return `${name}-done`
        })

      const result = yield* Quarantine.run({
        alpha: settle("alpha", 3),
        beta: Effect.fail(new Boom({ member: "beta" })),
        gamma: settle("gamma", 1)
      }, { policy: "quarantine" })

      expect(result.alpha).toEqual({ _tag: "Succeeded", member: "alpha", value: "alpha-done" })
      expect(result.gamma).toEqual({ _tag: "Succeeded", member: "gamma", value: "gamma-done" })
      expect(result.beta).toEqual({
        _tag: "Quarantined",
        member: "beta",
        error: new Boom({ member: "beta" })
      })
      expect([...finished].sort()).toEqual(["alpha", "gamma"])
    }))

  it.effect("returns own data properties for prototype-shaped member names", () =>
    Effect.gen(function*() {
      const names = ["__proto__", "constructor", "toString", "normal"]
      const result = yield* Quarantine.run(
        Object.fromEntries(names.map((name) => [name, Effect.succeed(`${name}-value`)])),
        { policy: "quarantine" }
      )

      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      for (const name of names) {
        expect(Object.hasOwn(result, name)).toBe(true)
        expect(result[name]).toEqual({ _tag: "Succeeded", member: name, value: `${name}-value` })
      }
    }))

  it.effect("interrupts siblings on the first failure under the halt policy", () =>
    Effect.gen(function*() {
      const finished: Array<string> = []
      const slow = Effect.gen(function*() {
        for (let index = 0; index < 5; index++) yield* Effect.yieldNow
        finished.push("alpha")
        return "alpha-done"
      })

      const exit = yield* Effect.exit(
        Quarantine.run({ alpha: slow, beta: Effect.fail(new Boom({ member: "beta" })) }, { policy: "halt" })
      )

      expect(exit._tag).toBe("Failure")
      expect(finished).toEqual([])
    }))

  it.effect("returns every member's value under the halt policy when none fails", () =>
    Effect.gen(function*() {
      const result = yield* Quarantine.run(
        { alpha: Effect.succeed("alpha-value"), beta: Effect.succeed("beta-value") },
        { policy: "halt" }
      )

      expect(result).toEqual({ alpha: "alpha-value", beta: "beta-value" })
      expect(Object.keys(result).sort()).toEqual(["alpha", "beta"])
    }))

  it.effect("bounds how many members run at once", () =>
    Effect.gen(function*() {
      // The two admitted members park on a shut gate, so a third can only
      // start after the test opens it.
      const gate = yield* Latch.make(false)
      const admitted = yield* Latch.make(false)
      let started = 0
      let live = 0
      let peak = 0
      const member = () =>
        Effect.gen(function*() {
          started = started + 1
          live = live + 1
          peak = Math.max(peak, live)
          if (started === 2) yield* admitted.open
          yield* gate.await
          live = live - 1
          return "done"
        })

      const fiber = yield* Effect.forkChild(
        Quarantine.run(
          { a: member(), b: member(), c: member(), d: member() },
          { policy: "quarantine", concurrency: 2 }
        ),
        { startImmediately: true }
      )
      yield* admitted.await
      expect(started).toBe(2)

      yield* gate.open
      const values = yield* Fiber.join(fiber)

      expect(peak).toBe(2)
      expect(values).toEqual(Object.fromEntries(
        ["a", "b", "c", "d"].map((member) => [member, { _tag: "Succeeded", member, value: "done" }])
      ))
    }))

  it.effect("settles a clean result and fails on quarantined members", () =>
    Effect.gen(function*() {
      const clean = yield* Quarantine.settle({
        a: { _tag: "Succeeded", member: "a", value: 1 },
        b: { _tag: "Succeeded", member: "b", value: 2 }
      })
      expect(clean).toEqual({ a: 1, b: 2 })

      const error = yield* Effect.flip(
        Quarantine.settle({
          a: { _tag: "Succeeded", member: "a", value: 1 } as const,
          b: { _tag: "Quarantined", member: "b", error: new Boom({ member: "b" }) } as const,
          c: { _tag: "Quarantined", member: "c", error: new Boom({ member: "c" }) } as const
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect(error.code).toBe("quarantined")
      expect(error.message).toBe("Quarantined members: b, c")
      expect(error.cause).toEqual([
        { member: "b", error: new Boom({ member: "b" }) },
        { member: "c", error: new Boom({ member: "c" }) }
      ])
    }))

  // `run` refuses with a TYPED failure, not a defect, for the same reason
  // `settle` does: `PatternError` is in the declared error channel.
  it.effect("fails run with a typed PatternError for an empty record or an invalid width", () =>
    Effect.gen(function*() {
      const none: Readonly<Record<string, Effect.Effect<number>>> = {}
      const empty = yield* Effect.flip(Quarantine.run(none, { policy: "quarantine" }))
      const width = yield* Effect.flip(
        Quarantine.run({ a: Effect.succeed(1) }, { policy: "quarantine", concurrency: 0 })
      )

      expect(empty).toBeInstanceOf(PatternError)
      expect(empty.code).toBe("invalid_decorator")
      expect(empty.message).toBe("Quarantine requires at least one member")
      expect(width).toBeInstanceOf(PatternError)
      expect(width.code).toBe("invalid_decorator")
      expect(width.message).toBe("Quarantine concurrency must be a positive safe integer, received 0")
    }))

  it("recognises only the full structural quarantined marker", () => {
    expect(Quarantine.isQuarantined({ _tag: "Quarantined", member: "a", error: 1 })).toBe(true)
    expect(Quarantine.isQuarantined({ _tag: "Quarantined" })).toBe(false)
    expect(Quarantine.isQuarantined({ _tag: "Quarantined", member: 1, error: "e" })).toBe(false)
    expect(Quarantine.isQuarantined({ _tag: "Quarantined", error: "e" })).toBe(false)
    expect(Quarantine.isQuarantined({ _tag: "quarantined", member: "a", error: "e" })).toBe(false)
    expect(Quarantine.isQuarantined({ _tag: "Settled" })).toBe(false)
    expect(Quarantine.isQuarantined(undefined)).toBe(false)
  })

  it("recognises only the full structural success envelope", () => {
    expect(Quarantine.isSucceeded({ _tag: "Succeeded", member: "a", value: 1 })).toBe(true)
    expect(Quarantine.isSucceeded({ _tag: "Succeeded", member: "a" })).toBe(false)
    expect(Quarantine.isSucceeded({ _tag: "Succeeded", member: 1, value: 1 })).toBe(false)
    expect(Quarantine.isSucceeded({ _tag: "Succeeded", member: "a", value: 1, extra: true })).toBe(false)
    expect(Quarantine.isSucceeded(null)).toBe(false)
  })

  it.effect("nests a full marker-shaped success without mistaking it for a failure", () =>
    Effect.gen(function*() {
      const value = { _tag: "Quarantined", member: "legitimate", error: "ordinary data" } as const
      const outcomes = yield* Quarantine.run({ a: Effect.succeed(value) }, { policy: "quarantine" })
      const settled = yield* Quarantine.settle(outcomes)

      expect(settled).toEqual({ a: value })
    }))

  it("executes declaration envelopes through the flow interpreter", async () => {
    const value = { _tag: "Quarantined", member: "legitimate", error: "ordinary data" } as const
    const host = Flow.make("quarantine/envelopes", {
      payload: { input: Schema.Unknown },
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: () => Quarantine.all({ a: Node.succeed(value), b: Node.fail("failed") }, { policy: "quarantine" })
    })

    expect(await execute(host, { input: undefined }, "quarantine-envelopes")).toEqual({
      a: { _tag: "Succeeded", member: "a", value },
      b: { _tag: "Quarantined", member: "b", error: "failed" }
    })
  })

  // Pins the other half of what the `settle` JSDoc claims: a success is nested,
  // so a value carrying the complete `Succeeded` wire shape settles unchanged
  // instead of being read as protocol metadata. The sibling case above covers
  // the `Quarantined` wire shape.
  it.effect("nests a full success-marker-shaped value without unwrapping it twice", () =>
    Effect.gen(function*() {
      const value = { _tag: "Succeeded", member: "impostor", value: 1 } as const
      const outcomes = yield* Quarantine.run({ a: Effect.succeed(value) }, { policy: "quarantine" })
      const settled = yield* Quarantine.settle(outcomes)

      expect(settled).toEqual({ a: value })
    }))

  it.effect("refuses malformed settlement envelopes", () =>
    Effect.gen(function*() {
      const failure = yield* Quarantine.settle({
        b: 2,
        a: { _tag: "Succeeded", member: "a", value: 1, extra: true }
      } as never).pipe(Effect.flip)

      expect(failure).toMatchObject({
        code: "invalid_input",
        message: "Invalid quarantine outcomes: a, b"
      })
    }))

  it("never invokes accessors while checking an outcome", () => {
    let calls = 0
    const accessor = Object.defineProperty({ member: "a", error: "e" }, "_tag", {
      enumerable: true,
      get: () => {
        calls += 1
        return "Quarantined"
      }
    })
    const proxy = new Proxy({}, {
      ownKeys: () => {
        throw new Error("hostile")
      }
    })
    let descriptors = 0
    const descriptorProxy = new Proxy({}, {
      ownKeys: () => ["_tag", "member", "error"],
      getOwnPropertyDescriptor: (_target, key) => {
        descriptors += 1
        if (descriptors > 3) throw new Error("hostile descriptor")
        return { configurable: true, enumerable: true, value: key === "_tag" ? "Quarantined" : "value" }
      }
    })

    expect(Quarantine.isQuarantined(accessor)).toBe(false)
    expect(Quarantine.isSucceeded(proxy)).toBe(false)
    expect(Quarantine.isQuarantined(descriptorProxy)).toBe(false)
    expect(calls).toBe(0)
  })
})
