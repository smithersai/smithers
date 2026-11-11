import { describe, it } from "@effect/vitest"
import * as RuntimeFlow from "@smthrs/flow/Flow"
import * as PlanNode from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Debate from "../src/Debate.vibe"
import * as MergeQueue from "../src/MergeQueue.vibe"
import * as Optimizer from "../src/Optimizer.ts"
import * as Pattern from "../src/Pattern.ts"
import * as ReviewLoop from "../src/ReviewLoop.vibe"

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
// `decorate(anonymous)`. Every make now labels its Flow after the pattern kind,
// its declared bounds and its members, the way the decorators name theirs, and
// honors a caller's `name` and `description` instead. The members are in the
// label because the engine resolves a flow by its tag (see SharedTag.test.ts).
describe("pattern flow names", () => {
  it("names an unnamed pattern after its kind, declared bounds and members", () => {
    expect(
      Debate.make({ proponent: runtimeStage, opponent: runtimeStage, judge: runtimeStage, rounds: 1 })._tag
    ).toBe("debate(rounds=1)[stage, stage, stage]")
    expect(ReviewLoop.make({ produce: stage, review: stage, revise: stage, maxRounds: 3 })._tag).toBe(
      "reviewLoop(maxRounds=3)[stage, stage, stage]"
    )
    expect(
      MergeQueue.make({
        members: [{ id: "docs", flow: runtimeStage }, { id: "hotfix", flow: runtimeStage, priority: 5000 }],
        failurePolicy: "halt"
      })._tag
    ).toBe("mergeQueue(members=hotfix,docs, concurrency=1, failurePolicy=halt)[stage, stage]")
  })

  it("leaves an undeclared bound out of the label", () => {
    expect(Optimizer.make({ generate: stage, evaluate: stage, maxIterations: 3 })._tag).toBe(
      "optimizer(maxIterations=3, onMaxReached=return-last)[stage, stage]"
    )
    expect(Optimizer.make({ generate: stage, evaluate: stage, maxIterations: 3, targetScore: 0.5 })._tag).toBe(
      "optimizer(maxIterations=3, targetScore=0.5, onMaxReached=return-last)[stage, stage]"
    )
  })

  it("names an action member by its name and an unnamed member anonymous", () => {
    const action = { name: "draft", call: stage.call }
    const unnamed = { call: stage.call }

    expect(Optimizer.make({ generate: action, evaluate: unnamed, maxIterations: 3 })._tag).toBe(
      "optimizer(maxIterations=3, onMaxReached=return-last)[draft, anonymous]"
    )
  })

  it("quotes a member name that could imitate the label's separators", () => {
    const inner = ReviewLoop.make({ produce: stage, review: stage, revise: stage, maxRounds: 2 })

    expect(ReviewLoop.make({ produce: inner, review: stage, revise: stage, maxRounds: 3 })._tag).toBe(
      "reviewLoop(maxRounds=3)[\"reviewLoop(maxRounds=2)[stage, stage, stage]\", stage, stage]"
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

    const audited: Pattern.Decorator = function audited(inner) {
      return inner
    }

    expect(Pattern.decorate(loop, audited)._tag).toBe("audited(reviewLoop(maxRounds=3)[stage, stage, stage])")
  })
})
