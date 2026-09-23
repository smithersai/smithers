import { describe, expect, test, spyOn } from "bun:test"
import { Effect } from "effect"
import { bindingOf, MODEL_TEST_MAX_TOKENS, ModelCatalogSchema, ModelCredentialReceiptSchema, ModelCredentialResultSchema, ModelTestResultSchema } from "@smthrs/rpc/ConfiguredModel"
import { memoryStorage, type NativeNamespace } from "./DurableStorage"
import { ExecutionContext, executionContextFrom, layersFromEnv, type WorkerEnv } from "./Environment"
import { Transport, transportFrom } from "./Http"
import { handleRequest } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"
import { AccountModelVault, cloudCredentialOrigin } from "./modelVault"

// Generated fixture bytes, never a live provider/encryption key.
const VAULT_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const VALUE = "sk-private-worker-fixture-0123456789"
const ORIGIN = "https://provider.example"
const model = { id: "mine", protocol: "openai-chat", modelId: "mine", credential: "PERSONAL", baseUrl: ORIGIN } as const
const completion = (text = "ok") => Response.json({ choices: [{ message: { content: text } }] })

const fixture = (key: string | undefined = VAULT_KEY) => {
  const stores = new Map<string, ReturnType<typeof memoryStorage>>()
  const objects = new Map<string, AccountModelVault>()
  const internal: string[] = []
  const namespace: NativeNamespace = { idFromName: name => name, get: id => {
    const login = String(id)
    let storage = stores.get(login)
    if (!storage) { storage = memoryStorage(); stores.set(login, storage) }
    let object = objects.get(login)
    if (!object) { object = new AccountModelVault({ storage }); objects.set(login, object) }
    const instance = object
    return { fetch: async request => {
      internal.push(await request.clone().text())
      const response = await instance.fetch(request)
      internal.push(await response.clone().text())
      return response
    } }
  } }
  const env: WorkerEnv = { ...memoryDurableObjects(), ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    IDENTITY_UPSTREAM_URL: "https://identity.example", CEREBRAS_API_KEY: "deployment-fixture", MODEL_VAULTS: namespace,
    ...(key === undefined ? {} : { MODEL_VAULT_KEY: key }) }
  const calls: Request[] = [], responses: string[] = [], spent: string[] = []
  let budget = true
  let provider: (request: Request) => Promise<Response> = async () => completion()
  let validate: (login: string) => string | undefined = login => login
  const limits: NativeNamespace = { idFromName: name => name, get: id => ({ fetch: async () => {
    spent.push(String(id)); return Response.json({ allowed: budget, remaining: budget ? 50 : 0, retryAt: Date.now() + 1000 })
  } }) }
  const runtimeEnv: WorkerEnv = { ...env, TURN_LIMITS: limits }
  const transport = transportFrom(async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname === "identity.example") {
      const login = validate(request.headers.get("cookie")?.split("=")[1] ?? "")
      return login ? Response.json({ login, allowlisted: true }) : Response.json({}, { status: 401 })
    }
    calls.push(request.clone())
    return provider(request)
  })
  const request = async (path: string, login?: string, body?: unknown) => {
    const response = await Effect.runPromise(handleRequest(new Request(`https://smithers.sh${path}`, {
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      headers: { "content-type": "application/json", ...(login ? { cookie: `session=${login}` } : {}) }
    })).pipe(Effect.provideService(Transport, transport), Effect.provideService(ExecutionContext, executionContextFrom(undefined)), Effect.provide(layersFromEnv(runtimeEnv))))
    const text = await response.text()
    responses.push(text)
    return { status: response.status, body: response.headers.get("content-type")?.includes("ndjson") ? text.trim().split("\n").map(line => JSON.parse(line)) : JSON.parse(text), text, headers: response.headers }
  }
  let sequence = 0
  const mutate = (action: "enroll" | "rotate" | "remove", login = "alice", fields: Record<string, unknown> = {}) =>
    request("/api/model/credential", login, { action, name: "PERSONAL", requestId: `request-${++sequence}`,
      ...(action === "enroll" ? { origin: ORIGIN } : {}), ...(action === "remove" ? {} : { value: VALUE }), ...fields })
  return { env, request, mutate, calls, responses, internal, stores, spent, restart: () => objects.clear(),
    budget: (allowed: boolean) => { budget = allowed },
    provider: (next: typeof provider) => { provider = next }, validate: (next: typeof validate) => { validate = next } }
}

describe("account credential vault through the Worker router", () => {
  test("a reasoning model passes the fixed Test on its first call", async () => {
    const f = fixture()
    await f.mutate("enroll")
    f.provider(async request => {
      const sent = await request.json() as { max_tokens?: number; reasoning_effort?: string }
      return sent.max_tokens === 128 && sent.reasoning_effort === "low"
        ? completion("ok")
        : Response.json({ choices: [{ finish_reason: "length", message: { content: "\n\n", reasoning: "thinking" } }] })
    })
    const tested = await f.request("/api/model/test", "alice", { model: { ...model, id: "video-demo-cerebras", modelId: "qwen-3.8-27b" } })
    expect(ModelTestResultSchema.parse(tested.body)).toMatchObject({ ok: true, sample: "ok" })
    expect(f.calls).toHaveLength(1)
    expect(await f.calls[0]!.json()).toMatchObject({
      model: "qwen-3.8-27b", max_tokens: MODEL_TEST_MAX_TOKENS, reasoning_effort: "low"
    })
  })

  test("reasoning exhausted before text is distinct from a malformed protocol response", async () => {
    const f = fixture()
    await f.mutate("enroll")
    f.provider(async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "\n\n", reasoning: "thinking" } }] }))
    expect((await f.request("/api/model/test", "alice", { model })).body.failure).toEqual({ code: "empty_output" })
    f.provider(async () => Response.json({ choices: [{ finish_reason: "length", message: { content: null, reasoning: "thinking" } }] }))
    expect((await f.request("/api/model/test", "alice", { model })).body.failure).toEqual({ code: "empty_output" })
    f.provider(async () => Response.json({ choices: [{ unrelated: true }] }))
    expect((await f.request("/api/model/test", "alice", { model })).body.failure).toEqual({ code: "invalid", field: "protocol" })
  })

  test("enroll, metadata catalog, Test and Ask spend only the same account and pinned origin", async () => {
    const f = fixture()
    expect(ModelCredentialResultSchema.parse((await f.mutate("enroll")).body).ok).toBe(true)
    const catalog = await f.request("/api/model/catalog", "alice")
    expect(ModelCatalogSchema.parse(catalog.body).credentials).toContainEqual({ name: "PERSONAL", origins: [ORIGIN], present: true, managed: true })
    expect(catalog.body.enrollment).toEqual({ available: true })
    expect(catalog.headers.get("cache-control")).toBe("no-store")
    expect(ModelTestResultSchema.parse((await f.request("/api/model/test", "alice", { model })).body).ok).toBe(true)
    expect((await f.request("/api/model/test", "alice", { model, input: { kind: "generation", system: "", prompt: "hello", maxTokens: 8 } })).body.ok).toBe(true)
    expect(f.spent).toEqual(["alice", "alice"])
    expect(f.calls.map(call => [new URL(call.url).origin, call.redirect, call.headers.get("authorization") === `Bearer ${VALUE}`]))
      .toEqual([[ORIGIN, "manual", true], [ORIGIN, "manual", true]])
    expect(JSON.stringify([f.responses, f.internal, [...f.stores.values()].map(s => [...s.data])])).not.toContain(VALUE)
  })

  test("rotation, removal, replay and restart retain the pin and safe receipt", async () => {
    const f = fixture()
    await f.mutate("enroll", "alice", { requestId: "original-id" })
    expect((await f.mutate("enroll", "alice", { requestId: "original-id", value: "other-key" })).body.ok).toBe(true)
    expect((await f.mutate("enroll", "alice", { origin: "https://elsewhere.example" })).body.failure.code).toBe("exists")
    expect((await f.mutate("enroll", "alice", { requestId: "original-id", name: "OTHER" })).body.failure).toEqual({ code: "invalid", field: "requestId" })
    const first = JSON.stringify([...f.stores.get("alice")!.data])
    await f.mutate("rotate", "alice", { value: "rotated-private-fixture", requestId: "rotation-id" })
    expect(JSON.stringify([...f.stores.get("alice")!.data])).not.toBe(first)
    await f.request("/api/model/test", "alice", { model })
    expect(f.calls.at(-1)!.headers.get("authorization") === "Bearer rotated-private-fixture").toBe(true)
    f.restart()
    expect(ModelCredentialReceiptSchema.parse((await f.request("/api/model/credential/receipt?id=rotation-id", "alice")).body).state).toBe("completed")
    expect((await f.mutate("rotate", "alice", { origin: "https://elsewhere.example" })).body.ok).toBe(false)
    await f.mutate("remove")
    f.restart()
    const catalog = (await f.request("/api/model/catalog", "alice")).body
    expect(catalog.credentials).toContainEqual({ name: "PERSONAL", origins: [ORIGIN], present: false, managed: true })
    const before = f.calls.length
    expect((await f.request("/api/model/test", "alice", { model })).body.failure).toEqual({ code: "credential_missing", credential: "PERSONAL" })
    expect(f.calls).toHaveLength(before)
    expect((await f.mutate("enroll", "alice", { origin: "https://elsewhere.example" })).body.failure.code).toBe("exists")
    expect((await f.mutate("rotate")).body.ok).toBe(true)
  })

  test("two logins and a signed-out visitor cannot see, read, mutate or recover each other's credentials", async () => {
    const f = fixture()
    await f.mutate("enroll", "alice", { requestId: "alice-receipt" })
    for (const login of ["bob", undefined]) {
      const catalog = await f.request("/api/model/catalog", login)
      expect(catalog.status).toBe(200)
      expect(catalog.text).not.toContain("PERSONAL")
      const used = await f.request("/api/model/test", login, { model })
      expect(login ? used.body.failure : used.body.code).toEqual(login ? { code: "credential_unknown", credential: "PERSONAL" } : "sign_in_required")
      const receipt = await f.request("/api/model/credential/receipt?id=alice-receipt", login)
      expect(login ? receipt.body.state : receipt.status).toBe(login ? "unknown" : 401)
    }
    expect((await f.mutate("remove", "bob")).body.failure.code).toBe("unknown")
    expect((await f.request("/api/model/credential", undefined, { action: "remove", name: "PERSONAL", requestId: "signed-out" })).status).toBe(401)
    expect(f.calls).toHaveLength(0)
    await f.mutate("enroll", "bob", { origin: "https://bob.example", value: "bob-private-fixture" })
    expect((await f.request("/api/model/catalog", "alice")).text).not.toContain("bob.example")
    expect((await f.request("/api/model/test", "bob", { model })).body.failure.code).toBe("endpoint_forbidden")
  })

  test.each([undefined, "bad-base64", btoa("too short")])("absent or invalid key is typed unavailable; deployment Test still works (%s)", async key => {
    const f = fixture(key === undefined ? "" : key)
    expect((await f.request("/api/model/catalog", "alice")).body.enrollment).toEqual({ available: false, reason: "vault_unavailable" })
    expect((await f.mutate("enroll")).body.failure.code).toBe("vault_unavailable")
    expect((await f.request("/api/model/test", "alice", { model: { ...model, credential: "CEREBRAS_API_KEY", baseUrl: "https://api.cerebras.ai" } })).body.ok).toBe(true)
    expect(f.stores.size).toBe(0)
  })

  test("deployment names remain read-only even when their value is unset", async () => {
    const f = fixture()
    for (const name of ["CEREBRAS_API_KEY", "AI_GATEWAY_API_KEY"]) {
      expect((await f.mutate("enroll", "alice", { name })).body.failure.code).toBe("read_only")
    }
  })

  test("identity changed during preparation cannot commit the old account's request", async () => {
    const f = fixture()
    let checks = 0
    f.validate(login => ++checks === 1 ? login : "bob")
    const result = await f.mutate("enroll")
    expect(result.status).toBe(401)
    f.validate(login => login)
    expect((await f.request("/api/model/catalog", "alice")).text).not.toContain("PERSONAL")
  })

  test("provider redirects, echoes and exceptions never disclose the value or fall back", async () => {
    const f = fixture(), logs: unknown[][] = []
    const log = spyOn(console, "error").mockImplementation((...args) => { logs.push(args) })
    try {
      await f.mutate("enroll")
      f.provider(async () => completion(`your key is ${VALUE}`))
      expect((await f.request("/api/model/test", "alice", { model })).body.ok).toBe(true)
      f.provider(async () => new Response(VALUE, { status: 302, headers: { location: "https://attacker.example" } }))
      expect((await f.request("/api/model/test", "alice", { model })).body.failure).toEqual({ code: "refused", status: 302 })
      f.provider(async () => { throw new Error(VALUE) })
      expect((await f.request("/api/model/test", "alice", { model })).body.failure.code).toBe("unreachable")
      expect(f.calls.every(call => new URL(call.url).origin === ORIGIN)).toBe(true)
      expect(JSON.stringify([f.responses, f.internal, logs])).not.toContain(VALUE)
    } finally { log.mockRestore() }
  })

  test("bound Explainer uses the same account vault and budget, and a second login never falls back", async () => {
    const f = fixture()
    await f.mutate("enroll")
    f.provider(async () => completion(`answer ${VALUE}`))
    const body = { runId: "explain-1", messages: [{ role: "user", content: "explain" }], instructions: "Explain briefly", purpose: "explain", model: bindingOf(model) }
    const served = await f.request("/api/agent/turn", "alice", body)
    expect(served.status).toBe(200)
    expect(served.body[0]).toMatchObject({ type: "delta", text: "answer " })
    expect(f.calls[0]!.headers.get("authorization") === `Bearer ${VALUE}`).toBe(true)
    expect(f.spent).toEqual(["alice"])
    expect((await f.request("/api/agent/turn", "bob", { ...body, runId: "explain-2" })).body.message).toContain("PERSONAL")
    expect(f.calls).toHaveLength(1)
    await f.mutate("remove")
    expect((await f.request("/api/agent/turn", "alice", { ...body, runId: "explain-3" })).body.message).toContain("PERSONAL")
    expect(f.calls).toHaveLength(1)
    expect(JSON.stringify(f.responses)).not.toContain(VALUE)
  })

  test("Test, Ask and bound Explainer refuse a spent budget before resolving or spending a user key", async () => {
    const f = fixture()
    await f.mutate("enroll")
    f.budget(false)
    for (const input of [undefined, { kind: "generation", system: "", prompt: "hello", maxTokens: 8 }]) {
      expect((await f.request("/api/model/test", "alice", { model, input })).status).toBe(429)
    }
    expect((await f.request("/api/agent/turn", "alice", { runId: "explain-limit", instructions: "Explain", messages: [{ role: "user", content: "explain" }], model: bindingOf(model) })).status).toBe(429)
    expect(f.calls).toHaveLength(0)
  })

  test("identity changes before spending or while a provider runs publish no old-account result", async () => {
    const f = fixture()
    await f.mutate("enroll")
    let validations = 0
    f.validate(login => ++validations === 1 ? login : "bob")
    expect((await f.request("/api/model/test", "alice", { model })).status).toBe(401)
    expect(f.calls).toHaveLength(0)
    f.validate(login => login)
    f.provider(async () => { f.validate(() => "bob"); return completion("old-account-answer") })
    const stale = await f.request("/api/model/test", "alice", { model })
    expect(stale.status).toBe(401)
    expect(stale.text).not.toContain("old-account-answer")
  })

  test("concurrent enrollment and duplicate request IDs commit one pin and one receipt", async () => {
    const f = fixture()
    const results = await Promise.all([
      f.mutate("enroll", "alice", { requestId: "same-request" }), f.mutate("enroll", "alice", { requestId: "same-request", value: "other-fixture" }),
      f.mutate("enroll", "alice", { origin: "https://different.example" })
    ])
    const catalog = (await f.request("/api/model/catalog", "alice")).body
    expect(catalog.credentials.filter((row: { name: string }) => row.name === "PERSONAL")).toHaveLength(1)
    expect(results.filter(result => result.body.ok).length).toBeGreaterThan(0)
    const stored = [...f.stores.get("alice")!.data.values()][0] as { entries: unknown[]; receipts: unknown[] }
    expect(stored.entries).toHaveLength(1)
    expect(stored.receipts).toHaveLength(1)
  })

  test("rotating the same value produces a fresh nonce; removal erases ciphertext", async () => {
    const f = fixture()
    await f.mutate("enroll")
    const entry = () => ([...f.stores.get("alice")!.data.values()][0] as { entries: Array<{ sealed: { nonce: string; ciphertext: string } | null }> }).entries[0]!
    const before = entry().sealed!
    await f.mutate("rotate")
    expect(entry().sealed!.nonce).not.toBe(before.nonce)
    expect(entry().sealed!.ciphertext).not.toBe(before.ciphertext)
    await f.mutate("remove")
    expect(entry().sealed).toBeNull()
    expect(JSON.stringify([...f.stores.get("alice")!.data])).not.toContain(before.ciphertext)
  })

  test("a provider without an HTTP status is still a typed failure", async () => {
    const f = fixture()
    await f.mutate("enroll")
    f.provider(async () => Response.error())
    const answer = await f.request("/api/model/test", "alice", { model })
    expect(ModelTestResultSchema.safeParse(answer.body).success).toBe(true)
    expect(answer.body.ok).toBe(false)
  })

  test("decision output cannot return an escaped credential as an answer label", async () => {
    const f = fixture(), value = 'fixture-"quoted"-\\-value'
    await f.mutate("enroll", "alice", { value })
    f.provider(async () => Response.json({ answers: { q: { type: "choice", choice: value } } }))
    const answer = await f.request("/api/model/test", "alice", { model: { ...model, protocol: "evaluation" },
      input: { kind: "decision", state: [], questions: { q: { type: "choice", instructions: "pick", criteria: { [value]: "a", other: "b" } } } } })
    expect(answer.body.ok).toBe(false)
    expect(answer.text).not.toContain(JSON.stringify(value).slice(1, -1))
  })

  test("a corrupt vault and storage exceptions are typed, silent failures, never success or deployment fallback", async () => {
    const f = fixture(), logged: unknown[][] = []
    const spies = ["log", "warn", "error"].map(method => spyOn(console, method as "error").mockImplementation((...args) => { logged.push(args) }))
    try {
      await f.mutate("enroll")
      const store = f.stores.get("alice")!, key = [...store.data.keys()][0]!
      store.data.set(key, { value: VALUE })
      expect((await f.mutate("rotate")).body.failure.code).toBe("storage_unavailable")
      expect((await f.request("/api/model/test", "alice", { model })).body.failure).toEqual({ code: "credential_missing", credential: "PERSONAL" })
      const broken = new AccountModelVault({ storage: { ...memoryStorage(), get: async () => { throw new Error(VALUE) } } })
      const response = await broken.fetch(new Request("https://model-vault.internal/vault", { method: "POST", body: JSON.stringify({ op: "read", login: "alice" }) }))
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain(VALUE)
      expect((await broken.fetch(new Request("https://model-vault.internal/debug"))).status).toBe(404)
      expect(JSON.stringify([logged, f.responses])).not.toContain(VALUE)
      expect(f.calls).toHaveLength(0)
    } finally { spies.forEach(spy => spy.mockRestore()) }
  })

  test.each(["anthropic-messages", "openai-responses", "evaluation"])("user credential resolves the %s wire on its pin", async protocol => {
    const f = fixture()
    await f.mutate("enroll")
    f.provider(async () => protocol === "anthropic-messages" ? Response.json({ content: [{ type: "text", text: `ok ${VALUE}` }] })
      : protocol === "openai-responses" ? Response.json({ output: [{ content: [{ type: "output_text", text: `ok ${VALUE}` }] }] })
      : Response.json({ answers: { ok: { type: "boolean", probability: 0.97 } } }))
    expect((await f.request("/api/model/test", "alice", { model: { ...model, protocol } })).body.ok).toBe(true)
    expect(new URL(f.calls[0]!.url).origin).toBe(ORIGIN)
    expect(f.calls[0]!.headers.get(protocol === "anthropic-messages" ? "x-api-key" : "authorization") === (protocol === "anthropic-messages" ? VALUE : `Bearer ${VALUE}`)).toBe(true)
    expect(JSON.stringify(f.responses)).not.toContain(VALUE)
  })

  test("front-door and recommend never accept the account vault as a decision allowlist bypass", async () => {
    const f = fixture()
    await f.mutate("enroll")
    const binding = { ...bindingOf(model), protocol: "evaluation", modelId: "not-allowed" }
    const result = await f.request("/api/agent/turn", "alice", { runId: "front-door-1", messages: [{ role: "user", content: "hello" }], instructions: "hi", decisionModel: binding })
    expect(result.status).toBe(400)
    expect((await f.request("/api/recommend", "alice", { repo: null, tail: [], commands: [{ name: "help", summary: "Help" }], model: binding })).status).toBe(400)
    expect(f.calls).toHaveLength(0)
  })

  test.each(["login", "name", "origin"])("AAD substitution of %s fails closed", async field => {
    const f = fixture()
    await f.mutate("enroll")
    await f.mutate("enroll", "bob")
    const alice = f.stores.get("alice")!, bob = f.stores.get("bob")!
    const [key, raw] = [...alice.data][0]!
    const document = structuredClone(raw) as { entries: Array<{ name: string; origin: string; sealed: unknown }> }
    let login = "alice"
    let binding = { ...model } as { id: string; protocol: "openai-chat"; modelId: string; credential: string; baseUrl: string }
    if (field === "login") {
      const target = structuredClone(bob.data.get(key)) as typeof document
      target.entries[0]!.sealed = document.entries[0]!.sealed
      bob.data.set(key, target); login = "bob"
    } else {
      if (field === "name") { document.entries[0]!.name = "RENAMED"; binding = { ...model, credential: "RENAMED" } }
      else { document.entries[0]!.origin = "https://different.example"; binding = { ...model, baseUrl: "https://different.example" } }
      alice.data.set(key, document)
    }
    const outcome = await f.request("/api/model/test", login, { model: binding })
    expect(outcome.body.failure).toEqual({ code: "credential_missing", credential: binding.credential })
    expect(f.calls).toHaveLength(0)
  })
})

test.each(["http://provider.example", "https://127.0.0.1", "https://2130706433", "https://0x7f000001", "https://[::1]", "https://[::ffff:10.0.0.1]",
  "https://localhost", "https://api.localhost", "https://api.local", "https://api.internal", "https://api.lan", "https://api.home.arpa", "https://metadata.google.internal",
  "https://10.0.0.1", "https://169.254.169.254", "https://provider.example:444", "https://user:pass@provider.example", "https://provider.example/path", "https://provider.example?key=x", "https://provider.example#x", "https://provider.example."])("cloud pin refuses %s", origin => {
  expect(cloudCredentialOrigin(origin)).toBeUndefined()
})
