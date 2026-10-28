import { final, finalFailure } from "../ModelRefusal.ts"
// A person's own models end to end in the Worker (docs/features/personal-model.md): saving their keys and tiers' models,
// removing and testing them through the real routes, with `model/Put` and `model/Delete` on the Node host's engine; the
// shape of the person's own rows; and the model endpoint answering each role with its tier's model. Postgres and Electric are the compose ones; the
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
import * as ModelTiers from "../ModelTiers.ts"
import * as SpendAlert from "../flows/SpendAlert.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import { eventually, harness, PERSONAL_KEYS, recorded, testFile } from "../test/harness.ts"
import * as PersonalApi from "./Api.ts"
import * as ModelFlows from "./ModelFlows.ts"
import { PersonalModels, PersonalModelsUnavailable, PersonalModelUnusable } from "./Models.ts"
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
  seedKeys,
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

/** A save of one key at `baseUrl` speaking `protocol`, with `modelId` as its fast model. */
const saveOne = (protocol: string, baseUrl: string, modelId: string, key: string = VALUE) => ({
  keys: [{ protocol, baseUrl, key }],
  models: { fast: { protocol, modelId } },
})

/** Both keys: Anthropic-compatible for `fast` and `hard`, OpenAI-compatible for `implement`. */
const BOTH = {
  keys: [
    { protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN, key: `${VALUE}-anthropic` },
    { protocol: "openai-chat", baseUrl: OPENAI_ORIGIN, key: VALUE },
  ],
  models: {
    fast: { protocol: "anthropic-messages", modelId: "claude-fast" },
    implement: { protocol: "openai-chat", modelId: "gpt-implement" },
    hard: { protocol: "anthropic-messages", modelId: "claude-hard" },
  },
}

describe("PUT /api/me/model", () => {
  test("a Member saves and replaces their key; Postgres and the journal hold only ciphertext and the key's tail", async () => {
    const h = await open({ actor: member })

    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(SAVE)))).toEqual([202, {}])
    const [saved] = await rows(runtime)
    expect(saved).toMatchObject({
      personId: "person-member",
      protocol: "openai-chat",
      baseUrl: OPENAI_ORIGIN,
      fastModel: "gpt-test",
      implementModel: null,
      hardModel: null,
      keyVersion: 1,
      keyLast4: '"~9Zq'.slice(-4),
      failureStatus: null,
      failedAt: null,
    })

    // A replacement clears the last refusal its earlier key had, and a key it leaves out is removed.
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE personal_models SET failure_status = 401, failed_at = now() WHERE person_id = 'person-member'`))
    expect(
      (await h.fetch(PERSONAL_MODEL_ROUTE, put(saveOne("anthropic-messages", ANTHROPIC_ORIGIN, "claude-test")))).status,
    ).toBe(202)
    expect(await rows(runtime)).toEqual([
      expect.objectContaining({ protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN, fastModel: "claude-test", failureStatus: null }),
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

  test("both keys, each tier on one of them; a later save keeps a key without its value and moves the tiers", async () => {
    const h = await open({ actor: member })
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(BOTH)))).toEqual([202, {}])
    expect((await rows(runtime)).map((row) => [row.protocol, row.fastModel, row.implementModel, row.hardModel, row.keyLast4]))
      .toEqual([
        ["anthropic-messages", "claude-fast", null, "claude-hard", "opic"],
        ["openai-chat", null, "gpt-implement", null, "~9Zq".slice(-4)],
      ])
    const [anthropic, openai] = await rows(runtime)

    // Both keys kept as saved, no value sent: every tier now on the OpenAI-compatible key, named or not.
    const kept = {
      keys: [{ protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN }, { protocol: "openai-chat", baseUrl: OPENAI_ORIGIN, key: "" }],
      models: { fast: { protocol: "openai-chat", modelId: " gpt-fast " } },
    }
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(kept)))).toEqual([202, {}])
    const after = await rows(runtime)
    expect(after.map((row) => [row.protocol, row.fastModel, row.implementModel, row.hardModel])).toEqual([
      ["anthropic-messages", null, null, null],
      ["openai-chat", "gpt-fast", null, null],
    ])
    // The sealed keys stayed as they were.
    expect(after.map((row) => row.ciphertext)).toEqual([anthropic!.ciphertext, openai!.ciphertext])
    expect(h.line("personal_model.request").at(-1)).toMatchObject({ annotations: { keys: 2, tiers: "fast", outcome: "putting" } })
    expect((await events(runtime)).map((event) => event.action)).toEqual(["set", "replace"])
    expect(leaks(h.recorded(), [VALUE, `${VALUE}-anthropic`])).toEqual([])
  })

  test("a key on a provider's own host needs no model named: its tiers use the presets", async () => {
    const h = await open({ actor: member })
    const preset = { keys: [{ protocol: "openai-chat", baseUrl: "https://api.openai.com/v1", key: VALUE }], models: {} }
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(preset)))).toEqual([202, {}])
    expect(await rows(runtime)).toEqual([
      expect.objectContaining({ baseUrl: "https://api.openai.com", fastModel: null, implementModel: null, hardModel: null }),
    ])
  })

  test("the base URL is https to one public DNS name, its host lowercased and a trailing /v1 dropped", async () => {
    const h = await open({ actor: member })
    const saved = async (baseUrl: string) => {
      const answered = await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(saveOne("openai-chat", baseUrl, "gpt-test"))))
      return answered[0] === 202 ? [202, (await rows(runtime))[0]!.baseUrl] as const : answered
    }
    expect(await saved("https://API.Example.COM/openai/v1/")).toEqual([202, "https://api.example.com/openai"])
    expect(await saved("  https://openrouter.ai/api/v1  ")).toEqual([202, "https://openrouter.ai/api"])
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
    const withKey = (key: string) => put(saveOne("openai-chat", OPENAI_ORIGIN, "gpt-test", key))
    expect(await refusal(put(saveOne("openai-responses", OPENAI_ORIGIN, "m")))).toEqual([400, { code: "invalid_protocol" }])
    expect(await refusal(put(saveOne("openai-chat", OPENAI_ORIGIN, "has space")))).toEqual([400, { code: "invalid_model" }])
    expect(await refusal(put(saveOne("openai-chat", OPENAI_ORIGIN, "x".repeat(82))))).toEqual([400, { code: "invalid_model" }])
    expect(await refusal(withKey("short"))).toEqual([400, { code: "too_short" }])
    // Eight bytes, so a value a secret may be, but four characters: its "last four" would be all of it.
    expect(await refusal(withKey("éééé"))).toEqual([400, { code: "too_short" }])
    expect(await refusal(withKey("x".repeat(15)))).toEqual([400, { code: "too_short" }])
    expect(await refusal(withKey("x".repeat(16 * 1024 + 1)))).toEqual([400, { code: "too_long" }])
    expect(await refusal(withKey("sk-line\nbreak"))).toEqual([400, { code: "control_character" }])
    expect(await refusal(withKey("sk-lone-\ud800-x"))).toEqual([400, { code: "malformed_text" }])
    // No key, three keys, the same protocol twice, or a tier no key serves.
    expect(await refusal(put({ keys: [], models: {} }))).toEqual([400, { code: "invalid" }])
    expect(await refusal(put({ ...BOTH, keys: [...BOTH.keys, BOTH.keys[0]] }))).toEqual([400, { code: "invalid" }])
    expect(await refusal(put({ ...BOTH, keys: [BOTH.keys[1], BOTH.keys[1]] }))).toEqual([400, { code: "invalid" }])
    expect(await refusal(put({ ...SAVE, models: { strong: { protocol: "openai-chat", modelId: "m" } } }))).toEqual([400, { code: "invalid" }])
    expect(await refusal(put({ ...SAVE, models: { hard: { protocol: "anthropic-messages", modelId: "m" } } }))).toEqual([400, { code: "no_key" }])
    expect(await refusal(put({ ...SAVE, models: { hard: { protocol: "openai-responses", modelId: "m" } } }))).toEqual([400, { code: "invalid_protocol" }])
    // A key at a host no preset knows needs some model named.
    expect(await refusal(put({ ...SAVE, models: {} }))).toEqual([400, { code: "no_model" }])
    // A key not sent needs one saved for the same protocol and base URL: nothing is saved.
    expect(await refusal(put({ ...SAVE, keys: [{ protocol: "openai-chat", baseUrl: OPENAI_ORIGIN }] }))).toEqual([400, { code: "key_required" }])
    expect(await refusal(put({ protocol: "openai-chat", baseUrl: OPENAI_ORIGIN, modelId: "m" }))).toEqual([
      400,
      { code: "invalid" },
    ])
    expect(await refusal(put(`{"key":"${VALUE.replaceAll('"', "")}`))).toEqual([400, { code: "invalid" }])
    expect(await refusal(put("x".repeat(48 * 1024 + 1)))).toEqual([413, { code: "too_large" }])
    expect(await refusal({ method: "PUT", body: new Uint8Array([0xff, 0xfe]) })).toEqual([400, { code: "invalid" }])
    expect((await h.fetch(PERSONAL_MODEL_ROUTE, { method: "POST" })).status).toBe(405)
    expect((await h.fetch(PERSONAL_MODEL_ROUTE, { method: "POST" })).headers.get("allow")).toBe("PUT, DELETE")
    expect(await rows(runtime)).toEqual([])
    expect(leaks(h.recorded())).toEqual([])
  })

  test("a saved key moves to another base URL only with its value typed again", async () => {
    await seed(runtime, "person-member")
    const h = await open({ actor: member })
    const moved = { ...SAVE, keys: [{ protocol: "openai-chat", baseUrl: "https://elsewhere.example.com" }] }
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(moved)))).toEqual([400, { code: "key_required" }])
    expect(await rows(runtime)).toEqual([expect.objectContaining({ baseUrl: OPENAI_ORIGIN })])
  })

  test("Postgres that can't say what the person saved is 503 unavailable", async () => {
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE personal_models RENAME TO models_gone`))
    try {
      const h = await open({ actor: member })
      expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(SAVE)))).toEqual([503, { code: "unavailable" }])
    } finally {
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE models_gone RENAME TO personal_models`))
    }
  })

  test("signed out and an agent acting for the person are refused, and nothing is written", async () => {
    expect(await json(await (await open()).fetch(PERSONAL_MODEL_ROUTE, put(SAVE)))).toEqual([
      401,
      { code: "authentication" },
    ])
    const h = await open({ actor: agent })
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(SAVE)))).toEqual([403, { code: "forbidden" }])
    expect(h.count(Actor.personOnlyRefusals, { act: "model", by: "agent" })).toBe(1)
    expect(await rows(runtime)).toEqual([])
  })

  test("a Guest of the deployment's repository, and someone with no role, save their own (ruling AUTH-8)", async () => {
    for (const actor of [guest, roleless]) {
      const h = await open({ actor })
      expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put(SAVE))), String(actor.role)).toEqual([202, {}])
      expect(h.count(PersonalApi.requests, { op: "put", outcome: "putting" })).toBe(1)
    }
    expect((await rows(runtime)).map((row) => row.personId).sort()).toEqual([guest.subject.id, roleless.subject.id].sort())
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
  const sealed = { ciphertext: "c", nonce: "n", keyVersion: 1, keyLast4: "abcd" }
  const model = {
    personId: "person-member",
    keys: [{ protocol: "openai-chat" as const, baseUrl: OPENAI_ORIGIN, sealed }],
    models: { fast: { protocol: "openai-chat" as const, modelId: "gpt-test" } },
  }
  const write = { ...model, invocationKey: "step-1" }

  test("a step run again records its change once", async () => {
    const database = await scratchDatabase()
    const run = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(Effect.provide(effect, database) as Effect.Effect<A>)
    expect(await run(Store.put(write))).toBe("set")
    expect(await run(Store.put(write))).toBe("repeat")
    const remove = { personId: "person-member", invocationKey: "step-2" }
    expect(await run(Store.remove(remove))).toBe("deleted")
    expect(await run(Store.remove(remove))).toBe("repeat")
    expect((await events(runtime)).map((event) => event.action)).toEqual(["set", "delete"])
    expect(await run(Store.saved("person-member"))).toEqual([])
  })

  test("a kept key that was removed or moved since the route checked it writes nothing: stale", async () => {
    const database = await scratchDatabase()
    const run = <A>(effect: Effect.Effect<A, unknown, any>) => runtime.runPromise(Effect.provide(effect, database) as Effect.Effect<A>)
    const kept = { ...model, keys: [{ protocol: "openai-chat" as const, baseUrl: OPENAI_ORIGIN }] }
    expect(await run(Store.put({ ...kept, invocationKey: "step-3" }))).toBe("stale")
    expect(await run(Store.put(write))).toBe("set")
    expect(await run(Store.put({ ...kept, keys: [{ protocol: "openai-chat", baseUrl: "https://moved.example.com" }], invocationKey: "step-4" })))
      .toBe("stale")
    expect(await rows(runtime)).toEqual([expect.objectContaining({ baseUrl: OPENAI_ORIGIN, fastModel: "gpt-test" })])
    expect((await events(runtime)).map((event) => event.action)).toEqual(["set"])
  })

  test("a step whose database can't be reached fails as StoreUnavailable, which the engine retries", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const { store, erase } = ModelFlows.steps(unreachable)
    const keyed = <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromiseExit(Effect.provideService(effect, Action.CurrentInvocationKey, "step-1") as Effect.Effect<A, E>)
    const saved = await keyed(store(model))
    const removed = await keyed(erase({ personId: "person-member" }))
    for (const exit of [saved, removed]) expect(JSON.stringify(exit)).toContain("@smthrs/mvp/personal/StoreUnavailable")
    expect(ModelFlows.STORE_RETRY).toMatchObject({ expirationMs: 30 * 60_000 })
  })

  test("a step with no invocation key dies rather than record its change twice", async () => {
    const { store, erase } = ModelFlows.steps(await scratchDatabase())
    const exits = [
      await Effect.runPromiseExit(store(model) as Effect.Effect<unknown, unknown>),
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
      "person_id,protocol,base_url,fast_model,implement_model,hard_model,key_last4,failure_status,failed_at,updated_at",
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

  test("nothing saved is 404 none, a Guest's too; signed out is refused; a key that no longer opens is unusable, never the deployment's", async () => {
    expect(await testCall(await open({ actor: member }))).toEqual([404, { code: "none" }])
    expect(await testCall(await open({ actor: guest }))).toEqual([404, { code: "none" }])
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

  test("with two keys, Test calls each key the tiers use once, and answers the first failure", async () => {
    await seedKeys(runtime, "person-member", {
      keys: [{ protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN }, { protocol: "openai-chat", baseUrl: OPENAI_ORIGIN }],
      models: {
        fast: { protocol: "openai-chat", modelId: "gpt-fast" },
        implement: { protocol: "openai-chat", modelId: "gpt-implement" },
        hard: { protocol: "anthropic-messages", modelId: "claude-hard" },
      },
    })
    const fine = scriptedProvider({ text: "ok" })
    const h = await open({ actor: member, provider: fine.fetch })
    expect((await testCall(h))[1]).toMatchObject({ ok: true, sample: "ok" })
    expect(fine.seen.map((seen) => [new URL(seen.url).origin, seen.body.model])).toEqual([
      [OPENAI_ORIGIN, "gpt-fast"],
      [ANTHROPIC_ORIGIN, "claude-hard"],
    ])
    expect((await usage(runtime)).map((row) => [row.role, row.protocol, row.tier])).toEqual([
      ["test", "openai-chat", null],
      ["test", "anthropic-messages", null],
    ])
    // The Anthropic-compatible key is refused: Test names it, and only its row is marked.
    const refused = scriptedProvider((index) => index === 0 ? { text: "ok" } : { status: 401, error: { message: "bad key" } })
    expect((await testCall(await open({ actor: member, provider: refused.fetch })))[1]).toMatchObject({
      ok: false,
      code: "authentication",
      status: 401,
      host: "anthropic.example.com",
    })
    expect((await rows(runtime)).map((row) => [row.protocol, row.failureStatus])).toEqual([
      ["anthropic-messages", 401],
      ["openai-chat", null],
    ])
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
  const call = async (h: H, role = "agent", request = ask("hi")) => {
    const response = await h.fetch(`/api/model/${role}`, { method: "POST", body: body(request) })
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
    for (const role of ["agent", "coding", "renderer", "judge", "review", "plan"]) {
      const answered = await call(h, role)
      expect(answered.status, role).toBe(200)
      expect(answered.lines).toContainEqual(expect.objectContaining({ type: "text-delta", text: "mine" }))
      expect(answered.lines.at(-1)).toEqual({ type: "end" })
    }
    expect(h.requests).toEqual([])
    expect(provider.seen).toHaveLength(6)
    expect(provider.seen.every((seen) => seen.headers.get("authorization") === `Bearer ${VALUE}`)).toBe(true)
    // One model saved answers every tier: `implement` and `hard` fall back to `fast`.
    expect(provider.seen.every((seen) => seen.body.model === "gpt-test")).toBe(true)
    expect(await modelUsage()).toEqual([])
    await eventually(async () => (await usage(runtime)).every((row) => row.settled))
    expect((await usage(runtime)).map((row) => [row.role, row.inputTokens, row.outputTokens, row.outcome, row.tier])).toEqual([
      ["agent", 7, 5, "success", "fast"],
      ["coding", 7, 5, "success", "fast"],
      ["renderer", 7, 5, "success", "fast"],
      ["judge", 7, 5, "success", "fast"],
      ["review", 7, 5, "success", "fast"],
      ["plan", 7, 5, "success", "fast"],
    ])
    expect(h.starts.filter((start) => start.flow === SpendAlert.SpendAlert._tag)).toEqual([])
    expect(h.count(PersonalUsage.calls, { role: "agent", outcome: "success" })).toBe(1)
    expect(h.count(PersonalUsage.tokens, { role: "agent", type: "input" })).toBe(7)
    expect(h.count(PersonalUsage.tokens, { role: "agent", type: "output" })).toBe(5)
    expect(leaks(JSON.stringify(h.logs))).toEqual([])
  })

  test("anyone signed in, a Guest of the deployment's repository included, is answered by their own model (ruling AUTH-8)", async () => {
    for (const role of ["guest", null] as const) {
      const person = `person-stranger-${role ?? "none"}`
      await seed(runtime, person, {}, PERSONAL_KEYS)
      const provider = scriptedProvider({ text: "mine" })
      const h = await harness(runtime, deployment, { actor: { subject: { kind: "person", id: person }, role }, fetch: provider.fetch })
      const answered = await call(h)
      expect(answered.status, String(role)).toBe(200)
      expect(answered.lines).toContainEqual(expect.objectContaining({ type: "text-delta", text: "mine" }))
      // Their key paid: the deployment's model, which is on, was never asked, and nothing alerts.
      expect(h.requests).toEqual([])
      expect(provider.seen.map((seen) => seen.headers.get("authorization"))).toEqual([`Bearer ${VALUE}`])
      expect(h.starts.filter((start) => start.flow === SpendAlert.SpendAlert._tag)).toEqual([])
    }
    expect(await modelUsage()).toEqual([])
  })

  test("each role is answered by its tier's model across the person's two keys, at the role's effort", async () => {
    await seedKeys(runtime, "person-member", {
      keys: [
        { protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN, key: `${VALUE}-anthropic` },
        { protocol: "openai-chat", baseUrl: OPENAI_ORIGIN },
      ],
      models: {
        fast: { protocol: "openai-chat", modelId: "gpt-6-luna" },
        implement: { protocol: "openai-chat", modelId: "gpt-6.1-sol" },
        hard: { protocol: "anthropic-messages", modelId: "claude-hard" },
      },
    }, PERSONAL_KEYS)
    const provider = scriptedProvider({ text: "tiered" })
    const h = await harness(runtime, deployment, { actor: member, fetch: provider.fetch })
    // A turn that already used a tool since the person's message is heavy.
    const working = ModelRequest.ModelRequest.make({
      ...ask("sort these"),
      messages: [
        ModelRequest.Message.user("sort these"),
        ModelRequest.Message.assistant(ModelRequest.ToolCallPart.make({ id: "c1", name: "app/jev/classify", arguments: "{}" })),
        ModelRequest.Message.tool(ModelRequest.ToolResultPart.make({ toolCallId: "c1", content: "{}" })),
      ],
    })
    const answered = [
      await call(h, "agent"),
      await call(h, "agent", working),
      await call(h, "judge"),
      await call(h, "summary"),
      await call(h, "renderer"),
      await call(h, "coding"),
      await call(h, "review"),
      await call(h, "plan"),
    ]
    expect(answered.map((each) => each.status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200])
    expect(provider.seen.map((seen) => [new URL(seen.url).origin, seen.body.model, seen.body.reasoning_effort ?? null])).toEqual([
      [OPENAI_ORIGIN, "gpt-6-luna", null],
      [OPENAI_ORIGIN, "gpt-6-luna", "high"],
      [OPENAI_ORIGIN, "gpt-6-luna", "low"],
      [OPENAI_ORIGIN, "gpt-6-luna", "low"],
      [OPENAI_ORIGIN, "gpt-6-luna", null],
      [OPENAI_ORIGIN, "gpt-6.1-sol", null],
      [ANTHROPIC_ORIGIN, "claude-hard", null],
      [ANTHROPIC_ORIGIN, "claude-hard", null],
    ])
    expect(provider.seen.slice(6).map((seen) => seen.headers.get("x-api-key"))).toEqual([`${VALUE}-anthropic`, `${VALUE}-anthropic`])
    await eventually(async () => (await usage(runtime)).length === 8 && (await usage(runtime)).every((row) => row.settled))
    expect((await usage(runtime)).map((row) => [row.role, row.protocol, row.tier])).toEqual([
      ["agent", "openai-chat", "fast"],
      ["agent", "openai-chat", "fast"],
      ["judge", "openai-chat", "fast"],
      ["summary", "openai-chat", "fast"],
      ["renderer", "openai-chat", "fast"],
      ["coding", "openai-chat", "implement"],
      ["review", "anthropic-messages", "hard"],
      ["plan", "anthropic-messages", "hard"],
    ])
    expect(leaks(recorded(h), [VALUE, `${VALUE}-anthropic`])).toEqual([])
  })

  test("MODEL_ROLE_TIERS moves a role to another tier; a value that doesn't parse keeps the defaults, logged", async () => {
    await seedKeys(runtime, "person-member", {
      keys: [{ protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN }, { protocol: "openai-chat", baseUrl: OPENAI_ORIGIN }],
      models: { fast: { protocol: "openai-chat", modelId: "gpt-fast" }, hard: { protocol: "anthropic-messages", modelId: "claude-hard" } },
    }, PERSONAL_KEYS)
    const provider = scriptedProvider({ text: "moved" })
    const moved = await harness(runtime, deployment, {
      actor: member,
      fetch: provider.fetch,
      config: { MODEL_ROLE_TIERS: JSON.stringify({ renderer: { tier: "hard", reasoningEffort: "medium" }, unknown: { tier: "fast" } }) },
    })
    expect((await call(moved, "renderer")).status).toBe(200)
    // An unset role keeps its default.
    expect((await call(moved, "judge")).status).toBe(200)
    const broken = await harness(runtime, deployment, { actor: member, fetch: provider.fetch, config: { MODEL_ROLE_TIERS: "{\"renderer\":{\"tier\":\"strong\"}}" } })
    expect((await call(broken, "renderer")).status).toBe(200)
    // `gpt-fast` is no model known to take an effort: the judge's hint never reaches it.
    expect(provider.seen.map((seen) => [seen.body.model, seen.body.output_config ?? seen.body.reasoning_effort ?? null])).toEqual([
      ["claude-hard", null],
      ["gpt-fast", null],
      ["gpt-fast", null],
    ])
    expect(broken.line("model.endpoint").map(({ annotations }) => String(annotations.errorCode))).toEqual([
      expect.stringMatching(/^role_tiers:/),
    ])
  })

  test("a model that refuses a reasoning effort never gets the role's hint: Jev and summaries on it still answer", async () => {
    await seedKeys(runtime, "person-member", {
      keys: [{ protocol: "openai-chat", baseUrl: OPENAI_ORIGIN }],
      models: { fast: { protocol: "openai-chat", modelId: "gpt-4.1-mini" }, hard: { protocol: "openai-chat", modelId: "openai/gpt-5" } },
    }, PERSONAL_KEYS)
    // A provider that refuses any call carrying `reasoning_effort`, as a non-reasoning model does.
    const provider = scriptedProvider((_, body) =>
      "reasoning_effort" in body && body.model === "gpt-4.1-mini"
        ? { status: 400, error: { type: "invalid_request_error", message: "Unsupported parameter: 'reasoning_effort'" } }
        : { text: "answered" }
    )
    const h = await harness(runtime, deployment, {
      actor: member,
      fetch: provider.fetch,
      config: { MODEL_ROLE_TIERS: JSON.stringify({ review: { tier: "hard", reasoningEffort: "medium" } }) },
    })
    for (const role of ["judge", "summary", "review"]) {
      const answered = await call(h, role)
      expect(answered.lines, role).toContainEqual(expect.objectContaining({ type: "text-delta", text: "answered" }))
    }
    // A gateway's prefixed id of a model that takes one still gets it.
    expect(provider.seen.map((seen) => [seen.body.model, seen.body.reasoning_effort ?? null])).toEqual([
      ["gpt-4.1-mini", null],
      ["gpt-4.1-mini", null],
      ["openai/gpt-5", "medium"],
    ])
    expect(h.count(ModelTiers.effortHints, { role: "judge", outcome: "dropped" })).toBe(1)
    expect(h.count(ModelTiers.effortHints, { role: "summary", outcome: "dropped" })).toBe(1)
    expect(h.count(ModelTiers.effortHints, { role: "review", outcome: "sent" })).toBe(1)
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

  test("a refusal of one of the person's keys marks only that key", async () => {
    await seedKeys(runtime, "person-member", {
      keys: [{ protocol: "anthropic-messages", baseUrl: ANTHROPIC_ORIGIN }, { protocol: "openai-chat", baseUrl: OPENAI_ORIGIN }],
      models: { fast: { protocol: "openai-chat", modelId: "gpt-fast" }, hard: { protocol: "anthropic-messages", modelId: "claude-hard" } },
    }, PERSONAL_KEYS)
    const provider = scriptedProvider((index) => index === 0 ? { status: 401, error: { message: "bad key" } } : { text: "fine" })
    const h = await harness(runtime, deployment, { actor: member, fetch: provider.fetch })
    expect((await call(h, "review")).lines.at(-1)).toMatchObject({ type: "error", code: "authentication" })
    expect((await call(h, "agent")).lines).toContainEqual(expect.objectContaining({ type: "text-delta", text: "fine" }))
    await eventually(async () => (await rows(runtime))[0]?.failureStatus === 401)
    expect((await rows(runtime)).map((row) => [row.protocol, row.failureStatus])).toEqual([
      ["anthropic-messages", 401],
      ["openai-chat", null],
    ])
  })

  test("keys whose tiers name no model, at a host with no presets, are 409 no_route (no_model)", async () => {
    await seed(runtime, "person-member", {}, PERSONAL_KEYS)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE personal_models SET fast_model = NULL`))
    const provider = scriptedProvider({ text: "never" })
    const h = await harness(runtime, deployment, { actor: member, fetch: provider.fetch })
    const answered = await call(h)
    expect(answered.status).toBe(409)
    expect(provider.seen).toEqual([])
    expect(h.line("model.endpoint")).toEqual([
      expect.objectContaining({ annotations: expect.objectContaining({ errorCode: "own_unusable:no_model" }) }),
    ])
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
  /** A run of the person who saved a model, a Member of the deployment's own repository. */
  const memberOwns: ModelEndpoint.Owned = { personId: "person-member", deploymentPays: true }

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
      Effect.succeed(executionId === "todo:mine" ? Option.some(memberOwns) : Option.none()), starter)
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
    const summary = await seat(provider.fetch, () => Effect.succeed(Option.some(memberOwns)), undefined, "summary")
    await Effect.runPromise(Stream.runCollect(summary.model.stream(ask).pipe(inRun("todo:mine"))))
    expect(provider.seen.map((seen) => [new URL(seen.url).origin, seen.body.model])).toEqual([[OPENAI_ORIGIN, "gpt-test"]])
    await eventually(async () => (await usage(runtime)).length === 1)
    expect(await usage(runtime)).toEqual([expect.objectContaining({ role: "summary" })])
  })

  test("a run whose owner isn't a Member of the deployment's repository and saved no model is refused no_route (ruling AUTH-8)", async () => {
    const provider = scriptedProvider({ text: "the deployment's" }, globalThis.fetch, ["https://deployment.example.com"])
    const strangers: ModelEndpoint.Owned = { personId: "person-stranger", deploymentPays: false }
    const coding = await seat(provider.fetch, () => Effect.succeed(Option.some(strangers)))
    const exit = await Effect.runPromiseExit(Stream.runCollect(coding.model.stream(ask).pipe(inRun("todo:theirs"))))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ code: "no_route", httpStatus: 409 })
    // The deployment's model, which is on, is never asked for them.
    expect(provider.seen).toEqual([])
    // A Member's run with no model of their own is the deployment's to answer.
    const members = await seat(provider.fetch, () => Effect.succeed(Option.some({ personId: "person-other", deploymentPays: true })))
    const answered = await Effect.runPromise(Stream.runCollect(members.model.stream(ask).pipe(inRun("todo:theirs"))))
    expect(answered.flatMap((event) => event.type === "text-delta" ? [event.text] : [])).toEqual(["the deployment's"])
  })

  test("with hosted inference off, a run nobody owns is refused no_route and its owner's run still answers", async () => {
    await seed(runtime, "person-member")
    const provider = scriptedProvider({ text: "theirs" }, globalThis.fetch, [OPENAI_ORIGIN, "https://deployment.example.com"])
    const coding = await seat(provider.fetch, (executionId) =>
      Effect.succeed(executionId === "todo:mine" ? Option.some(memberOwns) : Option.none()), undefined, "coding", false)
    const exit = await Effect.runPromiseExit(Stream.runCollect(coding.model.stream(ask).pipe(inRun("triage:1"))))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ code: "no_route", httpStatus: 409 })
    const theirs = await Effect.runPromise(Stream.runCollect(coding.model.stream(ask).pipe(inRun("todo:mine"))))
    expect(theirs.flatMap((event) => event.type === "text-delta" ? [event.text] : [])).toEqual(["theirs"])
    expect(provider.seen.map((seen) => new URL(seen.url).origin)).toEqual([OPENAI_ORIGIN])
  })

  test("its committer's refused key fails the run's call at once, and an owner lookup Postgres refuses fails it too", async () => {
    await seed(runtime, "person-member")
    const provider = scriptedProvider({ status: 401, error: { message: `bad key ${VALUE}` } })
    const coding = await seat(provider.fetch, () => Effect.succeed(Option.some(memberOwns)))
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
      Effect.flatMap(Effect.service(PersonalModels), (models) => models.open("person-member", "fast")).pipe(
        Effect.provide(PersonalModels.layer(unreachable).pipe(Layer.provide(SecretKeys.layer(KEY)))),
      ),
    )
    expect(JSON.stringify(exit)).toContain("@smthrs/mvp/personal/PersonalModelsUnavailable")
    expect(JSON.stringify(exit)).toContain('"errorCode":"sql:')
  })

  test("nobody's model: PersonalModels.none opens nothing", async () => {
    expect(await Effect.runPromise(Effect.flatMap(Effect.service(PersonalModels), (models) => models.open("x", "hard")).pipe(Effect.provide(PersonalModels.none))))
      .toEqual(Option.none())
    expect(new PersonalModelUnusable({ reason: "key", host: "h" }).reason).toBe("key")
  })

  test("a ledger write Postgres refuses at the end is never raised into the answer", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const exit = await Effect.runPromiseExit(
      PersonalUsage.end(
        { invocationId: "i", requestId: "i", personId: "p", role: "agent", modelId: "m", host: "h", protocol: "openai-chat" as const, tier: "fast" as const },
        { outcome: "success", usage: {} },
        unreachable,
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("a slow call on a key since replaced says nothing of the new key", async () => {
    const database = (await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database
    await seed(runtime, "person-member")
    const call = {
      invocationId: crypto.randomUUID(),
      requestId: "r",
      personId: "person-member",
      role: "agent",
      modelId: "m",
      host: "h",
      protocol: "openai-chat" as const,
      tier: "fast" as const,
    }
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
    const call = {
      invocationId: crypto.randomUUID(),
      requestId: "r",
      personId: "person-member",
      role: "agent",
      modelId: "m",
      host: "h",
      protocol: "openai-chat" as const,
      tier: "fast" as const,
    }
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
