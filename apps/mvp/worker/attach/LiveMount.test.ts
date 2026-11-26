import { Deferred, Effect, Option } from "effect"
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
} from "../../src/features/mcp/contract.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { Sessions } from "../Actor.ts"
import { BranchRoles } from "../branch/Access.vibe"
import * as Conversations from "../branch/Conversations.vibe"
import { repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as Messages from "../Messages.ts"
import { RunCredentials } from "../RunCredentials.ts"
import { testFile } from "../test/harness.ts"
import { cookie, signInHarness } from "../test/signIn.ts"
import { challengeFor } from "./Attach.ts"
import * as LiveMount from "./LiveMount.ts"

const runtime = testFile("attach_live")
const origin = "http://smithers.test"
const repo = repositoryOf("smithersai/smithers")
const branchName = "work/attach"
const mcp = attachMcpRoute(repo.owner, repo.name, branchName)
const verifier = "agent-verifier-0123456789-abcdefghijklmnopqrstuvwxyz"

const setup = async () => {
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
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) => {
    const attach = LiveMount.make(database)
    const handler = HttpEffect.toWebHandler(auth.signIn.admit(
      (LiveMount.handles(path) ? attach.fetch : Effect.succeed(HttpServerResponse.empty({ status: 404 }))).pipe(
        Effect.provide(auth.sessions),
        Effect.provide(BranchRoles.layer(roles)),
      ),
    ).pipe(Effect.provide(auth.services)))
    return handler(new Request(origin + path, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(data),
    }))
  }
  const mint = (scope: Partial<typeof target> = {}) =>
    post(ATTACH_INTENTS_ROUTE, { ...target, ...scope, ceiling: ATTACH_CAPABILITIES }, browser)
  const claim = async () => {
    const minted = await mint()
    expect(minted.status).toBe(201)
    const { reference } = await minted.json() as { reference: string }
    const claimed = await post(ATTACH_CLAIMS_ROUTE, { reference, client: "Codex", challenge: await challengeFor(verifier) })
    expect(claimed.status).toBe(201)
    const { claim, pairing } = await claimed.json() as { claim: string; pairing: string }
    return { reference, claim, pairing }
  }
  const attach = async () => {
    const claimed = await claim()
    const consent = await post(ATTACH_CONSENT_ROUTE, { reference: claimed.reference }, browser)
    expect(consent.status).toBe(200)
    expect(await consent.json()).toMatchObject({ ...target, claim: claimed.claim, ceiling: ATTACH_CAPABILITIES })
    const approved = await post(ATTACH_APPROVALS_ROUTE, { claim: claimed.claim, pairing: claimed.pairing }, browser)
    expect(approved.status).toBe(200)
    const { code, grant } = await approved.json() as { code: string; grant: string }
    const redeemed = await post(ATTACH_TOKENS_ROUTE, { claim: claimed.claim, code, verifier })
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
  return { person, branch, elsewhere, browser, target, post, mint, claim, attach, ask, credential }
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
