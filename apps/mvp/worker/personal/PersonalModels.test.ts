// A person's own model end to end in the Worker (docs/features/personal-model.md): saving, removing and testing it
// through the real routes, with `model/Put` and `model/Delete` on the Node host's engine; the shape of the person's own
// row; and the model endpoint answering the person's calls with it. Postgres and Electric are the compose ones; the
// person's provider is scripted at the network. Every test also searches what was recorded and stored for the key.
import { Action, FlowRuntime } from "@smthrs/flow"
import { type Model, ModelError, type ModelEvent, ModelRequest } from "@smthrs/model"
import { HostModel } from "@smthrs/model-host"
import { Cause, ConfigProvider, Effect, Exit, Fiber, Layer, Option, Redacted, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import {
  PERSONAL_MODEL_ROUTE,
  PERSONAL_MODEL_SHAPE_ROUTE,
  PERSONAL_MODEL_TEST_ROUTE,
  type TestResult,
} from "../../src/features/personal-model/contract.ts"
import * as Actor from "../Actor.ts"
import * as Flows from "../Flows.ts"
import * as ModelEndpoint from "../ModelEndpoint.ts"
import * as SpendAlert from "../flows/SpendAlert.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import { eventually, harness, PERSONAL_KEYS, recorded, testFile } from "../test/harness.ts"
import * as PersonalApi from "./Api.ts"
import * as ModelFlows from "./ModelFlows.ts"
import { final, finalFailure, PersonalModels, PersonalModelsUnavailable, PersonalModelUnusable } from "./Models.ts"
import * as Store from "./Store.ts"
import * as PersonalUsage from "./Usage.ts"
import {
  admin,
  agent,
  dump,
  engine,
  events,
  guest,
  KEY,
  leaks,
  member,
  personalHarness,
  resetModels,
  roleless,
  rows,
  SAVE,
  seed,
  usage,
  VALUE,
} from "./test/harness.ts"
import { ANTHROPIC_ORIGIN, OPENAI_ORIGIN, type Reply, scriptedProvider } from "./test/provider.ts"

const runtime = testFile("personal_models")
let host: Awaited<ReturnType<typeof engine>>
beforeAll(async () => {
  host = await engine(runtime)
})
afterAll(() => host.close())
beforeEach(async () => {
  await resetModels(runtime)
  await runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE model_usage, model_budget_days`),
  )
})

const open = (options: Parameters<typeof personalHarness>[2] = {}) => personalHarness(runtime, host.starter, options)

const put = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
})

const json = async (response: Response) => [response.status, await response.json()] as const

const testCall = async (h: { readonly fetch: (path: string, init?: RequestInit) => Promise<Response> }) =>
  json(await h.fetch(PERSONAL_MODEL_TEST_ROUTE, { method: "POST" }))

describe("PUT /api/me/model", () => {
  test("a Member saves and replaces their model; Postgres and the journal hold only ciphertext and the key's tail", async () => {
    const h = await open({ actor: member })

    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(SAVE)))).toEqual([202, { baseUrl: OPENAI_ORIGIN }])
    const [saved] = await rows(runtime)
    expect(saved).toMatchObject({
      personId: "person-member",
      protocol: "openai-chat",
      baseUrl: OPENAI_ORIGIN,
      modelId: "gpt-test",
      keyVersion: 1,
      keyLast4: '"~9Zq'.slice(-4),
      failureStatus: null,
      failedAt: null,
    })

    // A replacement clears the last refusal its earlier key had.
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE personal_models SET failure_status = 401, failed_at = now() WHERE person_id = 'person-member'`))
    expect(
      (await h.fetch(PERSONAL_MODEL_ROUTE, put({ ...SAVE, protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN, modelId: "claude-test" })))
        .status,
    ).toBe(202)
    expect(await rows(runtime)).toEqual([
      expect.objectContaining({ protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN, modelId: "claude-test", failureStatus: null }),
    ])
    expect(await events(runtime)).toEqual([
      { personId: "person-member", action: "set" },
      { personId: "person-member", action: "replace" },
    ])
    expect(h.count(PersonalApi.requests, { op: "put", outcome: "putting" })).toBe(2)
    expect(leaks(await dump(runtime, (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).name))).toEqual([])
    expect(leaks(await dump(runtime, host.schema))).toEqual([])
    expect(leaks(h.recorded())).toEqual([])
  })

  test("the base URL is https to one public DNS name, its host lowercased and a trailing /v1 dropped", async () => {
    const h = await open({ actor: member })
    const saved = async (baseUrl: string) => json(await h.fetch(PERSONAL_MODEL_ROUTE, put({ ...SAVE, baseUrl })))
    expect(await saved("https://API.Example.COM/openai/v1/")).toEqual([202, { baseUrl: "https://api.example.com/openai" }])
    expect(await saved("  https://openrouter.ai/api/v1  ")).toEqual([202, { baseUrl: "https://openrouter.ai/api" }])
    for (
      const refused of [
        "http://api.example.com",
        "https://localhost",
        "https://127.0.0.1",
        "https://[::1]",
        "https://api.example.com:8443",
        "https://user:pass@api.example.com",
        "https://api.example.com/?q=1",
        "https://api.example.com/#x",
        "https://example",
        "https://-bad.example.com",
        "https://api.example.123",
        `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example.com`,
        `https://api.example.com/${"p".repeat(520)}`,
        "not a url",
        "",
      ]
    ) {
      expect(await saved(refused), refused).toEqual([400, { code: "invalid_base_url" }])
    }
  })

  test("every other bad field is refused by its code, and nothing is written", async () => {
    const h = await open({ actor: member })
    const refusal = async (init: RequestInit) => json(await h.fetch(PERSONAL_MODEL_ROUTE, init))
    expect(await refusal(put({ ...SAVE, protocol: "openai-responses" }))).toEqual([400, { code: "invalid_protocol" }])
    expect(await refusal(put({ ...SAVE, modelId: "has space" }))).toEqual([400, { code: "invalid_model" }])
    expect(await refusal(put({ ...SAVE, modelId: "x".repeat(82) }))).toEqual([400, { code: "invalid_model" }])
    expect(await refusal(put({ ...SAVE, key: "short" }))).toEqual([400, { code: "too_short" }])
    // Eight bytes, so a value a secret may be, but four characters: its "last four" would be all of it.
    expect(await refusal(put({ ...SAVE, key: "éééé" }))).toEqual([400, { code: "too_short" }])
    expect(await refusal(put({ ...SAVE, key: "x".repeat(15) }))).toEqual([400, { code: "too_short" }])
    expect(await refusal(put({ ...SAVE, key: "x".repeat(16 * 1024 + 1) }))).toEqual([400, { code: "too_long" }])
    expect(await refusal(put({ ...SAVE, key: "sk-line\nbreak" }))).toEqual([400, { code: "control_character" }])
    expect(await refusal(put({ ...SAVE, key: "sk-lone-\ud800-x" }))).toEqual([400, { code: "malformed_text" }])
    expect(await refusal(put({ protocol: "openai-chat", baseUrl: OPENAI_ORIGIN, modelId: "m" }))).toEqual([
      400,
      { code: "invalid" },
    ])
    expect(await refusal(put(`{"key":"${VALUE.replaceAll('"', "")}`))).toEqual([400, { code: "invalid" }])
    expect(await refusal(put("x".repeat(32 * 1024 + 1)))).toEqual([413, { code: "too_large" }])
    expect(await refusal({ method: "PUT", body: new Uint8Array([0xff, 0xfe]) })).toEqual([400, { code: "invalid" }])
    expect((await h.fetch(PERSONAL_MODEL_ROUTE, { method: "POST" })).status).toBe(405)
    expect((await h.fetch(PERSONAL_MODEL_ROUTE, { method: "POST" })).headers.get("allow")).toBe("PUT, DELETE")
    expect(await rows(runtime)).toEqual([])
    expect(leaks(h.recorded())).toEqual([])
  })

  test("signed out, a Guest, someone with no role, and an agent acting for the person are refused", async () => {
    expect(await json(await (await open()).fetch(PERSONAL_MODEL_ROUTE, put(SAVE)))).toEqual([
      401,
      { code: "authentication" },
    ])
    for (const actor of [guest, roleless]) {
      expect(await json(await (await open({ actor })).fetch(PERSONAL_MODEL_ROUTE, put(SAVE)))).toEqual([
        403,
        { code: "forbidden" },
      ])
    }
    const h = await open({ actor: agent })
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(SAVE)))).toEqual([403, { code: "forbidden" }])
    expect(h.count(Actor.personOnlyRefusals, { act: "model", by: "agent" })).toBe(1)
    expect(await rows(runtime)).toEqual([])
  })

  test("without SECRETS_KEY it is off; a flow that can't start is unavailable; a key that won't seal is unavailable", async () => {
    expect(await json(await (await open({ actor: member, keys: false })).fetch(PERSONAL_MODEL_ROUTE, put(SAVE)))).toEqual(
      [503, { code: "off" }],
    )
    const failing = Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "down" })) })
    const h = await open({ actor: member, starter: failing })
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(SAVE)))).toEqual([503, { code: "unavailable" }])
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, { method: "DELETE" }))).toEqual([503, { code: "unavailable" }])
    const dying = Flows.FlowStarter.of({ start: () => Effect.die(new Error("boom")) })
    const died = await open({ actor: member, starter: dying })
    expect(await json(await died.fetch(PERSONAL_MODEL_ROUTE, put(SAVE)))).toEqual([503, { code: "unavailable" }])
    expect(died.line("personal_model.request").at(-1)).toMatchObject({ annotations: { errorCode: "unknown", status: 503 } })
    expect(await rows(runtime)).toEqual([])
  })
})

describe("DELETE /api/me/model", () => {
  test("the person, and the agent for them, remove their own model; anyone signed in may, whatever their role", async () => {
    await seed(runtime, "person-member")
    await seed(runtime, "person-guest")
    expect(await json(await (await open({ actor: agent })).fetch(PERSONAL_MODEL_ROUTE, { method: "DELETE" }))).toEqual(
      [202, {}],
    )
    expect(await json(await (await open({ actor: guest })).fetch(PERSONAL_MODEL_ROUTE, { method: "DELETE" }))).toEqual(
      [202, {}],
    )
    // Again: nothing to remove, recorded as such.
    expect((await (await open({ actor: member })).fetch(PERSONAL_MODEL_ROUTE, { method: "DELETE" })).status).toBe(202)
    expect(await rows(runtime)).toEqual([])
    expect(await events(runtime)).toEqual([
      { personId: "person-member", action: "set" },
      { personId: "person-guest", action: "set" },
      { personId: "person-member", action: "delete" },
      { personId: "person-guest", action: "delete" },
      { personId: "person-member", action: "delete" },
    ])
    expect(await json(await (await open()).fetch(PERSONAL_MODEL_ROUTE, { method: "DELETE" }))).toEqual([
      401,
      { code: "authentication" },
    ])
  })
})

describe("model/Put and model/Delete", () => {
  const scratchDatabase = async () => (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database
  const write = {
    personId: "person-member",
    protocol: "openai-chat" as const,
    baseUrl: OPENAI_ORIGIN,
    modelId: "gpt-test",
    ciphertext: "c",
    nonce: "n",
    keyVersion: 1,
    keyLast4: "abcd",
    invocationKey: "step-1",
  }

  test("a step run again records its change once", async () => {
    const database = await scratchDatabase()
    const run = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(Effect.provide(effect, database) as Effect.Effect<A>)
    expect(await run(Store.put(write))).toBe("set")
    expect(await run(Store.put(write))).toBe("repeat")
    const remove = { personId: "person-member", invocationKey: "step-2" }
    expect(await run(Store.remove(remove))).toBe("deleted")
    expect(await run(Store.remove(remove))).toBe("repeat")
    expect((await events(runtime)).map((event) => event.action)).toEqual(["set", "delete"])
    expect(await run(Store.saved("person-member"))).toEqual(Option.none())
  })

  test("a step whose database can't be reached fails as StoreUnavailable, which the engine retries", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const { store, erase } = ModelFlows.steps(unreachable)
    const keyed = <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromiseExit(Effect.provideService(effect, Action.CurrentInvocationKey, "step-1") as Effect.Effect<A, E>)
    const sealed = { ciphertext: "c", nonce: "n" }
    const { ciphertext: _c, nonce: _n, invocationKey: _k, ...model } = write
    const saved = await keyed(store({ ...model, sealed }))
    const removed = await keyed(erase({ personId: "person-member" }))
    for (const exit of [saved, removed]) expect(JSON.stringify(exit)).toContain("@smthrs/mvp/personal/StoreUnavailable")
    expect(ModelFlows.STORE_RETRY).toMatchObject({ expirationMs: 30 * 60_000 })
  })

  test("a step with no invocation key dies rather than record its change twice", async () => {
    const { store, erase } = ModelFlows.steps(await scratchDatabase())
    const { ciphertext: _c, nonce: _n, invocationKey: _k, ...model } = write
    const exits = [
      await Effect.runPromiseExit(store({ ...model, sealed: { ciphertext: "c", nonce: "n" } }) as Effect.Effect<unknown, unknown>),
      await Effect.runPromiseExit(erase({ personId: "person-member" }) as Effect.Effect<unknown, unknown>),
    ]
    for (const exit of exits) expect(JSON.stringify(exit)).toContain("NoInvocationKey")
    expect(await rows(runtime)).toEqual([])
  })
})

describe("GET /api/shapes/personal-model", () => {
  test("syncs the person's own row, never another's, never the sealed key; signed out syncs no rows", async () => {
    await seed(runtime, "person-member")
    await seed(runtime, "person-admin")
    const h = await open({ actor: member })
    const response = await h.fetch(`${PERSONAL_MODEL_SHAPE_ROUTE}?offset=-1`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("person-member")
    expect(text).not.toContain("person-admin")
    expect(text).not.toContain("ciphertext")
    expect(leaks(text)).toEqual([])
    const sent = h.electric.at(-1)!
    expect(sent.searchParams.get("where")).toBe("person_id = $1")
    expect(sent.searchParams.get("params[1]")).toBe("person-member")
    expect(sent.searchParams.get("columns")).toBe(
      "person_id,protocol,base_url,model_id,key_last4,failure_status,failed_at,updated_at",
    )
    const out = await open()
    expect((await out.fetch(`${PERSONAL_MODEL_SHAPE_ROUTE}?offset=-1`)).status).toBe(200)
    expect(out.electric.at(-1)!.searchParams.get("params[1]")).toBe("")
  })
})

describe("POST /api/me/model/test", () => {
  test("one tiny real call with the saved model: ok and its first words, kept in the person's ledger", async () => {
    await seed(runtime, "person-member")
    const provider = scriptedProvider({ text: "ok\n" })
    const h = await open({ actor: member, provider: provider.fetch })
    const [status, result] = await testCall(h)
    expect(status).toBe(200)
    expect(result).toMatchObject({ ok: true, sample: "ok" })
    expect(provider.seen).toHaveLength(1)
    expect(provider.seen[0]!.url).toBe(`${OPENAI_ORIGIN}/v1/chat/completions`)
    expect(provider.seen[0]!.headers.get("authorization")).toBe(`Bearer ${VALUE}`)
    expect(provider.seen[0]!.body).toMatchObject({ model: "gpt-test" })
    expect(await usage(runtime)).toEqual([
      expect.objectContaining({ personId: "person-member", role: "test", inputTokens: 3, outputTokens: 2, outcome: "success", settled: true }),
    ])
    expect(h.count(PersonalApi.requests, { op: "test", outcome: "ok" })).toBe(1)
    expect(leaks(h.recorded())).toEqual([])
  })

  test("an Anthropic-compatible model is called with its own key header", async () => {
    await seed(runtime, "person-member", { protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN, modelId: "claude-test" })
    const provider = scriptedProvider({ text: "ok" })
    const [, result] = await testCall(await open({ actor: member, provider: provider.fetch }))
    expect(result).toMatchObject({ ok: true, sample: "ok" })
    expect(provider.seen[0]!.url).toBe(`${ANTHROPIC_ORIGIN}/v1/messages`)
    expect(provider.seen[0]!.headers.get("x-api-key")).toBe(VALUE)
  })

  test("a refused key fails at once, naming the provider's host and status, and marks the person's row until it answers", async () => {
    await seed(runtime, "person-member")
    let reply: Reply = {
      status: 401,
      error: { type: "invalid_request_error", code: "invalid_api_key", message: `Incorrect API key ${VALUE}` },
    }
    const provider = scriptedProvider((index) => (index < 99 ? reply : { text: "ok" }))
    const h = await open({ actor: member, provider: provider.fetch })
    const [, refused] = await testCall(h)
    expect(refused).toEqual({ ok: false, latencyMs: expect.any(Number), code: "authentication", status: 401, host: "models.example.com" })
    expect(provider.seen).toHaveLength(1)
    expect(await rows(runtime)).toEqual([expect.objectContaining({ failureStatus: 401, failedAt: expect.any(Date) })])

    reply = { status: 429, error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" } }
    const [, out] = await testCall(h)
    expect(out).toMatchObject({ ok: false, code: "quota_exceeded", status: 429 })
    // Never retried: a key that ran out doesn't come back by asking again.
    expect(provider.seen).toHaveLength(2)
    expect(await rows(runtime)).toEqual([expect.objectContaining({ failureStatus: 429 })])

    reply = { text: "ok" }
    expect((await testCall(h))[1]).toMatchObject({ ok: true })
    expect(await rows(runtime)).toEqual([expect.objectContaining({ failureStatus: null, failedAt: null })])
    expect(h.line("personal_model.call").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ role: "test", outcome: "failed", errorCode: "authentication", httpStatus: 401 }),
      expect.objectContaining({ role: "test", outcome: "failed", errorCode: "quota_exceeded", httpStatus: 429 }),
    ])
    expect(leaks(h.recorded())).toEqual([])
    expect(leaks(await dump(runtime, (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).name))).toEqual([])
  })

  test("a test cancelled while the provider answers still settles its row, as interrupted", async () => {
    await seed(runtime, "person-member")
    const hanging = scriptedProvider({ hang: true })
    const h = await open({ actor: member, provider: hanging.fetch })
    const request = h.fork(PERSONAL_MODEL_TEST_ROUTE, { method: "POST" })
    await eventually(() => hanging.seen.length === 1)
    await Effect.runPromise(Fiber.interrupt(request))
    await eventually(async () => (await usage(runtime))[0]?.settled === true)
    expect(await usage(runtime)).toEqual([expect.objectContaining({ role: "test", outcome: "interrupted", settled: true })])
  })

  test("a provider that never answers times out; a server error leaves the person's row unmarked", async () => {
    await seed(runtime, "person-member")
    const hanging = scriptedProvider({ hang: true })
    const [, timedOut] = await testCall(await open({ actor: member, provider: hanging.fetch, testWithin: "50 millis" }))
    expect(timedOut).toMatchObject({ ok: false, code: "call_timeout", status: null, host: "models.example.com" })
    const broken = scriptedProvider({ status: 500, error: { message: "upstream" } })
    const [, failed] = await testCall(await open({ actor: member, provider: broken.fetch }))
    expect(failed).toMatchObject({ ok: false, code: "provider_internal", status: 500 })
    expect(await rows(runtime)).toEqual([expect.objectContaining({ failureStatus: null })])
  })

  test("nothing saved is 404 none; a Guest is refused; a key that no longer opens is unusable, never the deployment's", async () => {
    expect(await testCall(await open({ actor: member }))).toEqual([404, { code: "none" }])
    expect(await testCall(await open({ actor: guest }))).toEqual([403, { code: "forbidden" }])
    expect(await testCall(await open())).toEqual([401, { code: "authentication" }])
    expect((await (await open({ actor: member })).fetch(PERSONAL_MODEL_TEST_ROUTE, { method: "GET" })).headers.get("allow"))
      .toBe("POST")
    // Sealed under another deployment's key.
    await seed(runtime, "person-member", {}, Redacted.make("f".repeat(64)))
    const provider = scriptedProvider({ text: "ok" })
    expect(await testCall(await open({ actor: member, provider: provider.fetch }))).toEqual([
      200,
      { ok: false, latencyMs: expect.any(Number), code: "unusable", status: null, host: "models.example.com" },
    ])
    expect(await testCall(await open({ actor: member, keys: false, provider: provider.fetch }))).toMatchObject([
      200,
      { ok: false, code: "unusable" },
    ])
    expect(provider.seen).toEqual([])
  })

  test("a saved model the planner can't serve is unusable too", async () => {
    await seed(runtime, "person-member", { modelId: "has space" })
    const provider = scriptedProvider({ text: "ok" })
    expect((await testCall(await open({ actor: member, provider: provider.fetch })))[1]).toMatchObject({
      ok: false,
      code: "unusable",
      host: "models.example.com",
    })
    expect(provider.seen).toEqual([])
  })

  test("the routes ChatApi sends here are the three paths, nothing else", () => {
    expect([PERSONAL_MODEL_ROUTE, PERSONAL_MODEL_TEST_ROUTE, PERSONAL_MODEL_SHAPE_ROUTE].map(PersonalApi.handles)).toEqual([
      true,
      true,
      true,
    ])
    expect(["/api/me", "/api/me/model/other", "/api/shapes/secrets"].map(PersonalApi.handles)).toEqual([false, false, false])
  })

  test("Postgres that can't say whether a model is saved is 503 unavailable", async () => {
    const down = Layer.succeed(PersonalModels, PersonalModels.of({ open: () => Effect.fail(new PersonalModelsUnavailable({ errorCode: "sql:ConnectionError" })) }))
    expect(await testCall(await open({ actor: member, personalModels: down }))).toEqual([503, { code: "unavailable" }])
  })
})

describe("the model endpoint answers a person with their own model", () => {
  const ask = (text: string) =>
    ModelRequest.ModelRequest.make({
      modelId: "browser-choice",
      system: [ModelRequest.SystemPart.make({ text: "system" })],
      messages: [ModelRequest.Message.user(text)],
      tools: [],
      params: ModelRequest.GenerationParams.make({ maxTokens: 64 }),
    })
  const body = (request: ModelRequest.ModelRequest) => JSON.stringify(Schema.encodeSync(ModelRequest.ModelRequest)(request))
  type H = Awaited<ReturnType<typeof harness>>
  const call = async (h: H, role = "agent") => {
    const response = await h.fetch(`/api/model/${role}`, { method: "POST", body: body(ask("hi")) })
    const text = await response.text()
    return {
      status: response.status,
      lines: response.status === 200 ? text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)) : [],
      error: response.status === 200 ? undefined : JSON.parse(text),
    }
  }
  const deployment = () => Stream.make<Array<ModelEvent.ModelEvent>>(
    { type: "text-delta", id: "t", text: "the deployment's" },
    { type: "usage", inputTokens: 1, outputTokens: 1 },
    { type: "settle", stopReason: "stop" },
  )
  const modelUsage = () =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT invocation_id FROM model_usage`))

  test("the person's own calls go to their provider with their key, outside the deployment's budget", async () => {
    await seed(runtime, "person-member", {}, PERSONAL_KEYS)
    const provider = scriptedProvider({ text: "mine", usage: { input: 7, output: 5 } })
    // A deployment budget no call fits in: the person's calls never reach it.
    const h = await harness(runtime, deployment, { actor: member, fetch: provider.fetch, config: { MODEL_DAILY_TOKEN_BUDGET: "1" } })
    for (const role of ["agent", "coding", "renderer", "judge"]) {
      const answered = await call(h, role)
      expect(answered.status, role).toBe(200)
      expect(answered.lines).toContainEqual(expect.objectContaining({ type: "text-delta", text: "mine" }))
      expect(answered.lines.at(-1)).toEqual({ type: "end" })
    }
    expect(h.requests).toEqual([])
    expect(provider.seen).toHaveLength(4)
    expect(provider.seen.every((seen) => seen.headers.get("authorization") === `Bearer ${VALUE}`)).toBe(true)
    expect(provider.seen.every((seen) => seen.body.model === "gpt-test")).toBe(true)
    expect(await modelUsage()).toEqual([])
    await eventually(async () => (await usage(runtime)).every((row) => row.settled))
    expect((await usage(runtime)).map((row) => [row.role, row.inputTokens, row.outputTokens, row.outcome])).toEqual([
      ["agent", 7, 5, "success"],
      ["coding", 7, 5, "success"],
      ["renderer", 7, 5, "success"],
      ["judge", 7, 5, "success"],
    ])
    expect(h.starts.filter((start) => start.flow === SpendAlert.SpendAlert._tag)).toEqual([])
    expect(h.count(PersonalUsage.calls, { role: "agent", outcome: "success" })).toBe(1)
    expect(h.count(PersonalUsage.tokens, { role: "agent", type: "input" })).toBe(7)
    expect(h.count(PersonalUsage.tokens, { role: "agent", type: "output" })).toBe(5)
    expect(leaks(JSON.stringify(h.logs))).toEqual([])
  })

  test("timeline summaries are the person's too: their model answers them, never the deployment's", async () => {
    await seed(runtime, "person-member", {}, PERSONAL_KEYS)
    const DEPLOYMENT = "https://deployment.example.com"
    const provider = scriptedProvider({ text: "summed up" }, globalThis.fetch, [OPENAI_ORIGIN, DEPLOYMENT])
    const h = await harness(runtime, deployment, {
      actor: member,
      fetch: provider.fetch,
      config: {
        SUMMARY_MODEL: JSON.stringify({ protocol: "openai-chat", baseUrl: DEPLOYMENT, modelId: "summary-model", credential: "SUMMARIES" }),
        SMITHERS_MODEL_KEY_SUMMARIES: "summary-key",
        SMITHERS_MODEL_KEY_SUMMARIES_ORIGIN: DEPLOYMENT,
      },
    })
    const answered = await call(h, "summary")
    expect(answered.lines).toContainEqual(expect.objectContaining({ type: "text-delta", text: "summed up" }))
    expect(provider.seen.map((seen) => [new URL(seen.url).origin, seen.headers.get("authorization"), seen.body.model])).toEqual([
      [OPENAI_ORIGIN, `Bearer ${VALUE}`, "gpt-test"],
    ])
    // The person's ledger carries it; the deployment's ledger and budget have nothing.
    expect(await modelUsage()).toEqual([])
    await eventually(async () => (await usage(runtime)).length === 1)
    expect(await usage(runtime)).toEqual([expect.objectContaining({ role: "summary" })])
  })

  test("with hosted inference off, a person's own model answers, and a person who saved none is told to add one", async () => {
    await seed(runtime, "person-member", {}, PERSONAL_KEYS)
    const provider = scriptedProvider({ text: "theirs" })
    const off = { HOSTED_MODEL_ENABLED: "false" }
    const theirs = await harness(runtime, deployment, { actor: member, fetch: provider.fetch, config: off })
    const nobodys = await harness(runtime, deployment, { actor: admin, fetch: provider.fetch, config: off })

    const answered = await call(theirs, "judge")
    const refused = await call(nobodys)

    expect(answered.lines).toContainEqual(expect.objectContaining({ type: "text-delta", text: "theirs" }))
    expect(refused.status).toBe(409)
    expect(refused.error).toMatchObject({ code: "no_route", message: "Add your model in Settings to ask Smithers." })
    expect(nobodys.line("model.endpoint").map(({ annotations }) => annotations.errorCode)).toEqual(["hosted_off"])
    expect(theirs.requests).toEqual([])
    expect(nobodys.requests).toEqual([])
    expect(await modelUsage()).toEqual([])
  })

  test("another person, and a person who saved none, are answered by the deployment's model as before", async () => {
    await seed(runtime, "person-admin", {}, PERSONAL_KEYS)
    const provider = scriptedProvider({ text: "admin's" })
    const h = await harness(runtime, deployment, { actor: member, fetch: provider.fetch })
    const answered = await call(h)
    expect(answered.lines).toContainEqual(expect.objectContaining({ type: "text-delta", text: "the deployment's" }))
    expect(provider.seen).toEqual([])
    expect(await modelUsage()).toHaveLength(1)
    expect(h.starts.map((start) => start.flow)).toContain(SpendAlert.SpendAlert._tag)
  })

  test("a refused key fails the call at once with no fallback and no retry, and marks the person's row", async () => {
    await seed(runtime, "person-member", {}, PERSONAL_KEYS)
    // A provider that echoes the key in its refusal: no record may carry it.
    const provider = scriptedProvider({ status: 402, error: { message: `Payment required for ${VALUE}` } })
    const h = await harness(runtime, deployment, { actor: member, fetch: provider.fetch })
    const answered = await call(h)
    expect(answered.lines.at(-1)).toMatchObject({ type: "error", code: "quota_exceeded" })
    expect(answered.lines.at(-1)).not.toHaveProperty("retryAfterMillis")
    expect(provider.seen).toHaveLength(1)
    expect(h.requests).toEqual([])
    await eventually(async () => (await rows(runtime))[0]?.failureStatus === 402)
    expect(await usage(runtime)).toEqual([
      expect.objectContaining({ outcome: "failed", errorCode: "quota_exceeded", httpStatus: 402, settled: true }),
    ])
    expect(h.line("personal_model.call")).toEqual([
      expect.objectContaining({ annotations: expect.objectContaining({ role: "agent", errorCode: "quota_exceeded", httpStatus: 402 }) }),
    ])
    expect(leaks(JSON.stringify(answered))).toEqual([])
    expect(leaks(recorded(h))).toEqual([])
  })

  test("a saved model that can't be used is 409 no_route, never the deployment's model", async () => {
    await seed(runtime, "person-member", {}, Redacted.make("0".repeat(64)))
    const h = await harness(runtime, deployment, { actor: member })
    const answered = await call(h)
    expect(answered.status).toBe(409)
    expect(answered.error).toMatchObject({ code: "no_route", message: "Your model can't be used. Save it again in Settings." })
    expect(h.requests).toEqual([])
    expect(h.line("model.endpoint")).toEqual([expect.objectContaining({ annotations: expect.objectContaining({ errorCode: "own_unusable:key" }) })])
  })

  test("Postgres that can't open the person's model, or write their ledger, is 503", async () => {
    const down = Layer.succeed(PersonalModels, PersonalModels.of({ open: () => Effect.fail(new PersonalModelsUnavailable({ errorCode: "sql:ConnectionError" })) }))
    const h = await harness(runtime, deployment, { actor: member, personalModels: down })
    expect((await call(h)).status).toBe(503)
    expect(h.requests).toEqual([])

    // The ledger's table is gone: the row can't be written, so the call never runs.
    await seed(runtime, "person-member", {}, PERSONAL_KEYS)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE personal_model_usage RENAME TO usage_gone`))
    try {
      const provider = scriptedProvider({ text: "never" })
      const gone = await harness(runtime, deployment, { actor: member, fetch: provider.fetch })
      expect((await call(gone)).status).toBe(503)
      expect(provider.seen).toEqual([])
      expect(gone.count(PersonalUsage.errors, { op: "begin" })).toBe(1)
    } finally {
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE usage_gone RENAME TO personal_model_usage`))
    }
  })
})

describe("a todo run on its committer's model (ModelEndpoint.local)", () => {
  const ask = ModelRequest.ModelRequest.make({
    modelId: "coding",
    system: [],
    messages: [ModelRequest.Message.user("change it")],
    tools: [],
    params: ModelRequest.GenerationParams.make({ maxTokens: 64 }),
  })

  const seat = async (
    fetch: typeof globalThis.fetch,
    owner: ModelEndpoint.Owner,
    starter?: Flows.FlowStarter["Service"],
    role: "coding" | "summary" = "coding",
    hosted = true,
  ) => {
    const database = (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database
    const config = ConfigProvider.layer(ConfigProvider.fromUnknown({
      HOSTED_MODEL_ENABLED: hosted ? "true" : "false",
      SMITHERS_MODEL_KEY_DEPLOYMENT: "deployment-key",
      SMITHERS_MODEL_KEY_DEPLOYMENT_ORIGIN: "https://deployment.example.com",
      SUMMARY_MODEL: JSON.stringify({
        protocol: "openai-chat",
        baseUrl: "https://deployment.example.com",
        modelId: "summary-model",
        credential: "DEPLOYMENT",
      }),
    }))
    const local = await Effect.runPromise(
      ModelEndpoint.local(database, { alerts: true }).pipe(
        Effect.provide(PersonalModels.layer(database).pipe(Layer.provide(SecretKeys.layer(KEY)))),
        Effect.provide(HostModel.layerConfig("CHAT_MODEL", {
          protocol: "openai-chat",
          baseUrl: "https://deployment.example.com",
          modelId: "deployment-model",
          credential: "DEPLOYMENT",
        })),
        Effect.provide(config),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    )
    return local(role, starter, owner)
  }
  const inRun = (executionId: string) =>
    Stream.provideService(FlowRuntime.FlowInstance, { executionId } as unknown as FlowRuntime.FlowInstance["Service"])

  test("inside a run its owner saved a model for, their model answers; any other call is the deployment's", async () => {
    await seed(runtime, "person-member")
    const provider = scriptedProvider(
      (index) => ({ text: index === 0 ? "theirs" : "the deployment's" }),
      globalThis.fetch,
      [OPENAI_ORIGIN, "https://deployment.example.com"],
    )
    const starts: Array<string> = []
    const starter = Flows.FlowStarter.of({ start: (flow) => Effect.sync(() => void starts.push(flow._tag)) })
    const coding = await seat(provider.fetch, (executionId) =>
      Effect.succeed(executionId === "todo:mine" ? Option.some("person-member") : Option.none()), starter)
    const text = async (effect: Stream.Stream<ModelEvent.ModelEvent, unknown>) =>
      (await Effect.runPromise(Stream.runCollect(effect))).flatMap((event) => event.type === "text-delta" ? [event.text] : [])
    expect(await text(coding.model.stream(ask).pipe(inRun("todo:mine")))).toEqual(["theirs"])
    expect(provider.seen.map((seen) => seen.url)).toEqual([`${OPENAI_ORIGIN}/v1/chat/completions`])
    // The person's key paid: no spend alert started.
    expect(starts).toEqual([])
    // Outside a run, or in a run that is nobody's, the deployment answers.
    expect(await text(coding.model.stream(ask))).toEqual(["the deployment's"])
    expect(await text(coding.model.stream(ask).pipe(inRun("triage:1")))).toEqual(["the deployment's"])
    expect(provider.seen.map((seen) => seen.url)).toEqual([
      `${OPENAI_ORIGIN}/v1/chat/completions`,
      "https://deployment.example.com/v1/chat/completions",
      "https://deployment.example.com/v1/chat/completions",
    ])
    expect(provider.seen[1]!.headers.get("authorization")).toBe("Bearer deployment-key")
    // The deployment's own call alerts, once a window.
    expect(starts).toEqual([SpendAlert.SpendAlert._tag])
    await eventually(async () => (await usage(runtime)).length === 1 && (await usage(runtime))[0]!.settled)
    expect(await usage(runtime)).toEqual([expect.objectContaining({ role: "coding", outcome: "success" })])
  })

  test("a summary made inside its run is its owner's: their model answers it", async () => {
    await seed(runtime, "person-member")
    const provider = scriptedProvider({ text: "summed up" }, globalThis.fetch, [OPENAI_ORIGIN, "https://deployment.example.com"])
    const summary = await seat(provider.fetch, () => Effect.succeed(Option.some("person-member")), undefined, "summary")
    await Effect.runPromise(Stream.runCollect(summary.model.stream(ask).pipe(inRun("todo:mine"))))
    expect(provider.seen.map((seen) => [new URL(seen.url).origin, seen.body.model])).toEqual([[OPENAI_ORIGIN, "gpt-test"]])
    await eventually(async () => (await usage(runtime)).length === 1)
    expect(await usage(runtime)).toEqual([expect.objectContaining({ role: "summary" })])
  })

  test("with hosted inference off, a run nobody owns is refused no_route and its owner's run still answers", async () => {
    await seed(runtime, "person-member")
    const provider = scriptedProvider({ text: "theirs" }, globalThis.fetch, [OPENAI_ORIGIN, "https://deployment.example.com"])
    const coding = await seat(provider.fetch, (executionId) =>
      Effect.succeed(executionId === "todo:mine" ? Option.some("person-member") : Option.none()), undefined, "coding", false)
    const exit = await Effect.runPromiseExit(Stream.runCollect(coding.model.stream(ask).pipe(inRun("triage:1"))))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ code: "no_route", httpStatus: 409 })
    const theirs = await Effect.runPromise(Stream.runCollect(coding.model.stream(ask).pipe(inRun("todo:mine"))))
    expect(theirs.flatMap((event) => event.type === "text-delta" ? [event.text] : [])).toEqual(["theirs"])
    expect(provider.seen.map((seen) => new URL(seen.url).origin)).toEqual([OPENAI_ORIGIN])
  })

  test("its committer's refused key fails the run's call at once, and an owner lookup Postgres refuses fails it too", async () => {
    await seed(runtime, "person-member")
    const provider = scriptedProvider({ status: 401, error: { message: `bad key ${VALUE}` } })
    const coding = await seat(provider.fetch, () => Effect.succeed(Option.some("person-member")))
    const refused = await Effect.runPromiseExit(Stream.runCollect(coding.model.stream(ask).pipe(inRun("todo:x"))))
    expect(refused).toMatchObject({ _tag: "Failure" })
    expect(JSON.stringify(refused)).toContain('"code":"authentication"')
    // The journaled failure carries no echo of the key.
    expect(leaks(JSON.stringify(refused))).toEqual([])
    expect(provider.seen).toHaveLength(1)
    const lost = await seat(provider.fetch, () => Effect.fail("down"))
    const failed = await Effect.runPromiseExit(Stream.runCollect(lost.model.stream(ask).pipe(inRun("todo:x"))))
    expect(failed._tag).toBe("Failure")
    expect(JSON.stringify(failed)).toContain("provider_internal")
    expect(provider.seen).toHaveLength(1)
  })

})

describe("a refusal of a person's key is final", () => {
  test("quota and credit refusals lose their retry hints; anything else passes unchanged", () => {
    const quota = new ModelError.ModelError({
      code: "quota_exceeded",
      message: "out",
      httpStatus: 429,
      providerCode: "insufficient_quota",
      requestId: "r",
      retryAfterMillis: 1_000,
      resetAtEpochMillis: 2_000,
      quotaScope: "model",
    })
    const finalQuota = final(quota)
    expect(finalQuota).toMatchObject({ code: "quota_exceeded", message: "out", httpStatus: 429, providerCode: "insufficient_quota", requestId: "r" })
    expect([finalQuota.retryAfterMillis, finalQuota.resetAtEpochMillis, finalQuota.quotaScope]).toEqual([undefined, undefined, undefined])
    expect(ModelError.isTerminalRefusal(finalQuota)).toBe(true)
    expect(ModelError.isTerminalRefusal(quota)).toBe(false)
    const credit = final(new ModelError.ModelError({ code: "out_of_credit", message: "none", retryAfterMillis: 1 }))
    expect(credit).toMatchObject({ code: "out_of_credit", message: "none" })
    expect([credit.httpStatus, credit.providerCode, credit.requestId, credit.retryAfterMillis]).toEqual([undefined, undefined, undefined, undefined])
    const limited = new ModelError.ModelError({ code: "rate_limited", message: "wait", retryAfterMillis: 5 })
    expect(final(limited)).toBe(limited)
    expect(finalFailure(limited)).toBe(limited)
    expect((finalFailure(quota) as ModelError.ModelError).retryAfterMillis).toBeUndefined()
    // A permission failure, which a provider route never raises, passes unchanged.
    const denied = { _tag: "PermissionDenied" } as unknown as Model.ModelFailure
    expect(finalFailure(denied)).toBe(denied)
  })

  test("Postgres the real models can't reach fails as unavailable, by its SQL reason", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Effect.service(PersonalModels), (models) => models.open("person-member")).pipe(
        Effect.provide(PersonalModels.layer(unreachable).pipe(Layer.provide(SecretKeys.layer(KEY)))),
      ),
    )
    expect(JSON.stringify(exit)).toContain("@smthrs/mvp/personal/PersonalModelsUnavailable")
    expect(JSON.stringify(exit)).toContain('"errorCode":"sql:')
  })

  test("nobody's model: PersonalModels.none opens nothing", async () => {
    expect(await Effect.runPromise(Effect.flatMap(Effect.service(PersonalModels), (models) => models.open("x")).pipe(Effect.provide(PersonalModels.none))))
      .toEqual(Option.none())
    expect(new PersonalModelUnusable({ reason: "key", host: "h" }).reason).toBe("key")
  })

  test("a ledger write Postgres refuses at the end is never raised into the answer", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const exit = await Effect.runPromiseExit(
      PersonalUsage.end(
        { invocationId: "i", requestId: "i", personId: "p", role: "agent", modelId: "m", host: "h" },
        { outcome: "success", usage: {} },
        unreachable,
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("a slow call on a key since replaced says nothing of the new key", async () => {
    const database = (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database
    await seed(runtime, "person-member")
    const call = { invocationId: crypto.randomUUID(), requestId: "r", personId: "person-member", role: "agent", modelId: "m", host: "h" }
    await runtime.runPromise(Effect.provide(PersonalUsage.begin(call), database))
    // The call began a minute before the person replaced their key.
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE personal_model_usage SET created_at = now() - interval '1 minute' WHERE invocation_id = ${call.invocationId}`))
    await seed(runtime, "person-member", { key: `${VALUE}-new` })
    await runtime.runPromise(PersonalUsage.end(call, { outcome: "failed", usage: {}, errorCode: "authentication", httpStatus: 401 }, database))
    expect(await rows(runtime)).toEqual([expect.objectContaining({ failureStatus: null, failedAt: null })])
    // A call made with the current key marks it.
    const current = { ...call, invocationId: crypto.randomUUID() }
    await runtime.runPromise(Effect.provide(PersonalUsage.begin(current), database))
    await runtime.runPromise(PersonalUsage.end(current, { outcome: "failed", usage: {}, errorCode: "authentication", httpStatus: 401 }, database))
    expect(await rows(runtime)).toEqual([expect.objectContaining({ failureStatus: 401 })])
  })

  test("a call settled already isn't counted again", async () => {
    const database = (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database
    const call = { invocationId: crypto.randomUUID(), requestId: "r", personId: "person-member", role: "agent", modelId: "m", host: "h" }
    await runtime.runPromise(Effect.provide(PersonalUsage.begin(call), database))
    const ended = { outcome: "interrupted" as const, usage: { inputTokens: 1 } }
    await runtime.runPromise(PersonalUsage.end(call, ended, database))
    await runtime.runPromise(PersonalUsage.end(call, { outcome: "success", usage: {} }, database))
    expect(await usage(runtime)).toEqual([expect.objectContaining({ outcome: "interrupted", inputTokens: 1, outputTokens: 0 })])
    expect(PersonalUsage.refusedKey({ outcome: "failed", usage: {}, httpStatus: 500 })).toBe(false)
    expect(PersonalUsage.refusedKey({ outcome: "failed", usage: {} })).toBe(false)
    expect(PersonalUsage.refusedKey({ outcome: "failed", usage: {}, httpStatus: 403 })).toBe(true)
    // A 429 marks the key only when it ran out; a plain rate limit is waited out.
    expect(PersonalUsage.refusedKey({ outcome: "failed", usage: {}, httpStatus: 429, errorCode: "rate_limited" })).toBe(false)
    expect(PersonalUsage.refusedKey({ outcome: "failed", usage: {}, httpStatus: 429 })).toBe(false)
    expect(PersonalUsage.refusedKey({ outcome: "failed", usage: {}, httpStatus: 429, errorCode: "out_of_credit" })).toBe(true)
  })
})
