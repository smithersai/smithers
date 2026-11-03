// A person's ordered list of connections (decision 0132, docs/features/personal-model.md) end to end in the Worker: which
// connection answers a tier, Moonshot's defaults, the rules of each kind, a subscription-only person, the Codex device
// link with `model/CodexLink` on the Node host's engine, keeping a Codex token fresh, and the person's own Jev. Postgres
// and Electric are the compose ones; every provider, OpenAI's auth server and Vercel's gateway are scripted at the network
// through `FetchHttpClient.Fetch`. Every credential is searched for in what was stored and recorded.
import { Action } from "@smthrs/flow"
import { Classifier, type ModelEvent, ModelRequest } from "@smthrs/model"
import { ConfigProvider, Deferred, Effect, Exit, Layer, Option, Redacted, Schema, Stream, Tracer } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import {
  CODEX_LINK_ROUTE,
  DEFAULTS,
  JEV_ROUTE,
  LINK_SECONDS,
  MAX_JEV_BODY_BYTES,
  PERSONAL_MODEL_ROUTE,
  PERSONAL_MODEL_TEST_ROUTE,
} from "../../src/features/personal-model/contract.ts"
import * as Flows from "../Flows.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import { harness, PERSONAL_KEYS, testFile } from "../test/harness.ts"
import * as Agents from "./Agents.ts"
import * as PersonalApi from "./Api.ts"
import * as Codex from "./Codex.ts"
import * as ModelFlows from "./ModelFlows.ts"
import { PersonalModels, sealContext } from "./Models.ts"
import * as Store from "./Store.ts"
import * as Subscriptions from "./Subscriptions.ts"
import {
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
  rows,
  seed,
  seedKeys,
  usage,
  VALUE,
} from "./test/harness.ts"
import {
  ANTHROPIC_ORIGIN,
  CODEX_ACCESS,
  CODEX_AUTH_ORIGIN,
  CODEX_REFRESH,
  idToken,
  OPENAI_ORIGIN,
  scriptedGateway,
  scriptedOpenAi,
  scriptedProvider,
} from "./test/provider.ts"

const runtime = testFile("personal_connections")

/** OpenAI's auth server for a step or refresh run alone, as `model/CodexLink`'s host captures it. */
const codexAuth = Layer.effect(Codex.CodexAuth, Codex.config)

/** The network `model/CodexLink`'s steps reach: each test scripts its own. */
let network: typeof globalThis.fetch = globalThis.fetch
let host: Awaited<ReturnType<typeof engine>>
beforeAll(async () => {
  host = await engine(runtime, { fetch: (input, init) => network(input, init), config: { CODEX_AUTH_ORIGIN } })
})
afterAll(() => host.close())
beforeEach(async () => {
  network = globalThis.fetch
  await resetModels(runtime)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE model_usage, model_budget_days`))
})

const scratch = () => runtime.runPromise(Effect.service(TestDatabase.Scratch))

const open = (options: Parameters<typeof personalHarness>[2] = {}) =>
  personalHarness(runtime, host.starter, { ...options, config: { CODEX_AUTH_ORIGIN, ...options.config } })

const put = (connections: ReadonlyArray<unknown>): RequestInit => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ connections }),
})

const json = async (response: Response) => [response.status, await response.json()] as const

/** The stored and journalled text and everything recorded, searched for `values`. */
const nothingLeaked = async (h: { readonly recorded: () => string }, values: ReadonlyArray<string>) => {
  expect(leaks(await dump(runtime, (await scratch()).name), values)).toEqual([])
  expect(leaks(await dump(runtime, host.schema), values)).toEqual([])
  expect(leaks(h.recorded(), values)).toEqual([])
}

/** A token a Claude subscription keeps. */
const CLAUDE_TOKEN = "sk-ant-oat01-SENTINEL-claude"
/** A key Jev is served with. */
const JEV_KEY = "vck_SENTINEL-jev-key-0123"

const model = (protocol: "openai-chat" | "anthropic-messages", models: Record<string, string>, active = true) => ({
  protocol,
  baseUrl: protocol === "openai-chat" ? OPENAI_ORIGIN : ANTHROPIC_ORIGIN,
  models,
  active,
})

const ask = ModelRequest.ModelRequest.make({
  modelId: "browser-choice",
  system: [],
  messages: [ModelRequest.Message.user("hi")],
  tools: [],
  params: ModelRequest.GenerationParams.make({ maxTokens: 64 }),
})
const deployment = () =>
  Stream.make<Array<ModelEvent.ModelEvent>>(
    { type: "text-delta", id: "t", text: "the deployment's" },
    { type: "usage", inputTokens: 1, outputTokens: 1 },
    { type: "settle", stopReason: "stop" },
  )
/** One call of the model endpoint's `role`, as an agent's seat makes it. */
const chat = async (h: Awaited<ReturnType<typeof harness>>, role = "agent") => {
  const response = await h.fetch(`/api/model/${role}`, {
    method: "POST",
    body: JSON.stringify(Schema.encodeSync(ModelRequest.ModelRequest)(ask)),
  })
  const text = await response.text()
  return { status: response.status, text }
}

describe("which connection answers a tier", () => {
  test("the first active connection naming the tier wins, whatever comes after it", async () => {
    await seedKeys(runtime, "person-member", [
      model("anthropic-messages", { fast: "claude-first" }),
      model("openai-chat", { fast: "gpt-second", hard: "gpt-hard" }),
    ], PERSONAL_KEYS)
    const provider = scriptedProvider({ text: "tiered" })
    const h = await harness(runtime, deployment, { actor: member, fetch: provider.fetch })
    await chat(h, "agent")
    await chat(h, "review")
    expect(provider.seen.map((seen) => [new URL(seen.url).origin, seen.body.model])).toEqual([
      [ANTHROPIC_ORIGIN, "claude-first"],
      [OPENAI_ORIGIN, "gpt-hard"],
    ])
  })

  test("an inactive connection is skipped, and the ledger names the connection that answered", async () => {
    const [skipped, answered] = await seedKeys(runtime, "person-member", [
      model("anthropic-messages", { fast: "claude-first" }, false),
      model("openai-chat", { fast: "gpt-second" }),
    ], PERSONAL_KEYS)
    const provider = scriptedProvider({ text: "second" })
    const h = await harness(runtime, deployment, { actor: member, fetch: provider.fetch })
    expect((await chat(h)).status).toBe(200)
    expect(provider.seen.map((seen) => seen.body.model)).toEqual(["gpt-second"])
    expect((await usage(runtime)).map((row) => row.connectionId)).toEqual([answered])
    expect(answered).not.toBe(skipped)
  })

  test("a save that reorders the list changes the answer and keeps both keys sealed as they were", async () => {
    await seedKeys(runtime, "person-member", [
      model("anthropic-messages", { fast: "claude-first" }),
      model("openai-chat", { fast: "gpt-second" }),
    ])
    const before = await rows(runtime)
    const provider = scriptedProvider({ text: "ok" })
    const personalModels = PersonalModels.layer((await scratch()).database).pipe(Layer.provide(SecretKeys.layer(KEY)))
    const h = await harness(runtime, deployment, { actor: member, fetch: provider.fetch, personalModels })
    await chat(h)
    const saves = await open({ actor: member })
    const [first, second] = before
    expect((await saves.fetch(PERSONAL_MODEL_ROUTE, put([
      { id: second!.id, kind: "api_key", protocol: second!.protocol, baseUrl: second!.baseUrl, models: { fast: "gpt-second" } },
      { id: first!.id, kind: "api_key", protocol: first!.protocol, baseUrl: first!.baseUrl, models: { fast: "claude-first" } },
    ]))).status).toBe(202)
    await chat(h)
    expect(provider.seen.map((seen) => seen.body.model)).toEqual(["claude-first", "gpt-second"])
    expect((await rows(runtime)).map((row) => [row.id, row.position, row.ciphertext])).toEqual([
      [second!.id, 0, second!.ciphertext],
      [first!.id, 1, first!.ciphertext],
    ])
  })

  test("a tier nobody named takes the next tier's model, past the connection that doesn't name it", async () => {
    await seedKeys(runtime, "person-member", [
      model("anthropic-messages", { hard: "claude-hard" }),
      model("openai-chat", { implement: "gpt-implement" }),
    ], PERSONAL_KEYS)
    const provider = scriptedProvider({ text: "ok" })
    const h = await harness(runtime, deployment, { actor: member, fetch: provider.fetch })
    await chat(h, "agent")
    expect(provider.seen.map((seen) => seen.body.model)).toEqual(["gpt-implement"])
    expect((await usage(runtime)).map((row) => row.tier)).toEqual(["implement"])
  })
})

describe("a moonshot connection", () => {
  const MOONSHOT = "https://moonshot.example.com"
  const config = { MOONSHOT_BASE_URL: `${MOONSHOT}/v1` }

  test("takes its endpoint from MOONSHOT_BASE_URL and Kimi K3 for every tier, and its calls reach that origin", async () => {
    const provider = scriptedProvider({ text: "ok" }, globalThis.fetch, [MOONSHOT])
    const h = await open({ actor: member, provider: provider.fetch, config })
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put([{ kind: "moonshot", key: VALUE }])))).toEqual([202, {}])
    expect(await rows(runtime)).toEqual([expect.objectContaining({
      kind: "moonshot",
      protocol: "openai-chat",
      baseUrl: MOONSHOT,
      fastModel: "kimi-k3",
      implementModel: "kimi-k3",
      hardModel: "kimi-k3",
    })])
    expect((await json(await h.fetch(PERSONAL_MODEL_TEST_ROUTE, { method: "POST" })))[1]).toMatchObject({ ok: true })
    expect(provider.seen.map((seen) => [seen.url, seen.body.model, seen.headers.get("authorization")])).toEqual([
      [`${MOONSHOT}/v1/chat/completions`, "kimi-k3", `Bearer ${VALUE}`],
    ])
    await nothingLeaked(h, [VALUE])
  })

  test("MOONSHOT_MODEL replaces the default, a model the person names stays, and with nothing set it is Moonshot's own", async () => {
    const h = await open({ actor: member, config: { ...config, MOONSHOT_MODEL: "kimi-k9" } })
    await h.fetch(PERSONAL_MODEL_ROUTE, put([{ kind: "moonshot", key: VALUE, models: { hard: "kimi-max" } }]))
    expect((await rows(runtime)).map((row) => [row.fastModel, row.implementModel, row.hardModel])).toEqual([
      ["kimi-k9", "kimi-k9", "kimi-max"],
    ])
    const unset = await open({ actor: member })
    await unset.fetch(PERSONAL_MODEL_ROUTE, put([{ kind: "moonshot", key: VALUE }]))
    expect((await rows(runtime)).map((row) => [row.baseUrl, row.fastModel])).toEqual([
      [DEFAULTS.moonshot.baseUrl, DEFAULTS.moonshot.modelId],
    ])
  })

  test("a key is kept at the same endpoint, and must be typed again when the deployment moves it", async () => {
    const h = await open({ actor: member, config })
    await h.fetch(PERSONAL_MODEL_ROUTE, put([{ kind: "moonshot", key: VALUE }]))
    const [saved] = await rows(runtime)
    expect((await h.fetch(PERSONAL_MODEL_ROUTE, put([{ id: saved!.id, kind: "moonshot" }]))).status).toBe(202)
    const moved = await open({ actor: member, config: { MOONSHOT_BASE_URL: "https://moved.example.com" } })
    expect(await json(await moved.fetch(PERSONAL_MODEL_ROUTE, put([{ id: saved!.id, kind: "moonshot" }])))).toEqual([
      400,
      { code: "key_required" },
    ])
    expect((await rows(runtime))[0]!.ciphertext).toBe(saved!.ciphertext)
  })

  test("a moonshot connection never takes a protocol it didn't choose: an api_key's field does not move it", async () => {
    const h = await open({ actor: member, config })
    await h.fetch(PERSONAL_MODEL_ROUTE, put([{ kind: "moonshot", key: VALUE, baseUrl: "https://elsewhere.example.com" }]))
    expect((await rows(runtime))[0]!.baseUrl).toBe(MOONSHOT)
  })
})

describe("the rules of each kind", () => {
  const claude = { kind: "claude_subscription", key: CLAUDE_TOKEN }

  test("a Claude token that doesn't start as `claude setup-token` prints is invalid_token, and nothing is written", async () => {
    const h = await open({ actor: member })
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put([{ ...claude, key: `sk-ant-api03-${VALUE}` }]))))
      .toEqual([400, { code: "invalid_token" }])
    expect(await rows(runtime)).toEqual([])
    expect(leaks(h.recorded())).toEqual([])
  })

  test("a list of one subscription saves: no protocol, no model, its credential sealed", async () => {
    const h = await open({ actor: member })
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put([claude])))).toEqual([202, {}])
    expect(await rows(runtime)).toEqual([expect.objectContaining({
      kind: "claude_subscription",
      protocol: null,
      baseUrl: null,
      fastModel: null,
      keyLast4: "aude",
    })])
    expect(h.line("personal_model.request").at(-1)).toMatchObject({
      annotations: { connections: 1, kinds: "claude_subscription", outcome: "putting" },
    })
    await nothingLeaked(h, [CLAUDE_TOKEN])
  })

  test("a Claude subscription may keep a base URL, kept with it and moved only with the token", async () => {
    const h = await open({ actor: member })
    await h.fetch(PERSONAL_MODEL_ROUTE, put([{ ...claude, baseUrl: `${ANTHROPIC_ORIGIN}/v1` }]))
    const [saved] = await rows(runtime)
    expect(saved).toMatchObject({ baseUrl: ANTHROPIC_ORIGIN })
    expect((await h.fetch(PERSONAL_MODEL_ROUTE, put([{ id: saved!.id, kind: claude.kind, baseUrl: ANTHROPIC_ORIGIN }]))).status)
      .toBe(202)
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put([{ id: saved!.id, kind: claude.kind }]))))
      .toEqual([400, { code: "key_required" }])
  })

  test("a person keeps at most one active of a single kind, however many inactive", async () => {
    const h = await open({ actor: member })
    const twice = async (first: Record<string, unknown>, second = first) => [
      await json(await h.fetch(PERSONAL_MODEL_ROUTE, put([first, second]))),
      await json(await h.fetch(PERSONAL_MODEL_ROUTE, put([first, { ...second, active: false }]))),
    ]
    expect(await twice(claude)).toEqual([[400, { code: "invalid" }], [202, {}]])
    const jev = { kind: "jev", key: JEV_KEY }
    expect(await twice(jev)).toEqual([[400, { code: "invalid" }], [202, {}]])
    expect((await rows(runtime)).map((row) => [row.kind, row.active])).toEqual([["jev", true], ["jev", false]])
  })

  test("a save swaps which of two subscriptions is active, in one write the unique index never sees both", async () => {
    await seedKeys(runtime, "person-member", [
      { kind: "claude_subscription", key: CLAUDE_TOKEN },
      { kind: "claude_subscription", key: CLAUDE_TOKEN, active: false },
    ])
    const [first, second] = await rows(runtime)
    const h = await open({ actor: member })
    expect((await h.fetch(PERSONAL_MODEL_ROUTE, put([
      { id: first!.id, kind: claude.kind, active: false },
      { id: second!.id, kind: claude.kind, active: true },
    ]))).status).toBe(202)
    expect((await rows(runtime)).map((row) => row.active)).toEqual([false, true])
    expect((await events(runtime)).map((event) => event.action)).toEqual(["set", "replace"])
  })

  test("the database itself refuses a second active subscription, and a model wire on a subscription", async () => {
    await seedKeys(runtime, "person-member", [{ kind: "jev", key: JEV_KEY }])
    const refused = (statement: string) =>
      runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(
        Effect.as("written"),
        Effect.orElseSucceed(() => "refused"),
      ))
    const row = (kind: string, protocol: string) => `
      INSERT INTO personal_models (person_id, id, kind, position, active, protocol, ciphertext, nonce, key_version, key_last4)
      VALUES ('person-member', gen_random_uuid(), '${kind}', 1, true, ${protocol}, 'c', 'n', 1, 'abcd')`
    expect(await refused(row("jev", "NULL"))).toBe("refused")
    expect(await refused(row("claude_subscription", "'openai-chat'"))).toBe("refused")
    expect(await refused(row("api_key", "NULL"))).toBe("refused")
    expect(await refused(row("codex_subscription", "NULL"))).toBe("written")
  })

  test("each kind refuses the fields it has no use for, by their code", async () => {
    const h = await open({ actor: member })
    const refusal = async (connection: Record<string, unknown>) =>
      (await json(await h.fetch(PERSONAL_MODEL_ROUTE, put([connection]))))[1]
    expect(await refusal({ ...claude, protocol: "openai-chat" })).toEqual({ code: "invalid_protocol" })
    expect(await refusal({ ...claude, models: { fast: "m" } })).toEqual({ code: "invalid" })
    expect(await refusal({ kind: "jev", key: JEV_KEY, baseUrl: OPENAI_ORIGIN })).toEqual({ code: "invalid_base_url" })
    expect(await refusal({ kind: "jev", key: JEV_KEY, models: { fast: "m" } })).toEqual({ code: "invalid" })
    expect(await refusal({ kind: "jev", key: JEV_KEY, protocol: "openai-chat" })).toEqual({ code: "invalid_protocol" })
    expect(await refusal({ kind: "codex_subscription", key: VALUE })).toEqual({ code: "invalid" })
    expect(await refusal({ kind: "codex_subscription", baseUrl: OPENAI_ORIGIN })).toEqual({ code: "invalid" })
    // A Codex credential only ever comes from its link: a save can't start one.
    expect(await refusal({ kind: "codex_subscription" })).toEqual({ code: "key_required" })
    expect(await refusal({ kind: "claude_subscription" })).toEqual({ code: "key_required" })
    expect(await refusal({ kind: "api_key", baseUrl: OPENAI_ORIGIN, key: VALUE })).toEqual({ code: "invalid_protocol" })
    expect(await refusal({ kind: "api_key", protocol: "openai-chat", key: VALUE })).toEqual({ code: "invalid_base_url" })
    expect(await rows(runtime)).toEqual([])
  })

  test("an id that isn't one is refused at once, never left for a flow to retry against Postgres", async () => {
    const h = await open({ actor: member })
    const sent = { id: "not-a-uuid", kind: "api_key", protocol: "openai-chat", baseUrl: OPENAI_ORIGIN, key: VALUE }
    expect(await json(await h.fetch(PERSONAL_MODEL_ROUTE, put([sent])))).toEqual([400, { code: "invalid" }])
    // An empty id is a new connection.
    expect((await h.fetch(PERSONAL_MODEL_ROUTE, put([{ ...sent, id: "" }]))).status).toBe(202)
    expect(await rows(runtime)).toHaveLength(1)
  })

  test("a list of many kinds saves in its order, and DELETE removes all of it", async () => {
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription" }])
    const h = await open({ actor: member })
    const [codex] = await rows(runtime)
    expect((await h.fetch(PERSONAL_MODEL_ROUTE, put([
      { kind: "jev", key: JEV_KEY },
      { id: codex!.id, kind: "codex_subscription" },
      claude,
      { kind: "api_key", protocol: "openai-chat", baseUrl: OPENAI_ORIGIN, key: VALUE, active: false },
    ]))).status).toBe(202)
    expect((await rows(runtime)).map((row) => [row.kind, row.position, row.active])).toEqual([
      ["jev", 0, true],
      ["codex_subscription", 1, true],
      ["claude_subscription", 2, true],
      ["api_key", 3, false],
    ])
    expect((await h.fetch(PERSONAL_MODEL_ROUTE, { method: "DELETE" })).status).toBe(202)
    expect(await rows(runtime)).toEqual([])
  })
})

describe("a person with no model connection", () => {
  const subscribed = (key = PERSONAL_KEYS) =>
    seedKeys(runtime, "person-guest", [{ kind: "claude_subscription", key: CLAUDE_TOKEN }], key)

  test("chat answers no_route, not a provider call, when the deployment doesn't answer them either", async () => {
    await subscribed()
    const provider = scriptedProvider({ text: "never" })
    const h = await harness(runtime, deployment, { actor: guest, fetch: provider.fetch })
    const answered = await chat(h)
    expect(answered.status).toBe(409)
    expect(JSON.parse(answered.text)).toMatchObject({ code: "no_route", message: "Add your model in Settings to ask Smithers." })
    expect(provider.seen).toEqual([])
    expect(h.requests).toEqual([])
    expect(await usage(runtime)).toEqual([])
  })

  test("with hosted inference off a Member's subscription answers no_route too; on, the deployment answers them", async () => {
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription" }, { kind: "jev", key: JEV_KEY }], PERSONAL_KEYS)
    const provider = scriptedProvider({ text: "never" })
    const off = await harness(runtime, deployment, { actor: member, fetch: provider.fetch, config: { HOSTED_MODEL_ENABLED: "false" } })
    expect((await chat(off)).status).toBe(409)
    expect(off.line("model.endpoint").map(({ annotations }) => annotations.errorCode)).toEqual(["hosted_off"])
    const on = await harness(runtime, deployment, { actor: member, fetch: provider.fetch })
    expect((await chat(on)).text).toContain("the deployment's")
    expect(provider.seen).toEqual([])
  })

  test("a model connection that is off doesn't count: nothing is unusable, they just have no model", async () => {
    await seedKeys(runtime, "person-member", [model("openai-chat", {}, false)], PERSONAL_KEYS)
    const h = await harness(runtime, deployment, { actor: member, config: { HOSTED_MODEL_ENABLED: "false" } })
    expect((await chat(h)).status).toBe(409)
    expect(h.line("model.endpoint").map(({ annotations }) => annotations.errorCode)).toEqual(["hosted_off"])
  })

  test("an active model connection no tier resolves to is no_route, naming its own host, past a subscription's", async () => {
    await seedKeys(runtime, "person-member", [
      { kind: "claude_subscription", key: CLAUDE_TOKEN, baseUrl: ANTHROPIC_ORIGIN },
      model("openai-chat", {}),
    ], PERSONAL_KEYS)
    const exit = await runtime.runPromiseExit(
      Effect.flatMap(Effect.service(PersonalModels), (models) => models.open("person-member", "fast")).pipe(
        Effect.provide(PersonalModels.layer((await scratch()).database).pipe(Layer.provide(SecretKeys.layer(PERSONAL_KEYS)))),
      ),
    )
    expect(JSON.stringify(exit)).toContain('"reason":"no_model"')
    expect(JSON.stringify(exit)).toContain('"host":"models.example.com"')
  })
})

describe("Check Access by connection", () => {
  const check = (h: { readonly fetch: (path: string, init?: RequestInit) => Promise<Response> }, id?: string) =>
    h.fetch(`${PERSONAL_MODEL_TEST_ROUTE}${id === undefined ? "" : `?connection=${id}`}`, { method: "POST" }).then(json)

  test("one connection by id, even inactive; another's or none is 404", async () => {
    const [off] = await seedKeys(runtime, "person-member", [model("openai-chat", { fast: "gpt-off" }, false)])
    const [theirs] = await seedKeys(runtime, "person-admin", [model("openai-chat", { fast: "gpt-theirs" })])
    const provider = scriptedProvider({ text: "ok" })
    const h = await open({ actor: member, provider: provider.fetch })
    expect((await check(h, off))[1]).toMatchObject({ ok: true })
    expect(provider.seen.map((seen) => seen.body.model)).toEqual(["gpt-off"])
    // With no id only active connections are tried: this person has none.
    expect(await check(h)).toEqual([404, { code: "none" }])
    expect(await check(h, theirs)).toEqual([404, { code: "none" }])
  })

  test("a connection whose every tier is empty is unusable: nothing to call", async () => {
    await seedKeys(runtime, "person-member", [model("openai-chat", {})])
    const provider = scriptedProvider({ text: "never" })
    expect((await check(await open({ actor: member, provider: provider.fetch })))[1]).toMatchObject({
      ok: false,
      code: "unusable",
      host: "models.example.com",
    })
    expect(provider.seen).toEqual([])
  })

  test("a Claude subscription can't be checked here: alone it is nothing to check; by id it says so", async () => {
    const [claude] = await seedKeys(runtime, "person-member", [{ kind: "claude_subscription", key: CLAUDE_TOKEN }])
    const h = await open({ actor: member })
    expect(await check(h)).toEqual([404, { code: "none" }])
    expect((await check(h, claude))[1]).toEqual({ ok: false, latencyMs: expect.any(Number), code: "unchecked", status: null, host: "" })
  })

  test("a list checks each active connection that can be, stopping at the first that fails", async () => {
    const credential = JSON.stringify(credentialOf({ expiresAt: Date.now() + Codex.FRESH_FOR_MS * 2 }))
    await seedKeys(runtime, "person-member", [
      { kind: "claude_subscription", key: CLAUDE_TOKEN },
      model("openai-chat", { fast: "gpt-first" }),
      { kind: "codex_subscription", key: credential },
      { kind: "jev", key: JEV_KEY },
    ])
    const openai = scriptedOpenAi((path) => path === "/oauth/token" ? { status: 401, body: {} } : undefined)
    const gateway = scriptedGateway(() => ({ status: 200, body: { answers: { ok: { type: "boolean", probability: 1 } } } }))
    const provider = scriptedProvider({ text: "ok" }, (input, init) => openai.fetch(input, init))
    const refused = await check(await open({ actor: member, provider: provider.fetch }))
    expect(refused[1]).toMatchObject({ ok: false, code: "refused", status: 401, host: "auth.openai.com" })
    expect(provider.seen).toHaveLength(1)
    expect(gateway.seen).toEqual([])
  })

  test("the keys off: a subscription or a Jev can't be opened, unusable, and nothing is sent", async () => {
    const [jev, codex] = await seedKeys(runtime, "person-member", [{ kind: "jev", key: JEV_KEY }, { kind: "codex_subscription" }])
    const h = await open({ actor: member, keys: false })
    for (const id of [jev, codex]) {
      expect((await check(h, id))[1]).toEqual({ ok: false, latencyMs: expect.any(Number), code: "unusable", status: null, host: "" })
    }
  })
})

/** A credential as a link seals it. */
const credentialOf = (overrides: Partial<Codex.Credential> = {}): Codex.Credential => ({
  accessToken: `${CODEX_ACCESS}-1`,
  refreshToken: `${CODEX_REFRESH}-1`,
  idToken: idToken({ accountId: "acct-1234", planType: "plus" }),
  accountId: "acct-1234",
  planType: "plus",
  expiresAt: Date.now() + 8 * 24 * 60 * 60 * 1000,
  ...overrides,
})

const keysOf = async (secret = KEY) =>
  Option.getOrThrow(await Effect.runPromise(Effect.service(SecretKeys).pipe(Effect.provide(SecretKeys.layer(secret)))))

/** What `row` keeps, opened under `KEY`, as a credential. */
const credentialIn = async (row: Awaited<ReturnType<typeof rows>>[number]) =>
  JSON.parse(Redacted.value(
    await Effect.runPromise((await keysOf()).cipher.open(row, sealContext(row.personId, row.keyVersion))),
  )) as Codex.Credential

describe("POST /api/me/model/codex", () => {
  const link = (h: { readonly fetch: (path: string, init?: RequestInit) => Promise<Response> }) =>
    h.fetch(CODEX_LINK_ROUTE, { method: "POST" })

  const approved = (index: number) => ({
    status: 200,
    body: { authorization_code: `code-${index}`, code_verifier: "SENTINEL-codex-verifier" },
  })
  const tokens = {
    status: 200,
    body: {
      access_token: `${CODEX_ACCESS}-1`,
      refresh_token: `${CODEX_REFRESH}-1`,
      id_token: idToken({ accountId: "acct-1234", planType: "pro" }),
      expires_in: 3600,
    },
  }
  /** OpenAI where the person approved on `pollsBefore + 1`th poll. */
  const approving = (pollsBefore = 0) =>
    scriptedOpenAi((path, index) =>
      path === "/api/accounts/deviceauth/token"
        ? index < pollsBefore ? { status: index % 2 === 0 ? 403 : 404 } : approved(index)
        : path === "/oauth/token"
        ? tokens
        : undefined
    )

  test.each([false, true, "individual"] as const)("deleting connections while an approved Codex link waits to store cannot restore a credential (existing: %s)", async (existing) => {
    const kept = existing ? await seedKeys(runtime, "person-member", [
      model("openai-chat", { fast: "gpt-test" }),
      ...(existing === "individual" ? [{ kind: "codex_subscription" as const, key: JSON.stringify(credentialOf()), active: false }] : []),
    ]) : []
    const openai = approving()
    const storing = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const client = await runtime.runPromise(Effect.service(SqlClient.SqlClient))
    // Delay only the actual Keep step's database service, after the real Poll step has approved and sealed.
    const database = Layer.effect(SqlClient.SqlClient, Effect.gen(function* () {
      yield* Deferred.succeed(storing, undefined)
      yield* Deferred.await(release)
      return client
    }))
    const delayed = await engine(runtime, { database, fetch: openai.fetch, config: { CODEX_AUTH_ORIGIN } })
    const h = await open({ actor: member, provider: openai.fetch, starter: delayed.starter })
    const linking = link(h)
    try {
      await Effect.runPromise(Deferred.await(storing))
      expect(openai.seen.map((seen) => seen.path)).toContain("/oauth/token")
      const normal = await open({ actor: member })
      expect((await normal.fetch(PERSONAL_MODEL_ROUTE, existing === "individual"
        ? put([{ kind: "api_key", id: kept[0], ...model("openai-chat", { fast: "gpt-test" }) }]) : { method: "DELETE" })).status).toBe(202)
      await Effect.runPromise(Deferred.succeed(release, undefined))
      expect((await linking).status).toBe(202)
      expect((await rows(runtime)).map(({ kind, active }) => ({ kind, active }))).toEqual(
        existing === "individual" ? [{ kind: "api_key", active: true }] : [])
      expect(JSON.stringify(delayed.exits)).toContain('"change":"stale"')
      expect((await events(runtime)).map((event) => event.action)).toEqual([...(existing ? ["set"] : []), ...(existing === "individual" ? ["replace"] : ["delete"])])
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await linking
      await delayed.close()
    }
  })

  test("answers the code, polls once the person approves, and seals a credential at the end of their list", async () => {
    await seedKeys(runtime, "person-member", [model("openai-chat", { fast: "gpt-test" })])
    const openai = approving()
    network = openai.fetch
    const h = await open({ actor: member, provider: openai.fetch })
    const answered = await link(h)
    expect(answered.headers.get("cache-control")).toBe("no-store")
    expect(await json(answered)).toEqual([202, {
      userCode: "ABCD-EFGH",
      verificationUrl: `${CODEX_AUTH_ORIGIN}/codex/device`,
      expiresInSeconds: LINK_SECONDS,
    }])
    expect(openai.seen.map((seen) => seen.path)).toEqual([
      "/api/accounts/deviceauth/usercode",
      "/api/accounts/deviceauth/token",
      "/oauth/token",
    ])
    expect(openai.seen[0]!.body).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" })
    expect(openai.seen[1]!.body).toEqual({ device_auth_id: "device-1", user_code: "ABCD-EFGH" })
    expect(openai.seen[2]!.body).toEqual({
      grant_type: "authorization_code",
      code: "code-0",
      redirect_uri: `${CODEX_AUTH_ORIGIN}/deviceauth/callback`,
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code_verifier: "SENTINEL-codex-verifier",
    })
    const [, row] = await rows(runtime)
    expect(row).toMatchObject({ kind: "codex_subscription", position: 1, active: true, protocol: null, baseUrl: null, keyLast4: "1234" })
    expect(await credentialIn(row!)).toMatchObject({
      accessToken: `${CODEX_ACCESS}-1`,
      refreshToken: `${CODEX_REFRESH}-1`,
      accountId: "acct-1234",
      planType: "pro",
      expiresAt: expect.any(Number),
    })
    expect(h.line("personal_model.request").at(-1)).toMatchObject({ annotations: { op: "link", outcome: "linking", status: 202 } })
    expect(h.count(PersonalApi.requests, { op: "link", outcome: "linking" })).toBe(1)
    await nothingLeaked(h, [CODEX_ACCESS, CODEX_REFRESH, "SENTINEL-codex-verifier", "SENTINEL-codex-id-signature", "ABCD-EFGH", "device-1"])
  })

  test("pending polls wait on the code's own clock: OpenAI's 403 and 404 aren't a refusal", { timeout: 30_000 }, async () => {
    const openai = approving(1)
    network = openai.fetch
    const h = await open({ actor: member, provider: openai.fetch })
    expect((await link(h)).status).toBe(202)
    expect(openai.seen.filter((seen) => seen.path.endsWith("/deviceauth/token"))).toHaveLength(2)
    expect((await rows(runtime)).map((row) => row.kind)).toEqual(["codex_subscription"])
  })

  test("the poll's answers one by one: pending, refused and unreachable", async () => {
    const database = (await scratch()).database
    const keys = await keysOf()
    const sealed = await Effect.runPromise(keys.cipher.seal(
      Redacted.make(JSON.stringify({ deviceAuthId: "device-1", userCode: "ABCD" })),
      { id: "person:person-member", name: "model-link", version: keys.version },
    ))
    const payload = { personId: "person-member", id: crypto.randomUUID(), ...sealed, keyVersion: keys.version }
    const step = (fetch: typeof globalThis.fetch, write: typeof payload = payload, keyed = SecretKeys.layer(KEY)) =>
      Effect.runPromiseExit(ModelFlows.pollStep(write).pipe(
        Effect.provide(keyed),
        Effect.provideService(Action.CurrentInvocationKey, crypto.randomUUID()),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(codexAuth),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ CODEX_AUTH_ORIGIN })),
      ) as Effect.Effect<unknown, unknown>)
    const failed = (exit: Exit.Exit<unknown, unknown>) => JSON.stringify(exit)
    expect(failed(await step(scriptedOpenAi(() => ({ status: 403 })).fetch))).toContain("LinkPending")
    expect(failed(await step(scriptedOpenAi(() => ({ status: 404 })).fetch))).toContain("LinkPending")
    expect(failed(await step(() => Promise.reject(new Error("no route"))))).toContain("LinkPending")
    expect(failed(await step(scriptedOpenAi(() => ({ status: 500 })).fetch))).toContain('"status":500')
    // Approved, but an answer that doesn't read, a code OpenAI won't exchange, or tokens with nothing to refresh with.
    expect(failed(await step(scriptedOpenAi(() => "not json").fetch))).toContain('"status":200')
    expect(failed(await step(scriptedOpenAi((path, index) => path.endsWith("/token") && !path.startsWith("/oauth") ? approved(index) : { status: 400 }).fetch)))
      .toContain('"status":400')
    const noRefresh = scriptedOpenAi((path, index) =>
      path === "/oauth/token" ? { status: 200, body: { access_token: "a" } } : approved(index)
    )
    expect(failed(await step(noRefresh.fetch))).toContain("LinkRefused")
    // What the route sealed doesn't open, or doesn't read, or the keys are off.
    const never = scriptedOpenAi(() => approved(0))
    expect(failed(await step(never.fetch, { ...payload, ciphertext: `AAAA${payload.ciphertext.slice(4)}` }))).toContain("LinkRefused")
    const garbled = await Effect.runPromise(keys.cipher.seal(
      Redacted.make("not json"),
      { id: "person:person-member", name: "model-link", version: keys.version },
    ))
    expect(failed(await step(never.fetch, { ...payload, ...garbled }))).toContain("LinkRefused")
    expect(failed(await step(never.fetch, payload, SecretKeys.off))).toContain("LinkRefused")
    expect(never.seen).toEqual([])
    expect(await rows(runtime)).toEqual([])
  })

  test("a refusal ends the link at once: no more polling, no row, and the person starts again", async () => {
    const openai = scriptedOpenAi((path) => path.endsWith("/deviceauth/token") ? { status: 500 } : undefined)
    network = openai.fetch
    const h = await open({ actor: member, provider: openai.fetch })
    expect((await link(h)).status).toBe(202)
    expect(openai.seen.filter((seen) => seen.path.endsWith("/deviceauth/token"))).toHaveLength(1)
    expect(await rows(runtime)).toEqual([])
    expect(JSON.stringify(host.exits.at(-1))).toContain("LinkRefused")
  })

  test("a link when they already hold one replaces its credential, keeping its place, its activity and its id", async () => {
    const [, kept] = await seedKeys(runtime, "person-member", [
      model("openai-chat", { fast: "gpt-test" }),
      { kind: "codex_subscription", key: JSON.stringify(credentialOf({ accessToken: "stale" })), active: false },
    ])
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE personal_models SET failure_status = 401, failed_at = now() WHERE id = ${kept!}`))
    const openai = approving()
    network = openai.fetch
    await link(await open({ actor: member, provider: openai.fetch }))
    const after = await rows(runtime)
    expect(after).toHaveLength(2)
    expect(after[1]).toMatchObject({ id: kept, position: 1, active: false, failureStatus: null, failedAt: null })
    expect((await credentialIn(after[1]!)).accessToken).toBe(`${CODEX_ACCESS}-1`)
    expect((await events(runtime)).map((event) => event.action)).toEqual(["set", "replace"])
  })

  test("a person's first link is their first connection, and the step run again writes it once", async () => {
    const database = (await scratch()).database
    const run = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
      runtime.runPromise(Effect.provide(effect, database) as Effect.Effect<A>)
    const write = {
      personId: "person-member",
      id: crypto.randomUUID(),
      sealed: { ciphertext: "c", nonce: "n", keyVersion: 1, keyLast4: "abcd" },
      invocationKey: "step-1",
      generation: await runtime.runPromise(Store.linkGeneration("person-member")),
    }
    expect(await run(Store.link(write))).toBe("set")
    expect(await run(Store.link(write))).toBe("repeat")
    expect((await rows(runtime)).map((row) => [row.position, row.id])).toEqual([[0, write.id]])
    expect((await events(runtime)).map((event) => event.action)).toEqual(["set"])
  })

  test("individual Codex removal advances the generation; delayed Keep and replay stay cancelled", async () => {
    const ids = await seedKeys(runtime, "person-member", [
      model("openai-chat", { fast: "gpt-test" }),
      { kind: "codex_subscription", key: JSON.stringify(credentialOf()), active: false },
    ])
    const generation = await runtime.runPromise(Store.linkGeneration("person-member"))
    const write = { authority: null, personId: "person-member", id: crypto.randomUUID(), generation,
      sealed: { ciphertext: "sealed-test-only", nonce: "nonce-test-only", keyVersion: 1, keyLast4: "abcd" } }
    const h = await open({ actor: member })
    expect((await h.fetch(PERSONAL_MODEL_ROUTE, put([{ kind: "api_key", id: ids[0], ...model("openai-chat", { fast: "gpt-test" }) }]))).status).toBe(202)
    expect((await rows(runtime)).map((row) => row.kind)).toEqual(["api_key"])
    expect(await runtime.runPromise(Store.linkGeneration("person-member"))).not.toBe(generation)
    const keep = ModelFlows.keepStep((await scratch()).database)(write).pipe(
      Effect.provideService(Action.CurrentInvocationKey, "individual-removal-keep"))
    expect(await runtime.runPromise(keep)).toEqual({ change: "stale" })
    expect(await runtime.runPromise(keep)).toEqual({ change: "stale" })
    expect((await rows(runtime)).map((row) => row.kind)).toEqual(["api_key"])
  })

  test("link deletion generations fail closed, remain cancelled on replay, and allow a new link", async () => {
    const generation = await runtime.runPromise(Store.linkGeneration("person-member"))
    const write = { personId: "person-member", id: crypto.randomUUID(), generation,
      sealed: { ciphertext: "sealed-test-only", nonce: "nonce-test-only", keyVersion: 1, keyLast4: "abcd" },
      invocationKey: "link-generation-test" }
    expect(await runtime.runPromise(Store.remove({ personId: write.personId, invocationKey: "delete-before-link" }))).toBe("missing")
    expect(await runtime.runPromise(Store.link(write))).toBe("stale")
    expect(await runtime.runPromise(Store.link(write))).toBe("stale")
    expect(await runtime.runPromise(Store.link({ ...write, generation: undefined }))).toBe("stale")
    const next = { ...write, generation: await runtime.runPromise(Store.linkGeneration(write.personId)) }
    expect(await runtime.runPromise(Store.link(next))).toBe("set")
    expect(await runtime.runPromise(Store.remove({ personId: write.personId, invocationKey: "delete-after-link" }))).toBe("deleted")
    expect(await runtime.runPromise(Store.link(next))).toBe("repeat")
    expect((await rows(runtime)).map(({ kind }) => kind)).toEqual([])
  })

  test("personal connection fencing adds one admission query, one writer lock and one link generation query", async () => {
    const measure = async <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => {
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({ span(options) { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
      const value = await runtime.runPromise(effect.pipe(Effect.provideService(Tracer.Tracer, tracer)))
      const statements = spans.filter((span) => span.kind === "client")
        .map((span) => String(span.attributes.get("db.query.text") ?? span.attributes.get("db.statement") ?? ""))
      return { value, statements }
    }
    const admission = await measure(Store.linkGeneration("person-member"))
    expect(admission.statements).toHaveLength(1)
    const linked = await measure(Store.link({ personId: "person-member", id: crypto.randomUUID(), generation: admission.value,
      sealed: { ciphertext: "sealed-test-only", nonce: "nonce-test-only", keyVersion: 1, keyLast4: "abcd" }, invocationKey: "link-cost" }))
    expect(linked.value).toBe("set")
    expect(linked.statements.filter((text) => text.includes("pg_advisory_xact_lock"))).toHaveLength(1)
    expect(linked.statements.filter((text) => text.includes("coalesce(max(id)"))).toHaveLength(1)
    const removed = await measure(Store.remove({ personId: "person-member", invocationKey: "remove-cost" }))
    expect(removed.statements.filter((text) => text.includes("pg_advisory_xact_lock"))).toHaveLength(1)
  })

  test("a step whose database can't be reached, or with no invocation key, never records twice", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const keys = await keysOf()
    const sealed = await Effect.runPromise(keys.cipher.seal(
      Redacted.make(JSON.stringify({ deviceAuthId: "d", userCode: "u" })),
      { id: "person:person-member", name: "model-link", version: keys.version },
    ))
    const payload = { personId: "person-member", id: crypto.randomUUID(), ...sealed, keyVersion: keys.version }
    const openai = approving()
    const ready = <A, E>(effect: Effect.Effect<A, E, any>) =>
      effect.pipe(
        Effect.provide(SecretKeys.layer(KEY)),
        Effect.provideService(FetchHttpClient.Fetch, openai.fetch),
        Effect.provide(codexAuth),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ CODEX_AUTH_ORIGIN })),
      ) as Effect.Effect<A, E>
    const kept = {
      authority: null,
      personId: payload.personId,
      id: payload.id,
      sealed: { ciphertext: sealed.ciphertext, nonce: sealed.nonce, keyVersion: keys.version, keyLast4: "1234" },
    }
    const down = await Effect.runPromiseExit(ready(ModelFlows.keepStep(unreachable)(kept).pipe(
      Effect.provideService(Action.CurrentInvocationKey, "step-1"),
    )))
    expect(JSON.stringify(down)).toContain("StoreUnavailable")
    const unkeyed = await Effect.runPromiseExit(ready(ModelFlows.keepStep(unreachable)(kept)))
    expect(JSON.stringify(unkeyed)).toContain("NoInvocationKey")
  })

  test("OpenAI refusing the code is 502 link_refused, by its status; nothing starts", async () => {
    const refusing = async (fetch: typeof globalThis.fetch) => {
      const h = await open({ actor: member, provider: fetch })
      return [await json(await link(h)), h.line("personal_model.request").at(-1)] as const
    }
    const [answer, line] = await refusing(scriptedOpenAi(() => ({ status: 429 })).fetch)
    expect(answer).toEqual([502, { code: "link_refused" }])
    expect(line).toMatchObject({ annotations: { outcome: "refused", providerStatus: 429, status: 502 } })
    const [unreachable, plain] = await refusing(() => Promise.reject(new Error("no route")))
    expect(unreachable).toEqual([502, { code: "link_refused" }])
    expect(plain?.annotations).not.toHaveProperty("providerStatus")
    // A 200 that doesn't read as a code, one with no code in it, or that only says `usercode`, as a later server may.
    expect((await refusing(scriptedOpenAi(() => "not json").fetch))[0]).toEqual([502, { code: "link_refused" }])
    expect((await refusing(scriptedOpenAi(() => ({ status: 200, body: { device_auth_id: "d" } })).fetch))[0])
      .toEqual([502, { code: "link_refused" }])
    const later = scriptedOpenAi((path) =>
      path.endsWith("/usercode") ? { status: 200, body: { device_auth_id: "d", usercode: "LATER", interval: 0 } } : { status: 500 }
    )
    network = later.fetch
    expect((await refusing(later.fetch))[0]).toMatchObject([202, { userCode: "LATER" }])
    const omitted = scriptedOpenAi((path) =>
      path.endsWith("/usercode") ? { status: 200, body: { device_auth_id: "d", user_code: "OMITTED" } } : { status: 500 }
    )
    network = omitted.fetch
    expect((await refusing(omitted.fetch))[0]).toMatchObject([202, { userCode: "OMITTED" }])
  })

  test("only the person links: signed out 401, an agent 403, keys off 503, a flow that can't start 503", async () => {
    const openai = approving()
    expect(await json(await link(await open({ provider: openai.fetch })))).toEqual([401, { code: "authentication" }])
    expect(await json(await link(await open({ actor: agent, provider: openai.fetch })))).toEqual([403, { code: "forbidden" }])
    expect(await json(await link(await open({ actor: member, keys: false, provider: openai.fetch })))).toEqual([503, { code: "off" }])
    expect(openai.seen).toEqual([])
    const failing = Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "down" })) })
    expect(await json(await link(await open({ actor: member, starter: failing, provider: openai.fetch }))))
      .toEqual([503, { code: "unavailable" }])
    const h = await open({ actor: member })
    const get = await h.fetch(CODEX_LINK_ROUTE, { method: "GET" })
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"])
  })

  test("the id token's claims, and a token that isn't a JWT or says nothing", () => {
    expect(Codex.claimsOf(idToken({ accountId: "a", planType: "team" }))).toEqual({ accountId: "a", planType: "team" })
    expect(Codex.claimsOf("not a jwt")).toEqual({ accountId: "", planType: "unknown" })
    expect(Codex.claimsOf(`e30.${btoa("{}")}.x`)).toEqual({ accountId: "", planType: "unknown" })
  })
})

describe("a Codex token kept fresh", () => {
  test("Check Access reports an unreadable refresh without inventing a provider status", async () => {
    const [id] = await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(credentialOf()) }])
    const db = (await scratch()).database
    let opened = 0
    const failure = new SqlError({ reason: new ConnectionError({ cause: "injected outage", operation: "execute", message: "unavailable" }) })
    const failing = Layer.fresh(Layer.unwrap(Effect.sync(() => ++opened === 1 ? db : Layer.effect(SqlClient.SqlClient, Effect.fail(failure)))))
    const h = await open({ actor: member, database: failing })
    expect((await json(await h.fetch(`${PERSONAL_MODEL_TEST_ROUTE}?connection=${id}`, { method: "POST" })))[1])
      .toMatchObject({ ok: false, code: "refused", status: null, host: "auth.openai.com" })
    expect(opened).toBeGreaterThan(1)
  })
  const onNetwork = <A, E>(fetch: typeof globalThis.fetch, effect: Effect.Effect<A, E, SqlClient.SqlClient | Codex.CodexAuth>) =>
    runtime.runPromiseExit(effect.pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provide(codexAuth),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ CODEX_AUTH_ORIGIN })),
    ))
  const expiring = () => credentialOf({ expiresAt: Date.now() + 60_000 })
  const refreshed = (body: Record<string, unknown> = {}) =>
    scriptedOpenAi((path) => path === "/oauth/token" ? { status: 200, body: { access_token: `${CODEX_ACCESS}-2`, expires_in: 3600, ...body } } : undefined)

  test("a token good for a run's length isn't refreshed; nothing is sent", async () => {
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(credentialOf()) }])
    const before = await rows(runtime)
    const openai = refreshed()
    expect(Exit.isSuccess(await onNetwork(openai.fetch, Subscriptions.fresh("person-member", await keysOf())))).toBe(true)
    expect(openai.seen).toEqual([])
    expect(await rows(runtime)).toEqual(before)
  })

  test("two runs starting together refresh once: the second reads the first's token", async () => {
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(expiring()) }])
    // A far-off expiry, so the run that waited finds the token good.
    const openai = refreshed({ refresh_token: `${CODEX_REFRESH}-2`, expires_in: 24 * 60 * 60 })
    const opened = await keysOf()
    const exits = await Promise.all([
      onNetwork(openai.fetch, Subscriptions.fresh("person-member", opened)),
      onNetwork(openai.fetch, Subscriptions.fresh("person-member", opened)),
    ])
    expect(exits.every(Exit.isSuccess)).toBe(true)
    expect(openai.seen).toHaveLength(1)
    const [row] = await rows(runtime)
    expect(row).toMatchObject({ failureStatus: null })
  })

  test("one near its end is refreshed, the rotated refresh token sealed at once and the next refresh using it", async () => {
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(expiring()) }])
    const [before] = await rows(runtime)
    const openai = refreshed({ refresh_token: `${CODEX_REFRESH}-2`, id_token: idToken({ accountId: "acct-5678", planType: "team" }) })
    expect(Exit.isSuccess(await onNetwork(openai.fetch, Subscriptions.fresh("person-member", await keysOf())))).toBe(true)
    expect(openai.seen.map((seen) => seen.body)).toEqual([
      { grant_type: "refresh_token", refresh_token: `${CODEX_REFRESH}-1`, client_id: "app_EMoamEEZ73f0CkXaXp7hrann" },
    ])
    const [after] = await rows(runtime)
    expect(after!.ciphertext).not.toBe(before!.ciphertext)
    const credential = await credentialIn(after!)
    expect(credential).toMatchObject({
      accessToken: `${CODEX_ACCESS}-2`,
      refreshToken: `${CODEX_REFRESH}-2`,
      accountId: "acct-5678",
      planType: "team",
    })
    expect(credential.expiresAt).toBeGreaterThan(Date.now() + 3_000_000)
    expect(credential.expiresAt).toBeLessThan(Date.now() + 3_700_000)
    // `force` refreshes whatever its age: and uses the token the last refresh rotated to.
    expect(Exit.isSuccess(await onNetwork(openai.fetch, Subscriptions.fresh("person-member", await keysOf(), true)))).toBe(true)
    expect(openai.seen.map((seen) => seen.body.refresh_token)).toEqual([`${CODEX_REFRESH}-1`, `${CODEX_REFRESH}-2`])
    expect(leaks(await dump(runtime, (await scratch()).name), [CODEX_ACCESS, CODEX_REFRESH])).toEqual([])
  })

  test("a refresh that rotates nothing keeps the refresh token; one that doesn't say assumes the CLI's 8 days", async () => {
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(expiring()) }])
    const openai = scriptedOpenAi(() => ({ status: 200, body: { access_token: `${CODEX_ACCESS}-2` } }))
    await onNetwork(openai.fetch, Subscriptions.fresh("person-member", await keysOf()))
    const credential = await credentialIn((await rows(runtime))[0]!)
    expect(credential).toMatchObject({ accessToken: `${CODEX_ACCESS}-2`, refreshToken: `${CODEX_REFRESH}-1`, accountId: "acct-1234" })
    expect(credential.expiresAt).toBeGreaterThan(Date.now() + 7 * 24 * 60 * 60 * 1000)
  })

  test("a refusal marks the row and fails; OpenAI out of reach marks nothing; a refresh clears the mark", async () => {
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(expiring()) }])
    const keys = await keysOf()
    const refusal = scriptedOpenAi(() => ({ status: 401 }))
    const exit = await onNetwork(refusal.fetch, Subscriptions.fresh("person-member", keys))
    expect(JSON.stringify(exit)).toContain('"reason":"refused"')
    expect((await rows(runtime))[0]).toMatchObject({ failureStatus: 401, failedAt: expect.any(Date) })
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE personal_models SET failure_status = NULL, failed_at = NULL`))
    const unreachable = await onNetwork(() => Promise.reject(new Error("no route")), Subscriptions.fresh("person-member", keys))
    expect(JSON.stringify(unreachable)).toContain('"reason":"unreachable"')
    expect((await rows(runtime))[0]).toMatchObject({ failureStatus: null })
    // An answer that doesn't read says nothing of the token: no status to mark it with.
    const garbled = await onNetwork(scriptedOpenAi(() => "not json").fetch, Subscriptions.fresh("person-member", keys))
    expect(JSON.stringify(garbled)).toContain('"reason":"refused"')
    expect((await rows(runtime))[0]).toMatchObject({ failureStatus: null })
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE personal_models SET failure_status = 401, failed_at = now()`))
    await onNetwork(refreshed().fetch, Subscriptions.fresh("person-member", keys))
    expect((await rows(runtime))[0]).toMatchObject({ failureStatus: null, failedAt: null })
  })

  test("a link arriving during a refresh waits for it, so neither write is lost", async () => {
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(expiring()) }])
    const openai = scriptedOpenAi(() => {
      return { status: 200, body: { access_token: `${CODEX_ACCESS}-late` } }
    })
    let relink: Promise<unknown> | undefined
    const relinking: typeof globalThis.fetch = async (input, init) => {
      relink = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE personal_models SET ciphertext = 'relinked'`))
      return openai.fetch(input, init)
    }
    await onNetwork(relinking, Subscriptions.fresh("person-member", await keysOf()))
    await relink
    expect((await rows(runtime))[0]!.ciphertext).toBe("relinked")
  })

  test("an inactive Codex connection is nobody's run: only Check Access refreshes it", async () => {
    await seedKeys(runtime, "person-member", [
      { kind: "claude_subscription", key: CLAUDE_TOKEN },
      { kind: "codex_subscription", key: JSON.stringify(expiring()), active: false },
    ])
    const keys = await keysOf()
    const refusal = scriptedOpenAi(() => ({ status: 401 }))
    // A run on the active Claude subscription must not fail on the Codex token nobody is using.
    expect(Exit.isSuccess(await onNetwork(refusal.fetch, Subscriptions.fresh("person-member", keys)))).toBe(true)
    expect(refusal.seen).toEqual([])
    expect(JSON.stringify(await onNetwork(refusal.fetch, Subscriptions.fresh("person-member", keys, true)))).toContain('"reason":"refused"')
    expect(refusal.seen).toHaveLength(1)
  })

  test("nothing to do for a person with no Codex connection; a sealed token that doesn't open or read fails", async () => {
    const openai = refreshed()
    const keys = await keysOf()
    expect(Exit.isSuccess(await onNetwork(openai.fetch, Subscriptions.fresh("person-member", keys)))).toBe(true)
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: "this is not a credential" }])
    expect(JSON.stringify(await onNetwork(openai.fetch, Subscriptions.fresh("person-member", keys)))).toContain('"reason":"refused"')
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(expiring()) }], Redacted.make("f".repeat(64)))
    expect(JSON.stringify(await onNetwork(openai.fetch, Subscriptions.fresh("person-member", keys)))).toContain('"reason":"refused"')
    expect(openai.seen).toEqual([])
  })

  test("Check Access on a Codex connection refreshes it, and answers OpenAI's refusal by its status", async () => {
    const [id] = await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(credentialOf()) }])
    const fine = refreshed()
    const h = await open({ actor: member, provider: fine.fetch })
    expect((await json(await h.fetch(`${PERSONAL_MODEL_TEST_ROUTE}?connection=${id}`, { method: "POST" })))[1])
      .toEqual({ ok: true, latencyMs: expect.any(Number), sample: "" })
    expect(fine.seen).toHaveLength(1)
    const refused = await open({ actor: member, provider: scriptedOpenAi(() => ({ status: 401 })).fetch })
    expect((await json(await refused.fetch(PERSONAL_MODEL_TEST_ROUTE, { method: "POST" })))[1])
      .toMatchObject({ ok: false, code: "refused", status: 401, host: "auth.openai.com" })
    expect((await rows(runtime))[0]).toMatchObject({ failureStatus: 401 })
    await nothingLeaked(h, [CODEX_ACCESS, CODEX_REFRESH])
  })
})

describe("a subscription as a run uses it", () => {
  test("which agent the list puts first; a model ahead of a subscription keeps the Smithers agent", async () => {
    const keys = await keysOf()
    const agentOf = () => runtime.runPromise(Subscriptions.agentOf("person-member"))
    expect(await agentOf()).toBe("smithers")
    expect(await runtime.runPromise(Subscriptions.of("person-member", keys))).toEqual(Option.none())
    await seedKeys(runtime, "person-member", [
      model("openai-chat", { implement: "gpt-implement" }),
      { kind: "claude_subscription", key: CLAUDE_TOKEN },
    ])
    expect(await agentOf()).toBe("smithers")
    await seedKeys(runtime, "person-member", [
      model("openai-chat", { fast: "gpt-fast" }),
      { kind: "claude_subscription", key: CLAUDE_TOKEN },
    ])
    expect(await agentOf()).toBe("claude-code")
  })

  test("what a box reads of it: the hosts it may go to and a Codex account's public ids, never a credential", async () => {
    const keys = await keysOf()
    const [claude] = await seedKeys(runtime, "person-member", [{ kind: "claude_subscription", key: CLAUDE_TOKEN }])
    expect(await runtime.runPromise(Subscriptions.of("person-member", keys))).toEqual(Option.some({
      personId: "person-member",
      connectionId: claude,
      agent: "claude-code",
      baseUrl: null,
      hosts: Agents.CLAUDE_HOSTS,
    }))
    const [proxied] = await seedKeys(runtime, "person-member", [{ kind: "claude_subscription", key: CLAUDE_TOKEN, baseUrl: ANTHROPIC_ORIGIN }])
    expect(Option.getOrThrow(await runtime.runPromise(Subscriptions.of("person-member", keys)))).toMatchObject({
      connectionId: proxied,
      baseUrl: ANTHROPIC_ORIGIN,
      hosts: ["anthropic.example.com"],
    })
    const [codex] = await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(credentialOf()) }])
    expect(await runtime.runPromise(Subscriptions.of("person-member", keys))).toEqual(Option.some({
      personId: "person-member",
      connectionId: codex,
      agent: "codex",
      baseUrl: null,
      hosts: Agents.CODEX_HOSTS,
      account: { accountId: "acct-1234", planType: "plus" },
    }))
  })

  test("a Codex credential that doesn't open or read gives no subscription: its run fails on its first request", async () => {
    const keys = await keysOf()
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: "this is not a credential" }])
    expect(await runtime.runPromise(Subscriptions.of("person-member", keys))).toEqual(Option.none())
    await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: JSON.stringify(credentialOf()) }], Redacted.make("f".repeat(64)))
    expect(await runtime.runPromise(Subscriptions.of("person-member", keys))).toEqual(Option.none())
  })

  test("reveal: a Claude token, a Codex access token, nothing once removed, inactive or unreadable", async () => {
    const keys = await keysOf()
    const revealed = async (id: string) =>
      Option.map(await runtime.runPromise(Subscriptions.reveal("person-member", id, keys)), Redacted.value)
    const [claude] = await seedKeys(runtime, "person-member", [{ kind: "claude_subscription", key: CLAUDE_TOKEN }])
    expect(await revealed(claude!)).toEqual(Option.some(CLAUDE_TOKEN))
    const [codex, off] = await seedKeys(runtime, "person-member", [
      { kind: "codex_subscription", key: JSON.stringify(credentialOf()) },
      { kind: "claude_subscription", key: CLAUDE_TOKEN, active: false },
    ])
    expect(await revealed(codex!)).toEqual(Option.some(`${CODEX_ACCESS}-1`))
    expect(await revealed(off!)).toEqual(Option.none())
    expect(await revealed(claude!)).toEqual(Option.none())
    const [broken] = await seedKeys(runtime, "person-member", [{ kind: "codex_subscription", key: "this is not a credential" }])
    expect(await revealed(broken!)).toEqual(Option.none())
    const [sealed] = await seedKeys(runtime, "person-member", [{ kind: "claude_subscription", key: CLAUDE_TOKEN }], Redacted.make("f".repeat(64)))
    expect(await revealed(sealed!)).toEqual(Option.none())
  })
})

describe("POST /api/me/model/jev", () => {
  const judgment = { state: { ok: true }, questions: { ok: Classifier.boolean({ instructions: "Is ok true?" }) } }
  const post = (body: unknown = judgment): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  const answers = {
    answers: { ok: { type: "boolean", probability: 0.9 } },
    usage: { inputTokens: 40, outputTokens: 2 },
    providerMetadata: { typesafe: { confidence: { ok: 0.8 } } },
  }
  const jev = (extra: Record<string, unknown> = {}) =>
    seedKeys(runtime, "person-member", [{ kind: "jev", key: JEV_KEY, ...extra }])

  test("no connection is 404 none, and nothing reaches the gateway: the person's judge goes back to the seat", async () => {
    await seed(runtime, "person-member")
    const gateway = scriptedGateway(() => ({ status: 200, body: answers }))
    const h = await open({ actor: member, provider: gateway.fetch })
    expect(await json(await h.fetch(JEV_ROUTE, post()))).toEqual([404, { code: "none" }])
    await seedKeys(runtime, "person-member", [{ kind: "jev", key: JEV_KEY, active: false }])
    expect(await json(await h.fetch(JEV_ROUTE, post()))).toEqual([404, { code: "none" }])
    expect(gateway.seen).toEqual([])
    // Off, the key can't be opened: the seat answers as well.
    await jev()
    expect(await json(await (await open({ actor: member, keys: false, provider: gateway.fetch })).fetch(JEV_ROUTE, post())))
      .toEqual([404, { code: "none" }])
  })

  test("answers with the person's key, in their ledger as the judge; an agent may ask for them", async () => {
    const [id] = await jev()
    const gateway = scriptedGateway(() => ({ status: 200, body: answers }))
    const h = await open({ actor: agent, provider: gateway.fetch })
    const answered = await h.fetch(JEV_ROUTE, post())
    expect(answered.headers.get("cache-control")).toBe("no-store")
    expect(await json(answered)).toEqual([200, {
      answers: { ok: { type: "boolean", probability: 0.9 } },
      confidence: { ok: 0.8 },
      latencyMs: expect.any(Number),
    }])
    expect(gateway.seen.map((seen) => seen.headers.get("authorization"))).toEqual([`Bearer ${JEV_KEY}`])
    expect(gateway.seen[0]!.headers.get("ai-model-id")).toBe("typesafe-ai/jev")
    expect(gateway.seen[0]!.body).toMatchObject({
      state: { ok: true },
      questions: { ok: { type: "boolean", instructions: "Is ok true?" } },
    })
    expect(await usage(runtime)).toEqual([expect.objectContaining({
      personId: "person-member",
      role: "judge",
      modelId: "typesafe-ai/jev",
      connectionId: id,
      protocol: null,
      tier: null,
      inputTokens: 40,
      outputTokens: 2,
      outcome: "success",
      settled: true,
    })])
    expect(h.count(PersonalApi.requests, { op: "jev", outcome: "judged" })).toBe(1)
    await nothingLeaked(h, [JEV_KEY])
  })

  test("a key the gateway refuses marks the connection, with the gateway's status, until it answers again", async () => {
    await jev()
    let refused = true
    const gateway = scriptedGateway(() =>
      refused ? { status: 403, body: { error: `no such key ${JEV_KEY}` } } : { status: 200, body: answers }
    )
    const h = await open({ actor: member, provider: gateway.fetch })
    expect(await json(await h.fetch(JEV_ROUTE, post()))).toEqual([502, { code: "refused" }])
    expect(await rows(runtime)).toEqual([expect.objectContaining({ failureStatus: 403, failedAt: expect.any(Date) })])
    expect(await usage(runtime)).toEqual([
      expect.objectContaining({ outcome: "failed", errorCode: "refused", httpStatus: 403, settled: true }),
    ])
    expect(h.line("personal_model.request").at(-1)).toMatchObject({ annotations: { op: "jev", failure: "refused", status: 502 } })
    refused = false
    expect((await h.fetch(JEV_ROUTE, post())).status).toBe(200)
    expect(await rows(runtime)).toEqual([expect.objectContaining({ failureStatus: null, failedAt: null })])
    await nothingLeaked(h, [JEV_KEY])
  })

  test("a gateway that is down, or an answer that doesn't read, says nothing of the key: the connection stays unmarked", async () => {
    await jev()
    for (const [status, body] of [[503, { error: "down" }], [200, { nothing: true }]] as const) {
      const gateway = scriptedGateway(() => ({ status, body }))
      const h = await open({ actor: member, provider: gateway.fetch })
      expect((await h.fetch(JEV_ROUTE, post())).status).toBe(502)
    }
    expect(await rows(runtime)).toEqual([expect.objectContaining({ failureStatus: null })])
    expect((await usage(runtime)).map((row) => row.errorCode)).toEqual(["refused", "empty"])
  })

  test("a malformed body is 400, an oversized body 413; a method but POST is 405; signed out is 401", async () => {
    await jev()
    const gateway = scriptedGateway(() => ({ status: 200, body: answers }))
    const h = await open({ actor: member, provider: gateway.fetch })
    expect(await json(await h.fetch(JEV_ROUTE, post("not json")))).toEqual([400, { code: "invalid" }])
    expect(await json(await h.fetch(JEV_ROUTE, post({ state: {} })))).toEqual([400, { code: "invalid" }])
    expect(await json(await h.fetch(JEV_ROUTE, post("x".repeat(MAX_JEV_BODY_BYTES + 1))))).toEqual([413, { code: "too_large" }])
    expect(gateway.seen).toEqual([])
    const get = await h.fetch(JEV_ROUTE, { method: "GET" })
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"])
    expect(await json(await (await open()).fetch(JEV_ROUTE, post()))).toEqual([401, { code: "authentication" }])
  })

  test("a sealed key that doesn't open is 409 refused: the judge says so, and the seat doesn't answer", async () => {
    await seedKeys(runtime, "person-member", [{ kind: "jev", key: JEV_KEY }], Redacted.make("f".repeat(64)))
    const gateway = scriptedGateway(() => ({ status: 200, body: answers }))
    expect(await json(await (await open({ actor: member, provider: gateway.fetch })).fetch(JEV_ROUTE, post())))
      .toEqual([409, { code: "refused" }])
    expect(gateway.seen).toEqual([])
  })

  test("Check Access on a Jev connection is one judgment; a refusal names the gateway; a key that won't open is unusable", async () => {
    const [id] = await jev()
    const fine = scriptedGateway(() => ({ status: 200, body: { answers: { ok: { type: "boolean", probability: 1 } } } }))
    const h = await open({ actor: member, provider: fine.fetch })
    expect((await json(await h.fetch(PERSONAL_MODEL_TEST_ROUTE, { method: "POST" })))[1])
      .toEqual({ ok: true, latencyMs: expect.any(Number), sample: "" })
    expect(await usage(runtime)).toEqual([expect.objectContaining({ role: "test", connectionId: id, outcome: "success" })])
    const refused = await open({ actor: member, provider: scriptedGateway(() => ({ status: 401, body: {} })).fetch })
    expect((await json(await refused.fetch(PERSONAL_MODEL_TEST_ROUTE, { method: "POST" })))[1]).toEqual({
      ok: false,
      latencyMs: expect.any(Number),
      code: "refused",
      status: 401,
      host: "ai-gateway.vercel.sh",
    })
    expect((await rows(runtime))[0]).toMatchObject({ failureStatus: 401 })
    const down = await open({ actor: member, provider: scriptedGateway(() => ({ status: 200, body: {} })).fetch })
    expect((await json(await down.fetch(PERSONAL_MODEL_TEST_ROUTE, { method: "POST" })))[1])
      .toMatchObject({ ok: false, code: "empty", status: null })
    await seedKeys(runtime, "person-member", [{ kind: "jev", key: JEV_KEY }], Redacted.make("f".repeat(64)))
    expect((await json(await h.fetch(PERSONAL_MODEL_TEST_ROUTE, { method: "POST" })))[1])
      .toMatchObject({ ok: false, code: "unusable", status: null })
  })
})
