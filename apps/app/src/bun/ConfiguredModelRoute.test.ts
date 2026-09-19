import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as Evaluator from "@smthrs/model/Evaluator"
import { ModelRequest } from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import { hostModelCredentials, planModelBinding } from "@smthrs/rpc/ConfiguredModel"
import type { ModelBinding, ModelPlan } from "@smthrs/rpc/ConfiguredModel"
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { PROVIDER_CONFIDENCE, PROVIDER_MODEL, PROVIDER_REPLY } from "../../e2e/real/support/model-provider-behaviors"
import { launchModelProvider } from "../../e2e/real/support/model-provider-process"
import type { ModelProvider } from "../../e2e/real/support/model-provider-process"
import { toEvaluatorLayer, toModel, withRoute } from "./ConfiguredModelRoute"

const KEY = "sk-route-REDACTME-0123456789"
const apiKey = Redacted.make(KEY)

let provider: ModelProvider
let env: Record<string, string> = {}

beforeAll(async () => {
  provider = await launchModelProvider({ key: KEY })
  env = {
    ANTHROPIC_API_KEY: KEY,
    OPENAI_API_KEY: KEY,
    OPENROUTER_API_KEY: KEY,
    SMITHERS_MODEL_KEY_LOOPBACK: KEY,
    SMITHERS_MODEL_KEY_LOOPBACK_ORIGIN: provider.origin
  }
})

afterAll(async () => {
  await provider.close()
})

const planOf = (binding: ModelBinding): ModelPlan => {
  const planned = planModelBinding(binding, hostModelCredentials(env))
  if (!planned.ok) throw new Error(`not planned: ${planned.failure.code}`)
  return planned.plan
}

const prepared = (plan: ModelPlan): Promise<Route.PreparedRequest> => {
  const request = ModelRequest.make({
    modelId: plan.modelId,
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    params: {}
  })
  return Effect.runPromise(
    Effect.flatMap(Effect.fromResult(withRoute(plan, apiKey, (route) => Route.prepare(route, request))), (run) => run)
  )
}

const executor = RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))

const replyOf = (plan: ModelPlan): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const model = yield* toModel(plan, apiKey)
      const events = yield* Stream.runCollect(model.stream(ModelRequest.make({
        modelId: plan.modelId,
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        params: { maxTokens: 16 }
      })))
      return Array.from(events).flatMap((event) => event.type === "text-delta" ? [event.text] : []).join("")
    }).pipe(Effect.provide(executor))
  )

describe("a planned model becomes a Route", () => {
  test("each generation protocol posts to exactly the URL the plan promised, and the sealed view holds no credential", async () => {
    const plans = [
      planOf({ protocol: "anthropic-messages", modelId: "claude-x", credential: "ANTHROPIC_API_KEY" }),
      planOf({ protocol: "anthropic-messages", baseUrl: provider.origin, modelId: "claude-x", credential: "LOOPBACK" }),
      planOf({ protocol: "openai-responses", modelId: "gpt-x", credential: "OPENAI_API_KEY" }),
      planOf({ protocol: "openai-responses", baseUrl: "https://openrouter.ai/api", modelId: "gpt-x", credential: "OPENROUTER_API_KEY" }),
      planOf({ protocol: "openai-chat", baseUrl: provider.origin, modelId: "m", credential: "LOOPBACK" }),
      planOf({ protocol: "openai-chat", baseUrl: `${provider.origin}/v1beta/`, path: "/openai/chat/completions", modelId: "m", credential: "LOOPBACK" })
    ]
    expect(plans.map((plan) => plan.url)).toEqual([
      "https://api.anthropic.com/v1/messages",
      `${provider.origin}/v1/messages`,
      "https://api.openai.com/v1/responses",
      "https://openrouter.ai/api/v1/responses",
      `${provider.origin}/v1/chat/completions`,
      `${provider.origin}/v1beta/openai/chat/completions`
    ])
    for (const plan of plans) {
      const request = await prepared(plan)
      expect(request.url).toBe(plan.url)
      expect(JSON.stringify(request)).not.toContain(KEY)
      expect(Object.keys(request.publicHeaders)).not.toContain("x-api-key")
      expect(Object.keys(request.publicHeaders)).not.toContain("authorization")
    }
    expect((await prepared(plans[1]!)).publicHeaders["anthropic-version"]).toBe("2023-06-01")
  })

  test("an evaluation plan has no generation route", () => {
    const plan = planOf({ protocol: "evaluation", baseUrl: provider.origin, modelId: PROVIDER_MODEL.answers, credential: "LOOPBACK" })
    const routed = withRoute(plan, apiKey, () => "routed")
    expect(Result.isFailure(routed) && routed.failure.code).toBe("no_route")
  })

  test("anthropic-messages on a custom origin reaches it with the key header and the version header", async () => {
    const before = (await provider.journal()).length
    const reply = await replyOf(planOf({
      protocol: "anthropic-messages",
      baseUrl: provider.origin,
      modelId: PROVIDER_MODEL.answers,
      credential: "LOOPBACK"
    }))
    expect(reply).toBe(PROVIDER_REPLY.join(""))
    const seen = (await provider.journal()).slice(before)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      protocol: "anthropic-messages",
      authorized: true,
      credentialSha256: provider.acceptedKeySha256,
      headers: { "anthropic-version": "2023-06-01" }
    })
  })

  test("openai-chat on a custom origin streams the provider's reply", async () => {
    const reply = await replyOf(planOf({
      protocol: "openai-chat",
      baseUrl: provider.origin,
      modelId: PROVIDER_MODEL.answers,
      credential: "LOOPBACK"
    }))
    expect(reply).toBe(PROVIDER_REPLY.join(""))
  })

  test("a decision plan asks the real Evaluator at the plan's URL under the plan's model id", async () => {
    const plan = planOf({ protocol: "evaluation", baseUrl: provider.origin, modelId: PROVIDER_MODEL.answers, credential: "LOOPBACK" })
    const before = (await provider.journal()).length
    const answer = await Effect.runPromise(
      Effect.gen(function*() {
        const evaluator = yield* Evaluator.Evaluator
        return yield* evaluator.evaluate({
          state: { text: "x" },
          questions: { ok: new Evaluator.BooleanQuestion({ instructions: "Is it x?" }) }
        })
      }).pipe(Effect.provide(toEvaluatorLayer(plan, apiKey, 5_000).pipe(Layer.provide(FetchHttpClient.layer))))
    )
    expect(answer.answers["ok"]).toEqual({ type: "boolean", probability: PROVIDER_CONFIDENCE })
    const seen = (await provider.journal()).slice(before)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ protocol: "evaluation", modelId: PROVIDER_MODEL.answers, authorized: true })
  })
})
