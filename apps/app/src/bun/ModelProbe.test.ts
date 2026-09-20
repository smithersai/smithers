import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_CATALOG_PATH, MODEL_TEST_PATH } from "@smthrs/rpc/AgentApiRoutes"
import {
  MODEL_CALL_MAX_TOKENS_MAX,
  MODEL_CALL_STATE_MAX_BYTES,
  MODEL_CALL_TEXT_MAX,
  MODEL_TEST_BODY_MAX_BYTES,
  MODEL_TEST_DEADLINE_MS,
  ModelCatalogSchema,
  ModelTestResultSchema
} from "@smthrs/rpc/ConfiguredModel"
import type { ConfiguredModel, ModelCallInput, ModelTestResult } from "@smthrs/rpc/ConfiguredModel"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { PROVIDER_CONFIDENCE, PROVIDER_MODEL, PROVIDER_REPLY } from "../../e2e/real/support/model-provider-behaviors"
import { launchModelProvider } from "../../e2e/real/support/model-provider-process"
import type { ModelProvider } from "../../e2e/real/support/model-provider-process"
import { startLocalServer } from "./server"
import type { LocalServer, LocalServerOptions } from "./server"

/*
 * The real route handlers over the real loopback provider: every request below
 * leaves this process over TCP, and the provider's journal is the evidence of
 * how many arrived and with which credential.
 */
const KEY = "sk-probe-REDACTME-0123456789abcdef"
const REVOKED = "sk-probe-REVOKED-0123456789abcdef"
const BYSTANDER = "ghp-probe-BYSTANDER-0123456789abcdef"
const SECRETS = [KEY, REVOKED, BYSTANDER]
/** Shorter than the provider's slow answer, longer than any loopback round trip. */
const SHORT_DEADLINE_MS = 750
/** Kept short: the provider finishes a slow answer before it honours a stop. */
const SLOW_MS = 2_500

let dist = ""
let provider: ModelProvider
let redirector: ReturnType<typeof Bun.serve>
let server: LocalServer
let hurried: LocalServer
const logs: Array<string> = []
/** Everything a route answered, so one assertion at the end covers every body. */
const bodies: Array<string> = []

const hostEnv = (): Record<string, string> => ({
  AI_GATEWAY_API_KEY: KEY,
  ANTHROPIC_API_KEY: KEY,
  // A built-in name's origin is the contract's, never the operator's.
  ANTHROPIC_API_KEY_ORIGIN: provider.origin,
  SMITHERS_MODEL_KEY_ANTHROPIC_API_KEY_ORIGIN: provider.origin,
  GITHUB_TOKEN: BYSTANDER,
  SMITHERS_MODEL_KEY_LOOPBACK: KEY,
  SMITHERS_MODEL_KEY_LOOPBACK_ORIGIN: provider.origin,
  SMITHERS_MODEL_KEY_REVOKED: REVOKED,
  SMITHERS_MODEL_KEY_REVOKED_ORIGIN: provider.origin,
  SMITHERS_MODEL_KEY_UNSET: "  ",
  SMITHERS_MODEL_KEY_UNSET_ORIGIN: provider.origin,
  SMITHERS_MODEL_KEY_DETOUR: KEY,
  SMITHERS_MODEL_KEY_DETOUR_ORIGIN: `http://127.0.0.1:${redirector.port}`
})

const start = (options: Partial<LocalServerOptions> = {}): Promise<LocalServer> =>
  startLocalServer({ port: 0, distDir: dist, env: hostEnv(), log: (line) => logs.push(line), ...options })

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "smithers-model-probe-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title>")
  provider = await launchModelProvider({ key: KEY, slowMs: SLOW_MS })
  redirector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new Response(null, { status: 307, headers: { location: `${provider.origin}${new URL(request.url).pathname}` } })
  })
  server = await start()
  hurried = await start({ modelTestDeadlineMs: SHORT_DEADLINE_MS })
})

afterAll(async () => {
  await Promise.all([server.stop(), hurried.stop()])
  await redirector.stop(true)
  await provider.close()
  await rm(dist, { recursive: true, force: true })
})

const post = async (host: LocalServer, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${host.origin}${MODEL_TEST_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [LOCAL_SESSION_HEADER]: host.sessionToken, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

const runTest = async (model: ConfiguredModel, host: LocalServer = server, input?: ModelCallInput): Promise<ModelTestResult> => {
  const response = await post(host, input === undefined ? { model } : { model, input })
  const text = await response.text()
  bodies.push(text)
  expect(response.status).toBe(200)
  return ModelTestResultSchema.parse(JSON.parse(text))
}

const loopback = (modelId: string, fields: Partial<ConfiguredModel> = {}): ConfiguredModel => ({
  id: "mine",
  protocol: "openai-chat",
  baseUrl: provider.origin,
  modelId,
  credential: "LOOPBACK",
  ...fields
})

/** The provider requests one action caused. */
const requestsDuring = async <A>(action: () => Promise<A>) => {
  const before = (await provider.journal()).length
  const value = await action()
  return { value, requests: (await provider.journal()).slice(before) }
}

describe("GET /api/model/catalog", () => {
  test("lists names, presence and origins, the custom pairs the operator declared, and never a value", async () => {
    const response = await fetch(`${server.origin}${MODEL_CATALOG_PATH}`, { headers: { [LOCAL_SESSION_HEADER]: server.sessionToken } })
    expect(response.status).toBe(200)
    const text = await response.text()
    bodies.push(text)
    const catalog = ModelCatalogSchema.parse(JSON.parse(text))
    expect(catalog.seats).toEqual(["explainer"])
    expect(catalog.credentials).toEqual([
      { name: "ANTHROPIC_API_KEY", present: true, origins: ["https://api.anthropic.com"] },
      { name: "OPENAI_API_KEY", present: false, origins: ["https://api.openai.com"] },
      { name: "CEREBRAS_API_KEY", present: false, origins: ["https://api.cerebras.ai"] },
      { name: "OPENROUTER_API_KEY", present: false, origins: ["https://openrouter.ai"] },
      { name: "AI_GATEWAY_API_KEY", present: true, origins: ["https://ai-gateway.vercel.sh"] },
      { name: "DETOUR", present: true, origins: [`http://127.0.0.1:${redirector.port}`] },
      { name: "LOOPBACK", present: true, origins: [provider.origin] },
      { name: "REVOKED", present: true, origins: [provider.origin] },
      { name: "UNSET", present: false, origins: [provider.origin] }
    ])
    // This host is offline: a built-in row's origin is not loopback, so none is one a Test here could reach.
    expect(catalog.models).toEqual([])
  })

  test("a built-in row is listed only while a Test of it here would plan: its key set, its origin in reach", async () => {
    const models = async (host: LocalServer) => {
      const response = await fetch(`${host.origin}${MODEL_CATALOG_PATH}`, { headers: { [LOCAL_SESSION_HEADER]: host.sessionToken } })
      const text = await response.text()
      bodies.push(text)
      return ModelCatalogSchema.parse(JSON.parse(text)).models
    }
    const hybrid = await start({ cloudMode: "hybrid", identityUpstream: null })
    try {
      // AI_GATEWAY is set, CEREBRAS is not.
      const listed = await models(hybrid)
      expect(listed).toEqual([
        { id: "jev", protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY", builtin: true }
      ])
      expect(await models(server)).toEqual([])
      const offered = await runTest(listed[0]!, server)
      expect(offered).toMatchObject({ ok: false, failure: { code: "endpoint_forbidden" } })
    } finally {
      await hybrid.stop()
    }
  })

  test("needs the local session and no sign-in", async () => {
    const bare = await fetch(`${server.origin}${MODEL_CATALOG_PATH}`)
    expect(bare.status).toBe(401)
    expect(((await bare.json()) as { error: { code: string } }).error.code).toBe("local_session_required")
  })
})

describe("POST /api/model/test", () => {
  test("a working generation model passes with the provider's words, on exactly one authorized request", async () => {
    for (const protocol of ["openai-chat", "anthropic-messages"] as const) {
      const { value, requests } = await requestsDuring(() => runTest(loopback(PROVIDER_MODEL.answers, { protocol })))
      expect(value).toMatchObject({ ok: true, sample: PROVIDER_REPLY.join("") })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ protocol, status: 200, authorized: true, credentialSha256: provider.acceptedKeySha256 })
    }
  })

  test("a working decision model passes with its one boolean answer", async () => {
    const { value, requests } = await requestsDuring(() =>
      runTest(loopback(PROVIDER_MODEL.answers, { protocol: "evaluation" })))
    expect(value).toMatchObject({ ok: true, sample: `true ${PROVIDER_CONFIDENCE.toFixed(2)}` })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ protocol: "evaluation", modelId: PROVIDER_MODEL.answers, authorized: true })
  })

  test("a pass carries what the call produced, typed, so the composer can prefill from the fixed Test", async () => {
    const text = await runTest(loopback(PROVIDER_MODEL.answers))
    expect(text).toMatchObject({ ok: true, output: { kind: "generation", text: PROVIDER_REPLY.join("") } })
    const decision = await runTest(loopback(PROVIDER_MODEL.answers, { protocol: "evaluation" }))
    expect(decision).toMatchObject({ ok: true, output: { kind: "decision", answers: { ok: { type: "boolean", value: true, probability: PROVIDER_CONFIDENCE } } } })
  })

  test("a composed decision request asks its own state and questions of each kind, and every answer comes back typed", async () => {
    const input: ModelCallInput = {
      kind: "decision",
      state: [
        { key: "path", kind: "path", value: "src/a.ts" },
        { key: "passed", kind: "boolean", value: "false" },
        { key: "count", kind: "number", value: "3" }
      ],
      questions: {
        ok: { type: "boolean", instructions: "Did it pass?" },
        which: { type: "choice", instructions: "Which file?", criteria: { a: "src/a.ts", b: "src/b.ts" } },
        risk: { type: "score", instructions: "How risky?", criteria: ["low", "mid", "high"] }
      }
    }
    const { value, requests } = await requestsDuring(() => runTest(loopback(PROVIDER_MODEL.answers, { protocol: "evaluation" }), server, input))
    expect(value).toMatchObject({
      ok: true,
      output: { kind: "decision", answers: {
        ok: { type: "boolean", value: true, probability: PROVIDER_CONFIDENCE },
        which: { type: "choice", value: "a", probabilities: { a: PROVIDER_CONFIDENCE, b: 0 }, confidence: PROVIDER_CONFIDENCE },
        risk: { type: "score", value: 2, label: "high", probabilities: { low: 0, mid: 0, high: 1 }, confidence: 1 }
      } }
    })
    expect(requests).toHaveLength(1)
    // The provider read the state as one JSON object of the fields' kinds, and exactly these questions.
    expect(requests[0]).toMatchObject({ protocol: "evaluation", authorized: true, questions: ["ok", "which", "risk"], state: { path: "src/a.ts", passed: false, count: 3 } })
  })

  test("a composed generation request carries its system prompt and parameters, and the words come back whole", async () => {
    const input: ModelCallInput = { kind: "generation", system: "Answer tersely.", prompt: "ping?", maxTokens: 64, temperature: 0.2 }
    for (const protocol of ["openai-chat", "anthropic-messages"] as const) {
      const { value, requests } = await requestsDuring(() => runTest(loopback(PROVIDER_MODEL.answers, { protocol }), server, input))
      expect(value).toMatchObject({ ok: true, sample: PROVIDER_REPLY.join(""), output: { kind: "generation", text: PROVIDER_REPLY.join("") } })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ protocol, status: 200, system: true, maxTokens: 64, temperature: 0.2 })
    }
  })

  test("a composed request past a question class's limit is refused before any request leaves", async () => {
    const decision = loopback(PROVIDER_MODEL.answers, { protocol: "evaluation" })
    const state = [{ key: "text", kind: "text", value: "hi" }] as const
    const { requests } = await requestsDuring(async () => {
      for (const input of [
        { kind: "decision", state, questions: {} },
        { kind: "decision", state, questions: { which: { type: "choice", instructions: "?", criteria: { only: "" } } } },
        { kind: "decision", state, questions: { risk: { type: "score", instructions: "?", criteria: ["same", "same"] } } },
        { kind: "decision", state: [{ key: "big", kind: "text", value: "x".repeat(MODEL_CALL_STATE_MAX_BYTES) }], questions: { ok: { type: "boolean", instructions: "?" } } },
        // A record parse drops this id without a word; the request is refused whole, never run with a question missing.
        { kind: "decision", state, questions: { ok: { type: "boolean", instructions: "?" }, ["__proto__"]: { type: "boolean", instructions: "?" } } },
        { kind: "generation", system: "", prompt: " ", maxTokens: 8 },
        { kind: "generation", system: "", prompt: "hi", maxTokens: 0 }
      ]) {
        const refused = await post(server, { model: decision, input })
        expect(refused.status).toBe(400)
        expect(await refused.json()).toMatchObject({ code: "request_invalid" })
      }
    })
    expect(requests).toHaveLength(0)
  })

  test("an input of the other kind than the record's is invalid at the protocol, and nothing is dialled", async () => {
    const generation: ModelCallInput = { kind: "generation", system: "", prompt: "hi", maxTokens: 8 }
    const decision: ModelCallInput = { kind: "decision", state: [{ key: "text", kind: "text", value: "hi" }], questions: { ok: { type: "boolean", instructions: "?" } } }
    const { requests } = await requestsDuring(async () => {
      expect(await runTest(loopback(PROVIDER_MODEL.answers, { protocol: "evaluation" }), server, generation)).toMatchObject({ ok: false, failure: { code: "invalid", field: "protocol" }, fault: "user" })
      expect(await runTest(loopback(PROVIDER_MODEL.answers), server, decision)).toMatchObject({ ok: false, failure: { code: "invalid", field: "protocol" }, fault: "user" })
    })
    expect(requests).toHaveLength(0)
  })

  test("the words are cut at the wire's bound once every delta is joined, so a long answer is a pass that parses", async () => {
    const encoder = new TextEncoder()
    const chunk = (fields: object): string =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", ...fields })}\n\n`
    const half = "x".repeat(MODEL_CALL_TEXT_MAX / 2 + 1)
    const talkative = await start({
      modelFetch: (async () =>
        new Response(encoder.encode([
          chunk({ choices: [{ index: 0, delta: { role: "assistant", content: half }, finish_reason: null }] }),
          chunk({ choices: [{ index: 0, delta: { content: half }, finish_reason: null }] }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
          "data: [DONE]\n\n"
        ].join("")), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch
    })
    try {
      // runTest parses the body with ModelTestResultSchema: an uncut answer fails there, as it would in the client.
      const result = await runTest(loopback("m"), talkative, { kind: "generation", system: "", prompt: "go", maxTokens: MODEL_CALL_MAX_TOKENS_MAX })
      expect(result.ok && result.output?.kind === "generation" ? result.output.text.length : undefined).toBe(MODEL_CALL_TEXT_MAX)
    } finally {
      await talkative.stop()
    }
  })

  test("a wrong key is refused 401, the user's to fix", async () => {
    const { value, requests } = await requestsDuring(() =>
      runTest(loopback(PROVIDER_MODEL.answers, { credential: "REVOKED" })))
    expect(value).toMatchObject({ ok: false, failure: { code: "refused", status: 401 }, fault: "user" })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.authorized).toBe(false)
  })

  test("a declared credential with no value is missing, and nothing is sent", async () => {
    const { value, requests } = await requestsDuring(() =>
      runTest(loopback(PROVIDER_MODEL.answers, { credential: "UNSET" })))
    expect(value).toMatchObject({ ok: false, failure: { code: "credential_missing", credential: "UNSET" }, fault: "user" })
    expect(requests).toHaveLength(0)
  })

  test("a name the operator never declared is unknown, even when the environment holds it", async () => {
    for (const credential of ["GITHUB_TOKEN", "HOME", "SMITHERS_MODEL_KEY_LOOPBACK"]) {
      const { value, requests } = await requestsDuring(() => runTest(loopback(PROVIDER_MODEL.answers, { credential })))
      expect(value).toMatchObject({ ok: false, failure: { code: "credential_unknown", credential }, fault: "user" })
      expect(requests).toHaveLength(0)
    }
  })

  test("a credential never travels to an origin it is not pinned to", async () => {
    // The exfiltration case: a built-in key aimed at someone else's endpoint, and an operator's `_ORIGIN` beside it changes nothing.
    const { value, requests } = await requestsDuring(() =>
      runTest(loopback(PROVIDER_MODEL.answers, { credential: "ANTHROPIC_API_KEY" })))
    expect(value).toMatchObject({ ok: false, failure: { code: "endpoint_forbidden" }, fault: "user" })
    expect(requests).toHaveLength(0)
  })

  test("a rate limit is refused 429 and is asked exactly once", async () => {
    const { value, requests } = await requestsDuring(() => runTest(loopback(PROVIDER_MODEL.rateLimited)))
    expect(value).toMatchObject({ ok: false, failure: { code: "refused", status: 429 }, fault: "wait" })
    expect(requests).toHaveLength(1)
  })

  test("a slow provider times out carrying the deadline that was armed", async () => {
    for (const protocol of ["openai-chat", "evaluation"] as const) {
      const { value, requests } = await requestsDuring(() => runTest(loopback(PROVIDER_MODEL.slow, { protocol }), hurried))
      expect(value).toMatchObject({
        ok: false,
        failure: { code: "timeout", deadlineMs: SHORT_DEADLINE_MS },
        fault: "dependency"
      })
      expect(value.latencyMs).toBeLessThan(SLOW_MS)
      expect(requests).toHaveLength(1)
    }
    expect(SHORT_DEADLINE_MS).not.toBe(MODEL_TEST_DEADLINE_MS)
  })

  test("an answer that does not decode as the protocol is invalid", async () => {
    for (const protocol of ["openai-chat", "anthropic-messages", "evaluation"] as const) {
      const { value, requests } = await requestsDuring(() => runTest(loopback(PROVIDER_MODEL.garbled, { protocol })))
      expect(value).toMatchObject({ ok: false, failure: { code: "invalid", field: "protocol" }, fault: "user" })
      expect(requests).toHaveLength(1)
    }
  })

  test("a redirect is refused with its status and never followed", async () => {
    const { value, requests } = await requestsDuring(() =>
      runTest(loopback(PROVIDER_MODEL.answers, { baseUrl: `http://127.0.0.1:${redirector.port}`, credential: "DETOUR" })))
    expect(value).toMatchObject({ ok: false, failure: { code: "refused", status: 307 }, fault: "user" })
    expect(requests).toHaveLength(0)
  })

  test("a provider that is down is unreachable", async () => {
    await provider.stop()
    try {
      for (const protocol of ["openai-chat", "evaluation"] as const) {
        expect(await runTest(loopback(PROVIDER_MODEL.answers, { protocol }))).toMatchObject({
          ok: false,
          failure: { code: "unreachable" },
          fault: "dependency"
        })
      }
    } finally {
      await provider.start()
    }
  }, 20_000)

  test("the offline host reaches loopback only, and dials nothing else", async () => {
    let dialled = 0
    const offline = await start({
      modelFetch: (async () => {
        dialled += 1
        return new Response(null, { status: 500 })
      }) as unknown as typeof fetch
    })
    try {
      const result = await runTest({ id: "claude", protocol: "anthropic-messages", modelId: "claude-x", credential: "ANTHROPIC_API_KEY" }, offline)
      expect(result).toMatchObject({ ok: false, failure: { code: "endpoint_forbidden" } })
      expect(dialled).toBe(0)
    } finally {
      await offline.stop()
    }
  })

  test("only { model } is a request: an extra key, a key in the record, and an oversized body are refused before any test", async () => {
    const { requests } = await requestsDuring(async () => {
      const extra = await post(server, { model: loopback(PROVIDER_MODEL.answers), apiKey: KEY })
      expect(extra.status).toBe(400)
      expect(await extra.json()).toMatchObject({ status: "error", code: "request_invalid", origin: "local" })
      const smuggled = await post(server, { model: { ...loopback(PROVIDER_MODEL.answers), apiKey: KEY } })
      expect(smuggled.status).toBe(400)
      expect(await smuggled.json()).toMatchObject({ code: "request_invalid" })
      const appOnly = await post(server, { model: { ...loopback(PROVIDER_MODEL.answers), lastTest: { id: "t", testedAt: 1, result: { ok: true, latencyMs: 1, sample: "" } } } })
      expect(appOnly.status).toBe(400)
      const large = await post(server, JSON.stringify({ model: loopback(PROVIDER_MODEL.answers), pad: "x".repeat(MODEL_TEST_BODY_MAX_BYTES) }))
      expect(large.status).toBe(413)
      const bare = await fetch(`${server.origin}${MODEL_TEST_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      expect(bare.status).toBe(401)
      const foreign = await post(server, { model: loopback(PROVIDER_MODEL.answers) }, { origin: "https://attacker.example" })
      expect(foreign.status).toBe(403)
    })
    expect(requests).toHaveLength(0)
  })
})

describe("a credential value", () => {
  test("echoed by the model is cut out of the sample, and thrown by the transport reaches neither the answer nor the log", async () => {
    const encoder = new TextEncoder()
    const chunk = (fields: object): string =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", ...fields })}\n\n`
    const echoing = await start({
      modelFetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const presented = new Headers(init?.headers).get("authorization") ?? ""
        return new Response(encoder.encode([
          chunk({ choices: [{ index: 0, delta: { role: "assistant", content: `your key is ${presented}` }, finish_reason: null }] }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
          "data: [DONE]\n\n"
        ].join("")), { status: 200, headers: { "content-type": "text/event-stream" } })
      }) as unknown as typeof fetch
    })
    const throwing = await start({
      modelFetch: (async () => {
        throw new Error(`connect failed for Bearer ${KEY}`)
      }) as unknown as typeof fetch
    })
    const leaking = await start({
      modelFetch: (async () =>
        new Response(JSON.stringify({ error: { message: `bad key ${KEY}`, type: "authentication_error" } }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })) as unknown as typeof fetch
    })
    try {
      const echoed = await runTest(loopback("m"), echoing)
      expect(echoed).toMatchObject({ ok: true, sample: "your key is Bearer" })
      expect(await runTest(loopback("m"), throwing)).toMatchObject({ ok: false, failure: { code: "unreachable" } })
      expect(await runTest(loopback("m"), leaking)).toMatchObject({ ok: false, failure: { code: "refused", status: 401 } })
    } finally {
      await Promise.all([echoing.stop(), throwing.stop(), leaking.stop()])
    }
  })

  test("appears in no body any route answered and in no line the host logged", () => {
    expect(bodies.length).toBeGreaterThan(20)
    for (const secret of SECRETS) {
      expect(bodies.some((body) => body.includes(secret))).toBe(false)
      expect(logs.some((line) => line.includes(secret))).toBe(false)
    }
  })
})
