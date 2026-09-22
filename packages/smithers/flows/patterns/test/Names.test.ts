import { describe, it } from "@effect/vitest"
import * as RuntimeFlow from "@smthrs/flow/Flow"
import * as PlanNode from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Debate from "../src/Debate.ts"
import * as Loop from "../src/Loop.ts"
import * as MergeQueue from "../src/MergeQueue.ts"
import * as Optimizer from "../src/Optimizer.ts"
import * as ReviewLoop from "../src/ReviewLoop.ts"
import * as TryCatchFinally from "../src/TryCatchFinally.ts"
import * as WithRetry from "../src/WithRetry.ts"

// Every pattern member is a `@smthrs/flow` flow, and a pattern's declared name
// is the flow TAG, which is where `Compose.label`'s answer lands.
const runtimeStage = RuntimeFlow.make("stage", {
  payload: {
    input: Schema.optional(Schema.Unknown),
    previous: Schema.optional(Schema.Unknown),
    iteration: Schema.optional(Schema.Unknown),
    id: Schema.optional(Schema.Unknown),
    position: Schema.optional(Schema.Unknown),
    transcript: Schema.optional(Schema.Unknown),
    proponent: Schema.optional(Schema.Unknown),
    output: Schema.optional(Schema.Unknown),
    review: Schema.optional(Schema.Unknown),
    round: Schema.optional(Schema.Unknown),
    value: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown)
  },
  success: Schema.Unknown,
  body: ({ input }) => PlanNode.succeed(input)
})

const stage = runtimeStage

// A pattern flow used to be anonymous: no MakeOptions carried a name, so a
// plan listed it as `name: undefined` and a decorator over it read
// `withRetry(anonymous, attempts=2)`. Every make now labels its Flow after the
// pattern kind and its declared bounds, the way the decorators name theirs,
// and honors a caller's `name` and `description` instead.
describe("pattern flow names", () => {
  it("names an unnamed pattern after its kind and declared bounds", () => {
    expect(
      Debate.make({ proponent: runtimeStage, opponent: runtimeStage, judge: runtimeStage, rounds: 1 })._tag
    ).toBe("debate(rounds=1)")
    expect(ReviewLoop.make({ produce: stage, review: stage, revise: stage, maxRounds: 3 })._tag).toBe(
      "reviewLoop(maxRounds=3)"
    )
    expect(Loop.make({ body: runtimeStage, maxIterations: 2 })._tag).toBe(
      "loop(maxIterations=2, onMaxReached=return-last)"
    )
    expect(
      MergeQueue.make({
        members: [{ id: "docs", flow: runtimeStage }, { id: "hotfix", flow: runtimeStage, priority: 5000 }],
        failurePolicy: "halt"
      })._tag
    ).toBe("mergeQueue(members=hotfix,docs, concurrency=1, failurePolicy=halt)")
    expect(TryCatchFinally.make({ try: runtimeStage, catch: runtimeStage })._tag).toBe(
      "tryCatchFinally(catch=true, finally=false)"
    )
  })

  it("leaves an undeclared bound out of the label", () => {
    expect(Optimizer.make({ generate: stage, evaluate: stage, maxIterations: 3 })._tag).toBe(
      "optimizer(maxIterations=3, onMaxReached=return-last)"
    )
    expect(Optimizer.make({ generate: stage, evaluate: stage, maxIterations: 3, targetScore: 0.5 })._tag).toBe(
      "optimizer(maxIterations=3, targetScore=0.5, onMaxReached=return-last)"
    )
  })

  it("keeps the caller's name and description", () => {
    const debate = Debate.make({
      name: "pricing-debate",
      description: "Argue the pricing page copy.",
      proponent: runtimeStage,
      opponent: runtimeStage,
      judge: runtimeStage,
      rounds: 2
    })

    expect(debate._tag).toBe("pricing-debate")
    expect(debate.description).toBe("Argue the pricing page copy.")
  })

  it("reaches the decorators", () => {
    const loop = ReviewLoop.make({ produce: stage, review: stage, revise: stage, maxRounds: 3 })

    expect((WithRetry.withRetry(loop, { attempts: 2 }) as typeof loop)._tag).toBe(
      "withRetry(reviewLoop(maxRounds=3), attempts=2)"
    )
  })
})
