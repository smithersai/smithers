/**
 * `DelegationChain` on `@smthrs/flow`'s `Graph.build`.
 *
 * Every assertion is the one it was: how many calls a chain declares, what
 * each declared call is handed, and every refusal. The chain declares no retry
 * of its own: a tier retries through its actions' `RetryPolicy`, which the
 * last suite spends on the real engine. Three readings moved: a call's declared payload is
 * `node.payload` rather than the first `Literal` of `keyMaterial.inputs`, a
 * `Succeed` node's value is its payload too, and a member call is found by the
 * flow tag it names rather than by a capability planted on it.
 *
 * What is NEW is the arm pair at the end: a leaf review is a `Node.branch`,
 * so the plan carries the settled arm and the next tier before anything runs.
 */
import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph, RetryPolicy } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as DelegationChain from "../src/DelegationChain.vibe"
import { PatternError } from "../src/PatternError.vibe"
import * as Trellis from "../src/Trellis.ts"
import { execute, executeExit } from "./Execute.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

/**
 * One stub member, named by its role.
 *
 * `Graph.build` records a call's payload and the callee's schema IDENTITY; it
 * decodes nothing, and no case here executes the declaration. So one opaque
 * payload stands for every role the chain calls, and what each member is
 * HANDED is asserted from `node.payload`.
 */
/**
 * A scripted member: a real `@smthrs/flow` flow, type-erased.
 *
 * `Flow.Any` states a declaration's schemas and annotations but not `.call`,
 * which is what a pattern member is called through, and a flow's `Requires`
 * names the actions its body reaches. Erasing both is what lets one
 * declaration compose members backed by different actions.
 */
type Scripted = Flow.Any & { readonly call: (payload: never) => Node.Node<unknown, unknown, never> }

const stub = (name: string): Scripted =>
  Flow.make(name, {
    payload: { input: Schema.Unknown },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ name }, (payload: unknown) => Node.succeed(payload))
  }) as unknown as Scripted

const makeOptions: DelegationChain.MakeOptions = {
  refine: stub("refine"),
  plan: stub("plan"),
  derisk: stub("derisk"),
  execute: { weak: stub("weak"), strong: stub("strong") },
  review: stub("review"),
  settle: stub("settle"),
  tierOrder: ["weak", "strong"],
  maxDepth: 2,
  maxDeriskRounds: 2
}

const plan: Trellis.Plan = {
  sequence: [
    { agent: { goal: "a" } },
    { parallel: [{ agent: { goal: "b" } }, { agent: { goal: "c" } }] }
  ]
}

const bounds = { tierOrder: ["weak", "strong"], maxDepth: 3, maxDeriskRounds: 2 } as const

const budget: DelegationChain.Budget = { maxMinutes: 5 }
// A USD ceiling is the model boundary's `Budget.make({ usd })`; the chain carries none (#1842).
// @ts-expect-error `maxUsd` is not a chain budget field.
void ({ maxUsd: 5 } satisfies DelegationChain.Budget)

const keys = (value: Record<string, unknown>): ReadonlyArray<string> => Object.keys(value).sort()

/** Every member call a chain declares, which excludes the entry call itself. */
const memberCalls = (graph: Graph.Graph): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) => node.kind === "FlowCall" && node.id !== "root")

describe("DelegationChain", () => {
  it.effect("reports every plan refusal before executing any leaf", () =>
    Effect.gen(function*() {
      const invalid = { sequence: [{ agent: { goal: "" } }, { agent: { goal: "ok", seat: 1 } }] }
      const trace: Array<string> = []
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed(invalid),
        derisk: () => Effect.succeed(true),
        execute: {
          weak: () => Effect.sync(() => trace.push("weak")),
          strong: () => Effect.sync(() => trace.push("strong"))
        },
        review: () => Effect.sync(() => (trace.push("review"), true)),
        settle: () => Effect.sync(() => trace.push("settle"))
      }).pipe(Effect.flip)
      const refusals = Trellis.validate(invalid, { fuel: 3, depth: 3, fanout: 3 })

      expect(refusals).toHaveLength(2)
      expect(failure).toBeInstanceOf(Trellis.TrellisError)
      expect(failure.code).toBe(refusals[0]!.code)
      expect(failure.path).toBe(refusals[0]!.path)
      expect(failure.message).toBe(refusals[0]!.message)
      expect(failure.cause).toEqual({ rounds: [], remaining: 3, refusals })
      expect(trace).toEqual([])
    }))

  it.effect("stops the derisk loop at the first approved round", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.sync(() => (calls.push("refine"), "goal")),
        plan: () => Effect.sync(() => (calls.push("plan"), plan)),
        derisk: () => Effect.sync(() => (calls.push("derisk"), { approved: true })),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      })

      expect(calls).toEqual(["refine", "plan", "derisk"])
    }))

  it.effect("revises the plan while derisk withholds approval", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: ({ round }) => Effect.sync(() => (calls.push(`plan-${round}`), { agent: { goal: "a" } })),
        derisk: ({ round }) => Effect.sync(() => (calls.push(`derisk-${round}`), { approved: round === 2 })),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ deriskExhausted, leaves }) => Effect.succeed({ deriskExhausted, leaves })
      })

      expect(calls).toEqual(["plan-1", "derisk-1", "plan-2", "derisk-2"])
      expect(settled).toEqual({ deriskExhausted: false, leaves: ["ok"] })
    }))

  it.effect("escalates a leaf that fails on the weakest tier and succeeds on the next", () =>
    Effect.gen(function*() {
      const attempted: Array<string> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ leaf }) =>
            Effect.suspend(() => {
              attempted.push(`weak:${leaf.path}`)
              return Effect.fail("weak tier gave up")
            }),
          strong: ({ leaf }) =>
            Effect.sync(() => {
              attempted.push(`strong:${leaf.path}`)
              return "strong result"
            })
        },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      })

      // One call per tier: the chain never retries a tier itself.
      expect(attempted).toEqual(["weak:root", "strong:root"])
      expect(settled).toEqual(["strong result"])
    }))

  it.effect("escalates a leaf whose result the review rejects", () =>
    Effect.gen(function*() {
      const reviewed: Array<unknown> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("thin"), strong: () => Effect.succeed("thorough") },
        review: (request) =>
          Effect.sync(() => {
            if (request.stage === "leaf") reviewed.push(request.tier)
            return { approved: request.stage === "chain" || request.output === "thorough" }
          }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      })

      expect(reviewed).toEqual(["weak", "strong"])
      expect(settled).toEqual(["thorough"])
    }))

  it.effect("fails with the leaf path once every tier has failed", () =>
    Effect.gen(function*() {
      let attempts = 0
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: () => Effect.suspend(() => (attempts += 1, Effect.fail("weak failed"))),
          strong: () => Effect.suspend(() => (attempts += 1, Effect.fail("strong failed")))
        },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("leaf_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root.sequence[0]")
      expect((failure as DelegationChain.DelegationError).message).toBe(
        "No tier settled the leaf at root.sequence[0]"
      )
      expect((failure as DelegationChain.DelegationError & { readonly cause?: unknown }).cause).toEqual([
        { tier: "weak", error: "weak failed" },
        { tier: "strong", error: "strong failed" }
      ])
      expect(attempts).toBe(bounds.tierOrder.length)
    }))

  it.effect("fails an exhausted rejected ladder without settling its leaf", () =>
    Effect.gen(function*() {
      const attempts = new Map<string, number>()
      const reviewed: Array<string> = []
      let settled = false
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ tier }) =>
            Effect.sync(() => (attempts.set(tier, (attempts.get(tier) ?? 0) + 1), `${tier}-candidate`)),
          strong: ({ tier }) =>
            Effect.sync(() => (attempts.set(tier, (attempts.get(tier) ?? 0) + 1), `${tier}-candidate`))
        },
        review: (request) =>
          Effect.sync(() => {
            if (request.stage === "leaf") reviewed.push(request.tier)
            return { approved: request.stage === "chain" }
          }),
        settle: ({ leaves }) => Effect.sync(() => (settled = true, leaves))
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("leaf_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root.sequence[0]")
      expect((failure as DelegationChain.DelegationError).message).toBe(
        "No tier settled the leaf at root.sequence[0]"
      )
      expect((failure as DelegationChain.DelegationError & { readonly cause?: unknown }).cause).toEqual([
        { tier: "weak", rejected: true },
        { tier: "strong", rejected: true }
      ])
      expect(attempts).toEqual(new Map([["weak", 1], ["strong", 1]]))
      expect(reviewed).toEqual(["weak", "strong"])
      expect(settled).toBe(false)
    }))

  it.effect("hands settle every leaf output in plan order", () =>
    Effect.gen(function*() {
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed(plan),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: ({ leaf }) => Effect.succeed(leaf.goal.toUpperCase()),
          strong: () => Effect.succeed("unused")
        },
        review: () => Effect.succeed({ approved: true }),
        settle: (request) => Effect.succeed(request)
      })

      expect(settled).toMatchObject({
        goal: "goal",
        leaves: ["A", ["B", "C"]].flat(),
        deriskExhausted: false
      })
    }))

  it.effect("refuses a derisked plan that leaves the envelope", () =>
    Effect.gen(function*() {
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        maxDepth: 1,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ sequence: [{ agent: { goal: "a" } }] }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toMatchObject({
        code: "depth_exceeded",
        path: "root.sequence[0]",
        message: "Plan depth 2 exceeds the envelope depth 1"
      })
    }))

  it.effect("refuses invalid concurrency before any callback runs", () =>
    Effect.gen(function*() {
      for (const concurrency of [0, -5, 1.5, Number.NaN]) {
        let callbacks = 0
        const called = <A>(value: A) => Effect.sync(() => (callbacks += 1, value))
        const failure = yield* Effect.flip(
          DelegationChain.run("ship it", {
            ...bounds,
            concurrency,
            refine: () => called("goal"),
            plan: () => called({ agent: { goal: "a" } }),
            derisk: () => called({ approved: true }),
            execute: { weak: () => called("ok"), strong: () => called("ok") },
            review: () => called({ approved: true }),
            settle: ({ leaves }) => called(leaves)
          })
        )

        expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
        expect((failure as DelegationChain.DelegationError).code).toBe("invalid_bounds")
        expect((failure as DelegationChain.DelegationError).path).toBe("root")
        expect((failure as DelegationChain.DelegationError).message).toBe(
          `Delegation concurrency must be a positive safe integer, received ${concurrency}`
        )
        expect(callbacks).toBe(0)
      }
    }))

  it.effect("wraps a derisk PatternError with the exact delegation refusal", () =>
    Effect.gen(function*() {
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.fail(new PatternError({ code: "invalid_decorator", message: "planner refused input" })),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("ok") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("derisk_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root")
      expect((failure as DelegationChain.DelegationError).message).toBe("planner refused input")
    }))

  it.effect("wraps a leaf-review PatternError with the exact leaf refusal", () =>
    Effect.gen(function*() {
      const reviewFailure = new PatternError({ code: "invalid_decorator", message: "review unavailable" })
      const failure = yield* DelegationChain.run("ship it", {
        ...bounds,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: { weak: () => Effect.succeed("candidate"), strong: () => Effect.succeed("unused") },
        review: (request) =>
          request.stage === "leaf"
            ? Effect.fail(reviewFailure)
            : Effect.succeed({ approved: true }),
        settle: ({ leaves }) => Effect.succeed(leaves)
      }).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(DelegationChain.DelegationError)
      expect((failure as DelegationChain.DelegationError).code).toBe("leaf_failed")
      expect((failure as DelegationChain.DelegationError).path).toBe("root")
      expect((failure as DelegationChain.DelegationError).message).toBe(
        "No tier settled the leaf at root"
      )
      expect((failure as DelegationChain.DelegationError & { readonly cause?: unknown }).cause).toBe(reviewFailure)
    }))

  it("declares at most the documented number of flow calls across its two rounds", () => {
    const chain = DelegationChain.make(makeOptions)
    expect(Flow.isFlow(chain)).toBe(true)
    // The widest plan the envelope admits: maxDepth leaves in one container.
    const widest: Trellis.Plan = { parallel: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }] }
    const first = Graph.build(chain, { input: "ship it" })
    const second = Graph.build(chain, {
      input: "ship it",
      execution: { goal: "goal", derisked: { _tag: "Approved", output: widest } }
    })
    // The first round's handoff to the execution round is not a member call.
    const members = (graph: Graph.Graph) =>
      memberCalls(graph).filter((node) => (node.ast as { readonly flow?: string }).flow !== chain._tag)
    expect(members(first).length + members(second).length).toBe(DelegationChain.bound(makeOptions))
    // 4 fixed calls + 2 per derisk round + an execute and a review call per
    // tier for each of the maxDepth leaves.
    expect(DelegationChain.bound(makeOptions)).toBe(16)
  })

  it.effect("settles with deriskExhausted when derisk never approves", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const settled = yield* DelegationChain.run("ship it", {
        ...bounds,
        maxDeriskRounds: 2,
        refine: () => Effect.succeed("goal"),
        plan: ({ round }) => Effect.sync(() => (calls.push(`plan-${round}`), { agent: { goal: "a" } })),
        derisk: ({ round }) => Effect.sync(() => (calls.push(`derisk-${round}`), { approved: false })),
        execute: { weak: () => Effect.succeed("ok"), strong: () => Effect.succeed("unused") },
        review: () => Effect.succeed({ approved: true }),
        settle: ({ deriskExhausted, leaves }) => Effect.succeed({ deriskExhausted, leaves })
      })

      expect(calls).toEqual(["plan-1", "derisk-1", "plan-2", "derisk-2"])
      expect(settled).toEqual({ deriskExhausted: true, leaves: ["ok"] })
    }))

  it.effect("declares the payloads it executes", () =>
    Effect.gen(function*() {
      const executed: Array<ReadonlyArray<string>> = []
      const reviewed: Array<ReadonlyArray<string>> = []
      let settlement: ReadonlyArray<string> = []
      yield* DelegationChain.run("ship it", {
        ...bounds,
        maxDepth: 2,
        budget,
        refine: () => Effect.succeed("goal"),
        plan: () => Effect.succeed({ agent: { goal: "a" } }),
        derisk: () => Effect.succeed({ approved: true }),
        execute: {
          weak: (work) => Effect.sync(() => (executed.push(keys(work as never)), "ok")),
          strong: () => Effect.succeed("unused")
        },
        review: (request) => Effect.sync(() => (reviewed.push(keys(request as never)), { approved: true })),
        settle: (request) => Effect.sync(() => (settlement = keys(request as never), request.leaves))
      })

      const graph = Graph.build(DelegationChain.make({ ...makeOptions, budget }), {
        input: "ship it",
        execution: {
          goal: "goal",
          derisked: { _tag: "Approved", output: { sequence: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }] } }
        }
      })
      const declaredWork = callsTo(graph, "weak").map(payloadOf)
      const declaredReviews = callsTo(graph, "review").map(payloadOf)
      const declaredSettle = payloadOf(callsTo(graph, "settle")[0] as Graph.GraphNode)

      // One weakest-tier call per leaf the plan names, each carrying the tier it
      // is and the run budget.
      expect(declaredWork).toHaveLength(makeOptions.maxDepth)
      expect(declaredWork.map(keys)).toEqual(declaredWork.map(() => executed[0]))
      expect(declaredWork.map((work) => work.tier)).toEqual(declaredWork.map(() => "weak"))
      expect(declaredWork.map((work) => work.budget)).toEqual(declaredWork.map(() => budget))
      expect(declaredWork.map((work) => keys(work.leaf as Record<string, unknown>))).toEqual(
        declaredWork.map(() => ["goal", "path"])
      )
      expect(declaredWork.map((work) => (work.leaf as { readonly path: string }).path)).toEqual(
        ["root.sequence[0]", "root.sequence[1]"]
      )
      expect(declaredWork.map((work) => (work.leaf as { readonly goal: string }).goal)).toEqual(["a", "b"])
      // The leaf review names the tier that produced the output, as run does.
      const leafReviews = declaredReviews.filter((request) => request.stage === "leaf")
      expect(leafReviews.map(keys)).toEqual(leafReviews.map(() => reviewed[0]))
      expect(leafReviews.map((request) => request.tier)).toEqual(
        Array.from({ length: makeOptions.maxDepth }, () => ["weak", "strong"]).flat()
      )
      // Settle is declared with the keys run settles with.
      expect(keys(declaredSettle)).toEqual(settlement)
    }))

  it("refuses bounds and tiers it cannot honour", () => {
    expect(() => DelegationChain.make({ ...makeOptions, maxDepth: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_bounds",
        path: "root",
        message: "maxDepth and maxDeriskRounds must be positive safe integers"
      })
    )
    expect(() => DelegationChain.make({ ...makeOptions, tierOrder: [] })).toThrow(
      expect.objectContaining({
        code: "invalid_bounds",
        path: "root",
        message: "tierOrder must name at least one tier, weakest first"
      })
    )
    expect(() => DelegationChain.make({ ...makeOptions, tierOrder: ["absent"] })).toThrow(
      expect.objectContaining({
        code: "missing_tier",
        path: "root",
        message: "execute has no flow for tier absent"
      })
    )
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const named = DelegationChain.make({
      ...makeOptions,
      name: "ship-release",
      description: "Delegate a release down the tier ladder."
    })

    expect(named._tag).toBe("ship-release")
    expect(named.description).toBe("Delegate a release down the tier ladder.")
    expect(DelegationChain.make(makeOptions).description).toBeUndefined()
  })
})
/** Every payload a declared chain stage was handed while the plan ran. */
const chainCalls: Array<{ readonly role: string; readonly payload: unknown }> = []
/** The tier whose output the scripted reviewer approves, set per case. */
let approvesTier = "weak"
/** The plan the scripted planner answers, set per case. */
let planned: Trellis.Plan = { agent: { goal: "a" } }
/** A tier whose call fails, set per case. */
let failingTier: string | undefined
/** What the weak tier answers instead of its own output, set per case. */
let escalateOutput: unknown

const chainStep = Action.make("delegation/step", {
  payload: { role: Schema.String, payload: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown
})

const chainLayer = chainStep.toLayer(({ payload, role }) =>
  Effect.suspend(() => {
    chainCalls.push({ role, payload })
    return role === failingTier ? Effect.fail(`${role} failed`) : Effect.succeed(answer(role, payload))
  })
)

const answer = (role: string, payload: unknown): unknown => {
  switch (role) {
    case "refine":
      return "goal"
    case "plan":
      return planned
    case "derisk":
      return { approved: true }
    case "review": {
      const request = payload as { readonly stage?: string; readonly tier?: string }
      return { approved: request.stage === "chain" || request.tier === approvesTier }
    }
    case "settle":
      return "settled"
    case "weak":
      return escalateOutput ?? `weak:${(payload as { readonly leaf: Trellis.Leaf }).leaf.goal}`
    default:
      return `${role} result`
  }
}

const opaque = Schema.optionalKey(Schema.Unknown)

/** One scripted chain stage, forwarding whatever payload it is handed. */
const roleFlow = (role: string, fields: Schema.Struct.Fields): Scripted =>
  Flow.make(`delegation/${role}`, {
    payload: fields,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ role }, function(this: { readonly role: string }, payload: unknown) {
      return chainStep.call({ role: this.role, payload })
    })
  }) as unknown as Scripted

const scriptedChain = (maxDepth = 1): DelegationChain.DelegationChainFlow =>
  DelegationChain.make({
    refine: roleFlow("refine", { prompt: opaque }),
    plan: roleFlow("plan", { input: opaque, output: opaque, review: opaque, round: opaque }),
    derisk: roleFlow("derisk", { output: opaque }),
    execute: {
      weak: roleFlow("weak", { leaf: opaque, tier: opaque, goal: opaque, budget: opaque }),
      strong: roleFlow("strong", { leaf: opaque, tier: opaque, goal: opaque, budget: opaque })
    },
    review: roleFlow("review", {
      stage: opaque,
      leaf: opaque,
      tier: opaque,
      output: opaque,
      goal: opaque,
      plan: opaque,
      leaves: opaque
    }),
    settle: roleFlow("settle", {
      prompt: opaque,
      goal: opaque,
      plan: opaque,
      leaves: opaque,
      review: opaque,
      deriskExhausted: opaque
    }),
    tierOrder: ["weak", "strong"],
    maxDepth,
    maxDeriskRounds: 1
  })

/** Runs one declared chain to settlement against the scripted stages. */
const settle = (approves: string, executionId: string): Promise<unknown> => {
  chainCalls.length = 0
  approvesTier = approves
  planned = { agent: { goal: "a" } }
  return execute(scriptedChain() as never, { input: "ship it" }, executionId, chainLayer)
}

describe("DelegationChain declaration execution", () => {
  it("takes the TRUE arm when the real review approves the weakest tier", async () => {
    const settled = await settle("weak", "delegation-tier-true-arm")

    expect(settled).toBe("settled")
    // The strong tier is declared topology the run did not take.
    expect(chainCalls.map((call) => call.role)).toEqual([
      "refine",
      "plan",
      "derisk",
      "weak",
      "review",
      "review",
      "settle"
    ])
    expect(chainCalls.filter((call) => call.role === "review").map((call) => (call.payload as { tier?: string }).tier))
      .toEqual(["weak", undefined])
  })

  it("takes the FALSE arm when the real review refuses the weakest tier", async () => {
    const settled = await settle("strong", "delegation-tier-false-arm")

    expect(settled).toBe("settled")
    // The weak tier's output was refused on the real review, so the next rung
    // ran. A build-time evaluation of the same predicate cannot produce both.
    expect(chainCalls.map((call) => call.role)).toEqual([
      "refine",
      "plan",
      "derisk",
      "weak",
      "review",
      "strong",
      "review",
      "review",
      "settle"
    ])
    expect(chainCalls.filter((call) => call.role === "review").map((call) => (call.payload as { tier?: string }).tier))
      .toEqual(["weak", "strong", undefined])
  })

  it("retries a tier through its own action's RetryPolicy inside one declared rung", async () => {
    chainCalls.length = 0
    approvesTier = "weak"
    let flakyAttempts = 0
    // The tier's action owns its retries. The engine spends them as attempts
    // of one durable step, so the chain neither re-declares the tier nor
    // escalates to the next one while the policy still has attempts left.
    const flaky = Action.make("delegation/flaky-tier", {
      payload: { goal: Schema.Unknown },
      success: Schema.String,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 2 })
    })
    const flakyLayer = flaky.toLayer(() =>
      Effect.suspend(() => {
        flakyAttempts += 1
        return flakyAttempts === 1 ? Effect.fail("throttled") : Effect.succeed("weak result")
      })
    )
    const weak = Flow.make("delegation/weak-retried", {
      payload: { leaf: opaque, tier: opaque, goal: opaque, budget: opaque },
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: ({ goal }: { readonly goal?: unknown }) => flaky.call({ goal })
    }) as unknown as Scripted
    const chain = DelegationChain.make({
      refine: roleFlow("refine", { prompt: opaque }),
      plan: roleFlow("plan", { input: opaque, output: opaque, review: opaque, round: opaque }),
      derisk: roleFlow("derisk", { output: opaque }),
      execute: { weak, strong: roleFlow("strong", { leaf: opaque, tier: opaque, goal: opaque, budget: opaque }) },
      review: roleFlow("review", {
        stage: opaque,
        leaf: opaque,
        tier: opaque,
        output: opaque,
        goal: opaque,
        plan: opaque,
        leaves: opaque
      }),
      settle: roleFlow("settle", {
        prompt: opaque,
        goal: opaque,
        plan: opaque,
        leaves: opaque,
        review: opaque,
        deriskExhausted: opaque
      }),
      tierOrder: ["weak", "strong"],
      maxDepth: 1,
      maxDeriskRounds: 1
    })

    expect(await execute(chain as never, { input: "ship it" }, "delegation-tier-retry-policy", chainLayer, flakyLayer))
      .toBe("settled")
    expect(flakyAttempts).toBe(2)
    expect(chainCalls.map((call) => call.role)).toEqual(["refine", "plan", "derisk", "review", "review", "settle"])
    expect(chainCalls.filter((call) => call.role === "review").map((call) => (call.payload as { tier?: string }).tier))
      .toEqual(["weak", undefined])
  })

  it("declares both arms of every rung, so a plan carries the topology a run may take", () => {
    const first = Graph.build(scriptedChain(), { input: "ship it" })
    const second = Graph.build(scriptedChain(), {
      input: "ship it",
      execution: { goal: "goal", derisked: { _tag: "Approved", output: { agent: { goal: "a" } } } }
    })

    // The derisk loop's one approval decision in the first round; in the
    // execution round, a failure check and a verdict per tier for the leaf,
    // with each next rung declared once.
    expect(Graph.nodes(first).filter((node) => node.kind === "Branch")).toHaveLength(1)
    expect(Graph.nodes(second).filter((node) => node.kind === "Branch")).toHaveLength(4)
  })

  it("hands settle every leaf output of the derisked plan, in plan order", async () => {
    chainCalls.length = 0
    approvesTier = "weak"
    planned = {
      sequence: [{ agent: { goal: "a", seat: "drafter" } }, {
        parallel: [{ agent: { goal: "b" } }, { agent: { goal: "c" } }]
      }]
    }
    const settled = await execute(scriptedChain(3) as never, { input: "ship it" }, "delegation-plan-order", chainLayer)

    expect(settled).toBe("settled")
    const weak = chainCalls.filter((call) => call.role === "weak").map((call) =>
      (call.payload as { readonly leaf: Trellis.Leaf }).leaf
    )
    expect([...weak].sort((left, right) => left.path.localeCompare(right.path))).toEqual(Trellis.leaves(planned))
    const settlement = chainCalls.find((call) => call.role === "settle")!.payload as { readonly leaves: unknown }
    // Each output names its leaf, so a permuted settlement cannot pass.
    expect(settlement.leaves).toEqual(["weak:a", "weak:b", "weak:c"])
    // The sequence runs its first leaf before either member of the parallel group.
    const order = chainCalls.filter((call) => call.role === "weak").map((call) =>
      (call.payload as { readonly leaf: Trellis.Leaf }).leaf.goal
    )
    expect(order[0]).toBe("a")
  })

  it("fails leaf_failed at the leaf's path when no tier settles it, and never settles", async () => {
    chainCalls.length = 0
    approvesTier = "none"
    planned = { agent: { goal: "a" } }
    const exit = await executeExit(scriptedChain() as never, { input: "ship it" }, "delegation-exhausted", chainLayer)

    expect(exit._tag).toBe("Failure")
    const failure = Cause.findErrorOption((exit as Exit.Failure<unknown, unknown>).cause)
    expect(failure._tag === "Some" ? failure.value : undefined).toMatchObject({
      code: "leaf_failed",
      path: "root",
      message: "No tier settled the leaf at root"
    })
    expect(chainCalls.map((call) => call.role)).toEqual([
      "refine",
      "plan",
      "derisk",
      "weak",
      "review",
      "strong",
      "review"
    ])
  })

  it("escalates a tier whose call fails to the next tier", async () => {
    chainCalls.length = 0
    approvesTier = "strong"
    planned = { agent: { goal: "a" } }
    failingTier = "weak"
    try {
      expect(await execute(scriptedChain() as never, { input: "ship it" }, "delegation-tier-fails", chainLayer))
        .toBe("settled")
    } finally {
      failingTier = undefined
    }

    expect(chainCalls.map((call) => call.role)).toEqual([
      "refine",
      "plan",
      "derisk",
      "weak",
      "strong",
      "review",
      "review",
      "settle"
    ])
  })

  it("declares an error schema that encodes its own failures to JSON and back", () => {
    const chain = scriptedChain()
    const failures = [
      new DelegationChain.DelegationError({
        code: "leaf_failed",
        path: "root",
        message: "No tier settled the leaf at root"
      }),
      new Trellis.TrellisError({
        code: "fanout_exceeded",
        path: "root",
        message: "sequence declares 2 members, above the envelope fan-out 1",
        cause: { rounds: [], remaining: 1, refusals: [{ code: "fanout_exceeded", path: "root", message: "m" }] }
      })
    ]
    for (const failure of failures) {
      const encoded = Schema.encodeUnknownSync(chain.errorSchema)(failure)
      expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded)
      expect(Schema.decodeUnknownSync(chain.errorSchema)(encoded)).toEqual(failure)
    }
  })

  it("keeps a tier output that looks like the internal escalation marker", async () => {
    chainCalls.length = 0
    approvesTier = "weak"
    planned = { agent: { goal: "a" } }
    escalateOutput = { _tag: "flows/patterns/DelegationChain/Escalate" }
    try {
      expect(await execute(scriptedChain() as never, { input: "ship it" }, "delegation-marker", chainLayer))
        .toBe("settled")
    } finally {
      escalateOutput = undefined
    }

    expect(chainCalls.map((call) => call.role)).toEqual([
      "refine",
      "plan",
      "derisk",
      "weak",
      "review",
      "review",
      "settle"
    ])
    const settlement = chainCalls.find((call) => call.role === "settle")!.payload as { readonly leaves: unknown }
    expect(settlement.leaves).toEqual([{ _tag: "flows/patterns/DelegationChain/Escalate" }])
  })

  it("refuses execution state whose derisk outcome is malformed", async () => {
    for (
      const derisked of [null, "plan", { _tag: "Approved" }, { _tag: "Unknown", output: { agent: { goal: "a" } } }]
    ) {
      chainCalls.length = 0
      const exit = await executeExit(
        scriptedChain() as never,
        { input: "ship it", execution: { goal: "goal", derisked } },
        `delegation-forged-${JSON.stringify(derisked)}`,
        chainLayer
      )

      const failure = Cause.findErrorOption((exit as Exit.Failure<unknown, unknown>).cause)
      expect(failure._tag === "Some" ? failure.value : undefined).toMatchObject({ code: "derisk_failed", path: "root" })
      expect(chainCalls).toEqual([])
    }
  })

  it("refuses a derisked plan outside the envelope before any leaf runs", async () => {
    chainCalls.length = 0
    approvesTier = "weak"
    planned = { sequence: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }] }
    const exit = await executeExit(scriptedChain() as never, { input: "ship it" }, "delegation-refused", chainLayer)

    const failure = Cause.findErrorOption((exit as Exit.Failure<unknown, unknown>).cause)
    expect(failure._tag === "Some" ? failure.value : undefined).toMatchObject({
      code: "fanout_exceeded",
      path: "root",
      message: "sequence declares 2 members, above the envelope fan-out 1",
      cause: { rounds: [], remaining: 1 }
    })
    expect(chainCalls.map((call) => call.role)).toEqual(["refine", "plan", "derisk"])
  })
})
