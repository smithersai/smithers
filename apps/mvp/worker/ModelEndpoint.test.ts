// The metered model endpoint (worker/ModelEndpoint.ts, docs/features/model-endpoint.md), through ChatApi's routes on
// this file's own schema of the compose Postgres. The model provider is the only scripted seam: the deployment's
// default model is a scripted `Model` (worker/test/harness.ts), and a model an admin sets is a real HostModel reaching
// a scripted provider on loopback HTTP. `admin/SetModel` runs on the Node host (worker/test/flowHost.ts).
import { Model, ModelError, type ModelEvent, ModelProxy, ModelRequest } from "@smthrs/model"
import { HostModel } from "@smthrs/model-host"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Cause, ConfigProvider, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Redacted, Schema, Scope, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../db/Database.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import { type Actor, CurrentActor, Sessions, SessionsUnavailable } from "./Actor.ts"
import * as Flows from "./Flows.ts"
import * as HostedModel from "./HostedModel.ts"
import * as ModelEndpoint from "./ModelEndpoint.ts"
import * as ModelSpend from "./ModelSpend.ts"
import * as ModelRoles from "./ModelRoles.ts"
import * as ModelTiers from "./ModelTiers.ts"
import * as ModelUsage from "./ModelUsage.ts"
import { PersonalModels } from "./personal/Models.ts"
import * as SetModel from "./SetModel.ts"
import * as SpendAlert from "./flows/SpendAlert.ts"
import { Summarize, SummaryFailed } from "../src/features/timeline/flow.ts"
import { registration as summaries, SummaryLedger, SummarySeat } from "../src/features/timeline/steps.ts"
import { build, runFlow } from "./test/flowHost.ts"
import { delta, eventually, harness, recorded, stop, testFile, usage } from "./test/harness.ts"

const runtime = testFile("model_endpoint")

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`TRUNCATE model_roles, model_role_changes, model_usage, model_budget_days, hosted_model, hosted_model_changes`,
    ),
  )
)

const admin: Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin" }
const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }
const agentForAdmin: Actor = { ...admin, act: { kind: "agent", id: "agent-run-1" } }

const ask = (text: string, overrides: Partial<ConstructorParameters<typeof ModelRequest.ModelRequest>[0]> = {}) =>
  ModelRequest.ModelRequest.make({
    modelId: "browser-choice",
    system: [ModelRequest.SystemPart.make({ text: "browser system" })],
    messages: [ModelRequest.Message.user(text)],
    tools: [],
    params: ModelRequest.GenerationParams.make({ maxTokens: 999_999 }),
    ...overrides,
  })

const body = (request: ModelRequest.ModelRequest) =>
  JSON.stringify(Schema.encodeSync(ModelRequest.ModelRequest)(request))

type Harness = Awaited<ReturnType<typeof harness>>

/** One `POST /api/model/<role>`: its status, its NDJSON lines or error body. */
const call = async (h: Harness, request: ModelRequest.ModelRequest, role = "agent") => {
  const response = await h.fetch(`/api/model/${role}`, { method: "POST", body: body(request) })
  const text = await response.text()
  const lines = response.status === 200 ? text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)) : []
  return { status: response.status, lines, error: response.status === 200 ? undefined : JSON.parse(text || "null") }
}

/** A default model that answers "default answer", reports usage and stops. */
const answering = () => Stream.make(delta("default answer"), usage, stop)

/**
 * A model whose every call spends `tokens`, half in and half out. A call reserves its body's bytes plus 8,000 output
 * tokens, and a reservation larger than the whole budget is refused, so a budget a test spends must hold at least that.
 */
const spending = (tokens: number) => () =>
  Stream.make(delta("spent"), { type: "usage", inputTokens: tokens / 2, outputTokens: tokens / 2 } as ModelEvent.ModelEvent, stop)

const usageRows = () =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{
          readonly role: string
          readonly modelId: string
          readonly inputTokens: number
          readonly outputTokens: number
        }>`SELECT role, model_id AS "modelId", input_tokens AS "inputTokens", output_tokens AS "outputTokens"
          FROM model_usage ORDER BY created_at`,
    ),
  )

/** What today's budget counter holds: settled spend plus what calls in flight reserved. */
const committedToday = () =>
  runtime.runPromise(
    Effect.map(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly committed: string }>`
          SELECT committed::text AS committed FROM model_budget_days
          WHERE day = (now() AT TIME ZONE 'UTC')::date`),
      ([row]) => Number(row?.committed ?? 0),
    ),
  )

/** Every call's ledger row: what it reserved, what it spent, and whether it settled. */
const ledger = () =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{
          readonly invocationId: string
          readonly reserved: number
          readonly inputTokens: number
          readonly outputTokens: number
          readonly settled: boolean
        }>`SELECT invocation_id AS "invocationId", reserved_tokens AS reserved, input_tokens AS "inputTokens",
            output_tokens AS "outputTokens", settled_at IS NOT NULL AS settled
          FROM model_usage ORDER BY created_at`,
    ),
  )

/** Every call's charge (what it counts against its day) and how long its reservation lasts, in seconds. */
const charges = () =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{ readonly invocationId: string; readonly charged: number; readonly expiresInSeconds: number }>`
          SELECT invocation_id AS "invocationId", charged_tokens AS charged,
            round(extract(epoch FROM expires_at - created_at))::int AS "expiresInSeconds"
          FROM model_usage ORDER BY created_at`,
    ),
  )

/** How each call's ledger row says it ended. */
const endings = () =>
  runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{
          readonly outcome: string | null
          readonly errorCode: string | null
          readonly httpStatus: number | null
        }>`SELECT outcome, error_code AS "errorCode", http_status AS "httpStatus" FROM model_usage ORDER BY created_at`,
    ),
  )

/** Whether today's committed tokens are what today's calls are charged. */
const reconciled = async () => {
  const [row] = await runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly charged: string }>`
        SELECT coalesce(sum(charged_tokens), 0)::text AS charged FROM model_usage
        WHERE day = (now() AT TIME ZONE 'UTC')::date`),
  )
  return Number(row!.charged) === (await committedToday())
}

/** Moves a call's reservation expiry into the past, as if it had been open longer than the expiry. */
const expire = (invocationId: string) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE model_usage SET expires_at = now() - interval '1 second' WHERE invocation_id = ${invocationId}`),
  )

/** The expiry the direct `ModelUsage` tests reserve with. */
const expiry = Duration.minutes(10)

/** How the direct `ModelUsage` tests' calls ended. */
const ended: ModelUsage.Ended = { outcome: "answered" }

/** A model that waits for `gate` before it answers, reports 46 tokens (12 in, 34 out) and stops. */
const gated = (gate: Promise<void>) => () =>
  Stream.fromEffect(Effect.promise(() => gate)).pipe(Stream.flatMap(() => Stream.make(delta("late"), usage, stop)))

const scratchDatabase = () =>
  runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))

/** Runs `admin/SetModel` on the Node host as `actor`, writing to this file's schema. */
const setModel = async (actor: Actor, change: { readonly role: typeof ModelRoles.Role.Type; readonly model: ModelRoles.ModelRecord }) =>
  runFlow(
    SetModel.SetModel,
    change,
    SetModel.registration(await scratchDatabase()).pipe(Layer.provide(Layer.succeed(CurrentActor, actor))),
  )

// A scripted provider on loopback: an OpenAI-compatible chat endpoint that answers with `text`, or fails.
const servers: Array<Server> = []
afterEach(() => Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done)))))

const provider = async (respond: { readonly text?: string; readonly status?: number; readonly error?: string }) => {
  const seen: Array<{ readonly headers: IncomingHttpHeaders; readonly body: Record<string, unknown> }> = []
  const server = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => (raw += chunk))
    request.on("end", () => {
      seen.push({ headers: request.headers, body: JSON.parse(raw) })
      if (respond.status !== undefined) {
        response.writeHead(respond.status, { "content-type": "application/json" })
        return response.end(JSON.stringify({ error: { message: respond.error } }))
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
      response.end(
        chunk({ id: "c1", choices: [{ index: 0, delta: { content: respond.text } }] }) +
          chunk({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
          chunk({ id: "c1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }) +
          "data: [DONE]\n\n",
      )
    })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, seen }
}

/** A record for a model behind `origin`, whose key the Worker holds as `FIXTURE`. */
const rowModel = (origin: string, modelId = "row-model"): ModelRoles.ModelRecord => ({
  protocol: "openai-chat",
  baseUrl: origin,
  modelId,
  credential: "FIXTURE",
})

const keyConfig = (origin: string, key = "row-key") => ({
  SMITHERS_MODEL_KEY_FIXTURE: key,
  SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: origin,
})

describe("sign-in", () => {
  test("a signed-out call is refused with 401 and never reaches a model", async () => {
    const h = await harness(runtime, answering)

    const { status, error } = await call(h, ask("hi"))

    expect(status).toBe(401)
    expect(error).toMatchObject({ code: "authentication", message: "Sign in to ask Smithers." })
    expect(h.requests).toEqual([])
    expect(await usageRows()).toEqual([])
    expect(h.only("model.proxy.serve").annotations).toMatchObject({ role: "agent", outcome: "refused", status: 401 })
  })

  test.each([
    ["a Guest", "guest" as const],
    ["a person with no role", null],
  ])("%s is refused with 403, never reaches a model, and nothing is metered", async (_, role) => {
    const h = await harness(runtime, answering, { actor: { subject: { kind: "person", id: "person-other" }, role } })

    const { status, error } = await call(h, ask("hi"))

    expect(status).toBe(403)
    expect(error).toMatchObject({ code: "authentication", message: "Asking Smithers needs the Member role." })
    expect(h.requests).toEqual([])
    expect(await usageRows()).toEqual([])
    expect(h.only("model.proxy.serve").annotations).toMatchObject({ role: "agent", outcome: "refused", status: 403 })
  })

  test("sessions that can't be read are 503 provider_internal, logged by their code, and never reach a model", async () => {
    const h = await harness(runtime, answering, {
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
    })

    const { status, error } = await call(h, ask("hi"))

    expect(status).toBe(503)
    expect(error).toMatchObject({ code: "provider_internal" })
    expect(h.requests).toEqual([])
    expect(h.only("model.endpoint").annotations).toMatchObject({
      role: "agent",
      errorCode: "@smthrs/mvp/auth/SessionsUnavailable",
    })
  })

  test("a signed-in call streams the role's model and ends with the end line", async () => {
    const h = await harness(runtime, answering, { actor: member })

    const { status, lines } = await call(h, ask("hi"))

    expect(status).toBe(200)
    expect(lines).toEqual([
      { type: "text-delta", id: "t", text: "default answer" },
      { type: "usage", inputTokens: 12, outputTokens: 34 },
      { type: "settle", stopReason: "stop" },
      { type: "end" },
    ])
  })

  test("the browser's ModelProxy client reads the endpoint as a Model", async () => {
    const h = await harness(runtime, answering, { actor: member })
    const fetch: typeof globalThis.fetch = (input, init) =>
      h.fetch(new URL(String(input)).pathname, init as RequestInit)

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const model = yield* Model.Model
        return yield* Stream.runCollect(model.stream(ask("hi")))
      }).pipe(
        Effect.provide(ModelProxy.layerClient({ url: "http://chat.test/api/model/agent" })),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    )

    expect(Array.from(events).flatMap((event) => event.type === "text-delta" ? [event.text] : [])).toEqual([
      "default answer",
    ])
  })

  test("an unknown role is 404", async () => {
    const h = await harness(runtime, answering, { actor: member })

    expect((await call(h, ask("hi"), "poet")).status).toBe(404)
    expect((await h.fetch("/api/model", { method: "POST", body: body(ask("hi")) })).status).toBe(404)
  })
})

describe("what the model receives", () => {
  test("the role's model id and bounded output, with the caller's conversation, system prompt and tools", async () => {
    const h = await harness(runtime, answering, { actor: member, config: { MODEL_MAX_OUTPUT_TOKENS: "500" } })
    const tools = [ModelRequest.ToolDefinition.make({ name: "open_file", description: "Open a file", parameters: {} })]

    await call(h, ask("hi", { tools, params: ModelRequest.GenerationParams.make({ thinkingBudget: 9_000 }) }))
    await call(h, ask("again", { params: ModelRequest.GenerationParams.make({ maxTokens: 100 }) }))

    const [first, second] = h.requests
    expect(first!.modelId).toBe("test-model")
    expect(first!.system.map((part) => part.text)).toEqual(["browser system"])
    expect(first!.tools.map((tool) => tool.name)).toEqual(["open_file"])
    expect(first!.params).toMatchObject({ maxTokens: 500, thinkingBudget: 500 })
    expect(second!.params.maxTokens).toBe(100)
    expect(second!.params.thinkingBudget).toBeUndefined()
  })

  test.each([
    ["provider-run tools", ask("q", { serverTools: [{ type: "web_search" }] }), "Send no provider-run tools."],
    ["no messages", ask("q", { messages: [] }), "Send at least one message."],
    [
      "more messages than MODEL_MAX_MESSAGES",
      ask("q", { messages: [ModelRequest.Message.user("a"), ModelRequest.Message.user("b"), ModelRequest.Message.user("c")] }),
      "Send at most 2 messages.",
    ],
    // The reservation counts the output and thinking caps, so a cap that isn't a whole number of tokens would shrink
    // it while the provider still spends (Opus review 4, P2-1).
    ...([
      ["a negative maxTokens", { maxTokens: -8_000 }],
      ["a maxTokens of 0", { maxTokens: 0 }],
      ["a fractional maxTokens", { maxTokens: 10.5 }],
      ["a negative thinkingBudget", { thinkingBudget: -8_000 }],
      ["a fractional thinkingBudget", { thinkingBudget: 0.5 }],
    ] as const).map(([name, params]) =>
      [
        name,
        ask("q", { params: ModelRequest.GenerationParams.make(params) }),
        "Send maxTokens as a whole number above 0 and thinkingBudget as a whole number of at least 0.",
      ] as const
    ),
  ] as const)("refuses %s with 400", async (_, request, message) => {
    const h = await harness(runtime, answering, { actor: member, config: { MODEL_MAX_MESSAGES: "2" } })

    const { status, error } = await call(h, request)

    expect(status).toBe(400)
    expect(error).toMatchObject({ code: "invalid_request", message })
    expect(h.requests).toEqual([])
    expect(await ledger()).toEqual([])
  })

  test("a thinking budget of 0 is allowed and reserves nothing for thinking", async () => {
    const h = await harness(runtime, answering, { actor: member, config: { MODEL_MAX_OUTPUT_TOKENS: "500" } })

    expect((await call(h, ask("q", { params: ModelRequest.GenerationParams.make({ thinkingBudget: 0 }) }))).status)
      .toBe(200)
    expect(h.requests[0]!.params).toMatchObject({ maxTokens: 500, thinkingBudget: 0 })
  })

  test("concurrent calls with a negative thinking budget can't pass the budget: they never run", async () => {
    // The reproduction from Opus review 4, P2-1: eight calls at once against a budget of 20,000, each asking for 8,000
    // output tokens with a thinking budget of -8,000, all passed the budget and spent 64,800 tokens.
    let open = () => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    const h = await harness(runtime, gated(gate), { actor: member, config: { MODEL_DAILY_TOKEN_BUDGET: "20000" } })
    const request = ask("hi", { params: ModelRequest.GenerationParams.make({ maxTokens: 8_000, thinkingBudget: -8_000 }) })

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => h.fetch("/api/model/agent", { method: "POST", body: body(request) })),
    )
    open()
    await Promise.all(responses.map((response) => response.text()))

    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 8 }, () => 400))
    expect(h.requests).toEqual([])
    expect(await committedToday()).toBe(0)
  })
})

describe("the request's size", () => {
  test("a body over MODEL_MAX_REQUEST_BYTES is 413 and never reaches a model or the budget", async () => {
    const h = await harness(runtime, answering, { actor: member, config: { MODEL_MAX_REQUEST_BYTES: "512" } })
    const small = ask("hi")
    const large = ask("x".repeat(600))

    const fits = await call(h, small)
    const refused = await call(h, large)

    expect(new TextEncoder().encode(body(small)).length).toBeLessThanOrEqual(512)
    expect(fits.status).toBe(200)
    expect(refused.status).toBe(413)
    expect(refused.error).toMatchObject({ code: "invalid_request", message: "Send at most 512 bytes." })
    expect(h.requests).toHaveLength(1)
    expect(await ledger()).toHaveLength(1)
  })

  test("the bound is 192 KiB unless set, and a positive integer", async () => {
    const h = await harness(runtime, answering, { actor: member })

    const under = await call(h, ask("x".repeat(ModelEndpoint.MAX_REQUEST_BYTES - 1_024)))
    const over = await call(h, ask("x".repeat(ModelEndpoint.MAX_REQUEST_BYTES)))

    expect(ModelEndpoint.MAX_REQUEST_BYTES).toBe(192 * 1024)
    expect([under.status, over.status]).toEqual([200, 413])
    await expect(harness(runtime, answering, { config: { MODEL_MAX_REQUEST_BYTES: "0" } })).rejects.toThrow()
  })
})

describe("roles", () => {
  test("replaying an older model change preserves the newer setting and audit", async () => {
    const first = { role: "judge" as const, model: rowModel("https://models.example", "first") }
    const second = { ...first, model: rowModel("https://models.example", "second") }
    const by = { actorId: "person-admin", invocationKey: "first-step" }
    await runtime.runPromise(ModelRoles.set(first, by))
    await runtime.runPromise(ModelRoles.set(second, { ...by, invocationKey: "second-step" }))
    await runtime.runPromise(ModelRoles.set(first, by))
    const result = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      SELECT model->>'modelId' AS model, (SELECT count(*)::int FROM model_role_changes) AS changes
      FROM model_roles WHERE role = 'judge'`))
    expect(result).toEqual([{ model: "second", changes: 2 }])
  })

  test("a model permission failure is not counted as a quota refusal", async () => {
    const denied = { _tag: "PermissionDenied" } as unknown as Model.ModelFailure
    const h = await harness(runtime, () => Stream.fail(denied), { actor: member })
    const response = await call(h, ask("hi"))
    expect(response.lines.at(-1)).toMatchObject({ type: "error" })
    expect(h.line("model.quota.refused")).toHaveLength(0)
  })

  test("a credit refusal without an HTTP status still terminates and records safe telemetry", async () => {
    const h = await harness(runtime, () => Stream.fail(new ModelError.ModelError({
      code: "out_of_credit", message: "private balance detail", retryAfterMillis: 60_000,
    })), { actor: member })
    const response = await call(h, ask("private question"))
    expect(response.lines.at(-1)).toMatchObject({ type: "error", code: "out_of_credit" })
    expect(response.lines.at(-1).retryAfterMillis).toBeUndefined()
    expect(h.only("model.quota.refused").annotations).toMatchObject({ role: "agent", errorCode: "out_of_credit", httpStatus: 0 })
    expect(h.span("model.quota.refused")[0]!.attributes.get("httpStatus")).toBe(0)
    expect(h.count(ModelEndpoint.quotaRefusals, { role: "agent", errorCode: "out_of_credit" })).toBe(1)
    // Without the provider's status its usage remains unknown, so metering stays conservative.
    expect(h.count(ModelEndpoint.usageWrites, { outcome: "kept" })).toBe(1)
    expect(recorded(h)).not.toContain("private balance detail")
    expect(recorded(h)).not.toContain("private question")
  })

  test.each([
    { code: "quota_exceeded" as const, httpStatus: 429 },
    { code: "out_of_credit" as const, httpStatus: 429 },
    { code: "provider_internal" as const, httpStatus: 402 },
    { code: "rate_limited" as const, httpStatus: 429 },
  ])("deployment refusal $code ($httpStatus) preserves only recoverable retry hints and records no content", async ({ code, httpStatus }) => {
    const h = await harness(runtime, () => Stream.fail(new ModelError.ModelError({
      code, httpStatus, message: "private provider detail", retryAfterMillis: 60_000,
      resetAtEpochMillis: 123456789, quotaScope: "model",
    })), { actor: member })
    const response = await call(h, ask("private question"))
    const failure = response.lines.at(-1)
    expect(failure).toMatchObject({ type: "error", code: httpStatus === 402 ? "out_of_credit" : code })
    if (code === "rate_limited") {
      expect(failure).toMatchObject({ retryAfterMillis: 60_000 })
    } else {
      expect(failure.retryAfterMillis).toBeUndefined()
      expect(failure.resetAtEpochMillis).toBeUndefined()
      expect(failure.quotaScope).toBeUndefined()
    }
    expect(h.only("model.proxy.serve").annotations).toMatchObject({ outcome: "failed", errorCode: httpStatus === 402 ? "out_of_credit" : code })
    expect(h.count(ModelEndpoint.usageWrites, { outcome: "refused" })).toBe(1)
    expect(h.count(ModelProxy.requests, { role: "agent", side: "server", outcome: "failed", status: "200" })).toBe(1)
    expect(h.span("model.proxy.serve")[0]!.attributes.get("error.type")).toBe(httpStatus === 402 ? "out_of_credit" : code)
    expect(h.only("model.usage").annotations).toMatchObject({ outcome: "refused", errorCode: httpStatus === 402 ? "out_of_credit" : code })
    if (code === "rate_limited") {
      expect(h.line("model.quota.refused")).toHaveLength(0)
    } else {
      const errorCode = httpStatus === 402 ? "out_of_credit" : code
      expect(h.only("model.quota.refused").annotations).toMatchObject({ role: "agent", errorCode, httpStatus })
      expect(h.span("model.quota.refused")[0]!.attributes.get("errorCode")).toBe(errorCode)
      expect(h.count(ModelEndpoint.quotaRefusals, { role: "agent", errorCode })).toBe(1)
    }
    expect(recorded(h)).not.toContain("private provider detail")
    expect(recorded(h)).not.toContain("private question")
  })

  test("a role with no setting uses the deployment's default model", async () => {
    const h = await harness(runtime, answering, { actor: member, modelId: "default-model" })

    await call(h, ask("hi"), "renderer")

    expect(h.requests[0]!.modelId).toBe("default-model")
    expect(h.only("model.proxy.serve").annotations).toMatchObject({ role: "renderer", modelId: "default-model" })
  })

  test("a role change made by admin/SetModel applies on the next call, with no deploy", async () => {
    const upstream = await provider({ text: "row answer" })
    const h = await harness(runtime, answering, { actor: member, config: keyConfig(upstream.origin) })

    const before = await call(h, ask("first"))
    const ran = await setModel(admin, { role: "agent", model: rowModel(upstream.origin) })
    const after = await call(h, ask("second"))

    expect(before.lines[0]).toEqual({ type: "text-delta", id: "t", text: "default answer" })
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toEqual({ role: "agent", modelId: "row-model" })
    expect(ran.status).toBe("completed")
    expect(after.lines.filter((line) => line.type === "text-delta")).toEqual([
      { type: "text-delta", id: expect.any(String), text: "row answer" },
    ])
    expect(upstream.seen).toHaveLength(1)
    expect(upstream.seen[0]!.body.model).toBe("row-model")
    expect(upstream.seen[0]!.headers.authorization).toBe("Bearer row-key")
    expect(h.requests).toHaveLength(1)
    // The other roles keep the default.
    await call(h, ask("third"), "judge")
    expect(h.requests).toHaveLength(2)
  })

  test("replaying an older setting preserves the newer setting and its audit history", async () => {
    const first = { role: "judge" as const, model: rowModel("https://models.example", "judge-old") }
    const second = { role: "judge" as const, model: rowModel("https://models.example", "judge-new") }
    const by = { actorId: "person-admin", invocationKey: crypto.randomUUID() }
    await runtime.runPromise(ModelRoles.set(first, by))
    await runtime.runPromise(ModelRoles.set(second, { ...by, invocationKey: crypto.randomUUID() }))
    const read = () => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      SELECT model, updated_by, updated_at FROM model_roles WHERE role = 'judge'`))
    const before = await read()
    await runtime.runPromise(ModelRoles.set(first, by))
    expect(await read()).toEqual(before)
    expect(before[0]!.model).toEqual(second.model)
    const audit = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      SELECT model FROM model_role_changes ORDER BY id`))
    expect(audit.map((row) => row.model)).toEqual([first.model, second.model])
  })

  test("the coding role answers as the agent role does, its setting included, until an admin sets coding itself", async () => {
    const agentModel = await provider({ text: "agent row answer" })
    const codingModel = await provider({ text: "coding row answer" })
    const h = await harness(runtime, answering, {
      actor: member,
      modelId: "default-model",
      config: {
        SMITHERS_MODEL_KEY_FIXTURE: "row-key",
        SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: agentModel.origin,
        SMITHERS_MODEL_KEY_CODER: "coder-key",
        SMITHERS_MODEL_KEY_CODER_ORIGIN: codingModel.origin,
      },
    })

    // No setting for either: the deployment's default, booked as coding.
    await call(h, ask("first"), "coding")
    expect(h.requests.map((request) => request.modelId)).toEqual(["default-model"])
    expect(h.only("model.proxy.serve").annotations).toMatchObject({ role: "coding", modelId: "default-model" })
    // The agent role's setting: coding follows it.
    await setModel(admin, { role: "agent", model: rowModel(agentModel.origin, "agent-row") })
    const followed = await call(h, ask("second"), "coding")
    expect(followed.lines.filter((line) => line.type === "text-delta").map((line) => line.text)).toEqual(["agent row answer"])
    // Its own setting, an origin-pinned key of its own: coding goes there, and the agent role stays.
    const ran = await setModel(admin, {
      role: "coding",
      model: { protocol: "openai-chat", baseUrl: codingModel.origin, modelId: "coder-1", credential: "CODER" },
    })
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toEqual({ role: "coding", modelId: "coder-1" })
    const own = await call(h, ask("third"), "coding")
    const agent = await call(h, ask("fourth"), "agent")
    expect(own.lines.filter((line) => line.type === "text-delta").map((line) => line.text)).toEqual(["coding row answer"])
    expect(agent.lines.filter((line) => line.type === "text-delta").map((line) => line.text)).toEqual(["agent row answer"])
    expect(codingModel.seen.map((seen) => [seen.body.model, seen.headers.authorization])).toEqual([["coder-1", "Bearer coder-key"]])
  })

  test("admin/SetModel records who changed what, once per step", async () => {
    const ran = await setModel(admin, { role: "judge", model: rowModel("https://models.example", "judge-1") })

    const [row] = await runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql<{ readonly model: unknown; readonly updatedBy: string }>`
            SELECT model, updated_by AS "updatedBy" FROM model_roles WHERE role = 'judge'`,
      ),
    )
    const changes = await runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly role: string; readonly changedBy: string }>`
          SELECT role, changed_by AS "changedBy" FROM model_role_changes`,
      ),
    )
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    expect(row).toEqual({ model: rowModel("https://models.example", "judge-1"), updatedBy: "person-admin" })
    expect(changes).toEqual([{ role: "judge", changedBy: "person-admin" }])
  })

  test.each([
    ["an agent acting for an admin", agentForAdmin, "delegated"],
    ["a member", member, "not_admin"],
  ] as const)("%s can't run admin/SetModel, and nothing is written", async (_, actor, reason) => {
    const ran = await setModel(actor, { role: "agent", model: rowModel("https://models.example") })

    expect(Exit.isFailure(ran.exit)).toBe(true)
    expect(Exit.isFailure(ran.exit) && JSON.stringify(ran.exit.cause)).toContain(reason)
    expect(ran.status).toBe("failed")
    const counts = await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly settings: number; readonly changes: number }>`
          SELECT (SELECT count(*)::int FROM model_roles) AS settings,
            (SELECT count(*)::int FROM model_role_changes) AS changes`),
    )
    expect(counts).toEqual([{ settings: 0, changes: 0 }])
  })

  test("a setting the Worker can't use is refused with 409 no_route, logged by its reason", async () => {
    const h = await harness(runtime, answering, { actor: member })
    await setModel(admin, { role: "agent", model: rowModel("https://models.example") })
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO model_roles (role, model, updated_by) VALUES ('judge', '{"modelId": 1}'::jsonb, 'person-admin')`),
    )

    const missingKey = await call(h, ask("hi"))
    const notARecord = await call(h, ask("hi"), "judge")

    for (const { status, error } of [missingKey, notARecord]) {
      expect(status).toBe(409)
      expect(error).toMatchObject({ code: "no_route", message: "This model isn't available." })
    }
    expect(h.line("model.endpoint").map(({ annotations }) => [annotations.role, annotations.errorCode])).toEqual([
      ["agent", "unusable:credential_unknown"],
      ["judge", "unusable:invalid"],
    ])
    expect(h.requests).toEqual([])
  })
})

/** Runs `admin/SetHostedModel` on the Node host as `actor`, writing to this file's schema. */
const setHosted = async (actor: Actor, enabled: boolean) =>
  runFlow(
    HostedModel.SetHostedModel,
    { enabled },
    HostedModel.registration(await scratchDatabase()).pipe(Layer.provide(Layer.succeed(CurrentActor, actor))),
  )

describe("hosted inference", () => {
  test("off by default: a person without a model of their own is told to add one, and the deployment's model never runs", async () => {
    const h = await harness(runtime, answering, { actor: member, config: { HOSTED_MODEL_ENABLED: "not a boolean" } })
    const unset = await harness(runtime, answering, { actor: member, config: { HOSTED_MODEL_ENABLED: undefined as unknown as string } })

    for (const refused of [await call(h, ask("hi")), await call(unset, ask("hi"), "summary")]) {
      expect(refused.status).toBe(409)
      expect(refused.error).toMatchObject({ code: "no_route", message: "Add your model in Settings to ask Smithers." })
    }
    expect(h.line("model.endpoint").map(({ annotations }) => [annotations.role, annotations.errorCode])).toEqual([["agent", "hosted_off"]])
    expect(h.requests).toEqual([])
    expect(unset.requests).toEqual([])
    expect(await usageRows()).toEqual([])
  })

  test("admin/SetHostedModel turns it on and off on the next call, with no deploy, and records who did", async () => {
    const h = await harness(runtime, answering, { actor: member, config: { HOSTED_MODEL_ENABLED: "false" } })

    const before = await call(h, ask("first"))
    const on = await setHosted(admin, true)
    const served = await call(h, ask("second"))
    await setHosted(admin, false)
    const after = await call(h, ask("third"))

    expect(before.status).toBe(409)
    expect(Exit.isSuccess(on.exit) && on.exit.value).toEqual({ enabled: true })
    expect(served.lines[0]).toEqual({ type: "text-delta", id: "t", text: "default answer" })
    expect(after.status).toBe(409)
    expect(h.requests).toHaveLength(1)
    const changes = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly enabled: boolean; readonly changedBy: string }>`
        SELECT enabled, changed_by AS "changedBy" FROM hosted_model_changes ORDER BY changed_at`))
    expect(changes).toEqual([{ enabled: true, changedBy: "person-admin" }, { enabled: false, changedBy: "person-admin" }])
  })

  test("a replayed change leaves the newer setting and its audit as they were", async () => {
    const by = { actorId: "person-admin", invocationKey: crypto.randomUUID() }
    await runtime.runPromise(HostedModel.set(true, by))
    await runtime.runPromise(HostedModel.set(false, { ...by, invocationKey: crypto.randomUUID() }))
    await runtime.runPromise(HostedModel.set(true, by))
    expect(await runtime.runPromise(HostedModel.enabled(true))).toBe(false)
    const [counted] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly changes: number }>`SELECT count(*)::int AS changes FROM hosted_model_changes`))
    expect(counted).toEqual({ changes: 2 })
  })

  test.each([
    ["an agent acting for an admin", agentForAdmin, "delegated"],
    ["a member", member, "not_admin"],
  ] as const)("%s can't run admin/SetHostedModel, and nothing is written", async (_, actor, reason) => {
    const ran = await setHosted(actor, true)

    expect(Exit.isFailure(ran.exit) && JSON.stringify(ran.exit.cause)).toContain(reason)
    expect(await runtime.runPromise(HostedModel.enabled(false))).toBe(false)
  })

  test("a step with no invocation key is a defect, before touching Postgres", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://nobody:nothing@127.0.0.1:1/none")))

    const exit = await Effect.runPromiseExit(HostedModel.write({ enabled: true }, admin, undefined, unreachable))

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(SetModel.NoInvocationKey)
  })

  test("a change Postgres can't write fails the run, and the setting stays as it was", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://nobody:nothing@127.0.0.1:1/none")))
    const ran = await runFlow(
      HostedModel.SetHostedModel,
      { enabled: true },
      HostedModel.registration(unreachable).pipe(Layer.provide(Layer.succeed(CurrentActor, admin))),
    )

    expect(Exit.isFailure(ran.exit)).toBe(true)
    expect(await runtime.runPromise(HostedModel.enabled(false))).toBe(false)
  })

  test("a setting Postgres can't read is a 503 provider_internal, never the deployment's model", async () => {
    const h = await harness(runtime, answering, { actor: member, config: { HOSTED_MODEL_ENABLED: "true" } })
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE hosted_model RENAME TO hosted_model_gone`))
    try {
      const refused = await call(h, ask("hi"))
      expect(refused.status).toBe(503)
      expect(refused.error).toMatchObject({ code: "provider_internal" })
      expect(h.requests).toEqual([])
    } finally {
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`ALTER TABLE hosted_model_gone RENAME TO hosted_model`))
    }
  })
})

describe("a role's routing and reasoning", () => {
  const routed = (origin: string, modelId = "row-model"): ModelRoles.ModelRecord => ({
    ...rowModel(origin, modelId),
    path: "/v1/chat/completions",
    extraBody: { providerOptions: { gateway: { order: ["cerebras", "alibaba"] } } },
    reasoningEffort: "none",
  })
  const texts = (lines: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
    lines.filter((line) => line.type === "text-delta").map((line) => line.text)

  test("a role's extra body and reasoning effort reach its provider beneath the request's own fields", async () => {
    const upstream = await provider({ text: "routed answer" })
    const h = await harness(runtime, answering, { actor: member, config: keyConfig(upstream.origin) })

    const ran = await setModel(admin, { role: "summary", model: routed(upstream.origin) })
    const answered = await call(h, ask("label this"), "summary")

    expect(ran.status).toBe("completed")
    expect(texts(answered.lines)).toEqual(["routed answer"])
    expect(upstream.seen[0]!.body).toMatchObject({
      model: "row-model",
      max_tokens: 8_000,
      reasoning_effort: "none",
      providerOptions: { gateway: { order: ["cerebras", "alibaba"] } },
    })
  })

  test("admin/SetModel refuses an extra body that names a credential, and writes nothing", async () => {
    const ran = await setModel(admin, {
      role: "agent",
      model: { ...rowModel("https://models.example"), extraBody: { providerOptions: { gateway: { byok: { x: [{ apiKey: "k" }] } } } } },
    })

    expect(Exit.isFailure(ran.exit)).toBe(true)
    const [counted] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly settings: number }>`SELECT count(*)::int AS settings FROM model_roles`))
    expect(counted).toEqual({ settings: 0 })
  })

  test("a record with no base URL reaches the planner without one, which refuses it for a chat route", async () => {
    const h = await harness(runtime, answering, { actor: member })
    await setModel(admin, { role: "judge", model: { protocol: "openai-chat", modelId: "own-origin", credential: "CEREBRAS_API_KEY" } })

    const refused = await call(h, ask("hi"), "judge")

    expect(refused.status).toBe(409)
    expect(h.only("model.endpoint").annotations).toMatchObject({ role: "judge", errorCode: "unusable:invalid" })
    expect(h.requests).toEqual([])
  })

  test("SUMMARY_MODEL's own effort answers the summary role when no admin set one", async () => {
    const upstream = await provider({ text: "Summary label" })
    const h = await harness(runtime, answering, {
      actor: member,
      config: { SUMMARY_MODEL: JSON.stringify({ ...rowModel(upstream.origin, "cheap"), reasoningEffort: "minimal" }), ...keyConfig(upstream.origin) },
    })

    expect(texts((await call(h, ask("hi"), "summary")).lines)).toEqual(["Summary label"])
    expect(upstream.seen[0]!.body).toMatchObject({ model: "cheap", reasoning_effort: "minimal" })
  })

  test("plan and review answer with the agent's and the judge's settings until a tier or an admin names their own", async () => {
    const agentModel = await provider({ text: "agent row" })
    const judgeModel = await provider({ text: "judge row" })
    const h = await harness(runtime, answering, {
      actor: member,
      config: {
        SMITHERS_MODEL_KEY_FIXTURE: "row-key",
        SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: agentModel.origin,
        SMITHERS_MODEL_KEY_JUDGE: "judge-key",
        SMITHERS_MODEL_KEY_JUDGE_ORIGIN: judgeModel.origin,
      },
    })
    await setModel(admin, { role: "agent", model: rowModel(agentModel.origin, "agent-row") })
    await setModel(admin, {
      role: "judge",
      model: { protocol: "openai-chat", baseUrl: judgeModel.origin, modelId: "judge-row", credential: "JUDGE" },
    })
    expect(texts((await call(h, ask("draft"), "plan")).lines)).toEqual(["agent row"])
    expect(texts((await call(h, ask("review"), "review")).lines)).toEqual(["judge row"])
    expect(h.line("model.proxy.serve").map(({ annotations }) => [annotations.role, annotations.modelId])).toEqual([
      ["plan", "agent-row"],
      ["review", "judge-row"],
    ])
  })

  test("TIER_MODELS answers each role without its own setting on the role's tier, before any role it inherits from", async () => {
    const upstream = await provider({ text: "tiered" })
    const h = await harness(runtime, answering, {
      actor: member,
      modelId: "default-model",
      config: {
        TIER_MODELS: JSON.stringify({ hard: rowModel(upstream.origin, "hard-model"), fast: { ...rowModel(upstream.origin, "fast-model"), reasoningEffort: "minimal" } }),
        ...keyConfig(upstream.origin),
      },
    })
    await setModel(admin, { role: "judge", model: rowModel("https://judge.example", "judge-row") })
    for (const role of ["review", "plan", "summary", "renderer"]) {
      expect(texts((await call(h, ask(role), role)).lines), role).toEqual(["tiered"])
    }
    // No implement model: the coding role keeps the deployment's default.
    await call(h, ask("code"), "coding")
    expect(upstream.seen.map((seen) => [seen.body.model, seen.body.reasoning_effort ?? null])).toEqual([
      ["hard-model", null],
      ["hard-model", null],
      // The tier record's effort wins over the role's.
      ["fast-model", "minimal"],
      ["fast-model", "minimal"],
    ])
    expect(h.requests.map((request) => request.modelId)).toEqual(["default-model"])
  })

  test("a TIER_MODELS that doesn't parse refuses each role without a setting 409, logged unusable:config", async () => {
    const h = await harness(runtime, answering, { actor: member, config: { TIER_MODELS: "{\"hard\":{\"protocol\":\"\"}}" } })
    expect((await call(h, ask("hi"), "review")).status).toBe(409)
    expect(h.only("model.endpoint").annotations).toMatchObject({ role: "review", errorCode: "unusable:config" })
    expect(h.requests).toEqual([])
  })

  test("the deployment's default model gets a role's effort only when it takes one: a judge low, else none", async () => {
    const reasoning = await harness(runtime, answering, { actor: member, modelId: "gpt-oss-120b" })
    await call(reasoning, ask("is this a bug?"), "judge")
    await call(reasoning, ask("hi"), "agent")
    const plain = await harness(runtime, answering, { actor: member, modelId: "qwen-3.8-27b" })
    await call(plain, ask("is this a bug?"), "judge")
    expect(reasoning.requests.map((request) => request.params.reasoningEffort ?? null)).toEqual(["low", null])
    expect(plain.requests.map((request) => request.params.reasoningEffort ?? null)).toEqual([null])
    expect(reasoning.count(ModelTiers.effortHints, { role: "judge", outcome: "sent" })).toBe(1)
    expect(plain.count(ModelTiers.effortHints, { role: "judge", outcome: "dropped" })).toBe(1)
  })
})

describe("database failures", () => {
  test("a role lookup Postgres refuses is a 503 provider_internal, logged by its SQL reason", async () => {
    const sql = (statement: string) =>
      runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement)))
    await sql("ALTER TABLE model_roles RENAME TO model_roles_away")
    try {
      const h = await harness(runtime, answering, { actor: member })
      const { status, error } = await call(h, ask("hi"))

      expect(status).toBe(503)
      expect(error).toMatchObject({ code: "provider_internal" })
      expect(h.only("model.endpoint").annotations).toMatchObject({ role: "agent", errorCode: expect.stringMatching(/^sql:/) })
    } finally {
      await sql("ALTER TABLE model_roles_away RENAME TO model_roles")
    }
  })
})

describe("budget and metering", () => {
  test("each served call records what it spent, by role and model, as a row and a metric", async () => {
    const h = await harness(runtime, answering, { actor: member })

    await call(h, ask("hi"))
    await call(h, ask("hi"), "renderer")

    expect(await usageRows()).toEqual([
      { role: "agent", modelId: "test-model", inputTokens: 12, outputTokens: 34 },
      { role: "renderer", modelId: "test-model", inputTokens: 12, outputTokens: 34 },
    ])
    expect(h.count(ModelProxy.tokens, { role: "agent", type: "output", model: "test-model" })).toBe(34)
    expect(h.count(ModelProxy.tokens, { role: "renderer", type: "input", model: "test-model" })).toBe(12)
    expect(h.count(ModelEndpoint.usageWrites, { outcome: "recorded" })).toBe(2)
  })

  test("calls that repeat one request id each book what they spent, against the budget", async () => {
    // One call spends 10,000 tokens; the budget allows two.
    const h = await harness(runtime, spending(10_000), { actor: member, config: { MODEL_DAILY_TOKEN_BUDGET: "20000" } })
    const repeat = () =>
      h.fetch("/api/model/agent", {
        method: "POST",
        headers: { [ModelProxy.requestIdHeader]: "same" },
        body: body(ask("hi")),
      }).then((response) => response.text().then(() => response.status))

    expect([await repeat(), await repeat(), await repeat()]).toEqual([200, 200, 429])
    expect(h.requests).toHaveLength(2)
    const rows = await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly invocationId: string; readonly requestId: string; readonly tokens: number }>`
          SELECT invocation_id AS "invocationId", request_id AS "requestId", input_tokens + output_tokens AS tokens
          FROM model_usage ORDER BY created_at`),
    )
    expect(rows.map(({ requestId, tokens }) => ({ requestId, tokens }))).toEqual([
      { requestId: "same", tokens: 10_000 },
      { requestId: "same", tokens: 10_000 },
    ])
    // Each row is keyed by the call the server served, the id its log line carries, never by the caller's id.
    expect(rows.map((row) => row.invocationId)).toEqual(
      h.line("model.proxy.serve").filter((line) => line.annotations.status === 200).map((line) =>
        line.annotations.invocationId
      ),
    )
  })

  test("a call is refused with 429 quota_exceeded once today's spend reaches the budget", async () => {
    // One call spends 10,000 tokens, the whole budget.
    const h = await harness(runtime, spending(10_000), { actor: member, config: { MODEL_DAILY_TOKEN_BUDGET: "10000" } })

    const first = await call(h, ask("hi"))
    const second = await call(h, ask("hi"))

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(second.error).toMatchObject({ code: "quota_exceeded", message: "Today's model budget is spent." })
    expect(h.requests).toHaveLength(1)
  })

  test("yesterday's spend doesn't count against today's budget", async () => {
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO model_budget_days (day, committed)
        VALUES ((now() AT TIME ZONE 'UTC')::date - 1, 1000000)`),
    )
    const h = await harness(runtime, answering, { actor: member, config: { MODEL_DAILY_TOKEN_BUDGET: "10000" } })

    expect((await call(h, ask("hi"))).status).toBe(200)
    expect(await committedToday()).toBe(46)
  })

  test("concurrent calls can't overshoot: against a budget of one call's reservation, eight at once admit exactly one", async () => {
    // Every admitted call holds its model until all eight have answered, so a budget read before the call and
    // written after it would let all eight through. One call reserves its body's bytes plus the 8,000 output tokens.
    let open = () => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    const reservation = new TextEncoder().encode(body(ask("hi"))).length + 8_000
    const h = await harness(runtime, gated(gate), {
      actor: member,
      config: { MODEL_DAILY_TOKEN_BUDGET: String(reservation) },
    })

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => h.fetch("/api/model/agent", { method: "POST", body: body(ask("hi")) })),
    )
    open()
    const bodies = await Promise.all(responses.map((response) => response.text()))

    expect(responses.map((response) => response.status).sort()).toEqual([200, 429, 429, 429, 429, 429, 429, 429])
    expect(bodies.filter((text) => text.includes("quota_exceeded"))).toHaveLength(7)
    expect(h.requests).toHaveLength(1)
    expect(await committedToday()).toBe(46)
    expect(await ledger()).toEqual([
      { invocationId: expect.any(String), reserved: expect.any(Number), inputTokens: 12, outputTokens: 34, settled: true },
    ])
  })

  test("a call reserves its worst case before the model runs, then settles to what it spent", async () => {
    const seen: Array<{ readonly committed: number; readonly rows: Awaited<ReturnType<typeof ledger>> }> = []
    const h = await harness(
      runtime,
      () =>
        Stream.fromEffect(
          Effect.promise(async () => void seen.push({ committed: await committedToday(), rows: await ledger() })),
        ).pipe(Stream.flatMap(() => Stream.make(delta("ok"), usage, stop))),
      { actor: member, config: { MODEL_MAX_OUTPUT_TOKENS: "500" } },
    )
    const request = ask("hi", { params: ModelRequest.GenerationParams.make({ thinkingBudget: 9_000 }) })
    const bytes = new TextEncoder().encode(body(request)).length

    const { status } = await call(h, request)

    // Every byte of the body counted as a prompt token, plus the output and thinking caps, both clamped to 500.
    const reserved = bytes + 500 + 500
    expect(status).toBe(200)
    expect(seen).toEqual([{
      committed: reserved,
      rows: [{ invocationId: expect.any(String), reserved, inputTokens: 0, outputTokens: 0, settled: false }],
    }])
    expect(await committedToday()).toBe(46)
    expect(await ledger()).toEqual([
      { invocationId: seen[0]!.rows[0]!.invocationId, reserved, inputTokens: 12, outputTokens: 34, settled: true },
    ])
    // The ledger's key is the call the server served: the id its log line carries.
    expect(h.only("model.proxy.serve").annotations.invocationId).toBe(seen[0]!.rows[0]!.invocationId)
  })

  // Usage is what the call spent only when the call ended normally and the model reported both its input and output.
  // Anything less is unknown, never zero: the model may have spent tokens it never reported, so the call keeps its
  // reservation (Codex review 4, P1). These calls all stream paid output before they end.
  const reservationOf = (request: ModelRequest.ModelRequest) =>
    new TextEncoder().encode(body(request)).length + ModelEndpoint.MAX_OUTPUT_TOKENS
  const transportFailure = Stream.fail(new ModelError.ModelError({ code: "transport", message: "connection reset" }))

  test("a call whose client goes away after its text, before usage, keeps its whole reservation", async () => {
    const h = await harness(runtime, () => Stream.make(delta("paid output")).pipe(Stream.concat(Stream.never)), {
      actor: member,
    })
    const request = ask("hi")

    const response = await h.fetch("/api/model/agent", { method: "POST", body: body(request) })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()

    await eventually(async () => (await ledger())[0]?.settled === true)
    expect(await committedToday()).toBe(reservationOf(request))
    expect(h.only("model.proxy.serve").annotations).toMatchObject({ outcome: "interrupted" })
    expect(h.count(ModelEndpoint.usageWrites, { outcome: "kept" })).toBe(1)
    expect(h.only("model.usage")).toMatchObject({
      level: "INFO",
      annotations: { role: "agent", outcome: "kept", ended: "interrupted", reported: "none" },
    })
    expect(await endings()).toEqual([{ outcome: "aborted", errorCode: null, httpStatus: null }])
  })

  test("each call's ledger row says how it ended: answered, refused with its code and status, or failed", async () => {
    const script: Array<() => Stream.Stream<ModelEvent.ModelEvent, ModelError.ModelError>> = [
      answering,
      () => Stream.fail(new ModelError.ModelError({ code: "quota_exceeded", httpStatus: 402, message: "private detail" })),
      () => transportFailure,
    ]
    const h = await harness(runtime, () => script.shift()!(), { actor: member })

    for (let n = 0; n < 3; n++) await call(h, ask("hi"))

    expect(await endings()).toEqual([
      { outcome: "answered", errorCode: null, httpStatus: null },
      { outcome: "refused", errorCode: "quota_exceeded", httpStatus: 402 },
      { outcome: "failed", errorCode: "transport", httpStatus: null },
    ])
    expect(JSON.stringify(await endings())).not.toContain("private detail")
  })

  test("a call that fails after its text, before usage, keeps its whole reservation", async () => {
    const h = await harness(runtime, () => Stream.make(delta("paid output")).pipe(Stream.concat(transportFailure)), {
      actor: member,
    })
    const request = ask("hi")

    const { lines } = await call(h, request)

    expect(lines.at(-1)).toMatchObject({ type: "error", code: "transport" })
    expect(await committedToday()).toBe(reservationOf(request))
    expect(await ledger()).toEqual([
      { invocationId: expect.any(String), reserved: reservationOf(request), inputTokens: 0, outputTokens: 0, settled: true },
    ])
    expect(h.only("model.usage").annotations).toMatchObject({ outcome: "kept", ended: "failed", reported: "none" })
  })

  test("a call that fails after partial or complete usage keeps its reservation, or what it reported when more", async () => {
    const script: Array<Stream.Stream<ModelEvent.ModelEvent, ModelError.ModelError>> = [
      // Only the input so far, as a provider reports it when the stream opens.
      Stream.make(delta("paid"), { type: "usage", inputTokens: 12 } as const).pipe(Stream.concat(transportFailure)),
      // Both counts, but not final: the call failed after them.
      Stream.make(usage, delta("paid")).pipe(Stream.concat(transportFailure)),
      // More than the reservation: the report is a lower bound, so the call counts at least that.
      Stream.make({ type: "usage", inputTokens: 900_000, outputTokens: 1 } as const).pipe(Stream.concat(transportFailure)),
    ]
    const h = await harness(runtime, () => script.shift()!, { actor: member })
    const request = ask("hi")

    await call(h, request)
    await call(h, request)
    expect(await committedToday()).toBe(2 * reservationOf(request))
    await call(h, request)

    expect(await committedToday()).toBe(2 * reservationOf(request) + 900_001)
    expect((await ledger()).map(({ inputTokens, outputTokens }) => [inputTokens, outputTokens])).toEqual([
      [12, 0],
      [12, 34],
      [900_000, 1],
    ])
    expect(h.line("model.usage").map((line) => line.annotations.reported)).toEqual(["partial", "complete", "complete"])
    expect(h.count(ModelEndpoint.usageWrites, { outcome: "kept" })).toBe(3)
  })

  // A provider outage refuses each call before it produces anything. Such a call spent nothing beyond the usage its
  // provider reported, so it settles to that usage, 0 when none: 23 refused calls once spent a 1,000,000-token day of
  // reservations, about 43,000 each, while the provider spent nothing (docs/features/agent-evals.md, 2026-10-20).
  const refusal = (fields: Partial<ConstructorParameters<typeof ModelError.ModelError>[0]> = {}) =>
    Stream.fail(new ModelError.ModelError({ code: "rate_limited", message: "slow down", httpStatus: 429, ...fields }))

  test("a call the provider refuses before any output settles to what it reported, 0 when nothing", async () => {
    const script: Array<Stream.Stream<ModelEvent.ModelEvent, ModelError.ModelError>> = [
      refusal(),
      // A 4xx with input usage reported: it settles to that, never to its reservation.
      Stream.make({ type: "usage", inputTokens: 7 } as const).pipe(
        Stream.concat(refusal({ code: "invalid_request", httpStatus: 400 })),
      ),
      // `rate_limited` without a status, as a route that gave up on its own retries reports it.
      Stream.make({ type: "retry", attempt: 1, code: "rate_limited", delayMillis: 0 } as const).pipe(
        Stream.concat(refusal({ httpStatus: undefined })),
      ),
    ]
    const h = await harness(runtime, () => script.shift()!, { actor: member })
    const request = ask("hi")

    const ended = [await call(h, request), await call(h, request), await call(h, request)]

    expect(ended.map(({ lines }) => lines.at(-1)?.code)).toEqual(["rate_limited", "invalid_request", "rate_limited"])
    expect(await committedToday()).toBe(7)
    expect((await charges()).map((row) => row.charged)).toEqual([0, 7, 0])
    expect(await reconciled()).toBe(true)
    expect(h.count(ModelEndpoint.usageWrites, { outcome: "refused" })).toBe(3)
    expect(h.line("model.usage").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ outcome: "refused", ended: "failed", errorCode: "rate_limited", reported: "none" }),
      expect.objectContaining({ outcome: "refused", ended: "failed", errorCode: "invalid_request", reported: "partial" }),
      expect.objectContaining({ outcome: "refused", ended: "failed", errorCode: "rate_limited", reported: "none" }),
    ])
  })

  test("an outage's refused calls never spend the day's budget, so the next call is served", async () => {
    const request = ask("hi")
    let refusing = 25
    const h = await harness(runtime, () => (refusing-- > 0 ? refusal() : answering()), {
      actor: member,
      // One reservation's worth: before the fix, the first refused call spent the whole day.
      config: { MODEL_DAILY_TOKEN_BUDGET: String(reservationOf(request)) },
    })

    for (let index = 0; index < 25; index++) expect((await call(h, request)).status).toBe(200)
    const served = await call(h, request)

    expect(served.lines.at(-1)).toEqual({ type: "end" })
    expect(await committedToday()).toBe(46)
  })

  test("a failure before any output that may have spent keeps its reservation: transport, 5xx, unknown", async () => {
    const script: Array<Stream.Stream<ModelEvent.ModelEvent, ModelError.ModelError>> = [
      transportFailure,
      refusal({ code: "provider_internal", httpStatus: 503 }),
      refusal({ code: "call_timeout", httpStatus: undefined }),
    ]
    const h = await harness(runtime, () => script.shift()!, { actor: member })
    const request = ask("hi")

    for (let index = 0; index < 3; index++) await call(h, request)

    expect(await committedToday()).toBe(3 * reservationOf(request))
    expect(h.count(ModelEndpoint.usageWrites, { outcome: "kept" })).toBe(3)
    expect(h.count(ModelEndpoint.usageWrites, { outcome: "refused" })).toBe(0)
  })

  test("a refusal after output keeps its reservation", async () => {
    const h = await harness(runtime, () => Stream.make(delta("paid output")).pipe(Stream.concat(refusal())), {
      actor: member,
    })
    const request = ask("hi")

    await call(h, request)

    expect(await committedToday()).toBe(reservationOf(request))
    expect(h.only("model.usage").annotations).toMatchObject({ outcome: "kept", ended: "failed", errorCode: "rate_limited" })
  })

  test("a call that ends normally without both counts keeps its reservation", async () => {
    const script: Array<Stream.Stream<ModelEvent.ModelEvent>> = [
      Stream.make(delta("paid"), stop),
      Stream.make(delta("paid"), { type: "usage", outputTokens: 34 } as const, stop),
    ]
    const h = await harness(runtime, () => script.shift()!, { actor: member })
    const request = ask("hi")

    expect((await call(h, request)).lines.at(-1)).toEqual({ type: "end" })
    expect((await call(h, request)).lines.at(-1)).toEqual({ type: "end" })

    expect(await committedToday()).toBe(2 * reservationOf(request))
    expect(h.line("model.usage").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ outcome: "kept", ended: "success", reported: "none" }),
      expect.objectContaining({ outcome: "kept", ended: "success", reported: "partial" }),
    ])
  })

  test("calls cancelled after their text, before usage, spend the budget until they are refused", async () => {
    const request = ask("hi")
    // Two reservations' worth: the third call finds the budget spent.
    const h = await harness(runtime, () => Stream.make(delta("paid output")).pipe(Stream.concat(Stream.never)), {
      actor: member,
      config: { MODEL_DAILY_TOKEN_BUDGET: String(2 * reservationOf(request)) },
    })
    const cancelled = async () => {
      const response = await h.fetch("/api/model/agent", { method: "POST", body: body(request) })
      if (response.status !== 200) return response.status
      const reader = response.body!.getReader()
      await reader.read()
      await reader.cancel()
      return response.status
    }

    expect(await cancelled()).toBe(200)
    await eventually(async () => (await ledger())[0]?.settled === true)
    expect(await cancelled()).toBe(200)
    await eventually(async () => (await ledger())[1]?.settled === true)
    expect(await cancelled()).toBe(429)

    expect(h.requests).toHaveLength(2)
    expect(await committedToday()).toBe(2 * reservationOf(request))
  })

  test("a settle that runs again changes nothing", async () => {
    const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect)
    const call = { invocationId: "call-1", requestId: "r", role: "agent" as const, modelId: "m" }
    const reserved = await run(ModelUsage.reserve({ ...call, tokens: 100 }, { budget: 1_000, expiry }))
    const spent = { invocationId: "call-1", inputTokens: 10, outputTokens: 5, complete: true, ended }

    const settled = [
      await run(ModelUsage.settle(spent)),
      await run(ModelUsage.settle(spent)),
      await run(ModelUsage.settle({ ...spent, inputTokens: 999 })),
    ]

    expect(reserved).toBe(true)
    expect(settled).toEqual([true, false, false])
    expect(await committedToday()).toBe(15)
    expect(await ledger()).toEqual([
      { invocationId: "call-1", reserved: 100, inputTokens: 10, outputTokens: 5, settled: true },
    ])
  })

  test("a reservation is refused only once committed spend reaches the budget, whatever its own size up to the budget", async () => {
    const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect)
    const reserve = (invocationId: string, tokens: number) =>
      run(ModelUsage.reserve({ invocationId, requestId: "r", role: "agent", modelId: "m", tokens }, { budget: 100, expiry }))

    // A call below the budget is admitted while committed is below it, so the overshoot is one call's.
    expect(await reserve("a", 60)).toBe(true)
    expect(await reserve("b", 100)).toBe(true)
    expect(await reserve("c", 1)).toBe(false)
    await run(ModelUsage.settle({ invocationId: "b", inputTokens: 20, outputTokens: 19, complete: true, ended }))
    expect(await reserve("d", 100)).toBe(true)
    expect(await reserve("e", 1)).toBe(false)

    expect(await committedToday()).toBe(199)
    expect((await ledger()).map((row) => row.invocationId)).toEqual(["a", "b", "d"])
  })

  test("a reservation larger than the whole budget is refused, the day's first included", async () => {
    // Before, the day's first reservation inserted the day's row unchecked: a 1,500-token call passed a 100-token
    // budget fifteen times over, where the most any other call can pass it by is one call no larger than the budget.
    const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect)
    const reserve = (invocationId: string, tokens: number) =>
      run(ModelUsage.reserve({ invocationId, requestId: "r", role: "agent", modelId: "m", tokens }, { budget: 100, expiry }))
    expect(await reserve("first", 1_500)).toBe(false)
    expect(await committedToday()).toBe(0)
    expect(await ledger()).toEqual([])
    expect(await reserve("fits", 100)).toBe(true)
    expect(await reserve("later", 101)).toBe(false)
    expect(await committedToday()).toBe(100)
  })

  // A reservation that never settles (its Worker died, or its settle never ran) is unknown spend, so it counts at its
  // reservation. Its expiry makes that final, read by the statements themselves, never by a sweep (Opus review 4, P2-6).
  test("a reservation that never settles counts in full, and once it expires a late settle changes nothing", async () => {
    const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect)
    const reserve = (invocationId: string, tokens: number) =>
      run(ModelUsage.reserve({ invocationId, requestId: "r", role: "agent", modelId: "m", tokens }, { budget: 150, expiry }))

    expect(await reserve("abandoned", 100)).toBe(true)
    expect(await charges()).toEqual([
      { invocationId: "abandoned", charged: 100, expiresInSeconds: Duration.toSeconds(expiry) },
    ])
    await expire("abandoned")

    expect(await run(ModelUsage.settle({ invocationId: "abandoned", inputTokens: 1, outputTokens: 1, complete: true, ended })))
      .toBe(false)
    expect(await committedToday()).toBe(100)
    expect((await ledger())[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, settled: false })
    // Admission counts it: the next call fits, the one after doesn't.
    expect(await reserve("next", 60)).toBe(true)
    expect(await reserve("refused", 1)).toBe(false)
    expect(await reconciled()).toBe(true)
  })

  test("a call whose settle comes after its reservation expired stays charged in full, logged and counted", async () => {
    let open = () => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    const h = await harness(runtime, gated(gate), { actor: member, config: { MODEL_RESERVATION_EXPIRY: "1 minute" } })
    const request = ask("hi")

    const response = await h.fetch("/api/model/agent", { method: "POST", body: body(request) })
    const [{ invocationId, expiresInSeconds }] = await charges()
    await expire(invocationId)
    open()
    await response.text()

    expect(expiresInSeconds).toBe(60)
    expect(await committedToday()).toBe(reservationOf(request))
    expect(h.count(ModelEndpoint.usageWrites, { outcome: "expired" })).toBe(1)
    expect(h.only("model.usage")).toMatchObject({
      level: "WARN",
      annotations: { role: "agent", invocationId, outcome: "expired" },
    })
  })

  test("the reservation expiry is an hour unless set", async () => {
    const h = await harness(runtime, answering, { actor: member })

    await call(h, ask("hi"))

    expect(Duration.toSeconds(ModelEndpoint.RESERVATION_EXPIRY)).toBe(3_600)
    expect((await charges())[0]!.expiresInSeconds).toBe(3_600)
    expect(await reconciled()).toBe(true)
    await expect(harness(runtime, answering, { config: { MODEL_RESERVATION_EXPIRY: "soon" } })).rejects.toThrow()
  })

  test("what each call is charged adds up to the day's committed tokens", async () => {
    const script: Array<Stream.Stream<ModelEvent.ModelEvent, ModelError.ModelError>> = [
      Stream.make(delta("ok"), usage, stop),
      Stream.make(delta("paid")).pipe(Stream.concat(transportFailure)),
      Stream.make({ type: "usage", inputTokens: 900_000, outputTokens: 1 } as const).pipe(Stream.concat(transportFailure)),
    ]
    const h = await harness(runtime, () => script.shift()!, { actor: member })
    const request = ask("hi")

    for (let i = 0; i < 3; i++) await call(h, request)

    expect((await charges()).map((row) => row.charged)).toEqual([46, reservationOf(request), 900_001])
    expect(await reconciled()).toBe(true)
  })

  test("a settle that can't be written is logged and counted, the answer still ends, and the reservation stays", async () => {
    const request = ask("hi")
    await withMeteringFault("settle", {}, async (h) => {
      const { lines } = await call(h, request)

      expect(lines.at(-1)).toEqual({ type: "end" })
      expect(h.count(ModelEndpoint.usageWrites, { outcome: "error" })).toBe(1)
      expect(h.only("model.usage").annotations).toMatchObject({ role: "agent", errorCode: expect.stringMatching(/^sql:/) })
      // Fail-closed: the call still counts at its worst case.
      expect(await committedToday()).toBe(new TextEncoder().encode(body(request)).length + ModelEndpoint.MAX_OUTPUT_TOKENS)
    })
  })

  test("a reservation Postgres refuses is a 503 provider_internal, logged by its SQL reason, before any model", async () => {
    await withMeteringFault("reserve", {}, async (h) => {
      const { status, error } = await call(h, ask("hi"))

      expect(status).toBe(503)
      expect(error).toMatchObject({ code: "provider_internal" })
      expect(h.only("model.endpoint").annotations).toMatchObject({ role: "agent", errorCode: expect.stringMatching(/^sql:/) })
      expect(h.requests).toEqual([])
    })
  })

  test.each(["settle", "reserve"] as const)("%s fault is removed when harness setup fails", async (fault) => {
    try {
      await expect(withMeteringFault(fault, { MODEL_MAX_MESSAGES: "invalid" }, async () => {})).rejects.toThrow()
      const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'refuse_usage'
          AND tgrelid = to_regclass('model_usage')) AS trigger,
          to_regclass('model_budget_days') IS NOT NULL AS budget`))
      expect(rows).toEqual([{ trigger: false, budget: true }])
    } finally {
      // Keep the regression itself safe on the unfixed lifecycle.
      await faultSql("DROP TRIGGER IF EXISTS refuse_usage ON model_usage")
      await faultSql("DROP FUNCTION IF EXISTS refuse_usage()")
      await faultSql("DO $$ BEGIN IF to_regclass('model_budget_days_away') IS NOT NULL THEN ALTER TABLE model_budget_days_away RENAME TO model_budget_days; END IF; END $$")
    }
  })

  test("Postgres being unreachable refuses with 503 provider_internal, logged by its SQL reason", async () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://nobody:nothing@127.0.0.1:1/none")))
    const h = await harness(runtime, answering, { actor: member, database: unreachable })

    const { status, error } = await call(h, ask("hi"))

    expect(status).toBe(503)
    expect(error).toMatchObject({ code: "provider_internal" })
    expect(h.only("model.endpoint").annotations).toMatchObject({ errorCode: expect.stringMatching(/^sql:/) })
    expect(h.requests).toEqual([])
  })
})

const faultSql = (statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)))

const withMeteringFault = async (
  fault: "settle" | "reserve",
  config: Record<string, string>,
  use: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>,
) => {
  if (fault === "settle") {
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.withTransaction(Effect.andThen(
          sql`CREATE FUNCTION refuse_usage() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'refused'; END $$`,
          sql`CREATE TRIGGER refuse_usage BEFORE UPDATE ON model_usage FOR EACH ROW EXECUTE FUNCTION refuse_usage()`,
        ))),
    )
  } else {
    await faultSql("ALTER TABLE model_budget_days RENAME TO model_budget_days_away")
  }
  try {
    const h = await harness(runtime, answering, { actor: member, config })
    await use(h)
  } finally {
    if (fault === "settle") {
      await faultSql("DROP TRIGGER IF EXISTS refuse_usage ON model_usage")
      await faultSql("DROP FUNCTION IF EXISTS refuse_usage()")
    } else {
      await faultSql("ALTER TABLE model_budget_days_away RENAME TO model_budget_days")
    }
  }
}

describe("telemetry", () => {
  test("never carries the prompt, the answer, the provider's error text or the key", async () => {
    const sentinel = "SENTINEL-model-endpoint-41c9"
    const key = "sk-SENTINEL-key-77d0"
    const upstream = await provider({ status: 400, error: `provider says ${sentinel}` })
    const h = await harness(
      runtime,
      (request) =>
        Stream.make(delta(`echo ${JSON.stringify(request.messages)}`), usage).pipe(
          Stream.concat(Stream.fail(new ModelError.ModelError({ code: "provider_internal", message: sentinel }))),
        ),
      { actor: member, config: keyConfig(upstream.origin, key) },
    )

    const echoed = await call(h, ask(`tell me about ${sentinel}`))
    await setModel(admin, { role: "renderer", model: rowModel(upstream.origin) })
    const failed = await call(h, ask(`tell me about ${sentinel}`), "renderer")

    expect(JSON.stringify(echoed.lines)).toContain(sentinel)
    expect(JSON.stringify(failed.lines)).not.toContain(sentinel)
    expect(upstream.seen[0]!.headers.authorization).toBe(`Bearer ${key}`)
    const exported = recorded(h)
    expect(exported).not.toContain(sentinel)
    expect(exported).not.toContain(key)
  })
})

describe("a server flow's own calls (ModelEndpoint.local)", () => {
  /** The `judge` seat a flow on the server calls with, over a scripted model, metered on this file's schema. */
  const seat = async (
    script: (request: ModelRequest.ModelRequest) => Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure>,
    config: Record<string, string> = {},
  ) => {
    const requests: Array<ModelRequest.ModelRequest> = []
    const model = Model.make({
      stream: (request) => {
        requests.push(request)
        return script(request)
      },
    })
    const database = await runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))
    const local = await Effect.runPromise(
      ModelEndpoint.local(database, { alerts: true, hosted: true }).pipe(
        Effect.provide(PersonalModels.none),
        Effect.provideService(HostModel, HostModel.of({ modelId: "default-model", model, route: { prepare: () => Effect.die("unused") } })),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
      ),
    )
    return { judge: local("judge"), local, requests }
  }
  const run = (judge: ModelEndpoint.Seat, request: ModelRequest.ModelRequest) =>
    Effect.runPromiseExit(Stream.runCollect(judge.model.stream(request)))

  test("streams the role's model with no person's session, bounded and metered as the endpoint's calls are", async () => {
    const { judge, requests } = await seat(answering)
    const exit = await run(judge, ask("judge this"))
    expect(Exit.isSuccess(exit)).toBe(true)
    // The role's model id and the endpoint's output cap, whatever the caller asked for.
    expect(requests.map((request) => [request.modelId, request.params.maxTokens])).toEqual([["default-model", 8_000]])
    expect(await usageRows()).toEqual([{ role: "judge", modelId: "default-model", inputTokens: 12, outputTokens: 34 }])
    expect(await committedToday()).toBe(46)
  })

  test("given the host's starter, each admitted call starts its window's spend alert, once a window in this isolate", async () => {
    // A window whose only spend is a server flow's (a `todo` run's agent, triage's judge) alerts too: before, no server
    // call started one, so the alert waited for some person's call through the endpoint.
    const starts: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
    const starter = Flows.FlowStarter.of({
      start: (flow, { executionId, payload }) => Effect.sync(() => void starts.push({ flow: flow._tag, executionId, payload })),
    })
    const { local } = await seat(answering)
    const agent = local("agent", starter)
    const before = Flows.windowAt(Date.now(), ModelSpend.ALERT_WINDOW)
    expect(Exit.isSuccess(await run(agent, ask("implement this")))).toBe(true)
    expect(Exit.isSuccess(await run(agent, ask("and this")))).toBe(true)
    const window = Flows.windowAt(Date.now(), ModelSpend.ALERT_WINDOW)
    // Two calls in one window start it once; a window that ended between them starts the next one.
    expect(starts.map((start) => start.flow)).toEqual(window.from === before.from ? [SpendAlert.SpendAlert._tag] : [
      SpendAlert.SpendAlert._tag,
      SpendAlert.SpendAlert._tag,
    ])
    expect(starts[0]).toMatchObject({
      executionId: SpendAlert.executionId(before),
      payload: { ...before, budget: ModelEndpoint.DAILY_TOKEN_BUDGET },
    })
  })

  test("a refused call, a seat with no starter, or alerts off start no alert", async () => {
    const starts: Array<string> = []
    const starter = Flows.FlowStarter.of({ start: (_flow, { executionId }) => Effect.sync(() => void starts.push(executionId)) })
    const spent = await seat(spending(10_000), { MODEL_DAILY_TOKEN_BUDGET: "10000" })
    expect(Exit.isSuccess(await run(spent.local("judge"), ask("no starter")))).toBe(true)
    expect(Exit.isFailure(await run(spent.local("judge", starter), ask("refused")))).toBe(true)
    const off = await seat(answering, { MODEL_SPEND_ALERTS: "false" })
    expect(Exit.isSuccess(await run(off.local("judge", starter), ask("alerts off")))).toBe(true)
    expect(starts).toEqual([])
  })

  test("its step keys on the endpoint's own request for the role", async () => {
    const { judge } = await seat(answering)
    const prepared = await Effect.runPromise(judge.route.prepare(ask("judge this")))
    expect(prepared).toMatchObject({ routeId: "model-proxy", url: "/api/model/judge" })
  })

  test("today's budget spent: the call fails quota_exceeded and never reaches a model", async () => {
    const { judge, requests } = await seat(spending(10_000), { MODEL_DAILY_TOKEN_BUDGET: "10000" })
    expect(Exit.isSuccess(await run(judge, ask("first")))).toBe(true)
    const refused = await run(judge, ask("second"))
    expect(refused).toEqual(
      Exit.fail(new ModelError.ModelError({ code: "quota_exceeded", message: "Today's model budget is spent.", httpStatus: 429 })),
    )
    expect(requests).toHaveLength(1)
  })

  test("a request over MODEL_MAX_REQUEST_BYTES fails invalid_request before the budget or a model", async () => {
    const { judge, requests } = await seat(answering, { MODEL_MAX_REQUEST_BYTES: "512" })
    const exit = await run(judge, ask("x".repeat(1_000)))
    expect(exit).toEqual(
      Exit.fail(new ModelError.ModelError({ code: "invalid_request", message: "The request is too large.", httpStatus: 413 })),
    )
    expect(requests).toEqual([])
    expect(await usageRows()).toEqual([])
  })

  test("a call its caller interrupts after its text keeps its whole reservation", async () => {
    const { judge } = await seat(() => Stream.concat(Stream.make(delta("partial")), Stream.never))
    // Interrupted once its text arrived, not at a fixed time: under load, admission alone can outlast any deadline,
    // and the call would then end before it reserved or streamed anything.
    const texted = Effect.runSync(Deferred.make<void>())
    const caller = Effect.runFork(
      Stream.runForEach(judge.model.stream(ask("judge this")), () => Deferred.succeed(texted, undefined)),
    )
    await Effect.runPromise(Deferred.await(texted))
    // The interruption returns once the call has ended, its reservation settled.
    await Effect.runPromise(Fiber.interrupt(caller))
    expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(caller)))).toBe(true)
    const [row] = await ledger()
    expect(row!.settled).toBe(true)
    expect((await charges())[0]!.charged).toBe(row!.reserved)
  })

  test("a call the provider refuses before any output settles to 0, as the endpoint's does", async () => {
    const { judge } = await seat(() =>
      Stream.fail(new ModelError.ModelError({ code: "rate_limited", message: "slow down", httpStatus: 429 }))
    )
    const exit = await run(judge, ask("judge this"))
    expect(Exit.isFailure(exit)).toBe(true)
    const [row] = await ledger()
    expect(row).toMatchObject({ settled: true, inputTokens: 0, outputTokens: 0 })
    expect((await charges())[0]!.charged).toBe(0)
    expect(await committedToday()).toBe(0)
  })

  test("a call that fails after its text keeps its whole reservation, as the endpoint's does", async () => {
    const { judge } = await seat(() =>
      Stream.concat(Stream.make(delta("partial")), Stream.fail(new ModelError.ModelError({ code: "content_policy", message: "no" })))
    )
    const exit = await run(judge, ask("judge this"))
    expect(Exit.isFailure(exit)).toBe(true)
    const [row] = await ledger()
    expect(row).toMatchObject({ settled: true, inputTokens: 0, outputTokens: 0 })
    expect((await charges())[0]!.charged).toBe(row!.reserved)
  })
})


describe("timeline summary role", () => {
  test("SUMMARY_MODEL is captured when the endpoint builds, before request configuration loses it", async () => {
    const upstream = await provider({ text: "Inspect both retry attempts" })
    const config: Record<string, string> = {
      ...keyConfig(upstream.origin),
      SUMMARY_MODEL: JSON.stringify(rowModel(upstream.origin, "build-summary")),
    }
    const h = await harness(runtime, answering, { actor: member, config })
    delete config.SUMMARY_MODEL

    const answered = await call(h, ask("Summarize this entry"), "summary")

    expect(answered.status).toBe(200)
    expect(upstream.seen.map(({ body }) => body.model)).toEqual(["build-summary"])
    expect(answered.lines.some(line => line.type === "text-delta" && line.text === "Inspect both retry attempts")).toBe(true)
    expect(h.requests).toHaveLength(0)
  })

  test("summary never silently spends on the default agent model", async () => {
    const config: Record<string, string> = {}
    const h = await harness(runtime, answering, { actor: member, config })
    config.SUMMARY_MODEL = "not JSON"
    const refused = await call(h, ask("Summarize this entry"), "summary")
    expect(refused.status).toBe(409)
    expect(refused.error).toMatchObject({ code: "no_route" })
    expect(h.line("model.endpoint").map(({ annotations }) => annotations.errorCode)).toEqual(["unusable:unconfigured"])
    expect(h.requests).toHaveLength(0)
  })

  // The timeline's summary of one entry on the Node host's engine, its model calls admitted and metered by the endpoint
  // in process (`ModelEndpoint.local`), with `config` as the Worker's configuration. Counts the step's model calls.
  const summarize = async (config: Record<string, string> = {}) => {
    const database = await runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))
    const local = await Effect.runPromise(
      ModelEndpoint.local(database, { alerts: true, hosted: true }).pipe(
        Effect.provide(PersonalModels.none),
        // The agent's model, which the summary role must never reach.
        Effect.provideService(HostModel, HostModel.of({
          modelId: "agent-model",
          model: Model.make({ stream: () => Stream.die(new Error("the summary role reached the agent's model")) }),
          route: { prepare: () => Effect.die("unused") },
        })),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
      ),
    )
    const seat = local("summary")
    let calls = 0
    const counted = Layer.succeed(SummarySeat, {
      route: seat.route,
      model: Model.make({ stream: (request) => Stream.suspend(() => (calls++, seat.model.stream(request))) }),
    })
    const scope = Effect.runSync(Scope.make())
    try {
      // A fresh answer's claim is this run's (worker/TimelineSummaries.ts); this test is about the model call after it.
      const claimed = Layer.succeed(SummaryLedger, SummaryLedger.of({ claim: () => Effect.succeed(true), record: () => Effect.void }))
      const { context } = await Effect.runPromise(Scope.provide(scope)(build(summaries.pipe(
        Layer.provide(Layer.merge(counted, claimed)),
        Layer.provideMerge(Action.layerImplementations),
      ))))
      const payload = { id: "entry", revision: "r1", role: "user" as const, text: "Please check the release retries." }
      const exit = await Effect.runPromise(
        Effect.exit(Context.get(context, FlowRuntime.FlowRuntime).execute(Summarize, { executionId: crypto.randomUUID(), payload })),
      )
      return { exit, calls }
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }

  test("a summary role with no model fails its step once: the model is asked once, never again", async () => {
    const { exit, calls } = await summarize()

    // The endpoint's no_route is the deployment having no summary model: unconfigured, not a model outage.
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toEqual(new SummaryFailed({ code: "unconfigured" }))
    // As a 503 the refusal was capacity to the step, which the engine retried six times, up to 30 s apart.
    expect(calls).toBe(1)
  }, 30_000)

  test("SUMMARY_MODEL answers the summary role when no admin set one, and an admin setting overrides it", async () => {
    const upstream = await provider({ text: "Check both release retries" })
    const config = { ...keyConfig(upstream.origin), SUMMARY_MODEL: JSON.stringify(rowModel(upstream.origin, "cheap-summary")) }

    const byDefault = await summarize(config)
    await setModel(admin, { role: "summary", model: rowModel(upstream.origin, "set-summary") })
    const bySetting = await summarize(config)

    expect(byDefault.exit).toEqual(Exit.succeed({ summary: "Check both release retries" }))
    expect(bySetting.exit).toEqual(Exit.succeed({ summary: "Check both release retries" }))
    expect(upstream.seen.map(({ body }) => body.model)).toEqual(["cheap-summary", "set-summary"])
  })

  test.each(["not JSON", "{\"modelId\": 1}"])("malformed SUMMARY_MODEL (%s) is captured as unusable configuration", async (value) => {
    const config: Record<string, string> = { SUMMARY_MODEL: value }
    const h = await harness(runtime, answering, { actor: member, config })
    delete config.SUMMARY_MODEL

    const refused = await call(h, ask("Summarize this entry"), "summary")

    expect(refused.status).toBe(409)
    expect(refused.error).toMatchObject({ code: "no_route" })
    expect(h.line("model.endpoint").map(({ annotations }) => annotations.errorCode)).toEqual(["unusable:config"])
    expect(h.requests).toHaveLength(0)
    expect(await usageRows()).toEqual([])
  })
  test("an explicit summary setting reaches the metered role through the real endpoint", async () => {
    const upstream = await provider({ text: "Inspect both retry attempts" })
    const h = await harness(runtime, answering, { actor: member, config: keyConfig(upstream.origin) })
    const ran = await setModel(admin, { role: "summary", model: rowModel(upstream.origin, "cheap-summary") })
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    const answered = await call(h, ask("Summarize this entry"), "summary")
    expect(answered.status).toBe(200)
    expect(upstream.seen).toHaveLength(1)
    expect(upstream.seen[0]!.body.model).toBe("cheap-summary")
    expect(answered.lines.some(line => line.type === "text-delta" && line.text === "Inspect both retry attempts")).toBe(true)
    expect(h.requests).toHaveLength(0)
  })
})
