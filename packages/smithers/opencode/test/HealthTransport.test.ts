import { MockAgent } from "@effect/platform-node/Undici"
import type * as Undici from "@effect/platform-node/Undici"
import * as CompletionClaim from "@smthrs/harness/CompletionClaim"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Health from "../src/Health.ts"

const evidence: CompletionClaim.Evidence = {
  task: "Fix add.mjs and run node test.mjs",
  claim: "Fixed add.mjs; node test.mjs passes",
  treeMoved: true,
  checksRun: [{ command: "node test.mjs", outcome: "passed" }]
}

const answer = {
  answers: {
    complete: { type: "boolean", probability: 0.99 },
    overclaims: { type: "boolean", probability: 0.01 },
    invented: { type: "boolean", probability: 0.01 }
  }
}

describe("the host's judge transport", () => {
  it("judges the next completion after the judge's pools fail for one retry budget", async () => {
    const acquired: Array<MockAgent> = []
    const closed: Array<MockAgent> = []
    const acquire = Effect.gen(function*() {
      const agent = new MockAgent()
      agent.disableNetConnect()
      // Every poisoned pool refuses every request identically. The outage
      // lasts one completion's retry budget; a later pool can answer again.
      if (acquired.length >= Health.evaluatorRetry.attempts) {
        agent.get("https://ai-gateway.vercel.sh")
          .intercept({ method: "POST", path: "/v4/ai/evaluation-model" })
          .reply(200, answer)
      }
      acquired.push(agent)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          closed.push(agent)
          await agent.close()
        })
      )
      return agent as unknown as Undici.Dispatcher
    })
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* Effect.flip(CompletionClaim.read(evidence))
        const second = yield* CompletionClaim.read(evidence)
        return { first, second, closedDuringRun: [...closed] }
      }).pipe(Effect.provide(Health.evaluatorLayer({ AI_GATEWAY_API_KEY: "test-key" }, acquire)))
    )
    expect(outcome.first).toMatchObject({ code: "completion_unjudged" })
    expect(outcome.second).toMatchObject({ complete: 0.99, invented: 0.01 })
    expect(acquired).toHaveLength(Health.evaluatorRetry.attempts + 1)
    expect(outcome.closedDuringRun).toEqual(acquired.slice(0, -1))
    expect(closed).toEqual(acquired)
  })

  it("keeps a pool that answers, including gateway refusals", async () => {
    const acquired: Array<MockAgent> = []
    const acquire = Effect.gen(function*() {
      const agent = new MockAgent()
      agent.disableNetConnect()
      const pool = agent.get("https://ai-gateway.vercel.sh")
      pool.intercept({ method: "POST", path: "/v4/ai/evaluation-model" }).reply(401, {})
      pool.intercept({ method: "POST", path: "/v4/ai/evaluation-model" }).reply(200, answer).times(2)
      acquired.push(agent)
      yield* Effect.addFinalizer(() => Effect.promise(() => agent.close()))
      return agent as unknown as Undici.Dispatcher
    })
    await Effect.runPromise(
      Effect.gen(function*() {
        const evaluator = yield* Evaluator.Evaluator
        const refused = yield* Effect.flip(evaluator.evaluate({ state: {}, questions: {} }))
        expect(refused).toMatchObject({ code: "refused", status: 401 })
        yield* CompletionClaim.read(evidence)
        yield* CompletionClaim.read(evidence)
        expect(acquired).toHaveLength(1)
      }).pipe(Effect.provide(Health.evaluatorLayer({ AI_GATEWAY_API_KEY: "test-key" }, acquire)))
    )
  })
})
