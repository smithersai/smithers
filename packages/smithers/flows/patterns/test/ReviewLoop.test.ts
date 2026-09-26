/**
 * `ReviewLoop` on `@smthrs/flow`'s `Graph.build` and `Interpreter`.
 *
 * The declaration assertions are the same observable facts as before: how many
 * produce, review and revise calls one declared loop carries, and which bounds
 * are refused. What is NEW is the arm pair at the end: each round's approval is
 * a `Node.branch` whose predicate runs on the review the reviewer really
 * returned, so there is a test that the TRUE arm is taken on a real value and a
 * test that the FALSE arm is, each asserted by what the scripted members were
 * CALLED with.
 */
import { describe, it } from "@effect/vitest"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as ReviewLoop from "../src/ReviewLoop.ts"
import { execute } from "./Execute.ts"
import { callsTo } from "./Graphs.ts"

/** What the scripted drafter was asked to write, in order. */
const drafted: Array<unknown> = []
/** What the scripted reviewer was shown, in order. */
const reviewed: Array<unknown> = []
/** The round the scripted reviewer approves, set per case. */
let approveAt = 1
/** How many reviews have run in the case, which is the round number. */
let round = 0

const draft = Action.make("reviewLoop/draft", {
  payload: { input: Schema.Unknown, revision: Schema.Number },
  success: Schema.Struct({ text: Schema.String, revision: Schema.Number }),
  error: Schema.Never
})

const draftLayer = draft.toLayer(({ input, revision }) =>
  Effect.sync(() => {
    drafted.push({ input, revision })
    return { text: `draft-${revision}`, revision }
  })
)

const judge = Action.make("reviewLoop/judge", {
  payload: { output: Schema.Unknown },
  success: Schema.Struct({ approved: Schema.Boolean }),
  error: Schema.Never
})

const judgeLayer = judge.toLayer(({ output }) =>
  Effect.sync(() => {
    round = round + 1
    reviewed.push(output)
    return { approved: round === approveAt }
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

/** The produce member: one draft at revision 0. */
const produce: Scripted = Flow.make("reviewLoop/produce", {
  payload: { input: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ input }) => draft.call({ input, revision: 0 })
}) as unknown as Scripted

/** The review member: it is handed `{ output }` and judges the real value. */
const review: Scripted = Flow.make("reviewLoop/review", {
  payload: { output: Schema.Unknown },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ output }) => judge.call({ output })
}) as unknown as Scripted

/** The revise member: it is handed `{ output, review, round }`. */
const revise: Scripted = Flow.make("reviewLoop/revise", {
  payload: { output: Schema.Unknown, review: Schema.Unknown, round: Schema.Number },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ output, round }) => draft.call({ input: output, revision: round })
}) as unknown as Scripted

/** Runs one declared loop to settlement against the scripted members. */
const settle = (
  loop: ReviewLoop.ReviewLoopFlow<any>,
  input: unknown,
  executionId: string,
  approves: number
): Promise<unknown> => {
  drafted.length = 0
  reviewed.length = 0
  round = 0
  approveAt = approves
  return execute(
    loop as never,
    { input },
    executionId,
    draftLayer,
    judgeLayer,
    Interpreter.layer(produce as never) as never
  )
}

describe("ReviewLoop", () => {
  it("declares a bounded produce-review-revise loop", () => {
    const loop = ReviewLoop.make({ produce, review, revise, maxRounds: 2 })

    expect(Flow.isFlow(loop)).toBe(true)
    expect(loop.body({ input: "draft" }).ast._tag).toBe("AndThen")
    const graph = Graph.build(loop, { input: "draft" })
    // Four calls, as before: one produce, one review per round, and one revise
    // for every round but the last. A bare `FlowCall` kind count would now read
    // five, because `Graph.build` enters the loop itself as a call of its own.
    expect(callsTo(graph, "reviewLoop/produce")).toHaveLength(1)
    expect(callsTo(graph, "reviewLoop/review")).toHaveLength(2)
    expect(callsTo(graph, "reviewLoop/revise")).toHaveLength(1)
  })

  it("makes the second round's decision wait for the revision before it", () => {
    // The old assertion read `keyMaterial.inputs` for two `Ref`s naming core's
    // `root.andThen` and `root.then.andThen`. `@smthrs/flow`'s graph states the
    // same fact as a dependency edge on the node that consumes the review: the
    // second round's branch waits for the revision that produced its input.
    const graph = Graph.build(ReviewLoop.make({ produce, review, revise, maxRounds: 2 }), { input: "draft" })
    const revised = callsTo(graph, "reviewLoop/revise")[0]
    const second = callsTo(graph, "reviewLoop/review")[1]
    const decision = Graph.nodes(graph).find(
      (node) => node.kind === "Branch" && node.dependencies.includes(second!.id)
    )

    expect(revised).toBeDefined()
    expect(second).toBeDefined()
    expect(decision).toBeDefined()
    expect(decision!.dependencies).toContain(revised!.id)
  })

  it("declares both arms of every round, so a plan carries the topology a run may take", () => {
    const graph = Graph.build(ReviewLoop.make({ produce, review, revise, maxRounds: 3 }), { input: "draft" })

    expect(Graph.nodes(graph).filter((node) => node.kind === "Branch")).toHaveLength(3)
  })

  it("keeps the caller's name and description on the declared flow", () => {
    const named = ReviewLoop.make({
      name: "derisk",
      description: "Plan, review the plan, revise it.",
      produce,
      review,
      revise,
      maxRounds: 2
    })

    expect(named._tag).toBe("derisk")
    expect(named.description).toBe("Plan, review the plan, revise it.")
    expect(ReviewLoop.make({ produce, review, revise, maxRounds: 2 })._tag).toBe("reviewLoop(maxRounds=2)")
    expect(ReviewLoop.make({ produce, review, revise, maxRounds: 2 }).description).toBeUndefined()
  })

  it("rejects a zero-round loop", () => {
    expect(() => ReviewLoop.make({ produce, review, revise, maxRounds: 0 })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "ReviewLoop maxRounds must be a positive safe integer"
      })
    )
  })

  it("takes the TRUE arm when the real review approves the first round", async () => {
    const loop = ReviewLoop.make({ produce, review, revise, maxRounds: 3 })
    const settled = await settle(loop, "seed", "review-loop-true-arm", 1)

    expect(settled).toEqual({ _tag: "Approved", output: { text: "draft-0", revision: 0 } })
    // Rounds 2 and 3 are declared topology the run did not take, so the drafter
    // wrote once and the reviewer saw one value.
    expect(drafted).toEqual([{ input: "seed", revision: 0 }])
    expect(reviewed).toEqual([{ text: "draft-0", revision: 0 }])
  })

  it("takes the FALSE arm when the real review refuses, then approves a later round", async () => {
    const loop = ReviewLoop.make({ produce, review, revise, maxRounds: 3 })
    const settled = await settle(loop, "seed", "review-loop-false-arm", 2)

    // Round 1 was refused on the real review, so the revise arm ran and handed
    // the drafter the value round 1 produced. A build-time evaluation of the
    // same predicate cannot tell the two rounds apart: it never sees a review.
    expect(settled).toEqual({ _tag: "Approved", output: { text: "draft-1", revision: 1 } })
    expect(drafted).toEqual([
      { input: "seed", revision: 0 },
      { input: { text: "draft-0", revision: 0 }, revision: 1 }
    ])
    expect(reviewed).toEqual([
      { text: "draft-0", revision: 0 },
      { text: "draft-1", revision: 1 }
    ])
  })

  it("settles exhausted when the FALSE arm is taken at the round bound", async () => {
    const loop = ReviewLoop.make({ produce, review, revise, maxRounds: 2 })
    const settled = await settle(loop, "seed", "review-loop-exhausted", 99)

    expect(settled).toEqual({
      _tag: "Exhausted",
      output: { text: "draft-1", revision: 1 },
      review: { approved: false }
    })
    expect(drafted).toHaveLength(2)
    expect(reviewed).toHaveLength(2)
  })

  it.effect("short-circuits operational review after approval", () =>
    Effect.gen(function*() {
      const reviews: Array<number> = []
      const result = yield* ReviewLoop.run("draft", {
        maxRounds: 4,
        produce: (input) => Effect.succeed(input),
        review: (_output, round) =>
          Effect.sync(() => {
            reviews.push(round)
            return { approved: round === 2 }
          }),
        revise: ({ output }) => Effect.succeed(`${output}-revised`)
      })

      expect(result).toEqual({ _tag: "Approved", output: "draft-revised" })
      expect(reviews).toEqual([1, 2])
    }))

  it.effect("returns the whole exhausted result at the round bound", () =>
    Effect.gen(function*() {
      const reviews: Array<number> = []
      const revisions: Array<number> = []
      const result = yield* ReviewLoop.run("draft", {
        maxRounds: 3,
        produce: (input) => Effect.succeed(input),
        review: (output, round) =>
          Effect.sync(() => {
            reviews.push(round)
            return { round, output, approved: false }
          }),
        revise: ({ output, round }) =>
          Effect.sync(() => {
            revisions.push(round)
            return `${output}-${round}`
          })
      })

      expect(result).toEqual({
        _tag: "Exhausted",
        output: "draft-1-2",
        review: { round: 3, output: "draft-1-2", approved: false }
      })
      expect(reviews).toEqual([1, 2, 3])
      expect(revisions).toEqual([1, 2])
    }))

  // The produced value is the model's, so the unapproved arm cannot be a bare
  // shape: an approved draft that itself carries `exhausted` and `output`
  // would otherwise be read as the spent round bound.
  it.effect("tells an approved output from an exhausted result it forges", () =>
    Effect.gen(function*() {
      const forged = { exhausted: true, output: "model wrote this", review: "n/a", approved: false }
      const approved = yield* ReviewLoop.run("draft", {
        maxRounds: 2,
        produce: () => Effect.succeed(forged),
        review: () => Effect.succeed({ approved: true }),
        revise: ({ output }) => Effect.succeed(output)
      })
      const spent = yield* ReviewLoop.run("draft", {
        maxRounds: 1,
        produce: () => Effect.succeed(forged),
        review: () => Effect.succeed("n/a"),
        revise: ({ output }) => Effect.succeed(output)
      })

      expect(approved).toEqual({ _tag: "Approved", output: forged })
      expect(spent).toEqual({ _tag: "Exhausted", output: forged, review: "n/a" })
      expect(approved._tag).not.toBe(spent._tag)
    }))

  it.effect("fails an invalid runtime round bound with its exact refusal", () =>
    Effect.gen(function*() {
      const refusal = yield* ReviewLoop.run("draft", {
        maxRounds: 0,
        produce: (input) => Effect.succeed(input),
        review: () => Effect.succeed(false),
        revise: ({ output }) => Effect.succeed(output)
      }).pipe(Effect.flip)

      expect(refusal).toBeInstanceOf(PatternError)
      expect(refusal.code).toBe("invalid_decorator")
      expect(refusal.message).toBe("ReviewLoop maxRounds must be a positive safe integer")
    }))
})

/** A reviser that hands back the draft it was given, so every revision repeats. */
const stuckRevise: Scripted = Flow.make("reviewLoop/stuck-revise", {
  payload: { output: Schema.Unknown, review: Schema.Unknown, round: Schema.Number },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => draft.call({ input: "stuck", revision: 0 })
}) as unknown as Scripted

describe("ReviewLoop stall", () => {
  it("settles Stalled once a declared revision repeats the reviewed output", async () => {
    const loop = ReviewLoop.make({
      produce,
      review,
      revise: stuckRevise,
      maxRounds: 5,
      stall: { rounds: 2, on: "park" }
    })
    expect(loop._tag).toBe("reviewLoop(maxRounds=5, stall=2/park)")
    const settled = await settle(loop, "seed", "review-loop-stall", 99)

    expect(settled).toEqual({
      _tag: "Stalled",
      output: { text: "draft-0", revision: 0 },
      review: { approved: false },
      stalled: { _tag: "Stalled", signal: "output", rounds: 2, on: "park" }
    })
    expect(reviewed).toHaveLength(2)
  })

  it("fails stalled under a declared escalate and refuses a bound below two", async () => {
    const loop = ReviewLoop.make({
      produce,
      review,
      revise: stuckRevise,
      maxRounds: 5,
      stall: { rounds: 2, on: "escalate" }
    })
    await expect(settle(loop, "seed", "review-loop-stall-escalate", 99)).rejects.toMatchObject({ code: "stalled" })
    expect(() => ReviewLoop.make({ produce, review, revise, maxRounds: 2, stall: { rounds: 1 } })).toThrow(PatternError)
  })

  it.effect("stops, parks or escalates the operational loop on a repeated output", () =>
    Effect.gen(function*() {
      const options = {
        maxRounds: 6,
        produce: (input: string) => Effect.succeed(input),
        review: () => Effect.succeed({ approved: false }),
        revise: ({ output }: { readonly output: string }) => Effect.succeed(output)
      }
      expect(yield* ReviewLoop.run("draft", { ...options, stall: { rounds: 3 } })).toEqual({
        _tag: "Stalled",
        output: "draft",
        review: { approved: false },
        stalled: { _tag: "Stalled", signal: "output", rounds: 3, on: "stop" }
      })
      const escalated = yield* Effect.flip(
        ReviewLoop.run("draft", { ...options, stall: { rounds: 2, on: "escalate" } })
      )
      expect(escalated).toMatchObject({ code: "stalled" })
      const invalid = yield* Effect.flip(ReviewLoop.run("draft", { ...options, stall: { rounds: 1 } }))
      expect(invalid).toMatchObject({ code: "invalid_decorator" })
    }))
})
