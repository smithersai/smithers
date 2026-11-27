import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, describe, expect, test } from "vitest"
import type { McpConsentDetails, McpTokenSummary } from "./contract"
import { type Decision, Mcp, McpClient, McpNotTaken, McpStore, type McpView } from "./store.vibe"

// The MCP layer driven as React drives it: its plain actions and its live queries' rows, over a scripted `McpClient`
// (the only seam: ChatApi's routes).

const token = (id: string, over: Partial<McpTokenSummary> = {}): McpTokenSummary => ({
  id,
  clientName: "Claude Code",
  repoScope: "github/evmts/voltaire",
  scopes: ["mcp:read"],
  createdAt: "2026-11-20T12:00:00.000Z",
  expiresAt: "2026-12-20T12:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  ...over,
})

const DETAILS: McpConsentDetails = {
  clientId: "client_1",
  clientName: "Claude Code",
  redirectUri: "http://127.0.0.1:53682/callback",
  repoScope: "github/evmts/voltaire",
  scopes: ["mcp:read", "mcp:write"],
  state: "xyz",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
  login: "roninjin10",
  effectiveRole: "maintainer",
}

interface Script {
  pairing: McpClient["Service"]["pairing"]
  tokens: Effect.Effect<ReadonlyArray<McpTokenSummary>, McpNotTaken>
  revoke: (tokenId: string) => Effect.Effect<void, McpNotTaken>
  consent: (search: string) => Effect.Effect<McpConsentDetails, McpNotTaken>
  decide: (decision: Decision, search: string) => Effect.Effect<string, McpNotTaken>
}

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const open = async (script: Partial<Script> = {}): Promise<McpView> => {
  const refuse = Effect.fail(new McpNotTaken({}))
  const client = McpClient.of({
    pairing: script.pairing ?? { mint: () => refuse, review: () => refuse, approve: () => refuse, revoke: () => refuse },
    tokens: Effect.suspend(() => script.tokens ?? refuse),
    revoke: (tokenId) => script.revoke?.(tokenId) ?? refuse,
    consent: (search) => script.consent?.(search) ?? refuse,
    decide: (decision, search) => script.decide?.(decision, search) ?? refuse,
  })
  const runtime = ManagedRuntime.make(Mcp.layer.pipe(Layer.provide(Layer.succeed(McpClient, client))))
  runtimes.push(runtime)
  // A live query delivers once something reads it, as `useLiveQuery` does.
  return runtime.runPromise(Effect.gen(function* () {
    const store = yield* McpStore
    yield* Effect.all([store.connectState.preload, store.tokensState.preload, store.consentState.preload])
    return yield* Mcp
  }))
}

const connect = (mcp: McpView) => mcp.queries.connect.toArray[0]!
const tokens = (mcp: McpView) => mcp.queries.tokens.toArray[0]!
const consent = (mcp: McpView) => mcp.queries.consent.toArray[0]!

describe("the conversation attachment", () => {
  const target = { repo: "acme/demo", branch: "feature/demo", conversation: crypto.randomUUID() }
  const refused = Effect.fail(new McpNotTaken({ status: 403, code: "forbidden" }))

  test("closing the dialog while minting fences the response and repeated clicks claim one reference", async () => {
    const receipt = Effect.runSync(Deferred.make<{ reference: string }>())
    let calls = 0
    const tab = await open({ pairing: {
      mint: () => Effect.andThen(Effect.sync(() => { calls++ }), Deferred.await(receipt)),
      review: () => refused, approve: () => refused, revoke: () => refused,
    } })
    tab.queries.pairing.startSyncImmediate()
    const first = tab.actions.mintAttachment(target)
    await tab.actions.mintAttachment(target)
    expect(calls).toBe(1)
    expect(tab.queries.pairing.toArray[0]?.busy).toBe(true)
    tab.actions.closeAttachment()
    await Effect.runPromise(Deferred.succeed(receipt, { reference: "ABCD-EFGH" }))
    await first
    expect(tab.queries.pairing.toArray[0]).toMatchObject({ target: null, reference: null, busy: false })
  })

  test("an invalid consent target never reaches approval", async () => {
    let approvals = 0
    const tab = await open({ pairing: {
      mint: () => Effect.succeed({ reference: "ABCD-EFGH" }),
      review: () => Effect.succeed({ ...target, conversation: crypto.randomUUID(), claim: "claim", client: "fixture", ceiling: [] }),
      approve: () => Effect.andThen(Effect.sync(() => { approvals++ }), refused),
      revoke: () => refused,
    } })
    tab.queries.pairing.startSyncImmediate()
    await tab.actions.mintAttachment(target)
    await tab.actions.reviewAttachment()
    await tab.actions.approveAttachment("123456")
    expect(tab.queries.pairing.toArray[0]).toMatchObject({ error: "wrong_target", review: null, approval: null })
    expect(approvals).toBe(0)
  })
})

describe("the Connect agent dialog", () => {
  test("opens for a repository, shows the chosen client and keeps it when closed", async () => {
    const mcp = await open()
    expect(connect(mcp)).toMatchObject({ id: "connect", open: false, client: "claude", owner: "", name: "" })
    mcp.actions.openConnect("evmts", "voltaire")
    mcp.actions.selectClient("cursor")
    expect(connect(mcp)).toMatchObject({ id: "connect", open: true, client: "cursor", owner: "evmts", name: "voltaire" })
    mcp.actions.closeConnect()
    expect(connect(mcp)).toMatchObject({ open: false, client: "cursor" })
  })
})

describe("connected agents", () => {
  test("load lists them; revoke marks one revoked and sends its id", async () => {
    const revoked: Array<string> = []
    const mcp = await open({
      tokens: Effect.succeed([token("a"), token("b")]),
      revoke: (id) => Effect.sync(() => void revoked.push(id)),
    })
    expect(tokens(mcp).status).toBe("idle")
    await mcp.actions.loadTokens()
    expect(tokens(mcp)).toMatchObject({ status: "ready", error: null })
    expect(tokens(mcp).tokens.map((each) => each.id)).toEqual(["a", "b"])
    await mcp.actions.revokeToken("a")
    expect(revoked).toEqual(["a"])
    expect(tokens(mcp).revokingId).toBeNull()
    expect(tokens(mcp).tokens.map((each) => each.revokedAt === null)).toEqual([false, true])
    // Revoking it again keeps the time it was first revoked.
    const first = tokens(mcp).tokens[0]!.revokedAt
    await mcp.actions.revokeToken("a")
    expect(tokens(mcp).tokens[0]!.revokedAt).toBe(first)
  })

  test("a list ChatApi refuses is failed with its code; no answer is unavailable", async () => {
    const script: Partial<Script> = { tokens: Effect.fail(new McpNotTaken({ status: 403, code: "person_only" })) }
    const mcp = await open(script)
    await mcp.actions.loadTokens()
    expect(tokens(mcp)).toMatchObject({ status: "failed", error: "person_only" })
    script.tokens = Effect.fail(new McpNotTaken({}))
    await mcp.actions.loadTokens()
    expect(tokens(mcp)).toMatchObject({ status: "failed", error: "unavailable" })
    script.tokens = Effect.fail(new McpNotTaken({ status: 401 }))
    await mcp.actions.loadTokens()
    expect(tokens(mcp)).toMatchObject({ status: "failed", error: "authentication" })
  })

  test("a refused revoke leaves the token active and says why; a token already gone reads revoked", async () => {
    const script: Partial<Script> = {
      tokens: Effect.succeed([token("a")]),
      revoke: () => Effect.fail(new McpNotTaken({ status: 503 })),
    }
    const mcp = await open(script)
    await mcp.actions.loadTokens()
    await mcp.actions.revokeToken("a")
    expect(tokens(mcp)).toMatchObject({ revokingId: null, error: "unavailable" })
    expect(tokens(mcp).tokens[0]!.revokedAt).toBeNull()
    script.revoke = () => Effect.fail(new McpNotTaken({ status: 404, code: "not_found" }))
    await mcp.actions.revokeToken("a")
    expect(tokens(mcp).error).toBeNull()
    expect(tokens(mcp).tokens[0]!.revokedAt).not.toBeNull()
  })
})

describe("OAuth consent", () => {
  const SEARCH = "?client_id=client_1&state=xyz"

  test("load shows the request; approve answers the registered callback and sends the search", async () => {
    const sent: Array<[Decision, string]> = []
    const mcp = await open({
      consent: () => Effect.succeed(DETAILS),
      decide: (decision, search) => Effect.sync(() => (sent.push([decision, search]), `${DETAILS.redirectUri}?code=abc&state=xyz`)),
    })
    await mcp.actions.loadConsent(SEARCH)
    expect(consent(mcp)).toMatchObject({ status: "ready", details: DETAILS })
    await expect(mcp.actions.submitConsent("approve", SEARCH)).resolves.toBe("http://127.0.0.1:53682/callback?code=abc&state=xyz")
    expect(sent).toEqual([["approve", SEARCH]])
    expect(consent(mcp)).toMatchObject({ status: "done", submitting: null, redirectTo: "http://127.0.0.1:53682/callback?code=abc&state=xyz" })
  })

  test("a callback that isn't the registered one is never answered", async () => {
    const mcp = await open({ consent: () => Effect.succeed(DETAILS), decide: () => Effect.succeed("https://evil.example/callback?code=abc") })
    await mcp.actions.loadConsent(SEARCH)
    await expect(mcp.actions.submitConsent("approve", SEARCH)).resolves.toBeUndefined()
    expect(consent(mcp)).toMatchObject({ status: "ready", error: "invalid_redirect", redirectTo: null })
  })

  test("a 401 is signed out; another refusal is failed with its code", async () => {
    const script: Partial<Script> = { consent: () => Effect.fail(new McpNotTaken({ status: 401 })) }
    const mcp = await open(script)
    await mcp.actions.loadConsent(SEARCH)
    expect(consent(mcp).status).toBe("signed_out")
    script.consent = () => Effect.fail(new McpNotTaken({ status: 400, code: "invalid_client" }))
    await mcp.actions.loadConsent(SEARCH)
    expect(consent(mcp)).toMatchObject({ status: "failed", error: "invalid_client", details: null })
  })

  test("a refused decision keeps the screen up with why; nothing is sent before the request loads", async () => {
    let sent = 0
    const mcp = await open({
      consent: () => Effect.succeed(DETAILS),
      decide: () => Effect.suspend(() => (sent++, Effect.fail(new McpNotTaken({ status: 429, code: "token_limit" })))),
    })
    await expect(mcp.actions.submitConsent("approve", SEARCH)).resolves.toBeUndefined()
    expect(sent).toBe(0)
    await mcp.actions.loadConsent(SEARCH)
    await expect(mcp.actions.submitConsent("deny", SEARCH)).resolves.toBeUndefined()
    expect(sent).toBe(1)
    expect(consent(mcp)).toMatchObject({ status: "ready", submitting: null, error: "token_limit" })
  })
})

/** `McpClient` over a `fetch` that answers with `respond`, recording each request it was handed. */
const client = (respond: (request: Request) => Promise<Response>, within?: `${number} millis`) => {
  const seen: Array<{ readonly method: string; readonly url: string; readonly body: string }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ method: request.method, url: request.url, body: await request.clone().text() })
    return respond(request)
  }
  const layer = McpClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
  const run = <A, E>(effect: (client: McpClient["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.exit(Effect.flatMap(McpClient, effect).pipe(Effect.provide(layer))))
  return { run, seen }
}

const refusalOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? { ...(Cause.squash(exit.cause) as McpNotTaken) } : "succeeded"

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

describe("McpClient", () => {
  test("lists tokens at GET /api/me/mcp-tokens, bare or under `tokens`", async () => {
    const bare = client(() => json([token("a")]))
    expect(await bare.run((c) => c.tokens)).toEqual(Exit.succeed([token("a")]))
    expect(bare.seen).toEqual([{ method: "GET", url: "http://chat.test/api/me/mcp-tokens", body: "" }])
    expect(await client(() => json({ tokens: [token("b")] })).run((c) => c.tokens)).toEqual(Exit.succeed([token("b")]))
  })

  test("revokes at DELETE /api/me/mcp-tokens/<id>, the id escaped, taking a 204", async () => {
    const { run, seen } = client(() => Promise.resolve(new Response(null, { status: 204 })))
    expect(await run((c) => c.revoke("a/b"))).toEqual(Exit.succeed(undefined))
    expect(seen).toEqual([{ method: "DELETE", url: "http://chat.test/api/me/mcp-tokens/a%2Fb", body: "" }])
  })

  test("reads a request at GET /api/mcp/oauth/authorize<search> and decides it at POST, with the decision", async () => {
    const { run, seen } = client((request) => request.method === "GET" ? json(DETAILS) : json({ redirectTo: "http://127.0.0.1:53682/callback?code=abc" }))
    expect(await run((c) => c.consent("client_id=client_1"))).toEqual(Exit.succeed(DETAILS))
    expect(await run((c) => c.decide("approve", "?client_id=client_1"))).toEqual(Exit.succeed("http://127.0.0.1:53682/callback?code=abc"))
    expect(seen).toEqual([
      { method: "GET", url: "http://chat.test/api/mcp/oauth/authorize?client_id=client_1", body: "" },
      { method: "POST", url: "http://chat.test/api/mcp/oauth/authorize?client_id=client_1", body: `{"decision":"approve"}` },
    ])
  })

  test("a refusal carries its status and ChatApi's code, OAuth's error, or its status alone", async () => {
    expect(refusalOf(await client(() => json({ code: "person_only" }, 403)).run((c) => c.tokens))).toEqual({ _tag: "McpNotTaken", status: 403, code: "person_only" })
    expect(refusalOf(await client(() => json({ error: "invalid_client" }, 400)).run((c) => c.consent("")))).toEqual({ _tag: "McpNotTaken", status: 400, code: "invalid_client" })
    expect(refusalOf(await client(() => json({}, 401)).run((c) => c.consent("")))).toEqual({ _tag: "McpNotTaken", status: 401 })
    expect(refusalOf(await client(() => Promise.resolve(new Response("down", { status: 502 }))).run((c) => c.revoke("a")))).toEqual({ _tag: "McpNotTaken", status: 502 })
  })

  test("a body that isn't the route's answer is not taken, with its status", async () => {
    expect(refusalOf(await client(() => json({ tokens: [{ id: 1 }] })).run((c) => c.tokens))).toEqual({ _tag: "McpNotTaken", status: 200 })
    expect(refusalOf(await client(() => json({ redirect: "x" })).run((c) => c.decide("deny", "")))).toEqual({ _tag: "McpNotTaken", status: 200 })
  })

  test("no network, and no answer within the deadline, are not taken with no status", async () => {
    expect(refusalOf(await client(() => Promise.reject(new TypeError("offline"))).run((c) => c.tokens))).toEqual({ _tag: "McpNotTaken" })
    expect(refusalOf(await client(() => new Promise(() => {}), "20 millis").run((c) => c.tokens))).toEqual({ _tag: "McpNotTaken" })
  })

  test("Mcp.live binds the layer to ChatApi's routes", async () => {
    const seen: Array<string> = []
    const fetch: typeof globalThis.fetch = async (input, init) => (seen.push(new Request(input, init).url), json([token("a")]))
    const runtime = ManagedRuntime.make(
      Mcp.live({ origin: "http://chat.test" }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    )
    runtimes.push(runtime)
    const mcp = await runtime.runPromise(Effect.service(Mcp))
    await mcp.actions.loadTokens()
    expect(seen).toEqual(["http://chat.test/api/me/mcp-tokens"])
  })
})
