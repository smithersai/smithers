import { Deferred, Effect, Layer, Metric, Option } from "effect"
import { shardHost } from "../../src/test/messagesShardHost.ts"
import { MAX_BODY_LENGTH } from "@smthrs/app-state"
import { type Answered, answerOwner, MessagesShardBridge, questionOwner, writes as bridgeWrites } from "../chat/MessagesShardBridge.ts"
import { FetchHttpClient, HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA } from "../../src/features/auth/contract.ts"
import {
  ATTACH_APPROVALS_ROUTE,
  ATTACH_CAPABILITIES,
  ATTACH_CLAIMS_ROUTE,
  ATTACH_CONSENT_ROUTE,
  ATTACH_INTENTS_ROUTE,
  ATTACH_REVOCATIONS_ROUTE,
  ATTACH_TOKENS_ROUTE,
  attachMcpRoute,
  MCP_MAX_REQUEST_BYTES,
} from "../../src/features/mcp/contract.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { Sessions } from "../Actor.vibe"
import { BranchRoles } from "../branch/Access.vibe"
import * as Conversations from "../branch/Conversations.vibe"
import { repositoryOf } from "../github/Config.vibe"
import * as RepoRoles from "../github/RepoRoles.vibe"
import * as Messages from "../Messages.ts"
import * as SessionStore from "../SessionStore.vibe"
import * as Throttle from "../Throttle.vibe"
import { afterBody } from "../WriteAdmission.vibe"
import { RunCredentials } from "../RunCredentials.vibe"
import { testFile } from "../test/harness.ts"
import { cookie, signInHarness } from "../test/signIn.ts"
import { ATTACH_LIMITS, challengeFor } from "./Attach.vibe"
import * as LiveMount from "./LiveMount.vibe"

const runtime = testFile("attach_live")
const origin = "http://smithers.test"
const repo = repositoryOf("smithersai/smithers")
const branchName = "work/attach"
const mcp = attachMcpRoute(repo.owner, repo.name, branchName)
const verifier = "agent-verifier-0123456789-abcdefghijklmnopqrstuvwxyz"

const setup = async (bridge?: MessagesShardBridge["Service"]) => {
  const { database } = await runtime.runPromise(TestDatabase.Scratch)
  const auth = await signInHarness(runtime)
  const signed = await auth.signInAs()
  expect(signed.response.status).toBe(303)
  const browser = { origin, cookie: cookie(signed.cookies), [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA }
  const roles = await runtime.runPromise(RepoRoles.make(database, { repository: repo, app: Option.none() }).pipe(
    Effect.provide(FetchHttpClient.layer),
  ))
  const credential = await runtime.runPromise(Effect.gen(function* () {
    const current = yield* (yield* Sessions).resolve
    if (Option.isNone(current) || current.value.session === undefined) return yield* Effect.die("test session unavailable")
    const actor = current.value
    const run = crypto.randomUUID()
    const token = yield* (yield* RunCredentials).sign({
      v: 1, sub: actor.subject.id, sid: actor.session, act: "agent", run, root: run, chain: ["flow/new"],
      ceiling: [], exp: Date.now() + 60_000,
    })
    return { actor, token }
  }).pipe(
    Effect.provide(auth.sessions),
    Effect.provideService(HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(origin + ATTACH_INTENTS_ROUTE, { method: "POST", headers: browser }))),
  ))
  const person = credential.actor.subject.id
  const { branch } = await runtime.runPromise(Conversations.track(repo.id, branchName, "open", "a".repeat(40), person))
  const { branch: elsewhere } = await runtime.runPromise(
    Conversations.track(repo.id, "private", "open", "b".repeat(40), "another-person"),
  )
  const target = { repo: repo.owner + "/" + repo.name, branch: branch.name, conversation: branch.conversationId }

  // Build a fresh handler on every request. The intent, claim and grant must survive independently of the host instance.
  const request = (path: string, init: RequestInit, mountOnly = false) => {
    const attach = LiveMount.make(database)
    const fetch = mountOnly || LiveMount.handles(path)
      ? attach.fetch
      : Effect.succeed(HttpServerResponse.empty({ status: 404 }))
    const routed = fetch.pipe(
      Effect.provide(auth.sessions),
      Effect.provide(BranchRoles.layer(roles)),
      (routed) => bridge === undefined ? routed : Effect.provideService(routed, MessagesShardBridge, bridge),
    )
    const handler = HttpEffect.toWebHandler((mountOnly ? routed : auth.signIn.admit(routed)).pipe(Effect.provide(auth.services)))
    return handler(new Request(origin + path, init))
  }
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) =>
    request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(data) })
  const mint = (scope: Partial<typeof target> = {}) =>
    post(ATTACH_INTENTS_ROUTE, { ...target, ...scope, ceiling: ATTACH_CAPABILITIES }, browser)
  const claim = async (path: string = ATTACH_CLAIMS_ROUTE) => {
    const minted = await mint()
    expect(minted.status).toBe(201)
    const { reference } = await minted.json() as { reference: string }
    const claimed = await post(path, { reference, client: "Codex", challenge: await challengeFor(verifier) })
    expect(claimed.status).toBe(201)
    const { claim, pairing } = await claimed.json() as { claim: string; pairing: string }
    return { reference, claim, pairing }
  }
  const attach = async (claimPath?: string, tokenPath: string = ATTACH_TOKENS_ROUTE) => {
    const claimed = await claim(claimPath)
    const consent = await post(ATTACH_CONSENT_ROUTE, { reference: claimed.reference }, browser)
    expect(consent.status).toBe(200)
    expect(await consent.json()).toMatchObject({ ...target, claim: claimed.claim, ceiling: ATTACH_CAPABILITIES })
    const approved = await post(ATTACH_APPROVALS_ROUTE, { claim: claimed.claim, pairing: claimed.pairing }, browser)
    expect(approved.status).toBe(200)
    const { code, grant } = await approved.json() as { code: string; grant: string }
    const redeemed = await post(tokenPath, { claim: claimed.claim, code, verifier })
    expect(redeemed.status).toBe(200)
    const receipt = await redeemed.json() as { token: string; mcpPath: string; grant: { id: string } }
    expect(receipt.grant.id).toBe(grant)
    expect(receipt.mcpPath).toBe(mcp)
    return receipt
  }
  const ask = async (conversationId = target.conversation, askedBy = person) => {
    const id = crypto.randomUUID()
    const answerId = crypto.randomUUID()
    await runtime.runPromise(Messages.ask({
      id, answerId, conversationId, askedBy, text: "Question", data: { field: "value" },
    }))
    return { id, answerId }
  }
  return { database, roles, person, branch, elsewhere, browser, target, request, post, mint, claim, attach, ask, credential }
}

const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, params })
const tool = (name: string, args: unknown = {}) => rpc("tools/call", { name, arguments: args })
const bearer = (token: string) => ({ authorization: "Bearer " + token })

test("mounted routes grant only the bound conversation, run real tools and revoke immediately", async () => {
  const h = await setup()
  const question = await h.ask()
  const anotherPerson = await h.ask(h.target.conversation, "someone-else")
  const otherConversation = await h.ask(h.elsewhere.conversationId)
  const { token, grant } = await h.attach()
  const headers = bearer(token)

  const wrong = await h.post(attachMcpRoute(repo.owner, "other", branchName), rpc("initialize"), headers)
  expect(wrong.status).toBe(403)
  expect(await wrong.json()).toMatchObject({ error: { data: { reason: "wrong_target" } } })

  const initialized = await h.post(mcp, rpc("initialize"), headers)
  expect(initialized.status).toBe(200)
  const listed = await h.post(mcp, rpc("tools/list"), headers)
  const { result } = await listed.json() as { result: { tools: Array<{ name: string }> } }
  expect(result.tools.map(({ name }) => name))
    .toEqual(["conversation_read", "conversation_respond"])

  const history = await h.post(mcp, tool("conversation_read"), headers)
  expect(await history.json()).toMatchObject({ result: { structuredContent: { messages: [
    expect.objectContaining({ id: question.id, text: "Question", data: { field: "value" } }),
    expect.objectContaining({ id: question.answerId, status: "streaming" }),
    expect.objectContaining({ id: anotherPerson.id, text: "Question", data: null }),
    expect.objectContaining({ id: anotherPerson.answerId, status: "streaming" }),
  ] } } })
  for (const id of [anotherPerson.id, otherConversation.id]) {
    const response = await h.post(mcp, tool("conversation_respond", { questionId: id, text: "No" }), headers)
    expect(response.status).toBe(403)
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const answered = await h.post(mcp, tool("conversation_respond", { questionId: question.id, text: "Answer" }), headers)
    expect(await answered.json()).toMatchObject({ result: { structuredContent: { answered: true, answerId: question.answerId } } })
  }
  expect((await h.post(ATTACH_REVOCATIONS_ROUTE, { grant: grant.id }, h.browser)).status).toBe(204)
  const revoked = await h.post(mcp, rpc("initialize"), headers)
  expect(revoked.status).toBe(401)
  expect(await revoked.json()).toMatchObject({ error: { data: { reason: "revoked" } } })
})

test("legacy claim and redeem aliases issue a usable token", async () => {
  const h = await setup()
  const { token } = await h.attach("/api/attach/claim", "/api/attach/redeem")
  expect((await h.post(mcp, rpc("initialize"), bearer(token))).status).toBe(200)
})

test.each([ATTACH_CLAIMS_ROUTE, "/api/attach/claim"])(
  "write admission exhausts the allowance through %s before reading another body or acquiring Postgres",
  async (firstPath) => {
    const h = await setup()
    const auth = await signInHarness(runtime)
    let databaseAcquisitions = 0
    const database = Layer.unwrap(Effect.sync(() => {
      databaseAcquisitions++
      return h.database
    }))
    const seen = new Set<string>()
    const attach: Throttle.Limiter = {
      limit: ({ key }) => Effect.sync(() => {
        if (seen.has(key)) return { success: false }
        seen.add(key)
        return { success: true }
      }),
    }
    const open: Throttle.Limiter = { limit: () => Effect.succeed({ success: true }) }
    const throttle = Effect.flatMap(HttpServerRequest.HttpServerRequest,
      Throttle.make({ shape: open, telemetry: open, broker: open, attach, "attach-mcp": open, waitlist: open }))
    const mount = LiveMount.make(database)
    const handler = HttpEffect.toWebHandler(afterBody(mount.fetch, throttle).pipe(
      Effect.provide(auth.sessions),
      Effect.provide(BranchRoles.layer(h.roles)),
      Effect.provide(auth.services),
    ))
    const minted = await h.mint()
    expect(minted.status).toBe(201)
    const { reference } = await minted.json() as { reference: string }
    const claimBody = JSON.stringify({ reference, client: "Codex", challenge: await challengeFor(verifier) })
    const admitted = await handler(new Request(origin + firstPath, { method: "POST", body: claimBody }))
    expect(admitted.status).toBe(201)
    expect(databaseAcquisitions).toBe(1)

    for (const path of [ATTACH_CLAIMS_ROUTE, "/api/attach/claim", ATTACH_TOKENS_ROUTE, "/api/attach/redeem"]) {
      let pulls = 0
      const payload = path === ATTACH_TOKENS_ROUTE || path.endsWith("/redeem")
        ? JSON.stringify({ claim: "unused", code: "unused", verifier })
        : claimBody
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++
          controller.enqueue(new TextEncoder().encode(payload))
          controller.close()
        },
      }, { highWaterMark: 0 })
      const request = new Request(origin + path + "?ignored=1", { method: "POST", body, duplex: "half" } as RequestInit)
      const refused = await handler(request)
      expect(refused.status).toBe(429)
      expect(await refused.json()).toEqual({ code: "rate_limited" })
      expect(request.bodyUsed).toBe(false)
      expect(pulls).toBe(0)
      expect(databaseAcquisitions).toBe(1)
    }
  },
)

test("the mount allows only POST and forbids caching its method refusal", async () => {
  const h = await setup()
  const response = await h.request(ATTACH_INTENTS_ROUTE, { method: "GET", headers: h.browser })
  expect(response.status).toBe(405)
  expect(response.headers.get("allow")).toBe("POST")
  expect(response.headers.get("cache-control")).toBe("no-store")
})

test("the next intent is refused when the person reaches their limit", async () => {
  const h = await setup()
  for (let i = 0; i < ATTACH_LIMITS.intentsPerPerson; i++) {
    expect((await h.mint()).status).toBe(201)
  }
  const refused = await h.mint()
  expect(refused.status).toBe(429)
  expect(await refused.json()).toEqual({ code: "too_many" })
})

test("a person below their own limit cannot mint when the deployment is full", async () => {
  const h = await setup()
  const { reference } = await h.claim()
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO attach_grants (origin, reference, person_id, expires_at, state)
      SELECT origin, 'capacity-' || slot, 'other-' || slot, expires_at, state
      FROM attach_grants CROSS JOIN generate_series(1, ${ATTACH_LIMITS.intents - 1}::int) AS slot
      WHERE origin = ${origin} AND reference = ${reference}`
  }))
  const refused = await h.mint()
  expect(refused.status).toBe(429)
  expect(await refused.json()).toEqual({ code: "too_many" })
})

test("local sign-in can mint for its developer without a persisted session", async () => {
  const h = await setup()
  const auth = await signInHarness(runtime, {
    config: {},
    fallback: { actor: { subject: { kind: "person", id: h.person }, role: "admin" }, login: "local-developer" },
  })
  const handler = HttpEffect.toWebHandler(auth.signIn.admit(LiveMount.make(h.database).fetch).pipe(
    Effect.provide(auth.sessions),
    Effect.provide(BranchRoles.layer(h.roles)),
    Effect.provide(auth.services),
  ))
  const response = await handler(new Request(origin + ATTACH_INTENTS_ROUTE, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ ...h.target, ceiling: ATTACH_CAPABILITIES }),
  }))
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ ceiling: ATTACH_CAPABILITIES })
})

test("an intent reference collision cannot replace the existing row", async () => {
  const h = await setup()
  const ddl = (statement: string) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)))
  // Reserve the random reference just before the mount's insert reaches Postgres's unique index.
  await ddl(`CREATE FUNCTION reserve_attach_reference() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF pg_trigger_depth() = 1 THEN
        INSERT INTO attach_grants (origin, reference, person_id, expires_at, state)
        VALUES (NEW.origin, NEW.reference, 'existing-person', NEW.expires_at, NEW.state);
      END IF;
      RETURN NEW;
    END
  $$`)
  try {
    await ddl(`CREATE TRIGGER reserve_attach_reference BEFORE INSERT ON attach_grants
      FOR EACH ROW EXECUTE FUNCTION reserve_attach_reference()`)
    const response = await h.mint()
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ code: "too_many" })
    const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      SELECT person_id FROM attach_grants WHERE origin = ${origin}`))
    expect(rows).toEqual([{ person_id: "existing-person" }])
  } finally {
    await ddl("DROP TRIGGER IF EXISTS reserve_attach_reference ON attach_grants")
    await ddl("DROP FUNCTION reserve_attach_reference()")
  }
})

test("the mount refuses unknown routes, foreign or missing origins, and unreadable bodies", async () => {
  const h = await setup()
  const cases = [
    ["/api/attach/unknown", {}, "{}", 404, "not_found"],
    [ATTACH_INTENTS_ROUTE, { ...h.browser, origin: "https://elsewhere.test" }, "{}", 403, "wrong_origin"],
    [ATTACH_INTENTS_ROUTE, { cookie: h.browser.cookie, [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA }, "{}", 403, "wrong_origin"],
    [ATTACH_CLAIMS_ROUTE, { "content-length": String(MCP_MAX_REQUEST_BYTES + 1) }, "", 413, "invalid"],
    [ATTACH_CLAIMS_ROUTE, {}, new Uint8Array([0xff]), 400, "invalid"],
  ] as const
  for (const [path, headers, body, status, code] of cases) {
    const response = await h.request(path, { method: "POST", headers: { ...headers }, body }, true)
    expect(response.status).toBe(status)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ code })
  }
})

test("every attach route rejects an invalid payload", async () => {
  const h = await setup()
  for (const path of [
    ATTACH_CONSENT_ROUTE, ATTACH_APPROVALS_ROUTE, ATTACH_REVOCATIONS_ROUTE, ATTACH_CLAIMS_ROUTE, ATTACH_TOKENS_ROUTE,
  ]) {
    const response = await h.post(path, {}, h.browser)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ code: "invalid" })
  }
})

test("MCP refuses missing credentials and binds explicit reads to the grant's conversation", async () => {
  const h = await setup()
  const unauthenticated = await h.post(mcp, rpc("initialize"))
  expect(unauthenticated.status).toBe(401)
  const { token } = await h.attach()
  const headers = bearer(token)
  const allowed = await h.post(mcp, tool("conversation_read", { conversation: h.target.conversation }), headers)
  expect(allowed.status).toBe(200)
  expect(await allowed.json()).toMatchObject({ result: { structuredContent: { messages: [] } } })
  const refused = await h.post(mcp, tool("conversation_read", { conversation: h.elsewhere.conversationId }), headers)
  expect(refused.status).toBe(403)
})

test("ending the issuing session immediately removes MCP access", async () => {
  const h = await setup()
  const { token } = await h.attach()
  const headers = bearer(token)
  expect((await h.post(mcp, rpc("initialize"), headers)).status).toBe(200)
  await runtime.runPromise(SessionStore.revoke({ id: h.credential.actor.session! }, "sign_out"))
  const refused = await h.post(mcp, rpc("initialize"), headers)
  expect(refused.status).toBe(403)
  expect(await refused.json()).toMatchObject({ error: { data: { reason: "forbidden" } } })
})

test("approval refuses a stored intent with an incomplete repository", async () => {
  const h = await setup()
  const { reference, claim, pairing } = await h.claim()
  expect((await h.post(ATTACH_CONSENT_ROUTE, { reference }, h.browser)).status).toBe(200)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    UPDATE attach_grants SET state = jsonb_set(state, '{intents,0,1,repo}', '"incomplete"')
    WHERE origin = ${origin} AND reference = ${reference}`))
  const refused = await h.post(ATTACH_APPROVALS_ROUTE, { claim, pairing }, h.browser)
  expect(refused.status).toBe(403)
  expect(await refused.json()).toEqual({ code: "forbidden" })
})

test("approval refuses to reserve a grant when the deployment is at capacity", async () => {
  const h = await setup()
  const { reference, claim, pairing } = await h.claim()
  expect((await h.post(ATTACH_CONSENT_ROUTE, { reference }, h.browser)).status).toBe(200)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO attach_grants (origin, reference, person_id, expires_at, state, grant_id, token_hash)
    SELECT origin, 'capacity-' || slot, person_id, expires_at, state, 'grant-' || slot, 'token-' || slot
    FROM attach_grants CROSS JOIN generate_series(1, ${ATTACH_LIMITS.tokens}::int) AS slot
    WHERE origin = ${origin} AND reference = ${reference}`))
  const refused = await h.post(ATTACH_APPROVALS_ROUTE, { claim, pairing }, h.browser)
  expect(refused.status).toBe(429)
  expect(await refused.json()).toEqual({ code: "too_many" })
})

test("all person routes reject delegated Sessions and caller-supplied identity", async () => {
  const h = await setup()
  const delegated = { ...h.browser, ...bearer(h.credential.token) }
  for (const [route, body] of [
    [ATTACH_INTENTS_ROUTE, { ...h.target, ceiling: ATTACH_CAPABILITIES }],
    [ATTACH_CONSENT_ROUTE, { reference: "test" }],
    [ATTACH_APPROVALS_ROUTE, { claim: "test", pairing: "123456" }],
    [ATTACH_REVOCATIONS_ROUTE, { grant: "test" }],
  ] as const) {
    const refused = await h.post(route, body, delegated)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ code: "person_only" })
  }
  const forged = await h.post(ATTACH_INTENTS_ROUTE, { ...h.target, actor: h.credential.actor, ceiling: ATTACH_CAPABILITIES }, { origin })
  expect(forged.status).toBe(401)
  const smuggled = await h.post(ATTACH_INTENTS_ROUTE, { ...h.target, actor: h.credential.actor, ceiling: ATTACH_CAPABILITIES }, h.browser)
  expect(smuggled.status).toBe(400)
})

test("intent admission checks repo, branch and conversation and approval checks the pairing code", async () => {
  const h = await setup()
  for (const scope of [
    { repo: "smithersai/other" },
    { branch: "main" },
    { conversation: h.elsewhere.conversationId },
    { branch: h.elsewhere.name, conversation: h.elsewhere.conversationId },
  ]) {
    const refused = await h.mint(scope)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ code: "forbidden" })
  }
  const { reference, claim, pairing } = await h.claim()
  expect((await h.post(ATTACH_CONSENT_ROUTE, { reference }, h.browser)).status).toBe(200)
  const incorrect = pairing === "000000" ? "999999" : "000000"
  const refused = await h.post(ATTACH_APPROVALS_ROUTE, { claim, pairing: incorrect }, h.browser)
  expect(refused.status).toBe(401)
  expect(await refused.json()).toEqual({ code: "wrong_pairing" })
  const approvals = await Promise.all(Array.from({ length: 2 }, () =>
    h.post(ATTACH_APPROVALS_ROUTE, { claim, pairing }, h.browser)))
  expect(approvals.map(({ status }) => status).sort()).toEqual([200, 401])
  const approved = approvals.find(({ status }) => status === 200)!
  const { code, grant } = await approved.json() as { code: string; grant: string }
  expect((await h.post(ATTACH_REVOCATIONS_ROUTE, { grant }, h.browser)).status).toBe(204)
  const stopped = await h.post(ATTACH_TOKENS_ROUTE, { claim, code, verifier })
  expect(stopped.status).toBe(401)
  expect(await stopped.json()).toEqual({ code: "invalid_code" })
})

test("a live grant loses write access after its person is reduced to a view share", async () => {
  const h = await setup()
  const { token } = await h.attach()
  const question = await h.ask()
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE branches SET created_by = 'another-person' WHERE id = ${h.branch.branchId}`
    yield* sql`INSERT INTO branch_shares (branch_id, grantee, login, access) VALUES (${h.branch.branchId}, ${h.person}, 'octocat', 'view')`
  }))
  try {
    const response = await h.post(mcp, tool("conversation_respond", { questionId: question.id, text: "No" }), bearer(token))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { data: { reason: "capability_exceeded" } } })
    const read = await h.post(mcp, tool("conversation_read"), bearer(token))
    expect(read.status).toBe(200)
  } finally {
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM branch_shares WHERE branch_id = ${h.branch.branchId} AND grantee = ${h.person}`
      yield* sql`UPDATE branches SET created_by = ${h.person} WHERE id = ${h.branch.branchId}`
    }))
  }
})

test("revocation proceeds while unrelated anonymous requests wait on their own attachment rows", async () => {
  const h = await setup()
  const { token, grant } = await h.attach()
  const minted = await h.mint()
  expect(minted.status).toBe(201)
  const { reference } = await minted.json() as { reference: string }
  const pending = await h.claim()
  expect((await h.post(ATTACH_CONSENT_ROUTE, { reference: pending.reference }, h.browser)).status).toBe(200)
  const approved = await h.post(ATTACH_APPROVALS_ROUTE, { claim: pending.claim, pairing: pending.pairing }, h.browser)
  expect(approved.status).toBe(200)
  const { code } = await approved.json() as { code: string }
  const challenge = await challengeFor(verifier)

  const locked = Deferred.makeUnsafe<number>()
  const release = Deferred.makeUnsafe<void>()
  const holding = runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(Effect.gen(function* () {
      const rows = yield* sql<{ readonly pid: number }>`
        SELECT pg_backend_pid() AS pid FROM attach_grants
        WHERE origin = ${origin} AND reference IN (${reference}, ${pending.reference}) FOR UPDATE`
      expect(rows).toHaveLength(2)
      yield* Deferred.succeed(locked, rows[0]!.pid)
      yield* Deferred.await(release)
    }))
  }))
  const pid = await Promise.race([
    runtime.runPromise(Deferred.await(locked).pipe(Effect.timeout("5 seconds"))),
    holding.then(() => { throw new Error("Attachment locks were released early") }),
  ])
  const claimed = h.post(ATTACH_CLAIMS_ROUTE, { reference, client: "Codex", challenge })
  const redeemed = h.post(ATTACH_TOKENS_ROUTE, { claim: pending.claim, code, verifier })
  try {
    await expect.poll(() => runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ readonly waiting: number }>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pg_stat_activity.pid))`
      return row!.waiting
    }))).toBe(2)

    const [invalid, revocation] = await runtime.runPromise(Effect.promise(() => Promise.all([
      h.post(mcp, rpc("initialize"), bearer("smat_" + "A".repeat(43))),
      h.post(ATTACH_REVOCATIONS_ROUTE, { grant: grant.id }, h.browser),
    ])).pipe(Effect.timeout("5 seconds")))
    expect(invalid.status).toBe(401)
    expect(await invalid.json()).toMatchObject({ error: { data: { reason: "unauthenticated" } } })
    expect(revocation.status).toBe(204)
    const revoked = await h.post(mcp, rpc("initialize"), bearer(token))
    expect(await revoked.json()).toMatchObject({ error: { data: { reason: "revoked" } } })
  } finally {
    await runtime.runPromise(Deferred.succeed(release, undefined))
    await holding
    await Promise.allSettled([claimed, redeemed])
  }
  expect((await claimed).status).toBe(201)
  expect((await redeemed).status).toBe(200)
}, 20_000)

test("an unknown bearer needs only a read lock on the attachment table", async () => {
  const h = await setup()
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(Effect.gen(function* () {
      // EXCLUSIVE still permits plain SELECT, but blocks row-locking SELECT and writes.
      yield* sql`LOCK TABLE attach_grants IN EXCLUSIVE MODE`
      const response = yield* Effect.promise(() =>
        h.post(mcp, rpc("initialize"), bearer("smat_" + "A".repeat(43))),
      ).pipe(Effect.timeout("5 seconds"))
      expect(response.status).toBe(401)
    }))
  }))
}, 15_000)

test("an attached agent's answer and its completion are also sequenced into the conversation's shard, once", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const host = yield* shardHost()
    const registry: Metric.MetricRegistry = new Map()
    const counted = MessagesShardBridge.make(host.forward)
    const bridge = MessagesShardBridge.of({
      asked: (asked) => counted.asked(asked).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      answered: (answered) => counted.answered(answered).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      noted: counted.noted,
    })
    const h = yield* Effect.promise(() => setup(bridge))
    // Asked before the bridge reached this conversation: Postgres holds the pair, the shard nothing.
    const question = yield* Effect.promise(() => h.ask())
    const { token } = yield* Effect.promise(() => h.attach())
    const respond = (text: string) =>
      Effect.promise(async () =>
        (await h.post(mcp, tool("conversation_respond", { questionId: question.id.toUpperCase(), text }), bearer(token))).json())
    const state = () => Effect.map(host.state(h.target.conversation), ({ chat }) => chat.messages)
    const seq = () => Effect.map(host.head(h.target.conversation), (head) => head.seq)
    // Each as Postgres committed it, read back after the commit: its place, its time, and the answer's last write.
    const [asked, given] = yield* Effect.promise(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly position: number; readonly createdAt: string; readonly text: string }>`
        SELECT position::int AS position, (created_at AT TIME ZONE 'UTC')::text || '+00' AS "createdAt", text
        FROM messages WHERE conversation_id = ${h.target.conversation} ORDER BY position`)))
    const stored = [
      {
        id: question.id, author: questionOwner(question.id), body: asked!.text, status: "posted", hubSeq: 1,
        role: "user", position: asked!.position, createdAt: asked!.createdAt,
      },
      {
        id: question.answerId, author: answerOwner(question.answerId), body: "Answer", status: "complete", hubSeq: 2,
        role: "assistant", questionId: question.id, position: given!.position, createdAt: given!.createdAt,
        updatedAt: expect.stringMatching(/\+00$/),
      },
    ]
    // The answer, and the same answer given again: Postgres takes it once, and so does the shard. The question it
    // answers comes with it: the shard held nothing of this conversation.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(yield* respond("Answer")).toMatchObject({ result: { structuredContent: { answered: true, answerId: question.answerId } } })
      expect(yield* state()).toEqual(stored)
      expect(yield* seq()).toBe(6)
    }
    // Another answer once it is finished: Postgres refuses it, and the bridge is never asked.
    expect(yield* respond("Other words")).toMatchObject({ result: { structuredContent: { answered: false } } })
    expect(yield* state()).toEqual(stored)
    const count = Effect.runSync(Metric.value(Metric.withAttributes(bridgeWrites, { write: "answered", outcome: "ok" })).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
    )).count
    expect(count).toBe(2)
    const [row] = yield* Effect.promise(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly text: string; readonly status: string }>`SELECT text, status FROM messages WHERE id = ${question.answerId}`)))
    expect(row).toEqual({ text: "Answer", status: "done" })
  }))))

const answerRow = (answerId: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly text: string | null; readonly status: string }>`SELECT text, status FROM messages WHERE id = ${answerId}`))
    .then(([row]) => row!)

/** A bridge over `host` that first reads the answer's row on another connection: what Postgres has committed of it. */
const observing = (host: Effect.Success<ReturnType<typeof shardHost>>) => {
  const real = MessagesShardBridge.make(host.forward)
  const committed: Array<string> = []
  const outcomes: Array<string> = []
  const bridge = MessagesShardBridge.of({
    asked: real.asked,
    noted: real.noted,
    answered: (answered: Answered) =>
      Effect.gen(function* () {
        const row = yield* Effect.promise(() => answerRow(answered.answerId))
        committed.push(`${row.status}:${row.text === answered.text}`)
        const outcome = yield* real.answered(answered)
        outcomes.push(outcome)
        return outcome
      }),
  })
  return { bridge, committed, outcomes }
}

test("an answer reaches the shard only after Postgres commits it: a rollback and a failed commit write nothing there", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const host = yield* shardHost()
    const { bridge, committed, outcomes } = observing(host)
    const h = yield* Effect.promise(() => setup(bridge))
    const question = yield* Effect.promise(() => h.ask())
    const { token } = yield* Effect.promise(() => h.attach())
    const respond = (text: string) =>
      Effect.promise(() => h.post(mcp, tool("conversation_respond", { questionId: question.id, text }), bearer(token)))
    const state = () => Effect.map(host.state(h.target.conversation), ({ chat }) => chat.messages)
    const seq = () => Effect.map(host.head(h.target.conversation), (head) => head.seq)
    const ddl = (statement: string) =>
      Effect.promise(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement))))

    // Postgres itself refuses the write, two ways: the answer's UPDATE fails, so its transaction rolls back before the
    // tool finishes; then the UPDATE succeeds and the tool answers, and the COMMIT fails on a deferred constraint.
    yield* ddl(`CREATE FUNCTION refuse_answer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`)
    const faults = [
      `CREATE TRIGGER refuse_answer BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION refuse_answer()`,
      `CREATE CONSTRAINT TRIGGER refuse_answer AFTER UPDATE ON messages DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION refuse_answer()`,
    ]
    for (const fault of faults) {
      yield* ddl(fault)
      const failed = yield* respond("Answer").pipe(Effect.ensuring(ddl(`DROP TRIGGER refuse_answer ON messages`)))
      expect(failed.status, fault).toBe(503)
      // Postgres holds no answer, and the shard was never reached: zero entries, zero messages.
      expect(yield* Effect.promise(() => answerRow(question.answerId))).toMatchObject({ status: "streaming" })
      expect(committed).toEqual([])
      expect(yield* seq()).toBe(0)
      expect(yield* state()).toEqual([])
    }
    yield* ddl(`DROP FUNCTION refuse_answer()`)

    // Postgres still takes an answer, and other words than the ones that failed: the shard holds nothing that says otherwise.
    const answered = yield* respond("Another answer")
    expect(yield* Effect.promise(() => answered.json())).toMatchObject({ result: { structuredContent: { answered: true, answerId: question.answerId } } })
    // The bridge was called with the answer already committed: another connection read it finished, with this text.
    expect(committed).toEqual(["done:true"])
    const stored = [
      { id: question.id, author: questionOwner(question.id), status: "posted", hubSeq: 1, role: "user" },
      {
        id: question.answerId, author: answerOwner(question.answerId), body: "Another answer", status: "complete",
        hubSeq: 2, role: "assistant", questionId: question.id,
      },
    ]
    expect(yield* state()).toMatchObject(stored)
    expect(yield* state()).toHaveLength(2)
    expect(yield* seq()).toBe(6)
    // The same words again, as a retry gives them: committed as before, bridged again, and nothing added.
    const again = yield* respond("Another answer")
    expect(yield* Effect.promise(() => again.json())).toMatchObject({ result: { structuredContent: { answered: true } } })
    expect(committed).toEqual(["done:true", "done:true"])
    expect(outcomes).toEqual(["ok", "ok"])
    expect(yield* state()).toMatchObject(stored)
    expect(yield* seq()).toBe(6)
    // The words that failed are now another answer to a finished question: Postgres refuses, and the bridge is not called.
    const late = yield* respond("Answer")
    expect(yield* Effect.promise(() => late.json())).toMatchObject({ result: { structuredContent: { answered: false } } })
    expect(committed).toHaveLength(2)
  }))), 30_000)

test("an answer at the length bound in multibyte text is stored and bridged whole, and again on a retry", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const host = yield* shardHost()
    const { bridge, outcomes } = observing(host)
    const h = yield* Effect.promise(() => setup(bridge))
    const { token } = yield* Effect.promise(() => h.attach())
    // 32,000 UTF-16 units each: 96,000 bytes of UTF-8, past the 65,536 a submit once carried, and 64,000.
    for (const text of ["界".repeat(MAX_BODY_LENGTH), "😀".repeat(MAX_BODY_LENGTH / 2)]) {
      expect(text.length).toBe(MAX_BODY_LENGTH)
      const question = yield* Effect.promise(() => h.ask())
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = yield* Effect.promise(() =>
          h.post(mcp, tool("conversation_respond", { questionId: question.id, text }), bearer(token)))
        expect(yield* Effect.promise(() => response.json())).toMatchObject({ result: { structuredContent: { answered: true } } })
        const row = yield* Effect.promise(() => answerRow(question.answerId))
        expect([row.status, row.text === text]).toEqual(["done", true])
        const mirrored = (yield* host.state(h.target.conversation)).chat.messages.find((message) => message.id === question.answerId)
        // Finished in the shard too, with every character: never left streaming behind a write too large to send.
        expect([mirrored?.status, mirrored?.body === text]).toEqual(["complete", true])
      }
    }
    expect(outcomes).toEqual(["ok", "ok", "ok", "ok"])
  }))), 30_000)
