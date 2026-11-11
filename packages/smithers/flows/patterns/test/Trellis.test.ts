import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Trellis from "../src/Trellis.vibe"
import { executeExit } from "./Execute.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

// The author is handed the caller's prompt and a leaf is handed a `Leaf`, so
// one payload struct covers both roles: a `@smthrs/flow` flow states the
// payload it takes.
const MemberPayload = {
  input: Schema.optional(Schema.Unknown),
  goal: Schema.optional(Schema.Unknown),
  seat: Schema.optional(Schema.Unknown),
  path: Schema.optional(Schema.Unknown)
}

const author = Flow.make("author", {
  payload: MemberPayload,
  success: Schema.Unknown,
  error: Schema.Unknown,
  capabilities: ["delegate/author"],
  body: (payload) => Node.succeed(payload)
})

const leaf = Flow.make("leaf", {
  payload: MemberPayload,
  success: Schema.Unknown,
  error: Schema.Unknown,
  capabilities: ["delegate/leaf"],
  body: (payload) => Node.succeed(payload)
})

const envelope: Trellis.Envelope = { fuel: 3, depth: 3, fanout: 2 }

const nested: Trellis.Plan = {
  parallel: [
    { agent: { goal: "a" } },
    { sequence: [{ agent: { goal: "b" } }, { agent: { goal: "c" } }] }
  ]
}

const reported = (
  errors: ReadonlyArray<Trellis.TrellisError>
): ReadonlyArray<readonly [string, string, string]> =>
  errors.map((error) => [error.code, error.path, error.message] as const)

// `@smthrs/flow` keeps a call's hydrated payload on the node, where core kept a
// `Literal` entry in key material, and it names a call by the callee's tag,
// where core had only the capability the callee declared.
const payload = (node: Graph.GraphNode): unknown => payloadOf(node)

const leafCalls = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> => callsTo(graph, "leaf")

describe("Trellis", () => {
  it.effect("omits an absent seat from executed leaves", () =>
    Effect.gen(function*() {
      const seen: Array<Trellis.Leaf> = []
      yield* Trellis.execute({ sequence: [{ agent: { goal: "a" } }, { agent: { goal: "b", seat: "reviewer" } }] }, {
        concurrency: 1,
        leaf: (input) => Effect.sync(() => seen.push(input))
      })
      expect(Object.hasOwn(seen[0]!, "seat")).toBe(false)
      expect(seen[1]!.seat).toBe("reviewer")
    }))

  it("reports depth, fan-out, and fuel overruns at the offending path", () => {
    expect(Trellis.validate(nested, envelope)).toEqual([])
    expect(reported(Trellis.validate(nested, { fuel: 3, depth: 2, fanout: 2 }))).toEqual([
      ["depth_exceeded", "root.parallel[1].sequence[0]", "Plan depth 3 exceeds the envelope depth 2"],
      ["depth_exceeded", "root.parallel[1].sequence[1]", "Plan depth 3 exceeds the envelope depth 2"]
    ])
    expect(reported(Trellis.validate(nested, { fuel: 3, depth: 3, fanout: 1 }))).toEqual([
      ["fanout_exceeded", "root", "parallel declares 2 members, above the envelope fan-out 1"]
    ])
    expect(reported(Trellis.validate(nested, { fuel: 2, depth: 3, fanout: 2 }))).toEqual([
      ["fuel_exhausted", "root", "Plan needs 3 leaf calls but only 2 fuel remains"]
    ])
  })

  it("refuses a value that is not a plan and an envelope that is not bounded", () => {
    expect(reported(Trellis.validate({ agent: { goal: "" } }, envelope))).toEqual([
      ["invalid_plan", "root.agent.goal", "agent.goal must be a non-empty string"]
    ])
    expect(reported(Trellis.validate({ sequence: [{ swarm: [] }] }, envelope))).toEqual([
      ["invalid_plan", "root.sequence[0]", "A plan node must be exactly one of agent, sequence, or parallel"]
    ])
    expect(reported(Trellis.validate(nested, { fuel: 0, depth: 3, fanout: 2 }))).toEqual([
      ["invalid_envelope", "root", "Trellis envelope fuel, depth, and fanout must be positive safe integers"]
    ])
  })

  it("reports every malformed agent and container shape", () => {
    expect(reported(Trellis.validate(null, envelope))).toEqual([
      ["invalid_plan", "root", "A plan node must be exactly one of agent, sequence, or parallel"]
    ])
    expect(reported(Trellis.validate({ agent: null }, envelope))).toEqual([
      ["invalid_plan", "root.agent", "agent must be an object"]
    ])
    expect(reported(Trellis.validate({ agent: { goal: "work", seat: 1 } }, envelope))).toEqual([
      ["invalid_plan", "root.agent.seat", "agent.seat must be a string"]
    ])
    expect(reported(Trellis.validate({ sequence: "not-an-array" }, envelope))).toEqual([
      ["invalid_plan", "root.sequence", "sequence must be an array"]
    ])
  })

  it("refuses a container that holds no members", () => {
    expect(reported(Trellis.validate({ sequence: [] }, envelope))).toEqual([
      ["invalid_plan", "root", "sequence must hold at least one member"]
    ])
    expect(reported(Trellis.validate({ sequence: [{ parallel: [] }] }, envelope))).toEqual([
      ["invalid_plan", "root.sequence[0]", "parallel must hold at least one member"]
    ])
    // The closed grammar shows the constraint to the model that answers in it.
    expect(Schema.decodeUnknownResult(Trellis.Plan)({ sequence: [] })._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(Trellis.Plan)({ parallel: [] })._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(Trellis.Plan)(nested)._tag).toBe("Success")
  })

  it("refuses a container with a missing member", () => {
    const generous: Trellis.Envelope = { fuel: 4, depth: 3, fanout: 3 }
    const dense = { agent: { goal: "g" } }
    const holes: ReadonlyArray<readonly [unknown, string]> = [
      [{ parallel: new Array(1) }, "root.parallel[0]"],
      [{ sequence: new Array(1) }, "root.sequence[0]"],
      [{ sequence: [dense, , dense] }, "root.sequence[1]"],
      [{ parallel: [dense, , dense] }, "root.parallel[1]"],
      [{ sequence: [{ parallel: [dense, ,] }] }, "root.sequence[0].parallel[1]"]
    ]
    for (const [plan, path] of holes) {
      expect(Schema.is(Trellis.Plan)(plan)).toBe(false)
      expect(reported(Trellis.validate(plan, generous))).toEqual([
        ["invalid_plan", path, "A plan node must not be a missing member"]
      ])
    }
    const control = { parallel: [dense] }
    expect(reported(Trellis.validate(control, generous))).toEqual([])
  })

  it("makes codec decoding and runtime validation agree on the closed grammar", () => {
    const generous: Trellis.Envelope = { fuel: 20, depth: 10, fanout: 10 }
    const ambiguous = {
      agent: { goal: "g" },
      parallel: [{ agent: { goal: "h" } }]
    }

    expect(Schema.decodeUnknownExit(Trellis.Plan)(ambiguous)._tag).toBe("Failure")
    expect(reported(Trellis.validate(ambiguous, generous))).toEqual([
      ["invalid_plan", "root", "A plan node must be exactly one of agent, sequence, or parallel"]
    ])

    const accepted = [
      { agent: { goal: "g" } },
      { sequence: [{ agent: { goal: "a" } }, { sequence: [{ agent: { goal: "b" } }] }] },
      { parallel: [{ agent: { goal: "a" } }, { parallel: [{ agent: { goal: "b" } }] }] },
      { agent: { goal: "g", seat: "reviewer" } }
    ]
    for (const value of accepted) {
      const decoded = Schema.decodeUnknownSync(Trellis.Plan)(value)
      expect(Trellis.validate(decoded, generous)).toEqual([])
    }
    const excess = [
      { agent: { goal: "g" }, extra: true },
      { sequence: [{ agent: { goal: "g" } }], extra: true },
      { parallel: [{ agent: { goal: "g" } }], extra: true },
      { sequence: [{ agent: { goal: "g" }, extra: true }] },
      { parallel: [{ sequence: [{ agent: { goal: "g" } }], extra: true }] }
    ]
    for (const value of excess) {
      expect(Trellis.validate(value, generous)[0]?.code).toBe("invalid_plan")
      expect(Schema.decodeUnknownResult(Trellis.Plan)(value)._tag).toBe("Failure")
    }
  })

  it("stops after one fan-out refusal without walking hallucinated members", () => {
    const plan = { parallel: Array.from({ length: 500 }, () => null) }
    const refusals = Trellis.validate(plan, { fuel: 1000, depth: 5, fanout: 2 })

    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.code).toBe("fanout_exceeded")
    expect(refusals[0]?.message).toBe("parallel declares 500 members, above the envelope fan-out 2")
  })

  it("refuses a deeply nested value at the envelope depth without walking it", () => {
    for (const terminal of [{ agent: { goal: "next" } }, { parallel: [] }]) {
      let next: unknown = terminal
      for (let depth = 0; depth < 20_000; depth++) next = { sequence: [next] }

      expect(reported(Trellis.validate(next, envelope))).toEqual([
        ["depth_exceeded", "root.sequence[0].sequence[0].sequence[0]", "Plan depth 4 exceeds the envelope depth 3"]
      ])
    }
  })

  it.effect("refuses invalid execute concurrency before a leaf callback runs", () =>
    Effect.gen(function*() {
      const plan: Trellis.Plan = { agent: { goal: "a" } }
      for (const concurrency of [0, -5, 1.5, Number.NaN]) {
        let leaves = 0
        const failure = yield* Effect.flip(
          Trellis.execute(plan, {
            concurrency,
            leaf: () => Effect.sync(() => (leaves += 1, "done"))
          })
        )

        expect(failure.code).toBe("invalid_envelope")
        expect(failure.path).toBe("root")
        expect(failure.message).toBe(`Trellis concurrency must be a positive safe integer, received ${concurrency}`)
        expect(leaves).toBe(0)
      }
    }))

  it.effect("valid execute concurrency holds six parallel leaves to two in flight", () =>
    Effect.gen(function*() {
      const plan: Trellis.Plan = {
        parallel: Array.from({ length: 6 }, (_, index) => ({ agent: { goal: String(index) } })) as [
          Trellis.Plan,
          ...Array<Trellis.Plan>
        ]
      }
      const gate = yield* Latch.make(false)
      const saturated = yield* Latch.make(false)
      let started = 0
      let inFlight = 0
      let peak = 0
      const fiber = yield* Effect.forkChild(
        Trellis.execute(plan, {
          concurrency: 2,
          leaf: () =>
            Effect.gen(function*() {
              started += 1
              inFlight += 1
              peak = Math.max(peak, inFlight)
              if (started === 2) yield* saturated.open
              yield* gate.await
              inFlight -= 1
              return "done"
            })
        }),
        { startImmediately: true }
      )

      yield* saturated.await
      expect(started).toBe(2)
      yield* gate.open
      yield* Fiber.join(fiber)
      expect(peak).toBe(2)
    }))

  it.effect("returns parallel results in declaration order rather than completion order", () =>
    Effect.gen(function*() {
      const plan: Trellis.Plan = {
        parallel: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }, { agent: { goal: "c" } }]
      }
      const gates = yield* Effect.all([Latch.make(), Latch.make(), Latch.make()])
      const finished = yield* Effect.all([Latch.make(), Latch.make(), Latch.make()])
      const allStarted = yield* Latch.make()
      const completionOrder: Array<string> = []
      let started = 0
      const index = new Map([["a", 0], ["b", 1], ["c", 2]])
      const running = yield* Trellis.execute(plan, {
        concurrency: 3,
        leaf: ({ goal }) =>
          Effect.gen(function*() {
            const position = index.get(goal)!
            started += 1
            if (started === 3) yield* Latch.open(allStarted)
            yield* Latch.await(gates[position]!)
            completionOrder.push(goal)
            yield* Latch.open(finished[position]!)
            return goal.toUpperCase()
          })
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Latch.await(allStarted)
      for (const position of [2, 1, 0]) {
        yield* Latch.open(gates[position]!)
        yield* Latch.await(finished[position]!)
      }
      const result = yield* Fiber.join(running)

      expect(completionOrder).toEqual(["c", "b", "a"])
      expect(result).toEqual(["A", "B", "C"])
    }))

  it("keeps the caller's name and description on the declared flow", () => {
    const trellis = Trellis.make({ author, leaf, envelope, name: "plan-it", description: "Author and run a plan." })

    expect(trellis._tag).toBe("plan-it")
    expect(trellis.description).toBe("Author and run a plan.")
    expect(Trellis.make({ author, leaf, envelope }).description).toBeUndefined()
  })

  it("compiles a plan into the calls the plan names", () => {
    const compiled = Flow.make("compiled-nested", {
      payload: MemberPayload,
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: () => Trellis.compile(nested, { leaf })
    })
    const graph = Graph.build(compiled, { input: "ship it" })

    expect(leafCalls(graph)).toHaveLength(3)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
    expect(Trellis.leaves(nested)).toEqual([
      { goal: "a", path: "root.parallel[0]" },
      { goal: "b", path: "root.parallel[1].sequence[0]" },
      { goal: "c", path: "root.parallel[1].sequence[1]" }
    ])
  })

  it("preserves an explicitly selected seat in compiled and executed leaves", () => {
    const seated: Trellis.Plan = { agent: { goal: "review", seat: "critic" } }
    const compiled = Flow.make("compiled-seated", {
      payload: MemberPayload,
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: () => Trellis.compile(seated, { leaf })
    })
    const graph = Graph.build(compiled, { input: "ship it" })

    expect(payload(leafCalls(graph)[0]!)).toEqual({ goal: "review", seat: "critic", path: "root" })
    expect(Trellis.leaves(seated)).toEqual([{ goal: "review", seat: "critic", path: "root" }])
  })

  it.effect("hands an explicitly selected seat to execute", () =>
    Effect.gen(function*() {
      const seen: Array<Trellis.Leaf> = []
      yield* Trellis.execute({ agent: { goal: "review", seat: "critic" } }, {
        concurrency: 1,
        leaf: (input) => Effect.sync(() => (seen.push(input), input.goal))
      })

      expect(seen).toEqual([{ goal: "review", seat: "critic", path: "root" }])
    }))
})

/**
 * The declared trellis on the engine.
 *
 * Every member is a real flow calling one scripted action, so each case runs
 * the flow `make` declares through `Interpreter.layer` and the engine, and
 * reads what the action was really handed.
 */
interface Script {
  readonly author: (payload: unknown) => Effect.Effect<unknown, unknown>
  readonly leaf: (leaf: Trellis.Leaf) => Effect.Effect<unknown, unknown>
  readonly continue?: ((input: Trellis.Continuation) => Effect.Effect<unknown, unknown>) | undefined
}

let script: Script = {
  author: () => Effect.die("no script"),
  leaf: () => Effect.die("no script")
}

const step = Action.make("trellis/step", {
  payload: { role: Schema.String, payload: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown
})

const stepLayer = step.toLayer(({ payload, role }) =>
  Effect.suspend(() =>
    role === "author"
      ? script.author(payload)
      : role === "leaf"
      ? script.leaf(payload as Trellis.Leaf)
      : script.continue!(payload as Trellis.Continuation)
  )
)

const opaque = Schema.optionalKey(Schema.Unknown)

const roleFlow = (role: string, fields: Schema.Struct.Fields) =>
  Flow.make(`trellis/${role}`, {
    payload: fields,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ role }, (payload: unknown) => step.call({ role, payload }))
  })

const roles = {
  author: roleFlow("author", { prompt: opaque }),
  leaf: roleFlow("leaf", { goal: opaque, seat: opaque, path: opaque }),
  continue: roleFlow("continue", { plan: opaque, result: opaque, round: opaque, remaining: opaque })
}

const declared = (bounds: Trellis.Envelope, continued: boolean) =>
  Trellis.make({
    author: roles.author,
    leaf: roles.leaf,
    ...(continued ? { continue: roles.continue } : {}),
    envelope: bounds
  })

let executions = 0

/** Runs one declared trellis to settlement under `next` as its script. */
const settle = (
  next: Script,
  bounds: Trellis.Envelope = envelope
): Promise<Exit.Exit<unknown, unknown>> => {
  script = next
  return executeExit(
    declared(bounds, next.continue !== undefined) as never,
    { input: { prompt: "ship it" } },
    `trellis-${++executions}`,
    stepLayer
  )
}

const succeeded = (exit: Exit.Exit<unknown, unknown>): Trellis.RunResult => {
  if (exit._tag !== "Success") throw new Error(`the trellis failed: ${String(exit.cause)}`)
  return exit.value as Trellis.RunResult
}

const failed = (exit: Exit.Exit<unknown, unknown>): Trellis.TrellisError & { readonly cause?: unknown } => {
  if (exit._tag !== "Failure") throw new Error("the trellis settled")
  const error = Cause.findErrorOption(exit.cause)
  if (error._tag !== "Some") throw new Error(`the trellis did not fail on its typed channel: ${String(exit.cause)}`)
  return error.value as Trellis.TrellisError
}

describe("Trellis.make", () => {
  it("runs the leaves the authored plan names, with their goals and plan paths", async () => {
    const handed: Array<Trellis.Leaf> = []
    const result = succeeded(
      await settle({
        author: () => Effect.succeed(nested),
        leaf: (leaf) => Effect.sync(() => (handed.push(leaf), leaf.goal.toUpperCase()))
      })
    )

    // Exactly the plan's three leaves, never a placeholder slot carrying the
    // whole plan as its goal.
    expect([...handed].sort((left, right) => left.path.localeCompare(right.path))).toEqual(Trellis.leaves(nested))
    expect(result).toEqual({ rounds: [{ plan: nested, result: ["A", ["B", "C"]] }], remaining: 0 })
  })

  it("hands the author the caller's input and a seat to the leaf that names it", async () => {
    const authored: Array<unknown> = []
    const handed: Array<Trellis.Leaf> = []
    succeeded(
      await settle({
        author: (payload) => Effect.sync(() => (authored.push(payload), { agent: { goal: "review", seat: "critic" } })),
        leaf: (leaf) => Effect.sync(() => (handed.push(leaf), "ok"))
      })
    )

    expect(authored).toEqual([{ prompt: "ship it" }])
    expect(handed).toEqual([{ goal: "review", seat: "critic", path: "root" }])
  })

  it("runs a sequence in plan order", async () => {
    const trace: Array<string> = []
    succeeded(
      await settle({
        author: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }] }),
        leaf: ({ goal }) => Effect.sync(() => (trace.push(goal), goal))
      })
    )

    expect(trace).toEqual(["a", "b"])
  })

  it("declares the author round as one author call and a handoff, and a plan round as the plan's leaves", () => {
    const trellis = declared(envelope, false)

    const authoring = Graph.build(trellis, { input: { prompt: "ship it" } })
    expect(callsTo(authoring, "trellis/author")).toHaveLength(1)
    expect(callsTo(authoring, "trellis/leaf")).toHaveLength(0)

    const round = Graph.build(trellis, {
      input: { prompt: "ship it" },
      round: { plan: nested, round: 1, remaining: envelope.fuel, rounds: [] }
    })
    expect(callsTo(round, "trellis/author")).toHaveLength(0)
    expect(callsTo(round, "trellis/leaf").map(payload)).toEqual([
      { goal: "a", path: "root.parallel[0]" },
      { goal: "b", path: "root.parallel[1].sequence[0]" },
      { goal: "c", path: "root.parallel[1].sequence[1]" }
    ])
  })

  it("re-authors a second round and stops when continue returns nothing", async () => {
    const trace: Array<string> = []
    const continued: Array<Trellis.Continuation> = []
    const plans: ReadonlyArray<Trellis.Plan> = [{ agent: { goal: "first" } }, { agent: { goal: "second" } }]
    const result = succeeded(
      await settle({
        author: () => Effect.succeed(plans[0]),
        continue: (input) => Effect.sync(() => (continued.push(input), input.round === 1 ? plans[1] : null)),
        leaf: ({ goal }) => Effect.sync(() => (trace.push(goal), goal))
      }, { fuel: 3, depth: 1, fanout: 1 })
    )

    expect(trace).toEqual(["first", "second"])
    expect(continued).toEqual([
      { plan: plans[0], result: "first", round: 1, remaining: 2 },
      { plan: plans[1], result: "second", round: 2, remaining: 1 }
    ])
    expect(result).toEqual({
      rounds: [{ plan: plans[0], result: "first" }, { plan: plans[1], result: "second" }],
      remaining: 1
    })
  })

  it("stops when a continuation names no work, at any depth inside the envelope", async () => {
    for (
      const empty of [{ sequence: [] }, { sequence: [{ parallel: [] }] }, {
        sequence: [{ parallel: [{ sequence: [] }] }]
      }]
    ) {
      const trace: Array<string> = []
      const result = succeeded(
        await settle({
          author: () => Effect.succeed({ agent: { goal: "only" } }),
          continue: () => Effect.succeed(empty),
          leaf: ({ goal }) => Effect.sync(() => (trace.push(goal), goal))
        })
      )

      expect(trace).toEqual(["only"])
      expect(result).toEqual({ rounds: [{ plan: { agent: { goal: "only" } }, result: "only" }], remaining: 2 })
    }
  })

  it("refuses a too-deep continuation with the settled rounds as residue", async () => {
    const first: Trellis.Plan = { agent: { goal: "only" } }
    let next: unknown = { agent: { goal: "next" } }
    for (let depth = 0; depth < 5; depth++) next = { sequence: [next] }
    const trace: Array<string> = []
    const failure = failed(
      await settle({
        author: () => Effect.succeed(first),
        continue: () => Effect.succeed(next),
        leaf: ({ goal }) => Effect.sync(() => (trace.push(goal), goal))
      })
    )

    expect(failure).toBeInstanceOf(Trellis.TrellisError)
    expect(failure.code).toBe("depth_exceeded")
    expect(failure.path).toBe("root.sequence[0].sequence[0].sequence[0]")
    expect(failure.cause).toMatchObject({ rounds: [{ plan: first, result: "only" }], remaining: 2 })
    expect(trace).toEqual(["only"])
  })

  it("retains every refusal from an initial or a continuation plan, and runs no leaf of it", async () => {
    const first: Trellis.Plan = { agent: { goal: "only" } }
    const invalid = { sequence: [{ agent: { goal: "" } }, { agent: { goal: "ok", seat: 1 } }] }
    const refusals = Trellis.validate(invalid, envelope)
    for (const initial of [true, false]) {
      const trace: Array<string> = []
      const failure = failed(
        await settle({
          author: () => Effect.succeed(initial ? invalid : first),
          continue: () => Effect.succeed(invalid),
          leaf: ({ goal }) => Effect.sync(() => (trace.push(goal), goal))
        })
      )

      expect(failure.code).toBe(refusals[0]!.code)
      expect(failure.path).toBe(refusals[0]!.path)
      expect(failure.message).toBe(refusals[0]!.message)
      expect(failure.cause).toEqual({
        rounds: initial ? [] : [{ plan: first, result: "only" }],
        remaining: initial ? 3 : 2,
        refusals: refusals.map(({ code, message, path }) => ({ code, path, message }))
      })
      expect(trace).toEqual(initial ? [] : ["only"])
    }
  })

  it("refuses a value that is not a plan before any leaf runs", async () => {
    let leaves = 0
    const failure = failed(
      await settle({
        author: () => Effect.succeed({ swarm: [] }),
        leaf: () => Effect.sync(() => ++leaves)
      })
    )

    expect([failure.code, failure.path]).toEqual(["invalid_plan", "root"])
    expect(leaves).toBe(0)
  })

  it("fails fuel_exhausted before running a round the fuel cannot pay for", async () => {
    const trace: Array<string> = []
    const first: Trellis.Plan = { sequence: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }] }
    const failure = failed(
      await settle({
        author: () => Effect.succeed(first),
        continue: () => Effect.succeed({ agent: { goal: "c" } }),
        leaf: ({ goal }) => Effect.sync(() => (trace.push(goal), goal))
      }, { fuel: 2, depth: 2, fanout: 2 })
    )

    expect(failure.code).toBe("fuel_exhausted")
    expect(failure.path).toBe("root")
    expect(failure.message).toBe("Round 2 needs 1 leaf calls but only 0 fuel remains")
    expect(failure.cause).toEqual({ rounds: [{ plan: first, result: ["a", "b"] }], remaining: 0 })
    expect(trace).toEqual(["a", "b"])
  })

  it("refuses with fuel_exhausted, not the round budget, after fuel one-leaf rounds", async () => {
    const trace: Array<string> = []
    const failure = failed(
      await settle({
        author: () => Effect.succeed({ agent: { goal: "only" } }),
        continue: () => Effect.succeed({ agent: { goal: "again" } }),
        leaf: ({ goal }) => Effect.sync(() => (trace.push(goal), goal))
      }, { fuel: 1, depth: 1, fanout: 1 })
    )

    expect(failure).toMatchObject({
      code: "fuel_exhausted",
      path: "root",
      message: "Round 2 needs 1 leaf calls but only 0 fuel remains",
      cause: { rounds: [{ plan: { agent: { goal: "only" } }, result: "only" }], remaining: 0 }
    })
    expect(trace).toEqual(["only"])
  })

  it("refuses round state that its settled rounds and the envelope do not account for", async () => {
    const settled = { plan: { agent: { goal: "done" } }, result: "done" }
    for (
      const round of [
        { round: 1, remaining: 100, rounds: [] },
        { round: 0, remaining: 3, rounds: [] },
        { round: 1, remaining: -1, rounds: [] },
        { round: 999, remaining: 2, rounds: [settled] },
        { round: 2, remaining: 3, rounds: [settled] },
        { round: 2, remaining: 2, rounds: [{ plan: { swarm: [] }, result: null }] },
        { round: 2, remaining: 2, rounds: [null] }
      ]
    ) {
      let leaves = 0
      script = { author: () => Effect.die("never authored"), leaf: () => Effect.sync(() => ++leaves) }
      const failure = failed(
        await executeExit(
          declared(envelope, false) as never,
          { input: { prompt: "ship it" }, round: { plan: { agent: { goal: "a" } }, ...round } },
          `trellis-${++executions}`,
          stepLayer
        )
      )

      expect(failure).toMatchObject({ code: "invalid_envelope", path: "root" })
      expect(leaves).toBe(0)
    }
  })

  it("refuses a plan the model authored outside the envelope", async () => {
    const failure = failed(
      await settle({
        author: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        leaf: ({ goal }) => Effect.succeed(goal)
      }, { fuel: 2, depth: 1, fanout: 2 })
    )

    expect(failure.code).toBe("depth_exceeded")
    expect(failure.path).toBe("root.sequence[0]")
    expect(failure.message).toBe("Plan depth 2 exceeds the envelope depth 1")
  })

  it("fails the round with a leaf's own error", async () => {
    const error = { reason: "worker failed" }
    const trace: Array<string> = []
    const exit = await settle({
      author: () => Effect.succeed({ sequence: [{ agent: { goal: "ok" } }, { agent: { goal: "fail" } }] }),
      leaf: ({ goal }) =>
        Effect.suspend(() => (trace.push(goal), goal === "fail" ? Effect.fail(error) : Effect.succeed(goal)))
    })

    expect(failed(exit)).toEqual(error)
    expect(trace).toEqual(["ok", "fail"])
  })

  it("refuses an envelope bound that is not a positive safe integer", () => {
    for (
      const bounds of [{ fuel: 0, depth: 1, fanout: 1 }, { fuel: 1, depth: 0, fanout: 1 }, {
        fuel: 1,
        depth: 1,
        fanout: 1.5
      }]
    ) {
      expect(() => Trellis.make({ author, leaf, envelope: bounds })).toThrow(
        expect.objectContaining({
          code: "invalid_envelope",
          path: "root",
          message: "Trellis envelope fuel, depth, and fanout must be positive safe integers"
        })
      )
    }
  })
})
