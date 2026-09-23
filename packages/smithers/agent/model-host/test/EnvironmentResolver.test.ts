import { ModelError } from "@smthrs/model/ModelError"
import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import * as ConfiguredModelRoute from "../src/ConfiguredModelRoute.ts"
import type { DurableChatGrant } from "../src/DurableChatProducer.ts"
import { environmentModelResolver } from "../src/EnvironmentResolver.ts"
import { runModelTurn } from "../src/ModelTurnHost.ts"

const binding = {
  protocol: "openai-chat",
  baseUrl: "https://fixture.test",
  modelId: "fixture",
  credential: "FIXTURE"
} as const
const env = { SMITHERS_MODEL_KEY_FIXTURE: " fixture-key ", SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: "https://fixture.test" }
const grant: DurableChatGrant = {
  turnId: "turn",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 1,
  token: "fixture-token",
  cursor: { version: 1, runId: "run", legId: "leg", batch: 0, position: 0, hash: "a".repeat(64) },
  expiresAt: "2100-01-01",
  producerBaseUrl: "https://callback.test",
  request: { runId: "run", instructions: "answer", messages: [{ role: "user", content: "hi" }] }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test.each([false, true])(
  "routes the chosen model using the configured fetch and token budget (%s)",
  async (override) => {
    const fetchImpl = vi.fn<typeof fetch>(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://fixture.test/v1/chat/completions")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key")
      expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toMatchObject({
        model: override ? "override" : "fixture"
      })
      return new Response(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      )
    }, { preconnect() {} }))
    vi.stubGlobal("fetch", fetchImpl)
    const chosenGrant = override
      ? { ...grant, request: { ...grant.request, model: { ...binding, modelId: "override" } } }
      : grant
    const resolved = await Effect.runPromise(
      environmentModelResolver({
        binding,
        env,
        ...(override ? { fetchImpl, maxTokens: 123 } : {})
      })(chosenGrant)
    )
    expect(resolved.options).toEqual({
      modelId: override ? "override" : "fixture",
      credential: "fixture-key",
      ...(override ? { maxTokens: 123 } : {})
    })
    const frames: unknown[] = []
    await Effect.runPromise(
      runModelTurn(resolved.model, chosenGrant.request, resolved.options, (frame) =>
        Effect.sync(() => {
          frames.push(frame)
        }))
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(frames).toContainEqual({ runId: "run", type: "delta", kind: "text", text: "hello" })
    expect(frames.at(-1)).toEqual({ runId: "run", type: "done", reason: "stop" })
  }
)

test("refuses unavailable and foreign-origin models before invoking transport", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
  for (
    const options of [{ binding: {}, env }, { binding, env: {} }, {
      binding: { ...binding, baseUrl: "https://other.test" },
      env
    }]
  ) {
    await expect(Effect.runPromise(environmentModelResolver({ ...options, fetchImpl })(grant))).rejects.toThrow(
      "configured model is unavailable"
    )
  }
  expect(fetchImpl).not.toHaveBeenCalled()
})

test.each([undefined, " "])("refuses a credential removed between planning and retrieval (%s)", async (removed) => {
  let reads = 0
  const changingEnv = {
    ...env,
    get SMITHERS_MODEL_KEY_FIXTURE() {
      return ++reads === 1 ? "fixture-key" : removed
    }
  }
  await expect(Effect.runPromise(environmentModelResolver({ binding, env: changingEnv })(grant))).rejects.toThrow(
    "credential is unavailable"
  )
})

test("replaces a route failure with a credential-safe diagnostic", async () => {
  vi.spyOn(ConfiguredModelRoute, "toModel").mockReturnValueOnce(
    Effect.fail(new ModelError({ code: "no_route", message: "private route diagnostic" }))
  )
  await expect(Effect.runPromise(environmentModelResolver({ binding, env })(grant))).rejects.toThrow(
    /^configured model route is unavailable$/
  )
})
