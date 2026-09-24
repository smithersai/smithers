/**
 * `Escalation` on `@smthrs/flow`'s `Graph.build` and `Interpreter`.
 *
 * The declaration assertions are the same observable facts as before: which
 * rungs, deciders and fallback a ladder declares, and in what order. What is
 * NEW is the two arm pairs at the end: a rung's `escalateIf` and the shared
 * `accept` are both `Node.branch` predicates that run at run time on the result
 * the rung really produced, so each has a TRUE-arm and a FALSE-arm case
 * asserted by what the scripted members were CALLED with.
 */
import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as DelegationChain from "../src/DelegationChain.ts"
import * as Escalation from "../src/Escalation.ts"
import { PatternError } from "../src/PatternError.ts"
import * as ReviewLoop from "../src/ReviewLoop.ts"
import { execute } from "./Execute.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

/** The tiers the scripted work action was asked for, in order. */
const attempted: Array<string> = []
/** The results the scripted decider judged, in order. */
const judged: Array<unknown> = []
/** The rung levels the scripted per-rung gate saw, in order. */
const gated: Array<number> = []
/** The tier whose result the scripted members call good, set per case. */
let settleTier = "cheap"

const work = Action.make("escalation/work", {
  payload: { tier: Schema.String, input: Schema.Unknown },
  success: Schema.Struct({ tier: Schema.String, ok: Schema.Boolean }),
  error: Schema.Never
})

const workLayer = work.toLayer(({ tier }) =>
  Effect.sync(() => {
    attempted.push(tier)
    return { tier, ok: tier === settleTier }
  })
)

const verdict = Action.make("escalation/verdict", {
  payload: { result: Schema.Unknown },
  success: Schema.Struct({ approved: Schema.Boolean }),
  error: Schema.Never
})

const verdictLayer = verdict.toLayer(({ result }) =>
  Effect.sync(() => {
    judged.push(result)
    return { approved: (result as { readonly ok: boolean }).ok }
  })
)

const gate = Action.make("escalation/gate", {
  payload: { result: Schema.Unknown, level: Schema.Number },
  success: Schema.Boolean,
  error: Schema.Never
})

// A per-rung decider SETTLES on `false` and escalates on anything else.
const gateLayer = gate.toLayer(({ level, result }) =>
  Effect.sync(() => {
    gated.push(level)
    return !(result as { readonly ok: boolean }).ok
  })
)

/**
 * A scripted member: a real `@smthrs/flow` flow, type-erased.
 *
 * `Flow.Any` states a declaration's schemas and annotations but not `.call`,
 * which is what a pattern member is called through, and a flow's `Requires`
 * names the actions its body reaches. Erasing both is what lets one
 * declaration compose members backed by different actions.
 */
type Scripted = Flow.Any & { readonly call: (payload: never) => Node.Node<unknown, unknown, never> }

/** A rung member: it is handed `{ input }` and produces one tier's result. */
const tier = (name: string): Scripted =>
  Flow.make(`escalation/${name}`, {
    payload: { input: Schema.Unknown },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: ({ input }) => work.call({ tier: name, input })
  }) as unknown as Scripted

const cheap = tier("cheap")
const strong = tier("strong")
const human = tier("human")

/** The shared decider: it is handed `{ result }`. */
const accept: Scripted = Flow.make("escalation/accept", {
  payload: { result: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ result }) => verdict.call({ result })
}) as unknown as Scripted

/** A per-rung decider: it is handed `{ result, level }`. */
const escalateIf: Scripted = Flow.make("escalation/check", {
  payload: { result: Schema.Unknown, level: Schema.Number },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ level, result }) => gate.call({ level, result })
}) as unknown as Scripted

/** Runs one declared ladder to settlement against the scripted members. */
const settle = (
  ladder: Escalation.EscalationFlow<any>,
  input: unknown,
  executionId: string,
  good: string
): Promise<unknown> => {
  attempted.length = 0
  judged.length = 0
  gated.length = 0
  settleTier = good
  return execute(
    ladder as never,
    { input },
    executionId,
    workLayer,
    verdictLayer,
    gateLayer,
    Interpreter.layer(cheap as never) as never
  )
}

describe("Escalation", () => {
  it("declares every bounded escalation rung", () => {
    const ladder = Escalation.make({ rungs: [cheap, strong], accept })

    expect(Flow.isFlow(ladder)).toBe(true)
    expect(ladder.body({ input: "request" }).ast._tag).toBe("AndThen")
    const graph = Graph.build(ladder, { input: "request" })
    // Four member calls, as before: one per rung and one decider per rung.
    expect(callsTo(graph, "escalation/cheap")).toHaveLength(1)
    expect(callsTo(graph, "escalation/strong")).toHaveLength(1)
    expect(callsTo(graph, "escalation/accept")).toHaveLength(2)
  })

  it("makes the first decider wait for the rung it judges", () => {
    // The old assertion read `keyMaterial.inputs` for a `Ref` naming core's
    // `root.andThen`. `@smthrs/flow` states the same fact as a dependency edge
    // on the node that consumes the decision.
    const graph = Graph.build(Escalation.make({ rungs: [cheap, strong], accept }), { input: "request" })
    const rung = callsTo(graph, "escalation/cheap")[0]
    const decider = callsTo(graph, "escalation/accept")[0]
    const decision = Graph.nodes(graph).find(
      (node) => node.kind === "Branch" && node.dependencies.includes(decider!.id)
    )

    expect(decision).toBeDefined()
    expect(decision!.dependencies).toContain(rung!.id)
  })

  it("rejects an empty ladder", () => {
    let refusal: unknown
    try {
      Escalation.make({ rungs: [], accept })
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(PatternError)
    expect((refusal as PatternError).code).toBe("invalid_decorator")
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const named = Escalation.make({
      rungs: [cheap, strong],
      accept,
      name: "answer-it",
      description: "Try the cheap tier, then the strong one."
    })

    expect(named._tag).toBe("answer-it")
    expect(named.description).toBe("Try the cheap tier, then the strong one.")
    expect(Escalation.make({ rungs: [cheap, strong], accept }).description).toBeUndefined()
  })

  it("decides every rung by defaultEscalate when no accept flow is available", () => {
    const graph = Graph.build(Escalation.make({ rungs: [cheap, strong] }), { input: "request" })
    const terminal = Graph.nodes(graph).filter((node) => node.kind === "Succeed").at(-1)

    expect(callsTo(graph, "escalation/cheap")).toHaveLength(1)
    expect(callsTo(graph, "escalation/strong")).toHaveLength(1)
    expect(callsTo(graph, "escalation/accept")).toHaveLength(0)
    // One branch per rung, deciding on the rung's own result as `run` does.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Branch")).toHaveLength(2)
    // The terminal is the exhausted arm, and the last rung's result reaches it
    // as a planned reference rather than a value. `@smthrs/flow` keeps a
    // `Succeed`'s value on the node's payload, where core kept it inside
    // `keyMaterial.body`.
    expect(terminal).toBeDefined()
    expect(payloadOf(terminal!).level).toBe(1)
    expect(payloadOf(terminal!).accepted).toBe(false)
    expect(payloadOf(terminal!).exhausted).toBe(true)
  })

  it("declares the fallback as the last flow call", () => {
    const graph = Graph.build(
      Escalation.make({ rungs: [cheap, strong], accept, fallback: human }),
      { input: "request" }
    )
    const fallback = callsTo(graph, "escalation/human")[0]
    const last = callsTo(graph, "escalation/strong")[0]

    // Five member calls, as before, and the fallback is declared beneath the
    // last rung's escalated arm, which is what "last" meant.
    expect(
      ["cheap", "strong", "accept", "human"].map((name) => callsTo(graph, `escalation/${name}`).length)
    ).toEqual([1, 1, 2, 1])
    expect(fallback).toBeDefined()
    expect(fallback!.id.startsWith(`${last!.id.slice(0, last!.id.lastIndexOf("."))}.`)).toBe(true)
  })

  it("declares a per-rung escalateIf instead of the shared accept", () => {
    const graph = Graph.build(
      Escalation.make({ rungs: [{ flow: cheap, escalateIf }, strong], accept }),
      { input: "request" }
    )

    expect(callsTo(graph, "escalation/cheap")).toHaveLength(1)
    expect(callsTo(graph, "escalation/check")).toHaveLength(1)
    expect(callsTo(graph, "escalation/strong")).toHaveLength(1)
    // The shared decider judges the second rung alone, because the first rung
    // brought its own.
    expect(callsTo(graph, "escalation/accept")).toHaveLength(1)
    expect(payloadOf(callsTo(graph, "escalation/check")[0]!).level).toBe(0)
  })

  it("takes the TRUE arm when the real result satisfies the shared decider", async () => {
    const ladder = Escalation.make({ rungs: [cheap, strong], accept })
    const settled = await settle(ladder, "request", "escalation-accept-true", "cheap")

    expect(settled).toEqual({ level: 0, result: { tier: "cheap", ok: true }, exhausted: false })
    // The second rung is declared topology the run did not take.
    expect(attempted).toEqual(["cheap"])
    expect(judged).toEqual([{ tier: "cheap", ok: true }])
  })

  it("takes the FALSE arm when the real result does not satisfy the shared decider", async () => {
    const ladder = Escalation.make({ rungs: [cheap, strong], accept })
    const settled = await settle(ladder, "request", "escalation-accept-false", "strong")

    expect(settled).toEqual({ level: 1, result: { tier: "strong", ok: true }, exhausted: false })
    expect(attempted).toEqual(["cheap", "strong"])
    expect(judged).toEqual([{ tier: "cheap", ok: false }, { tier: "strong", ok: true }])
  })

  it("settles exhausted when every rung's real result is refused and no fallback is declared", async () => {
    const ladder = Escalation.make({ rungs: [cheap, strong], accept })
    const settled = await settle(ladder, "request", "escalation-exhausted", "nothing")

    expect(settled).toEqual({
      level: 1,
      result: { tier: "strong", ok: false },
      accepted: false,
      exhausted: true
    })
    expect(attempted).toEqual(["cheap", "strong"])
  })

  it("runs the declared fallback only after every rung's real result is refused", async () => {
    const ladder = Escalation.make({ rungs: [cheap, strong], accept, fallback: human })
    const settled = await settle(ladder, "request", "escalation-fallback", "nothing")

    expect(settled).toEqual({ level: 2, result: { tier: "human", ok: false }, exhausted: false })
    expect(attempted).toEqual(["cheap", "strong", "human"])
  })

  it("takes the TRUE arm of a per-rung escalateIf on the real result", async () => {
    const ladder = Escalation.make({ rungs: [{ flow: cheap, escalateIf }, strong], accept })
    const settled = await settle(ladder, "request", "escalation-gate-true", "cheap")

    // The gate answered `false`, which is the one value that settles, so the
    // second rung and the shared decider were never reached.
    expect(settled).toEqual({ level: 0, result: { tier: "cheap", ok: true }, exhausted: false })
    expect(attempted).toEqual(["cheap"])
    expect(gated).toEqual([0])
    expect(judged).toEqual([])
  })

  it("takes the FALSE arm of a per-rung escalateIf on the real result", async () => {
    const ladder = Escalation.make({ rungs: [{ flow: cheap, escalateIf }, strong], accept })
    const settled = await settle(ladder, "request", "escalation-gate-false", "strong")

    expect(settled).toEqual({ level: 1, result: { tier: "strong", ok: true }, exhausted: false })
    expect(attempted).toEqual(["cheap", "strong"])
    expect(gated).toEqual([0])
    expect(judged).toEqual([{ tier: "strong", ok: true }])
  })

  it.effect("stops operational escalation after acceptance", () =>
    Effect.gen(function*() {
      const attempts: Array<string> = []
      const reached = yield* Escalation.run("request", {
        rungs: [
          () =>
            Effect.sync(() => {
              attempts.push("first")
              return "draft"
            }),
          () =>
            Effect.sync(() => {
              attempts.push("second")
              return "accepted"
            }),
          () =>
            Effect.sync(() => {
              attempts.push("third")
              return "unreachable"
            })
        ],
        accept: (value) => Effect.succeed(value === "accepted")
      })

      expect(reached).toEqual({ level: 1, result: "accepted", exhausted: false })
      expect(attempts).toEqual(["first", "second"])
    }))

  it.effect("uses one own-property acceptance vocabulary across escalation, review, and delegation", () =>
    Effect.gen(function*() {
      const acceptedForms: ReadonlyArray<unknown> = [
        true,
        "approved",
        { approved: true },
        { accepted: true }
      ]
      const inherited = Object.create({ approved: true }) as unknown
      const nearMisses: ReadonlyArray<unknown> = [
        { approved: "yes" },
        { accepted: 1 },
        { approved: false },
        "Approved",
        inherited
      ]

      for (const decision of acceptedForms) {
        const reached = yield* Escalation.run("request", {
          rungs: [() => Effect.succeed("cheap"), () => Effect.succeed("expensive")],
          accept: () => Effect.succeed(decision)
        })
        const reviewed = yield* ReviewLoop.run("draft", {
          maxRounds: 2,
          produce: (input) => Effect.succeed(input),
          review: () => Effect.succeed(decision),
          revise: ({ output }) => Effect.succeed(`${output}-revised`)
        })

        expect(Escalation.accepted(decision)).toBe(true)
        expect(ReviewLoop.accepted(decision)).toBe(true)
        expect(DelegationChain.accepted(decision)).toBe(true)
        expect(reached).toEqual({ level: 0, result: "cheap", exhausted: false })
        expect(reviewed).toEqual({ _tag: "Approved", output: "draft" })
      }

      for (const decision of nearMisses) {
        const reached = yield* Escalation.run("request", {
          rungs: [() => Effect.succeed("cheap"), () => Effect.succeed("expensive")],
          accept: () => Effect.succeed(decision)
        })
        const reviewed = yield* ReviewLoop.run("draft", {
          maxRounds: 2,
          produce: (input) => Effect.succeed(input),
          review: () => Effect.succeed(decision),
          revise: ({ output }) => Effect.succeed(`${output}-revised`)
        })

        expect(Escalation.accepted(decision)).toBe(false)
        expect(ReviewLoop.accepted(decision)).toBe(false)
        expect(DelegationChain.accepted(decision)).toBe(false)
        expect(reached).toEqual({
          level: 1,
          result: "expensive",
          accepted: false,
          exhausted: true
        })
        expect(reviewed).toEqual({
          _tag: "Exhausted",
          output: "draft-revised",
          review: decision
        })
      }
    }))

  it.effect("escalates on the default predicate when no accept flow is supplied", () =>
    Effect.gen(function*() {
      const attempts: Array<number> = []
      const reached = yield* Escalation.run("request", {
        rungs: [
          () =>
            Effect.sync(() => {
              attempts.push(0)
              return { ok: false }
            }),
          () =>
            Effect.sync(() => {
              attempts.push(1)
              return { ok: true }
            })
        ]
      })

      expect(reached).toEqual({ level: 1, result: { ok: true }, exhausted: false })
      expect(attempts).toEqual([0, 1])
    }))

  it("escalates on a failure marker and settles on anything else", () => {
    expect(Escalation.defaultEscalate(undefined)).toBe(true)
    expect(Escalation.defaultEscalate({ error: "boom" })).toBe(true)
    expect(Escalation.defaultEscalate({ failed: true })).toBe(true)
    expect(Escalation.defaultEscalate({ ok: false })).toBe(true)
    expect(Escalation.defaultEscalate({ ok: true })).toBe(false)
    expect(Escalation.defaultEscalate({ error: false })).toBe(false)
    expect(Escalation.defaultEscalate("done")).toBe(false)
  })

  it.effect("stops at a rung whose escalateIf refuses even when accept would escalate", () =>
    Effect.gen(function*() {
      const attempts: Array<number> = []
      const reached = yield* Escalation.run("request", {
        rungs: [
          {
            run: () =>
              Effect.sync(() => {
                attempts.push(0)
                return "cheap"
              }),
            escalateIf: () => Effect.succeed(false)
          },
          () =>
            Effect.sync(() => {
              attempts.push(1)
              return "strong"
            })
        ],
        accept: () => Effect.succeed(false)
      })

      expect(reached).toEqual({ level: 0, result: "cheap", exhausted: false })
      expect(attempts).toEqual([0])
    }))

  it.effect("hands each escalateIf its own rung level", () =>
    Effect.gen(function*() {
      const levels: Array<number> = []
      yield* Escalation.run("request", {
        rungs: [
          { run: () => Effect.succeed("a"), escalateIf: (_result, level) => Effect.succeed(levels.push(level) > 0) },
          { run: () => Effect.succeed("b"), escalateIf: (_result, level) => Effect.succeed(levels.push(level) < 0) }
        ]
      })

      expect(levels).toEqual([0, 1])
    }))

  it.effect("runs the fallback only after every rung escalates", () =>
    Effect.gen(function*() {
      let fallbacks = 0
      const fallback = () =>
        Effect.sync(() => {
          fallbacks = fallbacks + 1
          return "human"
        })

      const reached = yield* Escalation.run("request", {
        rungs: [() => Effect.succeed({ ok: false }), () => Effect.succeed({ ok: false })],
        fallback
      })
      expect(reached).toEqual({ level: 2, result: "human", exhausted: false })
      expect(fallbacks).toBe(1)

      const early = yield* Escalation.run("request", {
        rungs: [() => Effect.succeed({ ok: true }), () => Effect.succeed({ ok: false })],
        fallback
      })
      expect(early).toEqual({ level: 0, result: { ok: true }, exhausted: false })
      expect(fallbacks).toBe(1)
    }))

  it.effect("returns the last result when the ladder is exhausted without a fallback", () =>
    Effect.gen(function*() {
      const exhausted = yield* Escalation.run("request", {
        rungs: [() => Effect.succeed({ ok: false }), () => Effect.succeed({ ok: false, note: "last" })]
      })

      expect(exhausted).toEqual({
        level: 1,
        result: { ok: false, note: "last" },
        accepted: false,
        exhausted: true
      })
    }))

  it.effect("does not admit a rung appended while the run is in flight", () =>
    Effect.gen(function*() {
      const attempts: Array<string> = []
      const rungs: Array<(input: string) => Effect.Effect<{ readonly ok: boolean }>> = []
      const late = () => Effect.sync(() => (attempts.push("late"), { ok: true }))
      rungs.push(() =>
        Effect.sync(() => {
          attempts.push("first")
          rungs.push(late)
          return { ok: false }
        })
      )

      const result = yield* Escalation.run("request", { rungs })

      expect(attempts).toEqual(["first"])
      expect(result).toEqual({
        level: 0,
        result: { ok: false },
        accepted: false,
        exhausted: true
      })
    }))

  it.effect("fails run for an empty ladder", () =>
    Effect.gen(function*() {
      // A bare `Failure` assertion also passes when the run dies for an
      // unrelated reason, so the refusal is pinned by its typed code.
      const error = yield* Effect.flip(
        Escalation.run("request", { rungs: [] as ReadonlyArray<(input: string) => Effect.Effect<string>> })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect(error.code).toBe("invalid_decorator")
    }))
})
