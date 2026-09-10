import { describe, it } from "@effect/vitest"
import { Flow, Node } from "@smthrs/core"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Debate from "../src/Debate.ts"
import * as Loop from "../src/Loop.ts"
import * as MergeQueue from "../src/MergeQueue.ts"
import * as Optimizer from "../src/Optimizer.ts"
import * as ReviewLoop from "../src/ReviewLoop.ts"
import * as TryCatchFinally from "../src/TryCatchFinally.ts"
import * as WithRetry from "../src/WithRetry.ts"

const stage = Flow.make({ input: Schema.Unknown, output: Schema.Unknown, body: (input) => Node.succeed(input) })

// A pattern flow used to be anonymous: no MakeOptions carried a name, so a
// plan listed it as `name: undefined` and a decorator over it read
// `withRetry(anonymous, attempts=2)`. Every make now labels its Flow after the
// pattern kind and its declared bounds, the way the decorators name theirs,
// and honors a caller's `name` and `description` instead.
describe("pattern flow names", () => {
  it("names an unnamed pattern after its kind and declared bounds", () => {
    expect(Debate.make({ proponent: stage, opponent: stage, judge: stage, rounds: 1 }).name).toBe("debate(rounds=1)")
    expect(ReviewLoop.make({ produce: stage, review: stage, revise: stage, maxRounds: 3 }).name).toBe(
      "reviewLoop(maxRounds=3)"
    )
    expect(Loop.make({ body: stage, maxIterations: 2 }).name).toBe("loop(maxIterations=2, onMaxReached=return-last)")
    expect(
      MergeQueue.make({
        members: [{ id: "docs", flow: stage }, { id: "hotfix", flow: stage, priority: 5000 }],
        failurePolicy: "halt"
      }).name
    ).toBe("mergeQueue(members=hotfix,docs, concurrency=1, failurePolicy=halt)")
    expect(TryCatchFinally.make({ try: stage, catch: stage }).name).toBe("tryCatchFinally(catch=true, finally=false)")
  })

  it("leaves an undeclared bound out of the label", () => {
    expect(Optimizer.make({ generate: stage, evaluate: stage, maxIterations: 3 }).name).toBe(
      "optimizer(maxIterations=3, onMaxReached=return-last)"
    )
    expect(Optimizer.make({ generate: stage, evaluate: stage, maxIterations: 3, targetScore: 0.5 }).name).toBe(
      "optimizer(maxIterations=3, targetScore=0.5, onMaxReached=return-last)"
    )
  })

  it("keeps the caller's name and description", () => {
    const debate = Debate.make({
      name: "pricing-debate",
      description: "Argue the pricing page copy.",
      proponent: stage,
      opponent: stage,
      judge: stage,
      rounds: 2
    })

    expect(debate.name).toBe("pricing-debate")
    expect(debate.description).toBe("Argue the pricing page copy.")
  })

  it("reaches the decorators", () => {
    const debate = Debate.make({ proponent: stage, opponent: stage, judge: stage, rounds: 1 })

    expect((WithRetry.withRetry(debate, { attempts: 2 }) as typeof debate).name).toBe(
      "withRetry(debate(rounds=1), attempts=2)"
    )
  })
})
