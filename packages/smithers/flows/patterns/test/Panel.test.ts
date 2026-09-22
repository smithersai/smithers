import { describe, it } from "@effect/vitest"
import { Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Panel from "../src/Panel.ts"
import { PatternError } from "../src/PatternError.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

// A panelist and the moderator are separate declarations, because a
// `@smthrs/flow` flow states the payload it takes and the two take different
// ones. Counting calls by tag is what the old `FlowCall` count meant.
// A panelist with no declared role is still handed the bare input, exactly as
// before, which is what the payload cases below assert.
const participant = Flow.make("panelist", {
  payload: { input: Schema.Unknown, role: Schema.Unknown },
  success: Schema.Unknown,
  body: ({ input }) => Node.succeed(input)
})

const moderator = Flow.make("moderator", {
  payload: { input: Schema.Unknown, opinions: Schema.Unknown },
  success: Schema.Unknown,
  body: ({ opinions }) => Node.succeed(opinions)
})

describe("Panel", () => {
  it("declares keyed fail-fast fan-out", () => {
    const panel = Panel.make({
      panelists: { one: participant, two: participant },
      moderator
    })

    expect(Flow.isFlow(panel)).toBe(true)
    expect(panel.body({ input: "topic" }).ast._tag).toBe("AndThen")
    const graph = Graph.build(panel, { input: "topic" })
    const joined = Graph.nodes(graph).filter((node) => node.kind === "All")
    expect(callsTo(graph, "panelist")).toHaveLength(2)
    expect(callsTo(graph, "moderator")).toHaveLength(1)
    expect(joined).toHaveLength(1)
    // The moderator waits for the fan-out: its `opinions` is the join's result,
    // which the graph records as a dependency edge on the join node.
    expect(callsTo(graph, "moderator")[0]!.dependencies).toContain(joined[0]!.id)
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const panel = Panel.make({
      name: "pricing-panel",
      description: "Ask three panelists about the pricing page.",
      panelists: { one: participant },
      moderator
    })

    expect(panel._tag).toBe("pricing-panel")
    expect(panel.description).toBe("Ask three panelists about the pricing page.")
    expect(Panel.make({ panelists: { one: participant }, moderator }).description).toBeUndefined()
  })

  it("rejects an empty panel", () => {
    expect(() => Panel.make({ panelists: {}, moderator })).toThrow(
      expect.objectContaining({ code: "invalid_decorator", message: "Panel requires at least one panelist" })
    )
  })

  it("rejects a role named for a panelist the panel does not have", () => {
    expect(() => Panel.make({ panelists: { critic: participant }, moderator, roles: { absent: "nobody" } })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Panel declares a role for the unknown panelist \"absent\""
      })
    )
  })

  it("rejects prototype-shaped roles that are not own panelist names", () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      expect(() =>
        Panel.make({
          panelists: { critic: participant },
          moderator,
          roles: Object.fromEntries([[name, "unknown role"]])
        })
      ).toThrow(expect.objectContaining({
        code: "invalid_decorator",
        message: `Panel declares a role for the unknown panelist "${name}"`
      }))
    }
  })

  it("rejects an invalid concurrency at declaration", () => {
    // `make` is the declaration half, so a width the panel can never honour is
    // refused here rather than by whatever container the body later builds.
    for (const concurrency of [0, 1.5, -2]) {
      expect(() => Panel.make({ panelists: { a: participant }, moderator, concurrency })).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: `Panel concurrency must be a positive safe integer, received ${concurrency}`
        })
      )
    }
  })

  it.effect("fails run for an invalid concurrency", () =>
    Effect.gen(function*() {
      // A bare `Failure` assertion also passes when the run dies for an
      // unrelated reason, so the refusal is pinned by its typed code.
      const error = yield* Effect.flip(
        Panel.run("topic", {
          panelists: { a: () => Effect.succeed("a") },
          moderator: ({ opinions }) => Effect.succeed(opinions),
          concurrency: 0
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect(error.code).toBe("invalid_decorator")
      expect(error.message).toBe("Panel concurrency must be a positive safe integer, received 0")
    }))

  it("puts each declared role in that panelist's call payload", () => {
    const panel = Panel.make({
      panelists: { critic: participant, builder: participant, quiet: participant },
      moderator,
      roles: { critic: "find the flaw", builder: "find the fix" }
    })
    const graph = Graph.build(panel, { input: "topic" })
    const called = (name: string) => payloadOf(Graph.nodes(graph).find((node) => node.id.endsWith(`.all.${name}`))!)

    expect(called("critic")).toEqual({ input: "topic", role: "find the flaw" })
    expect(called("builder")).toEqual({ input: "topic", role: "find the fix" })
    expect(called("quiet")).toEqual("topic")
  })

  it("changes declaration identity when a role changes", () => {
    const identity = (role: string) =>
      Graph.nodes(
        Graph.build(
          Panel.make({ panelists: { critic: participant }, moderator, roles: { critic: role } }),
          { input: "topic" }
        )
      ).find((node) => node.id.endsWith(".all.critic"))?.draft.material

    expect(identity("find the flaw")).not.toEqual(identity("find the fix"))
  })

  it("bounds the declared fan-out when a concurrency is given", () => {
    const panel = Panel.make({
      panelists: { one: participant, two: participant, three: participant },
      moderator,
      concurrency: 2
    })
    const graph = Graph.build(panel, { input: "topic" })

    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(2)
    expect(callsTo(graph, "panelist")).toHaveLength(3)
    expect(callsTo(graph, "moderator")).toHaveLength(1)
  })

  // Each panelist parks on a shared gate the test holds shut, so what the
  // assertions read is how many the bound ADMITTED, not how the fibers
  // happened to interleave around a yield.
  it.effect("starts one panelist at a time at width one", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make(false)
      const started: Array<string> = []
      const first = yield* Latch.make(false)
      const panelist = (name: string) => () =>
        Effect.gen(function*() {
          started.push(name)
          yield* first.open
          yield* gate.await
          return `${name}-said`
        })

      const fiber = yield* Effect.forkChild(
        Panel.run("topic", {
          panelists: { a: panelist("a"), b: panelist("b"), c: panelist("c") },
          moderator: ({ opinions }) => Effect.succeed(opinions),
          concurrency: 1
        }),
        { startImmediately: true }
      )
      // `a` holds the only slot, so no sibling can have started.
      yield* first.await
      expect(started).toEqual(["a"])

      yield* gate.open
      const opinions = yield* Fiber.join(fiber)

      expect(started).toEqual(["a", "b", "c"])
      expect(opinions).toEqual({ a: "a-said", b: "b-said", c: "c-said" })
    }))

  it.effect("holds three panelists in flight together at width three", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make(false)
      const arrivals = { a: yield* Latch.make(false), b: yield* Latch.make(false), c: yield* Latch.make(false) }
      const started: Array<string> = []
      const panelist = (name: "a" | "b" | "c") => () =>
        Effect.gen(function*() {
          started.push(name)
          yield* arrivals[name].open
          yield* gate.await
          return `${name}-said`
        })

      const fiber = yield* Effect.forkChild(
        Panel.run("topic", {
          panelists: { a: panelist("a"), b: panelist("b"), c: panelist("c") },
          moderator: ({ opinions }) => Effect.succeed(opinions),
          concurrency: 3
        }),
        { startImmediately: true }
      )
      // All three arrivals resolve only while all three are parked at once. A
      // narrower bound never opens the third and the test times out.
      yield* Effect.all([arrivals.a.await, arrivals.b.await, arrivals.c.await])
      expect(started).toHaveLength(3)

      yield* gate.open
      const opinions = yield* Fiber.join(fiber)

      expect(opinions).toEqual({ a: "a-said", b: "b-said", c: "c-said" })
    }))

  it.effect("keys opinions by panelist name whatever the completion order", () =>
    Effect.gen(function*() {
      const settled: Array<string> = []
      const panelist = (name: string, yields: number) => () =>
        Effect.gen(function*() {
          for (let index = 0; index < yields; index++) yield* Effect.yieldNow
          settled.push(name)
          return `${name}-said`
        })

      const seen = yield* Panel.run("topic", {
        panelists: { alpha: panelist("alpha", 4), beta: panelist("beta", 2), gamma: panelist("gamma", 0) },
        moderator: ({ input, opinions }) => Effect.succeed({ input, opinions })
      })

      expect(settled).toEqual(["gamma", "beta", "alpha"])
      expect(seen.input).toBe("topic")
      expect(Object.keys(seen.opinions)).toEqual(["alpha", "beta", "gamma"])
      expect(seen.opinions).toEqual({ alpha: "alpha-said", beta: "beta-said", gamma: "gamma-said" })
    }))

  it.effect("hands the moderator own properties for prototype-shaped panelist names", () =>
    Effect.gen(function*() {
      const names = ["__proto__", "constructor", "toString", "normal"]
      const opinions = yield* Panel.run("topic", {
        panelists: Object.fromEntries(
          names.map((name) => [name, () => Effect.succeed(`${name}-opinion`)])
        ),
        moderator: ({ opinions }) => Effect.succeed(opinions)
      })

      expect(Object.getPrototypeOf(opinions)).toBe(Object.prototype)
      for (const name of names) {
        expect(Object.hasOwn(opinions, name)).toBe(true)
        expect(opinions[name]).toBe(`${name}-opinion`)
      }
    }))

  it.effect("fails run with a typed PatternError for an empty panel", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        Panel.run("topic", {
          panelists: {} as Readonly<Record<string, () => Effect.Effect<string>>>,
          moderator: () => Effect.succeed("none")
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect(error.code).toBe("invalid_decorator")
      expect(error.message).toBe("Panel requires at least one panelist")
    }))
})
