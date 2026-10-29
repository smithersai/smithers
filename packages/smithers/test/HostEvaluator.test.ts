import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import * as NativeControl from "../src/internal/NativeControl.ts"
import { layerSeatEvaluator } from "../src/internal/NativeEquipment.ts"
import { platform } from "../src/internal/NodeControlHost.ts"
import * as NodeControl from "../src/NodeControl.ts"

/** Claude Code, scripted: every session the SDK is asked to start, and the text each one answers. */
const claudeCode = vi.hoisted(() => ({
  started: [] as Array<{ readonly model: unknown; readonly prompt: unknown }>,
  reply: ""
}))
vi.mock(import("@anthropic-ai/claude-agent-sdk"), async (original) => ({
  ...(await original()),
  query: (({ options, prompt }: { readonly options?: { readonly model?: string }; readonly prompt: unknown }) => {
    claudeCode.started.push({ model: options?.model, prompt })
    return Object.assign(
      (async function*() {
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: { id: "msg_1", content: [{ type: "text", text: claudeCode.reply }] }
        }
        yield {
          type: "result",
          subtype: "success",
          session_id: "sess_1",
          is_error: false,
          result: claudeCode.reply,
          stop_reason: "end_turn",
          usage: { input_tokens: 30, output_tokens: 9 }
        }
      })(),
      { interrupt: () => Promise.resolve(), close: () => {} }
    )
  }) as never
}))

const roots: Array<string> = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  claudeCode.started.length = 0
})

it("composes native hosts without provider keys", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "")
  const host = NativeControl.make(platform)
  expect(() => host.layerHost({ root: "/unused" })).not.toThrow()
  expect(() => host.layerControl({ root: "/unused" })).not.toThrow()
  expect(() => NodeControl.layer({ root: "/unused" })).not.toThrow()
  expect(() => NodeControl.layerControl({ root: "/unused" })).not.toThrow()
})

it("accepts an explicitly scripted judge without reading credentials", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "")
  const host = NativeControl.make({ ...platform, evaluator: ScriptedJudge.layer })
  expect(() => host.layerHost({ root: "/unused" })).not.toThrow()
  expect(() => NodeControl.layerControl({ root: "/unused", evaluator: ScriptedJudge.layer })).not.toThrow()
})

it("does not demand a judge from a host that drives no run", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "")
  // A listing, a diagnosis and a log read cannot reach a completion, so there
  // is nothing for a judge to rule on and nothing to refuse. The executor
  // underneath them refuses the launch instead, which is what keeps this a
  // narrower refusal rather than a hole in it.
  const host = NativeControl.make(platform)
  expect(() => host.layerControl({ root: "/unused", startsRuns: false })).not.toThrow()
  expect(() => NodeControl.layer({ root: "/unused", startsRuns: false })).not.toThrow()
  expect(() => NodeControl.layerControl({ root: "/unused", startsRuns: false })).not.toThrow()
})

it("does not demand local credentials from a remote control client", () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", "")
  expect(() => NodeControl.layerControl({ remote: "http://127.0.0.1:5300" })).not.toThrow()
})

const question = { complete: Evaluator.BooleanQuestion.of({ instructions: "Complete?" }) }
const poolEnvironment = {
  SMITHERS_ACCOUNT_POOL_URL: "https://pool.example",
  SMITHERS_ACCOUNT_POOL_KEY: "host-credential",
  SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt"
}
const jevUrl = Evaluator.defaultBaseUrl
const sse = (
  request: Parameters<RequestExecutor.RequestExecutor["execute"]>[0],
  answer: unknown,
  usage: Record<string, number> = {}
) => {
  const events = [
    {
      type: "response.output_text.delta",
      item_id: "answer",
      output_index: 0,
      content_index: 0,
      delta: JSON.stringify({ answers: { complete: answer } })
    },
    { type: "response.completed", response: { id: "response", status: "completed", usage } }
  ]
  return HttpClientResponse.fromWeb(
    request,
    new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" }
    })
  )
}
type Gateway = "answers" | "unreachable" | "never" | "invalid" | 400 | 401 | 403 | 422 | 429 | 503
/**
 * Jev's gateway behaves as `gateway` says, over its own HTTP client; the
 * model executor serves only the pool and Luna.
 */
const judge = (environment: Record<string, string>, gateway: Gateway) => {
  const sent: string[] = []
  const jevHttp = HttpClient.make((request) => {
    sent.push(request.url)
    if (gateway === "never") return Effect.never
    if (gateway === "unreachable") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connect ECONNREFUSED" })
        })
      )
    }
    if (typeof gateway === "number") {
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: gateway })))
    }
    const answers = gateway === "answers"
      ? { complete: { type: "boolean", probability: 0.9 } }
      : { complete: { type: "boolean", probability: "high" } }
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ answers })))
  })
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request) => {
      sent.push(request.url)
      if (request.url.endsWith("/routes")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ routes: ["chatgpt"] })))
      }
      return Effect.succeed(sse(request, { type: "boolean", probability: 0.95 }))
    }
  })
  const run = Effect.flatMap(
    Evaluator.Evaluator,
    (evaluator) => evaluator.evaluate({ state: "proof", questions: question })
  )
    .pipe(Effect.provide(
      layerSeatEvaluator({ ...poolEnvironment, ...environment }, Layer.succeed(HttpClient.HttpClient)(jevHttp)).pipe(
        Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor))
      )
    ))
  return { run, sent }
}

it("judges with Jev and never calls Luna when the gateway answers", async () => {
  const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, "answers")
  const result = await Effect.runPromise(run)
  expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.9 })
  expect(result.decidedBy).toBeUndefined()
  expect(sent).toEqual([jevUrl])
})

it("judges through the metered model proxy a self-hosted Flow host is given", async () => {
  // The backend hands a Flow host a per-binding credential and the proxy URLs,
  // never a gateway key; the public gateway answers that credential 401.
  const proxied = judge({
    AI_GATEWAY_API_KEY: "smithers-binding-credential",
    SMITHERS_MODEL_PROXY_URL: "https://backend.example.test/model-proxy",
    SMITHERS_MODEL_PROXY_PROVIDERS: "cerebras,vercel"
  }, "answers")
  await Effect.runPromise(proxied.run)
  expect(proxied.sent).toEqual(["https://backend.example.test/model-proxy/vercel/v4/ai/evaluation-model"])

  const explicit = judge({
    AI_GATEWAY_API_KEY: "smithers-binding-credential",
    SMITHERS_EVALUATOR_BASE_URL: "https://backend.example.test/model-proxy/vercel/v4/ai/evaluation-model"
  }, "answers")
  await Effect.runPromise(explicit.run)
  expect(explicit.sent).toEqual(["https://backend.example.test/model-proxy/vercel/v4/ai/evaluation-model"])
})

it("keeps Jev on the public gateway when the proxy does not serve vercel", async () => {
  const { run, sent } = judge({
    AI_GATEWAY_API_KEY: "vck_test",
    SMITHERS_MODEL_PROXY_URL: "https://backend.example.test/model-proxy",
    SMITHERS_MODEL_PROXY_PROVIDERS: "cerebras"
  }, "answers")
  await Effect.runPromise(run)
  expect(sent).toEqual([jevUrl])
})

it("answers with Luna through the pool seat when Jev is unreachable", async () => {
  const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, "unreachable")
  const result = await Effect.runPromise(run)
  expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.95 })
  expect(result.decidedBy).toBe("seat")
  expect(sent.at(-1)).toBe("https://pool.example/chatgpt/codex/responses")
})

it("answers with Luna when Jev times out", async () => {
  vi.useFakeTimers()
  try {
    const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, "never")
    const result = Effect.runPromise(run)
    await vi.advanceTimersByTimeAsync(Evaluator.defaultTimeoutMs + 100)
    expect((await result).answers.complete).toEqual({ type: "boolean", probability: 0.95 })
    expect(sent.at(-1)).toBe("https://pool.example/chatgpt/codex/responses")
  } finally {
    vi.useRealTimers()
  }
})

it("judges on Luna through the pool, and never asks Jev, when no gateway key is set", async () => {
  const { run, sent } = judge({}, "answers")
  const result = await Effect.runPromise(run)
  expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.95 })
  expect(result.decidedBy).toBe("seat")
  expect(sent).toEqual(["https://pool.example/routes", "https://pool.example/chatgpt/codex/responses"])
})

it.each([429, 503] as const)("answers with Luna when the gateway keeps answering %s", async (status) => {
  const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, status)
  const result = await Effect.runPromise(run)
  expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.95 })
  expect(sent.filter((url) => url === jevUrl)).toHaveLength(Evaluator.defaultAttempts)
  expect(sent.at(-1)).toBe("https://pool.example/chatgpt/codex/responses")
})

it.each([[400, "invalid_question"], [401, "refused"], [403, "refused"], [422, "invalid_question"]] as const)(
  "does not fall back to Luna when the gateway answers %s",
  async (status, code) => {
    const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, status)
    await expect(Effect.runPromise(run)).rejects.toMatchObject({ code, status })
    expect(sent).toEqual([jevUrl])
  }
)

it("does not fall back to Luna when Jev answers something invalid", async () => {
  const { run, sent } = judge({ AI_GATEWAY_API_KEY: "vck_test" }, "invalid")
  await expect(Effect.runPromise(run)).rejects.toMatchObject({ code: "invalid_answer" })
  expect(sent).toEqual([jevUrl])
})

it("explains missing gateway setup through the TUI message, without using a provider API key", async () => {
  const executor = RequestExecutor.RequestExecutor.of({
    execute: () => Effect.die("must not call an API-key provider")
  })
  try {
    await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate({ state: {}, questions: question })).pipe(
        Effect.provide(
          layerSeatEvaluator({
            OPENAI_API_KEY: "sk-test",
            SMITHERS_OPENAI_AUTH: "api-key",
            CODEX_HOME: "/nonexistent"
          })
            .pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
        )
      )
    )
    throw new Error("Expected missing judge setup to fail")
  } catch (error) {
    expect(error).toMatchObject({ code: "unconfigured" })
    const message = Evaluator.publicMessage(error as Evaluator.EvaluatorError)
    expect(message).toContain("AI_GATEWAY_API_KEY")
    expect(message).not.toContain("did not answer")
    expect(message).not.toContain("sk-test")
  }
})

it("judges on the gateway's second-vendor model when Jev cannot answer and no Luna subscription exists", async () => {
  // An install's Flow host: its Gateway credential reaches Jev and the
  // Gateway's chat route through the backend's model proxy, and nothing signs
  // Luna. The real-GitHub walk logged 11 unjudged completions this way.
  const proxy = "https://backend.example.test/model-proxy"
  const jevCalls: string[] = []
  const jevHttp = HttpClient.make((request) => {
    jevCalls.push(request.url)
    return Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "private gateway address and token" })
      })
    )
  })
  const routed: Array<{ readonly url: string; readonly model: unknown }> = []
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request) => {
      const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : {}
      routed.push({ url: request.url, model: body.model })
      const answer = JSON.stringify({ answers: { complete: { type: "boolean", probability: 0.95 } } })
      const frames = [
        { id: "chat_1", choices: [{ index: 0, delta: { role: "assistant", content: answer } }] },
        { id: "chat_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
      ]
      return Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" }
        })
      ))
    }
  })
  const result = await Effect.runPromise(
    Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate({ state: {}, questions: question })).pipe(
      Effect.provide(
        layerSeatEvaluator({
          AI_GATEWAY_API_KEY: "smithers-binding-credential",
          SMITHERS_MODEL_PROXY_URL: proxy,
          SMITHERS_MODEL_PROXY_PROVIDERS: "cerebras,vercel",
          CODEX_HOME: "/nonexistent"
        }, Layer.succeed(HttpClient.HttpClient)(jevHttp)).pipe(
          Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor))
        )
      )
    )
  )
  expect(result.answers.complete).toEqual({ type: "boolean", probability: 0.95 })
  expect(jevCalls).toEqual(Array(Evaluator.defaultAttempts).fill(`${proxy}/vercel/v4/ai/evaluation-model`))
  expect(routed).toHaveLength(1)
  expect(routed[0]!.url).toBe(`${proxy}/vercel/v1/chat/completions`)
  expect(routed[0]!.model).toBe("anthropic/claude-sonnet-4.5")
})

it("keeps the Jev setup refusal when Luna is opted in without a usable session", async () => {
  const executor = RequestExecutor.RequestExecutor.of({
    execute: () => Effect.die("An unsigned Luna must never reach model transport")
  })
  try {
    await Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate({ state: {}, questions: question })).pipe(
        Effect.provide(
          layerSeatEvaluator({
            SMITHERS_OPENAI_AUTH: "chatgpt",
            CODEX_HOME: "/nonexistent"
          }).pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
        )
      )
    )
    throw new Error("Expected missing Codex session")
  } catch (error) {
    expect(error).toMatchObject({ code: "unconfigured" })
    const message = Evaluator.publicMessage(error as Evaluator.EvaluatorError)
    expect(message).toContain("AI_GATEWAY_API_KEY")
    expect(message).toContain("codex login")
    expect(message).not.toContain("did not answer")
  }
})

it("keeps the missing gateway setup reason when Luna cannot resolve either", async () => {
  const executor = RequestExecutor.RequestExecutor.of({
    execute: () => Effect.die("must not call an API-key provider")
  })
  await expect(
    Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate({ state: {}, questions: {} })).pipe(
        Effect.provide(
          layerSeatEvaluator({ CODEX_HOME: "/nonexistent" })
            .pipe(
              Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor))
            )
        )
      )
    )
  ).rejects.toMatchObject({ code: "unconfigured", message: expect.stringContaining("AI_GATEWAY_API_KEY") })
})

// Pool failures are backup outages: a configured Jev primary must first be
// unreachable. A missing primary key is a setup refusal and never asks Luna.
const unreachableJev = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "connection refused" })
      })
    )
  )
)

it.each(["unavailable", "disconnected"] as const)(
  "fails closed when the subscription pool is %s during resolution",
  async (failure) => {
    const sent: string[] = []
    const executor = RequestExecutor.RequestExecutor.of({
      execute: (request) => {
        sent.push(request.url)
        expect(request.url).toBe("https://pool.example/routes")
        const response = failure === "unavailable"
          ? Response.json({ error: "private pool diagnostic" }, { status: 503 })
          : Response.json({ routes: [] })
        return Effect.succeed(HttpClientResponse.fromWeb(request, response))
      }
    })
    await expect(Effect.runPromise(
      Effect.flatMap(Evaluator.Evaluator, (judge) =>
        judge.evaluate({
          state: "proof",
          questions: { complete: Evaluator.BooleanQuestion.of({ instructions: "Complete?" }) }
        })).pipe(Effect.provide(
          layerSeatEvaluator({
            AI_GATEWAY_API_KEY: "vck_test",
            SMITHERS_ACCOUNT_POOL_URL: "https://pool.example",
            SMITHERS_ACCOUNT_POOL_KEY: "host-credential",
            SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
            CODEX_HOME: "/nonexistent",
            OPENAI_API_KEY: "must-not-use"
          }, unreachableJev).pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
        ))
    )).rejects.toMatchObject({ code: "unreachable", message: Evaluator.unreachableMessage })
    expect(sent).toHaveLength(1)
  }
)

it("fails closed when the subscription pool's route list cannot be read", async () => {
  const sent: string[] = []
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request) => {
      sent.push(request.url)
      const body = new ReadableStream({ start: (controller) => controller.error(new Error("connection reset")) })
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)))
    }
  })
  await expect(Effect.runPromise(
    Effect.flatMap(Evaluator.Evaluator, (judge) =>
      judge.evaluate({
        state: "proof",
        questions: { complete: Evaluator.BooleanQuestion.of({ instructions: "Complete?" }) }
      })).pipe(Effect.provide(
        layerSeatEvaluator({
          AI_GATEWAY_API_KEY: "vck_test",
          SMITHERS_ACCOUNT_POOL_URL: "https://pool.example",
          SMITHERS_ACCOUNT_POOL_KEY: "host-credential",
          SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
          CODEX_HOME: "/nonexistent",
          OPENAI_API_KEY: "must-not-use"
        }, unreachableJev).pipe(Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor)))
      ))
  )).rejects.toMatchObject({ code: "unreachable", message: Evaluator.unreachableMessage })
  expect(sent).toEqual(["https://pool.example/routes"])
})

// A host with no gateway key judges on its subscription, through the
// model-to-judge adapter (#3806).
const signedIn = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }

/**
 * A machine: a Codex subscription (login and opt-in) and a Claude Code on
 * `PATH`, signed in or signed out, each when asked for.
 */
const machine = (
  has: { readonly codex?: boolean; readonly claude?: boolean | "signed-out" }
): Record<string, string> => {
  const root = mkdtempSync(join(tmpdir(), "smithers-host-judge-"))
  roots.push(root)
  if (has.codex === true) {
    const expiry = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
    writeFileSync(
      join(root, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: "fake-id",
          access_token: `eyJhbGciOiJub25lIn0.${expiry}.signature`,
          refresh_token: "fake-refresh",
          account_id: "acct-fake"
        }
      }),
      { mode: 0o600 }
    )
  }
  if (has.claude !== undefined && has.claude !== false) {
    const status = has.claude === true ? signedIn : { loggedIn: false, authMethod: "none" }
    writeFileSync(join(root, "claude"), `#!/bin/sh\necho '${JSON.stringify(status)}'\n`, { mode: 0o755 })
  }
  return { CODEX_HOME: root, PATH: root, ...(has.codex === true ? { SMITHERS_OPENAI_AUTH: "chatgpt" } : {}) }
}

const verdict = (probability: number) => ({ type: "boolean", probability })

/** The model transport, scripted: it records each call and Luna answers 0.95. */
const transport = () => {
  const sent: Array<{ readonly url: string; readonly model: unknown }> = []
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request) => {
      const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : {}
      sent.push({ url: request.url, model: body.model })
      return Effect.succeed(sse(request, verdict(0.95), { input_tokens: 40, output_tokens: 12 }))
    }
  })
  return { sent, executor }
}

const jevNeverAsked = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make(() => Effect.die("Jev must not be asked without a gateway key"))
)

const judgment = (
  environment: Record<string, string>,
  executor: RequestExecutor.RequestExecutor,
  jevHttp: Layer.Layer<HttpClient.HttpClient> = jevNeverAsked
) =>
  Effect.runPromise(
    Effect.flatMap(Evaluator.Evaluator, (evaluator) => evaluator.evaluate({ state: "proof", questions: question }))
      .pipe(
        Effect.provide(
          layerSeatEvaluator(environment, jevHttp).pipe(
            Layer.provide(Layer.succeed(RequestExecutor.RequestExecutor)(executor))
          )
        )
      )
  )

it("judges on Luna with no gateway key on a Codex subscription", async () => {
  const { sent, executor } = transport()
  const result = await judgment(machine({ codex: true }), executor)
  expect(result).toMatchObject({
    answers: { complete: verdict(0.95) },
    decidedBy: "seat",
    usage: { inputTokens: 40, outputTokens: 12, modelId: "gpt-6-luna" }
  })
  expect(sent).toEqual([{ url: "https://chatgpt.com/backend-api/codex/responses", model: "gpt-6-luna" }])
})

it("judges on Claude Haiku with no gateway key where Claude Code is the only subscription", async () => {
  const { sent, executor } = transport()
  claudeCode.reply = JSON.stringify({ answers: { complete: verdict(0.8) } })
  const result = await judgment(machine({ claude: true }), executor)
  expect(result).toMatchObject({
    answers: { complete: verdict(0.8) },
    decidedBy: "seat",
    usage: { inputTokens: 30, outputTokens: 9, modelId: "haiku" }
  })
  // Claude Code is asked for its own `haiku` alias, and nothing reaches the HTTP transport.
  expect(claudeCode.started).toEqual([{ model: "haiku", prompt: expect.stringContaining("Complete?") }])
  expect(sent).toEqual([])
})

it("judges on Claude Haiku, and never asks Luna, when both subscriptions are signed in", async () => {
  const { sent, executor } = transport()
  claudeCode.reply = JSON.stringify({ answers: { complete: verdict(0.8) } })
  const result = await judgment(machine({ codex: true, claude: true }), executor)
  expect(result).toMatchObject({ answers: { complete: verdict(0.8) }, decidedBy: "seat", usage: { modelId: "haiku" } })
  expect(claudeCode.started).toHaveLength(1)
  expect(sent).toEqual([])
})

it.each(
  [
    ["is signed out", { codex: true, claude: "signed-out" }, {}],
    ["is refused because ANTHROPIC_API_KEY is set", { codex: true, claude: true }, { ANTHROPIC_API_KEY: "sk-ant-test" }]
  ] as const
)("judges on Luna on a Codex subscription when Claude Code %s", async (_case, has, keys) => {
  const { sent, executor } = transport()
  const result = await judgment({ ...machine(has), ...keys }, executor)
  expect(result).toMatchObject({
    answers: { complete: verdict(0.95) },
    decidedBy: "seat",
    usage: { modelId: "gpt-6-luna" }
  })
  expect(sent).toEqual([{ url: "https://chatgpt.com/backend-api/codex/responses", model: "gpt-6-luna" }])
  expect(claudeCode.started).toEqual([])
})

it("fails unconfigured and asks nothing with no gateway key and no subscription", async () => {
  const { sent, executor } = transport()
  await expect(judgment(machine({}), executor)).rejects.toMatchObject({
    code: "unconfigured",
    message: `AI_GATEWAY_API_KEY is not set and no subscription can judge. ${Evaluator.unconfiguredMessage}`
  })
  // Every way out the message names is one this host takes, in the order it takes them.
  const ways = ["AI_GATEWAY_API_KEY", "claude auth login", "codex login", "SMITHERS_OPENAI_AUTH=chatgpt"]
  const at = ways.map((way) => Evaluator.unconfiguredMessage.indexOf(way))
  expect(at.every((index) => index >= 0)).toBe(true)
  expect(at).toEqual([...at].sort((left, right) => left - right))
  expect(sent).toEqual([])
  expect(claudeCode.started).toEqual([])
})

it.each(
  [
    ["OPENAI_API_KEY beside a Codex login", { codex: true }, {
      SMITHERS_OPENAI_AUTH: "api-key",
      OPENAI_API_KEY: "sk-test"
    }],
    ["ANTHROPIC_API_KEY beside a signed-in Claude Code", { claude: true }, { ANTHROPIC_API_KEY: "sk-ant-test" }]
  ] as const
)("never judges on a provider API key: %s", async (_case, has, keys) => {
  const { sent, executor } = transport()
  const failure = await judgment({ ...machine(has), ...keys }, executor).then(
    () => undefined,
    (error: Evaluator.EvaluatorError) => error
  )
  expect(failure).toMatchObject({ code: "unconfigured" })
  expect(failure?.message).not.toContain("sk-")
  expect(sent).toEqual([])
  expect(claudeCode.started).toEqual([])
})

it("judges on Claude Haiku in Jev's place when the gateway is unreachable", async () => {
  const { sent, executor } = transport()
  claudeCode.reply = JSON.stringify({ answers: { complete: verdict(0.7) } })
  const result = await judgment(
    { ...machine({ claude: true }), AI_GATEWAY_API_KEY: "vck_test" },
    executor,
    unreachableJev
  )
  expect(result).toMatchObject({ answers: { complete: verdict(0.7) }, decidedBy: "seat", usage: { modelId: "haiku" } })
  expect(claudeCode.started).toHaveLength(1)
  // The Gateway key is a router key too, and the subscription still judges ahead of it.
  expect(sent).toEqual([])
})
