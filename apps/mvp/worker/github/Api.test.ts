// The git loop's routes (worker/github/Api.ts, docs/features/issues.md#routes) through their real handler, over this
// file's schema of the compose Postgres and Electric (`pnpm db:up`), with remote flows recorded or run on the Node host
// against the scripted GitHub (worker/github/test/harness.ts). Unhappy paths give the routes a faulty service; nothing
// intercepts a request.
import { BranchRoles } from "../branch/Access.ts"
import { ConfigProvider, Duration, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import {
  applyExecutionId,
  COMMENTS_SHAPE_ROUTE,
  GITHUB_WEBHOOK_ROUTE,
  ITEMS_SHAPE_ROUTE,
  MAX_WEBHOOK_BYTES,
  MAX_WRITE_BYTES,
  reconcileBucketStart,
  reconcileExecutionId,
  refusalOf,
  SYNC_SHAPE_ROUTE,
  writeExecutionId,
  writesRoute,
  WRITES_SHAPE_ROUTE,
} from "../../src/features/issues/contract.ts"
import { CHECKS_SHAPE_ROUTE, compareRoute, PULLS_SHAPE_ROUTE } from "../../src/features/pulls/contract.ts"
import * as Actor from "../Actor.ts"
import { FlowStarter, StartConflict, StartUnavailable } from "../Flows.ts"
import { testFile } from "../test/harness.ts"
import { handles, make, parseWritesPath, RECONCILE_START_TIMEOUT } from "./Api.ts"
import * as Metrics from "./Metrics.ts"
import * as RepoRoles from "./RepoRoles.ts"
import { comments, items, REPOSITORY, reset, rolesThatRead, signedIn, sql, writeRow } from "./test/fixtures.ts"
import { app, delivery, githubHarness, member, sign, WEBHOOK_SECRET } from "./test/harness.ts"
import { type ScriptedGitHub, scriptedGitHub } from "./test/scriptedGitHub.ts"

const runtime = testFile("github_api")

beforeAll(async () => {
  const health = `${await runtime.runPromise(TestDatabase.electricUrl)}/v1/health`
  const response = await fetch(health).catch((error: unknown) => {
    throw TestDatabase.explain("Electric", new URL(health).host)(error)
  })
  if (!response.ok) throw new Error(`Electric answered ${response.status} to ${health}`)
})

beforeEach(() => reset(runtime))

const SENTINEL = "sentinel-content-5c2e"

const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))

const issuesEvent = (number: number, full = "acme/widgets") => ({
  action: "opened",
  repository: { full_name: full },
  issue: { number, title: SENTINEL },
})

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
})

const createWrite = (overrides: Record<string, unknown> = {}) => ({
  writeId: crypto.randomUUID(),
  op: "issue/create",
  title: "Crash on empty body",
  body: "Steps",
  ...overrides,
})

describe("paths", () => {
  test("the writes path is /api/repos/<owner>/<name>/writes, and nothing else", () => {
    expect(parseWritesPath(writesRoute("acme", "widgets"))).toEqual({ owner: "acme", name: "widgets" })
    expect(parseWritesPath("/api/repos/acme/widgets")).toBeUndefined()
    expect(parseWritesPath("/api/repos/acme/widgets/tree")).toBeUndefined()
    expect(parseWritesPath("/api/other/acme/widgets/writes")).toBeUndefined()
    expect(parseWritesPath("/api/repos/%E0%A4%A/widgets/writes")).toBeUndefined()
    expect(handles(GITHUB_WEBHOOK_ROUTE) && handles(ITEMS_SHAPE_ROUTE) && handles(writesRoute("a", "b"))).toBe(true)
    expect(handles("/api/repos/acme/widgets/tree/abc")).toBe(false)
  })
})

describe("POST /api/github/webhook", () => {
  test("a signed issues delivery starts github/Apply for its issue once, records it, and answers 200", async () => {
    const h = await githubHarness(runtime)
    const id = crypto.randomUUID()
    const first = await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("issues", issuesEvent(7), { id }))
    expect(first.status).toBe(200)
    expect(h.starts).toEqual([
      {
        flow: "github/Apply",
        executionId: applyExecutionId(id),
        payload: { deliveryId: id, repo: "acme/widgets", number: 7, event: "issues" },
      },
    ])
    expect(await sql(runtime, `SELECT event, action, repo_id AS "repoId", subject FROM github_deliveries`)).toEqual([
      { event: "issues", action: "opened", repoId: REPOSITORY.id, subject: 7 },
    ])
    // GitHub redelivers: the same execution, which changes nothing, and the delivery counted as a duplicate.
    const again = await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("issues", issuesEvent(7), { id }))
    expect(again.status).toBe(200)
    expect(h.count(Metrics.webhooks, { event: "issues", outcome: "applied" })).toBe(1)
    expect(h.count(Metrics.webhooks, { event: "issues", outcome: "duplicate" })).toBe(1)
    expect(h.line("github.webhook")[0]!.annotations).toMatchObject({ event: "issues", number: 7, outcome: "applied", status: 200 })
  })

  test("a comment delivery runs github/Apply to the end: GitHub's comment becomes a row", async () => {
    const h = await githubHarness(runtime, { run: true })
    h.github.open("On GitHub", "Body", "sam")
    h.github.comment(1, "Made on github.com", "maya")
    const response = await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("issue_comment", { ...issuesEvent(1), action: "created" }))
    expect(response.status).toBe(200)
    await h.settled()
    expect(await items(runtime)).toEqual([expect.objectContaining({ number: 1, title: "On GitHub", comments: 1 })])
    expect(await comments(runtime)).toEqual([expect.objectContaining({ body: "Made on github.com", author: "maya" })])
  })

  test("deliveries naming no issue of a repository the deployment acts on are recorded and answered, starting nothing", async () => {
    // GITHUB_ALLOWED_REPOSITORIES leaves someone/else out.
    const h = await githubHarness(runtime, { allowed: new Set([REPOSITORY.id]) })
    for (const sent of [
      await delivery("ping", { zen: "Keep it logically awesome." }),
      await delivery("issues", issuesEvent(1, "someone/else")),
      await delivery("issues", { action: "opened" }),
      await delivery("issues", issuesEvent(1, "not a/name")),
      await delivery("push", { ref: "refs/heads/main", repository: { full_name: "acme/widgets" } }),
    ]) {
      expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, sent)).status).toBe(200)
    }
    expect(h.starts).toEqual([])
    expect(h.count(Metrics.webhooks, { event: "issues", outcome: "ignored" })).toBe(3)
    expect(await sql(runtime, `SELECT count(*)::int AS n FROM github_deliveries WHERE repo_id IS NULL`)).toEqual([{ n: 5 }])
  })

  test("an issue delivery of another repository the App is installed on starts github/Apply for that repository (decision 0079)", async () => {
    // The deployment's own repository is acme/home; GitHub only sends the App events of repositories it is installed on.
    const h = await githubHarness(runtime, { own: { owner: "acme", name: "home", id: "github/acme/home" } })
    const sent = await delivery("issues", issuesEvent(3, "acme/widgets"))
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, sent)).status).toBe(200)
    expect(h.starts).toEqual([
      expect.objectContaining({ flow: "github/Apply", payload: expect.objectContaining({ repo: "acme/widgets", number: 3 }) }),
    ])
    expect(await sql(runtime, `SELECT repo_id AS "repoId", subject FROM github_deliveries`)).toEqual([
      { repoId: "github/acme/widgets", subject: 3 },
    ])
    expect(h.line("github.webhook")[0]).toMatchObject({ annotations: { outcome: "applied", repoId: "github/acme/widgets", number: 3 } })
  })

  test("refusals: a wrong or missing signature, no delivery id, a body too large, bad JSON, another method", async () => {
    const h = await githubHarness(runtime)
    const forged = await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("issues", issuesEvent(1), { secret: "wrong" }))
    expect(forged.status).toBe(401)
    expect(await forged.json()).toEqual({ code: "invalid_signature" })
    const unsigned = await delivery("issues", issuesEvent(1), { signature: "" })
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, unsigned)).status).toBe(401)
    const anonymous = await delivery("issues", issuesEvent(1))
    delete (anonymous.headers as Record<string, string>)["x-github-delivery"]
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, anonymous)).status).toBe(400)
    const huge = "x".repeat(MAX_WEBHOOK_BYTES + 1)
    const tooLarge = await h.fetch(GITHUB_WEBHOOK_ROUTE, {
      method: "POST",
      headers: { "x-github-event": "issues", "x-github-delivery": "d1", "x-hub-signature-256": "sha256=00" },
      body: huge,
    })
    expect(tooLarge.status).toBe(413)
    const brokenUtf8 = await h.fetch(GITHUB_WEBHOOK_ROUTE, {
      method: "POST",
      headers: { "x-github-event": "issues", "x-github-delivery": "d2" },
      body: new Uint8Array([0xff, 0xfe]),
    })
    expect(brokenUtf8.status).toBe(400)
    const notJson = "not json"
    const signedGarbage = await h.fetch(GITHUB_WEBHOOK_ROUTE, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "d3",
        "x-hub-signature-256": await sign(notJson),
      },
      body: notJson,
    })
    expect(signedGarbage.status).toBe(400)
    const noEvent = await delivery("issues", issuesEvent(1))
    delete (noEvent.headers as Record<string, string>)["x-github-event"]
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, noEvent)).status).toBe(400)
    const get = await h.fetch(GITHUB_WEBHOOK_ROUTE)
    expect(get.status).toBe(405)
    expect(h.starts).toEqual([])
    expect(h.count(Metrics.webhooks, { event: "issues", outcome: "refused" })).toBe(2)
    expect(h.count(Metrics.webhooks, { event: "issues", outcome: "too_large" })).toBe(1)
  })

  test("with REPO_FLOWS on, a push or a pull request of any installed repository starts its triggers/Dispatch; off, none", async () => {
    const sha = "d".repeat(40)
    const pushEvent = { ref: "refs/heads/feature/x", after: sha, repository: { full_name: "octo/other", default_branch: "trunk" } }
    const on = await githubHarness(runtime, { repoFlows: true })
    const id = crypto.randomUUID()
    expect((await on.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("push", pushEvent, { id }))).status).toBe(200)
    expect(on.starts).toEqual([{
      flow: "triggers/Dispatch",
      executionId: `triggers/dispatch:${id}`,
      payload: {
        delivery: id,
        repo: "octo/other",
        defaultBranch: "trunk",
        event: "push",
        ref: "refs/heads/feature/x",
        branch: "feature/x",
        tag: null,
        action: null,
        sha,
        trusted: true,
      },
    }])
    expect(on.count(Metrics.webhooks, { event: "push", outcome: "applied" })).toBe(1)
    expect(on.line("github.webhook")[0]!.annotations).toMatchObject({ event: "push", dispatched: "octo/other", status: 200 })
    const off = await githubHarness(runtime)
    expect((await off.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("push", pushEvent))).status).toBe(200)
    expect(off.starts).toEqual([])
  })

  test("without the App's webhook secret the route refuses every delivery: 503 not_configured", async () => {
    for (const configured of [null, app({ webhookSecret: Option.none() })]) {
      const h = await githubHarness(runtime, { app: configured })
      const response = await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("issues", issuesEvent(1)))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ code: "not_configured" })
    }
  })

  test("a start or Postgres that fails answers 503, so GitHub shows the delivery failed", async () => {
    const actor = member()
    const refusing = await githubHarness(runtime, {
      actor,
      starter: FlowStarter.of({ start: () => Effect.fail(new StartUnavailable({ errorCode: "down" })) }),
    })
    expect((await refusing.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("issues", issuesEvent(1)))).status).toBe(503)
    const offline = await githubHarness(runtime, { database: unreachable })
    expect((await offline.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("ping", {}))).status).toBe(503)
    expect(offline.line("github.webhook")[0]!.annotations).toMatchObject({ outcome: "unavailable", status: 503 })
  })

  test("no record carries the payload or the secret", async () => {
    const h = await githubHarness(runtime)
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("issues", issuesEvent(3)))
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("issues", issuesEvent(3), { secret: "wrong" }))
    const text = JSON.stringify({ logs: h.logs, spans: h.spans.map((span) => [...span.attributes]) })
    expect(text).toContain("github.webhook")
    expect(text).not.toContain(SENTINEL)
    expect(text).not.toContain(WEBHOOK_SECRET)
  })
})

describe("POST /api/repos/<owner>/<name>/writes", () => {
  test("a person's write: recorded with their session, github/Write started under its id, 202 with the txid", async () => {
    const actor = member()
    const h = await githubHarness(runtime, { actor })
    const write = createWrite()
    const response = await h.fetch(writesRoute("acme", "widgets"), post(write))
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ txid: expect.any(Number), writeId: write.writeId })
    expect(h.starts).toEqual([
      { flow: "github/Write", executionId: writeExecutionId(write.writeId), payload: { writeId: write.writeId } },
    ])
    expect(
      await sql(runtime, `SELECT actor_id AS "actorId", session_id::text AS "sessionId", via, op, payload, status FROM github_writes`),
    ).toEqual([
      {
        actorId: actor.subject.id,
        sessionId: actor.session,
        via: "person",
        op: "issue/create",
        payload: { op: "issue/create", title: "Crash on empty body", body: "Steps" },
        status: "pending",
      },
    ])
    expect(h.line("github.write.request")[0]!.annotations).toMatchObject({
      op: "issue/create",
      via: "person",
      writeId: write.writeId,
      outcome: "started",
      status: 202,
    })
  })

  test("a resend answers the row and starts the same execution again; another payload under the id is 409", async () => {
    const h = await githubHarness(runtime)
    const write = createWrite()
    await h.fetch(writesRoute("acme", "widgets"), post(write))
    const again = await h.fetch(writesRoute("Acme", "Widgets"), post(write))
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ txid: null, writeId: write.writeId, status: "pending" })
    expect(h.starts.map((start) => start.executionId)).toEqual([
      writeExecutionId(write.writeId),
      writeExecutionId(write.writeId),
    ])
    const changed = await h.fetch(writesRoute("acme", "widgets"), post({ ...write, title: "Something else" }))
    expect(changed.status).toBe(409)
    expect(await changed.json()).toEqual({ code: "conflict" })
    // A settled write's resend starts nothing.
    await sql(runtime, `UPDATE github_writes SET status = 'done', item_number = 1, settled_at = now()`)
    const settled = await h.fetch(writesRoute("acme", "widgets"), post(write))
    expect(await settled.json()).toEqual({ txid: null, writeId: write.writeId, status: "done" })
    expect(h.starts).toHaveLength(2)
    expect(h.count(Metrics.writeRequests, { op: "issue/create", outcome: "existing" })).toBe(2)
  })

  test("end to end on the Node host: a person's issue and the agent's comment reach GitHub and settle with their rows", async () => {
    const github = scriptedGitHub("acme", "widgets")
    // The agent's write checks again that Maya is a Member there.
    github.roles.set("maya", "write")
    const token = github.userToken("maya")
    const person = await signedIn(runtime, { login: "maya", token })
    const actor = member(person.personId, person.sessionId)
    const h = await githubHarness(runtime, { actor, run: true, github })
    const issue = createWrite({ title: "Opened from Smithers" })
    expect((await h.fetch(writesRoute("acme", "widgets"), post(issue))).status).toBe(202)
    await h.settled()
    expect(await writeRow(runtime, issue.writeId)).toMatchObject({ status: "done", itemNumber: 1 })
    expect(github.issues.get(1)!.login).toBe("maya")
    // The agent's comment comes with its run credential: it acts for Maya, as the App.
    const agent = await githubHarness(runtime, { actor: { ...actor, act: { kind: "agent", id: "answer-1" } }, run: true, github })
    const reply = { writeId: crypto.randomUUID(), op: "issue/comment", number: 1, body: "On it" }
    expect((await agent.fetch(writesRoute("acme", "widgets"), post(reply))).status).toBe(202)
    await agent.settled()
    expect(github.issues.get(1)!.comments.map((comment) => [comment.login, comment.body.split("\n")[0]])).toEqual([
      ["smithers[bot]", "On it"],
    ])
    expect(await comments(runtime)).toEqual([expect.objectContaining({ writeId: reply.writeId, author: "smithers[bot]" })])
  })

  test.each([
    ["signed out", { actor: null }, 401, "authentication"],
    ["no role on the repository", { actor: { ...member(), role: null } }, 403, "forbidden"],
    ["no GitHub App", { app: null }, 503, "not_configured"],
  ] as const)("%s: %i %s, nothing recorded", async (_, options, status, code) => {
    const h = await githubHarness(runtime, options)
    const response = await h.fetch(writesRoute("acme", "widgets"), post(createWrite()))
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ code })
    expect(h.starts).toEqual([])
    expect(await sql(runtime, `SELECT * FROM github_writes`)).toEqual([])
  })

  test("a Guest's write goes as the Guest, never as the bot: their own write is taken, an agent's refused", async () => {
    const guest: Actor.Actor = { ...member(), role: "guest" }
    const h = await githubHarness(runtime, { actor: guest })
    // Opening an issue and commenting are Guest acts, with the Guest's own GitHub token.
    expect((await h.fetch(writesRoute("acme", "widgets"), post(createWrite()))).status).toBe(202)
    const comment = { writeId: crypto.randomUUID(), op: "issue/comment", number: 1, body: "Me too" }
    expect((await h.fetch(writesRoute("acme", "widgets"), post(comment))).status).toBe(202)
    // The App's token is the agent's, and a Guest has no agent: refused, nothing recorded or started.
    const agent = await githubHarness(runtime, { actor: { ...guest, act: { kind: "agent", id: "answer-1" } } })
    for (const write of [createWrite(), { ...comment, writeId: crypto.randomUUID() }]) {
      const refused = await agent.fetch(writesRoute("acme", "widgets"), post(write))
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual({ code: "forbidden" })
    }
    expect(await sql(runtime, `SELECT via FROM github_writes ORDER BY created_at`)).toEqual([{ via: "person" }, { via: "person" }])
    expect(h.starts).toHaveLength(2)
    expect(agent.count(Metrics.writeRequests, { op: "issue/create", outcome: "forbidden" })).toBe(1)
  })

  test("a body that names who acts claims nothing: the request's session or run credential says", async () => {
    const h = await githubHarness(runtime)
    expect((await h.fetch(writesRoute("acme", "widgets"), post(createWrite({ via: "agent" })))).status).toBe(202)
    expect(await sql(runtime, `SELECT via FROM github_writes`)).toEqual([{ via: "person" }])
  })

  test("bounds: a repository the App isn't on, a bad body, a blank title, a write too large, a person with no session", async () => {
    const h = await githubHarness(runtime)
    // A repository the App isn't installed on, asked about for someone GitHub could know.
    const person = await signedIn(runtime, { login: "maya", token: Redacted.make("ghu_unused") })
    const elsewhere = await githubHarness(runtime, { actor: { ...member(person.personId, person.sessionId), login: "maya" } })
    const refused = await elsewhere.fetch(writesRoute("someone", "else"), post(createWrite()))
    expect([refused.status, await refused.json()]).toEqual([404, { code: "app_not_installed" }])
    for (const body of [
      "not json",
      createWrite({ writeId: "not-a-uuid" }),
      createWrite({ title: "   " }),
      createWrite({ title: "x".repeat(257) }),
      createWrite({ op: "issue/delete" }),
      { writeId: crypto.randomUUID(), op: "issue/comment", number: 0, body: "Hi" },
      { writeId: crypto.randomUUID(), op: "issue/comment", number: 1, body: " " },
    ]) {
      const response = await h.fetch(writesRoute("acme", "widgets"), post(body))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ code: "invalid" })
    }
    const huge = await h.fetch(writesRoute("acme", "widgets"), post(createWrite({ body: "x".repeat(MAX_WRITE_BYTES) })))
    expect(huge.status).toBe(413)
    const broken = await h.fetch(writesRoute("acme", "widgets"), { method: "POST", body: new Uint8Array([0xc3, 0x28]) })
    expect(broken.status).toBe(400)
    expect((await h.fetch(writesRoute("acme", "widgets"))).status).toBe(405)
    const sessionless = await githubHarness(runtime, { actor: member(crypto.randomUUID(), null) })
    expect((await sessionless.fetch(writesRoute("acme", "widgets"), post(createWrite()))).status).toBe(401)
    // The agent acts as the App, so it needs no session.
    const agent = await githubHarness(runtime, {
      actor: { ...member(crypto.randomUUID(), null), act: { kind: "agent", id: "answer-1" } },
    })
    expect((await agent.fetch(writesRoute("acme", "widgets"), post(createWrite()))).status).toBe(202)
    expect(h.starts).toEqual([])
  })

  test("Postgres, sessions or the start failing answers 503, and the device sends again", async () => {
    const offline = await githubHarness(runtime, { database: unreachable })
    expect((await offline.fetch(writesRoute("acme", "widgets"), post(createWrite()))).status).toBe(503)
    const sessionsDown = await githubHarness(runtime, {
      sessions: Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) })),
    })
    expect((await sessionsDown.fetch(writesRoute("acme", "widgets"), post(createWrite()))).status).toBe(503)
    const actor = member()
    const refusing = await githubHarness(runtime, {
      actor,
      starter: FlowStarter.of({ start: () => Effect.fail(new StartUnavailable({ errorCode: "down" })) }),
    })
    const write = createWrite()
    const response = await refusing.fetch(writesRoute("acme", "widgets"), post(write))
    expect(response.status).toBe(503)
    expect(refusing.line("github.write.request")[0]!.annotations).toMatchObject({
      outcome: "unavailable",
      errorCode: "@smthrs/mvp/flows/StartUnavailable",
    })
    // The row stayed pending: the same person's resend starts it.
    const h = await githubHarness(runtime, { actor })
    expect((await h.fetch(writesRoute("acme", "widgets"), post(write))).status).toBe(200)
    expect(h.starts).toHaveLength(1)
  })

  test("no record carries a title or a body", async () => {
    const h = await githubHarness(runtime)
    await h.fetch(writesRoute("acme", "widgets"), post(createWrite({ title: SENTINEL, body: SENTINEL })))
    const text = JSON.stringify({ logs: h.logs, spans: h.spans.map((span) => [...span.attributes]) })
    expect(text).toContain("github.write.request")
    expect(text).not.toContain(SENTINEL)
  })
})

describe("POST /api/repos/<owner>/<name>/writes on another repository (decision 0079)", () => {
  // The deployment's own repository is acme/home; the scripted GitHub's acme/widgets is a second one it acts on.
  const OWN = { owner: "acme", name: "home", id: "github/acme/home" } as const
  const route = writesRoute("acme", "widgets")
  /** Maya, signed in: sign-in's person, whose login and account GitHub is asked about. */
  const maya = async (role: Actor.Actor["role"] = "member", login = "maya"): Promise<Actor.Actor> => {
    const person = await signedIn(runtime, { login, token: Redacted.make("ghu_unused") })
    return { ...member(person.personId, person.sessionId), role, login }
  }
  const permissionReads = (h: { readonly github: ScriptedGitHub }) =>
    h.github.seen("GET", /\/collaborators\/maya\/permission$/)

  test("opening an issue and commenting: the role is GitHub's there, read once with the App, and the write is that repository's", async () => {
    const h = await githubHarness(runtime, { own: OWN, actor: await maya("guest") })
    h.github.roles.set("maya", "write")
    const write = createWrite()
    expect((await h.fetch(route, post(write))).status).toBe(202)
    const comment = { writeId: crypto.randomUUID(), op: "issue/comment", number: 1, body: "Me too" }
    expect((await h.fetch(route, post(comment))).status).toBe(202)
    expect(await sql(runtime, `SELECT repo_id AS "repoId", op FROM github_writes ORDER BY created_at`)).toEqual([
      { repoId: "github/acme/widgets", op: "issue/create" },
      { repoId: "github/acme/widgets", op: "issue/comment" },
    ])
    expect(h.starts.map((start) => start.flow)).toEqual(["github/Write", "github/Write"])
    // Read once, as the App, with a token minted for that repository with Metadata: read only.
    expect(permissionReads(h)).toEqual([expect.objectContaining({ token: "installation" })])
    expect(h.github.minted.map((minted) => minted.body)).toEqual([
      { repositories: ["widgets"], permissions: { metadata: "read" } },
    ])
    expect(await sql(runtime, `SELECT repo_id AS "repoId", role FROM github_repo_roles`)).toEqual([
      { repoId: "github/acme/widgets", role: "member" },
    ])
    expect(h.count(RepoRoles.reads, { source: "github", outcome: "member" })).toBe(1)
    expect(h.count(RepoRoles.reads, { source: "cached", outcome: "member" })).toBe(1)
  })

  test("the session's role on the deployment's own repository never decides another's", async () => {
    // An Admin of acme/home whom GitHub knows nothing of on acme/widgets has no role there.
    const h = await githubHarness(runtime, { own: OWN, actor: await maya("admin") })
    const response = await h.fetch(route, post(createWrite()))
    expect([response.status, await response.json()]).toEqual([403, { code: "forbidden" }])
    expect(await sql(runtime, `SELECT * FROM github_writes`)).toEqual([])
    // A person sign-in recorded no account for has nobody to ask GitHub about, whatever login the request carries.
    const nameless = await githubHarness(runtime, { own: OWN, actor: { ...member(), role: "admin", login: "maya" } })
    expect((await nameless.fetch(route, post(createWrite()))).status).toBe(403)
    expect(nameless.github.seen("GET", /\/permission$/)).toEqual([])
  })

  test("end to end on the Node host: an issue opened on a second repository reaches GitHub as the person", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "read")
    const person = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const actor: Actor.Actor = { ...member(person.personId, person.sessionId), login: "maya" }
    const h = await githubHarness(runtime, { own: OWN, actor, run: true, github })
    const issue = createWrite({ title: "Opened on a second repository" })
    expect((await h.fetch(route, post(issue))).status).toBe(202)
    await h.settled()
    expect(await writeRow(runtime, issue.writeId)).toMatchObject({ status: "done", itemNumber: 1 })
    expect([github.issues.get(1)!.login, github.issues.get(1)!.title]).toEqual(["maya", "Opened on a second repository"])
    // Its row is acme/widgets', not the deployment's own repository's.
    expect(await items(runtime)).toEqual([expect.objectContaining({ number: 1, writeId: issue.writeId })])
  })

  test.each([
    ["signed out", { actor: null }, (): void => {}, 401, "authentication"],
    ["no GitHub App", { app: null }, (): void => {}, 503, "not_configured"],
    ["left out of GITHUB_ALLOWED_REPOSITORIES", { allowed: new Set(["github/acme/other"]) }, (): void => {}, 404, "not_found"],
    ["the App not installed there", {}, (github: ScriptedGitHub): void => void (github.installed = false), 404, "app_not_installed"],
    ["no role there", {}, (github: ScriptedGitHub): void => void github.roles.delete("maya"), 403, "forbidden"],
    [
      "GitHub down",
      {},
      (github: ScriptedGitHub): void => void github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 502 }),
      503,
      "github_unavailable",
    ],
  ] as const)("%s: %i %s, nothing recorded", async (_, options, fault, status, code) => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    fault(github)
    const h = await githubHarness(runtime, { own: OWN, actor: await maya(), github, ...options })
    const response = await h.fetch(route, post(createWrite()))
    expect([response.status, await response.json()]).toEqual([status, { code }])
    expect(h.starts).toEqual([])
    expect(await sql(runtime, `SELECT * FROM github_writes`)).toEqual([])
    // Only a refusal GitHub gave records a role; a deployment that may not act there never asks.
    if (code === "not_found" || code === "not_configured" || code === "authentication") expect(github.calls).toEqual([])
  })

  test("GitHub's rate limit: 429 rate_limited with GitHub's wait, which the device waits out and sends again", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "30" } })
    const h = await githubHarness(runtime, { own: OWN, actor: await maya(), github })
    const write = createWrite()
    const limited = await h.fetch(route, post(write))
    expect([limited.status, limited.headers.get("retry-after"), await limited.json()]).toEqual([
      429,
      "30",
      { code: "rate_limited" },
    ])
    expect(refusalOf(429)).toBeUndefined()
    expect((await h.fetch(route, post(write))).status).toBe(202)
  })

  test("a stale role is read again, and GitHub down never lets it decide", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    const h = await githubHarness(runtime, { own: OWN, actor: await maya(), github })
    expect((await h.fetch(route, post(createWrite()))).status).toBe(202)
    await sql(runtime, `UPDATE github_repo_roles SET checked_at = now() - interval '6 minutes'`)
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 502 })
    expect((await h.fetch(route, post(createWrite()))).status).toBe(503)
    // Removed on GitHub: the next read says so.
    github.roles.delete("maya")
    expect((await h.fetch(route, post(createWrite()))).status).toBe(403)
    expect(permissionReads(h)).toHaveLength(3)
    expect(await sql(runtime, `SELECT role FROM github_repo_roles`)).toEqual([{ role: null }])
  })

  test("only opening an issue and commenting go to another repository: triage, commitments and merging are 404", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "maintain")
    const h = await githubHarness(runtime, { own: OWN, actor: await maya(), github })
    for (const write of [
      { writeId: crypto.randomUUID(), op: "issue/triage", number: 1, decision: "accept" },
      { writeId: crypto.randomUUID(), op: "issue/commitment", number: 1, commitment: "now" },
      { writeId: crypto.randomUUID(), op: "triage/run", number: 1 },
      { writeId: crypto.randomUUID(), op: "triage/enable" },
      { writeId: crypto.randomUUID(), op: "triage/pause" },
      { writeId: crypto.randomUUID(), op: "pr/merge", number: 1, headSha: "a".repeat(40), baseSha: "b".repeat(40) },
    ]) {
      const response = await h.fetch(route, post(write))
      expect([write.op, response.status, await response.json()]).toEqual([write.op, 404, { code: "not_found" }])
    }
    expect(await sql(runtime, `SELECT * FROM github_writes`)).toEqual([])
  })

  test("a write id is its repository's and its person's: resent to another repository, or by another person, 409", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    const actor = await maya()
    const h = await githubHarness(runtime, { own: OWN, actor, github })
    const write = createWrite()
    expect((await h.fetch(route, post(write))).status).toBe(202)
    // The deployment's own repository, where Maya's session makes her a Member: the id is acme/widgets' write.
    const own = await h.fetch(writesRoute("acme", "home"), post(write))
    expect([own.status, await own.json()]).toEqual([409, { code: "conflict" }])
    const other = await githubHarness(runtime, { own: OWN, actor: { ...actor, subject: { kind: "person", id: crypto.randomUUID() } }, github })
    expect((await other.fetch(writesRoute("acme", "home"), post(write))).status).toBe(409)
    expect(h.starts).toHaveLength(1)
  })

  test("the agent's write checks the person again when it runs: removed on GitHub meanwhile, it is refused, nothing written", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "write")
    github.open("Crash", "Steps")
    const person = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const agent: Actor.Actor = { ...member(person.personId, person.sessionId), login: "maya", act: { kind: "agent", id: "answer-1" } }
    const reply = { writeId: crypto.randomUUID(), op: "issue/comment", number: 1, body: "On it" }
    // Taken while Maya is a Member; then removed before the run writes.
    expect((await (await githubHarness(runtime, { own: OWN, actor: agent, github })).fetch(route, post(reply))).status).toBe(202)
    github.roles.delete("maya")
    const running = await githubHarness(runtime, { own: OWN, actor: agent, run: true, github })
    expect((await running.fetch(route, post(reply))).status).toBe(200)
    await running.settled()
    expect(await writeRow(runtime, reply.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    expect(github.issues.get(1)!.comments).toEqual([])
    // A login that changed hands is someone else: refused too.
    github.roles.set("maya", "write")
    github.accounts.set("maya", 1)
    const again = { ...reply, writeId: crypto.randomUUID() }
    const runAgain = await githubHarness(runtime, { own: OWN, actor: agent, run: true, github })
    expect((await runAgain.fetch(route, post(again))).status).toBe(202)
    await runAgain.settled()
    expect(await writeRow(runtime, again.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    expect(github.issues.get(1)!.comments).toEqual([])
  })

  test("a role that changed between the route's read and the write's transaction refuses the write, recording nothing", async () => {
    const actor = await maya()
    // GitHub made Maya a Guest after the route read Member: the write's transaction finds the row as it stands.
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role) VALUES ('github/acme/widgets', '${actor.subject.id}', 'guest')`)
    const h = await githubHarness(runtime, { own: OWN, actor, roles: rolesThatRead(OWN, "member") })
    const response = await h.fetch(route, post({ writeId: crypto.randomUUID(), op: "issue/comment", number: 1, body: "Me too" }))
    expect([response.status, await response.json()]).toEqual([403, { code: "forbidden" }])
    expect(await sql(runtime, `SELECT * FROM github_writes`)).toEqual([])
    expect(h.starts).toEqual([])
  })

  test("no record carries the person's login", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("login-sentinel-7d1", "write")
    const h = await githubHarness(runtime, { own: OWN, actor: await maya("member", "login-sentinel-7d1"), github })
    expect((await h.fetch(route, post(createWrite()))).status).toBe(202)
    const text = JSON.stringify({ logs: h.logs, spans: h.spans.map((span) => [...span.attributes]) })
    expect(text).toContain("github.repo_role")
    expect(text).not.toContain("login-sentinel-7d1")
  })
})

describe("the shapes", () => {
  const shape = (h: Awaited<ReturnType<typeof githubHarness>>, route: string) =>
    h.fetch(`${route}?offset=-1`).then(async (response) => ({ status: response.status, rows: (await response.json()) as Array<{ value?: Record<string, unknown> }> }))
  const values = (rows: Array<{ value?: Record<string, unknown> }>) => rows.flatMap((row) => (row.value === undefined ? [] : [row.value]))

  const seed = async () => {
    await sql(
      runtime,
      `INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, created_at, updated_at,
        source_updated_at, fetched_at)
      VALUES ('${REPOSITORY.id}#1', '${REPOSITORY.id}', 1, 'issue', 11, 'One', 'Body', 'open', now(), now(), now(), now()),
        ('github/someone/else#1', 'github/someone/else', 1, 'issue', 12, 'Other', '', 'open', now(), now(), now(), now())`,
    )
    await sql(
      runtime,
      `INSERT INTO comments (id, repo_id, item_id, github_id, body, created_at, updated_at, source_updated_at, fetched_at)
      VALUES ('${REPOSITORY.id}/comment/5', '${REPOSITORY.id}', '${REPOSITORY.id}#1', 5, 'Hi', now(), now(), now(), now())`,
    )
  }

  test("items and comments: this repository's rows, with only their listed columns", async () => {
    await seed()
    const h = await githubHarness(runtime)
    const listed = await shape(h, ITEMS_SHAPE_ROUTE)
    expect(listed.status).toBe(200)
    const [item] = values(listed.rows)
    expect(values(listed.rows)).toHaveLength(1)
    expect(item).toMatchObject({ id: `${REPOSITORY.id}#1`, title: "One" })
    expect(Object.keys(item!)).not.toContain("source_updated_at")
    expect(Object.keys(item!)).not.toContain("fetched_at")
    const listedComments = values((await shape(h, COMMENTS_SHAPE_ROUTE)).rows)
    expect(listedComments).toEqual([expect.objectContaining({ id: `${REPOSITORY.id}/comment/5`, body: "Hi" })])
    expect(Object.keys(listedComments[0]!)).not.toContain("fetched_at")
  })

  test("a read of stale issues starts github/Reconcile once per 5 minutes; fresh ones start nothing", async () => {
    const h = await githubHarness(runtime)
    // The read answers once the start is admitted: it is recorded before the response, with no waiting after it.
    expect((await shape(h, ITEMS_SHAPE_ROUTE)).status).toBe(200)
    expect(h.starts.map((start) => start.flow)).toEqual(["github/Reconcile"])
    expect(h.starts[0]!.executionId).toBe(reconcileExecutionId(REPOSITORY.id, Date.now()))
    // Every read in the bucket asks with the bucket's start, so their starts are one intent.
    expect(h.starts[0]!.payload).toEqual({
      repo: `${REPOSITORY.owner}/${REPOSITORY.name}`,
      requestedAtMs: reconcileBucketStart(Date.now()),
    })
    expect(h.line("github.reconcile.start").map((line) => ({ level: line.level, ...line.annotations }))).toMatchObject([
      { level: "INFO", repoId: REPOSITORY.id, outcome: "started", durationMs: expect.any(Number) },
    ])
    expect(h.count(Metrics.reconcileStarts, { outcome: "started" })).toBe(1)
    // A bucket this isolate saw admitted isn't asked again.
    await shape(h, ITEMS_SHAPE_ROUTE)
    expect(h.starts).toHaveLength(1)
    await sql(runtime, `INSERT INTO github_sync (repo_id, stream, synced_at, complete) VALUES ('${REPOSITORY.id}', 'issues', now(), true)`)
    await shape(h, ITEMS_SHAPE_ROUTE)
    expect(h.starts).toHaveLength(1)
    const synced = values((await shape(h, SYNC_SHAPE_ROUTE)).rows)
    expect(synced).toEqual([{ repo_id: REPOSITORY.id, stream: "issues", synced_at: expect.any(String), complete: "true", failure: null }])
    // Without the App nothing starts, and a failed start still serves the rows; the next stale read asks again.
    const off = await githubHarness(runtime, { app: null })
    await sql(runtime, `UPDATE github_sync SET synced_at = now() - interval '1 hour'`)
    expect((await shape(off, ITEMS_SHAPE_ROUTE)).status).toBe(200)
    expect(off.starts).toEqual([])
    const actor = member()
    let asked = 0
    const refusing = await githubHarness(runtime, {
      actor,
      starter: FlowStarter.of({ start: () => Effect.suspend(() => (asked++, Effect.fail(new StartUnavailable({ errorCode: "down" })))) }),
    })
    expect((await shape(refusing, ITEMS_SHAPE_ROUTE)).status).toBe(200)
    expect((await shape(refusing, ITEMS_SHAPE_ROUTE)).status).toBe(200)
    expect(asked).toBe(2)
    expect(refusing.line("github.reconcile.start").map((line) => ({ level: line.level, ...line.annotations }))).toMatchObject([
      { level: "WARN", outcome: "not_started", errorCode: "down" },
      { level: "WARN", outcome: "not_started", errorCode: "down" },
    ])
    expect(refusing.count(Metrics.reconcileStarts, { outcome: "not_started" })).toBe(2)
  })

  test("concurrent stale reads start exactly one github/Reconcile execution for the bucket", async () => {
    const h = await githubHarness(runtime, { run: true })
    h.github.open("Reconciled issue", "", "sam")
    const reads = await Promise.all(Array.from({ length: 10 }, () => h.fetch(`${ITEMS_SHAPE_ROUTE}?offset=-1`)))
    expect(reads.map((read) => read.status)).toEqual(Array(10).fill(200))
    await Promise.all(reads.map((read) => read.arrayBuffer()))
    // Each read that found no admitted bucket asked, with the bucket's one execution id: one execution.
    expect(new Set(h.starts.map((start) => start.executionId))).toEqual(new Set([reconcileExecutionId(REPOSITORY.id, Date.now())]))
    expect(h.starts.length).toBeGreaterThanOrEqual(1)
    expect(h.starts.length).toBeLessThanOrEqual(10)
    const asked = h.starts.length
    await h.settled()
    expect(await items(runtime)).toEqual([expect.objectContaining({ number: 1, title: "Reconciled issue" })])
    expect(h.github.calls.filter((call) => call.method === "GET" && call.path === "/repos/acme/widgets/issues")).toHaveLength(1)
    await shape(h, ITEMS_SHAPE_ROUTE)
    expect(h.starts).toHaveLength(asked)
  })

  test.each([
    { name: "conflicting intent", start: Effect.fail(new StartConflict()), errorCode: "@smthrs/mvp/flows/StartConflict" },
    { name: "defect", start: Effect.die(new Error(SENTINEL)), errorCode: "unknown" },
  ])("a starter $name is counted and logged without failing the read or leaking error text", async ({ start, errorCode }) => {
    const h = await githubHarness(runtime, { starter: FlowStarter.of({ start: () => start }) })
    expect((await shape(h, ITEMS_SHAPE_ROUTE)).status).toBe(200)
    expect(h.line("github.reconcile.start").map((line) => ({ level: line.level, ...line.annotations }))).toMatchObject([
      { level: "WARN", repoId: REPOSITORY.id, outcome: "not_started", errorCode },
    ])
    expect(h.count(Metrics.reconcileStarts, { outcome: "not_started" })).toBe(1)
    expect(JSON.stringify({ logs: h.logs, spans: h.spans.map((span) => [...span.attributes]) })).not.toContain(SENTINEL)
  })

  test("github-writes: only the signed-in person's own writes, their status only; signed out, none; sessions down, 503", async () => {
    const mine = member()
    const h = await githubHarness(runtime, { actor: mine })
    const ours = createWrite()
    await h.fetch(writesRoute("acme", "widgets"), post(ours))
    const theirs = await githubHarness(runtime)
    await theirs.fetch(writesRoute("acme", "widgets"), post(createWrite()))
    const listed = values((await shape(h, WRITES_SHAPE_ROUTE)).rows)
    expect(listed).toEqual([
      {
        id: ours.writeId,
        repo_id: REPOSITORY.id,
        op: "issue/create",
        status: "pending",
        failure: null,
        item_number: null,
        created_at: expect.any(String),
        settled_at: null,
        branch_id: null,
      },
    ])
    const nobody = await githubHarness(runtime, { actor: null })
    expect(values((await shape(nobody, WRITES_SHAPE_ROUTE)).rows)).toEqual([])
    const sessionsDown = await githubHarness(runtime, {
      sessions: Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) })),
    })
    // Sessions down: refused, never the shape of nobody under the device's handle.
    const refused = await sessionsDown.fetch(`${WRITES_SHAPE_ROUTE}?offset=-1&handle=h-1`)
    expect([refused.status, refused.headers.get("retry-after")]).toEqual([503, "5"])
  })

  test("signed out: a repository GitHub said is private, or hasn't said, is refused; a public one's rows are served", async () => {
    await seed()
    const visitor = await githubHarness(runtime, { actor: null })
    // Not yet known: refused, though the read still starts the sync that will find out.
    for (const route of [ITEMS_SHAPE_ROUTE, COMMENTS_SHAPE_ROUTE, SYNC_SHAPE_ROUTE]) {
      const response = await visitor.fetch(`${route}?offset=-1`)
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ code: "authentication" })
    }
    await expect.poll(() => visitor.starts.map((start) => start.flow), { timeout: 10_000 }).toEqual(["github/Reconcile"])
    // Private: refused to a visitor and to a person with no role on it; served to a Member, whom GitHub lets see it.
    await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('${REPOSITORY.id}', 1, true)`)
    expect((await shape(visitor, ITEMS_SHAPE_ROUTE)).status).toBe(401)
    expect((await shape(visitor, COMMENTS_SHAPE_ROUTE)).status).toBe(401)
    const outsider = await githubHarness(runtime, { actor: { ...member(), role: null } })
    const forbidden = await outsider.fetch(`${ITEMS_SHAPE_ROUTE}?offset=-1`)
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ code: "forbidden" })
    const insider = await githubHarness(runtime)
    expect(values((await shape(insider, ITEMS_SHAPE_ROUTE)).rows)).toEqual([expect.objectContaining({ title: "One" })])
    expect(visitor.count(Metrics.shapes, { table: "items", status: "401", live: "false" })).toBe(2)
    // Public: anyone reads.
    await sql(runtime, `UPDATE github_repositories SET private = false`)
    expect(values((await shape(visitor, ITEMS_SHAPE_ROUTE)).rows)).toEqual([expect.objectContaining({ title: "One" })])
    expect(values((await shape(visitor, COMMENTS_SHAPE_ROUTE)).rows)).toEqual([expect.objectContaining({ body: "Hi" })])
    // Sessions or Postgres down: neither signed in nor signed out, so nothing is served.
    const sessionsDown = await githubHarness(runtime, {
      sessions: Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) })),
    })
    expect((await shape(sessionsDown, ITEMS_SHAPE_ROUTE)).status).toBe(503)
    const offline = await githubHarness(runtime, { actor: null, database: unreachable })
    expect((await shape(offline, COMMENTS_SHAPE_ROUTE)).status).toBe(503)
  })

  test("any other path under the routes is 404", async () => {
    const h = await githubHarness(runtime)
    expect((await h.fetch("/api/shapes/elsewhere")).status).toBe(404)
  })

  describe("another repository the deployment acts on (decision 0079, slice 1b)", () => {
    // The deployment's own repository is acme/home; acme/gadgets, served by its own scripted GitHub, is a second one. No
    // other test's shapes name acme/gadgets, so Electric never answers these with another test's rows.
    const OWN = { owner: "acme", name: "home", id: "github/acme/home" } as const
    const GADGETS = "github/acme/gadgets"
    const gadgets = () => scriptedGitHub("acme", "gadgets")
    const seedGadgets = () =>
      sql(
        runtime,
        `INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, created_at, updated_at,
          source_updated_at, fetched_at)
        VALUES ('${GADGETS}#7', '${GADGETS}', 7, 'issue', 77, 'Gadget', '', 'open', now(), now(), now(), now()),
          ('${OWN.id}#1', '${OWN.id}', 1, 'issue', 71, 'Home', '', 'open', now(), now(), now(), now())`,
      )
    const named = (route: string, repo: string) => `${route}?repo=${encodeURIComponent(repo)}`
    /** Shape `route` of `repo`, from the start. */
    const shapeOf = (h: Awaited<ReturnType<typeof githubHarness>>, route: string, repo: string) =>
      h.fetch(`${named(route, repo)}&offset=-1`).then(async (response) => ({
        status: response.status,
        rows: response.status === 200 ? (await response.json()) as Array<{ value?: Record<string, unknown> }> : [],
      }))

    test("?repo= names it: its rows alone, read by its role there, and a stale read reconciles it", async () => {
      await seedGadgets()
      const person = await signedIn(runtime, { login: "maya", token: Redacted.make("ghu_unused") })
      // A Member of acme/home, whose role on acme/gadgets is GitHub's read there.
      const h = await githubHarness(runtime, { own: OWN, github: gadgets(), actor: { ...member(person.personId, person.sessionId), role: "member", login: "maya" } })
      h.github.roles.set("maya", "read")
      const listed = await shapeOf(h, ITEMS_SHAPE_ROUTE, "acme/gadgets")
      expect([listed.status, values(listed.rows).map((row) => row.title)]).toEqual([200, ["Gadget"]])
      await expect.poll(() => h.starts.map((start) => start.payload), { timeout: 10_000 }).toEqual([
        { repo: "acme/gadgets", requestedAtMs: reconcileBucketStart(Date.now()) },
      ])
      for (const route of [COMMENTS_SHAPE_ROUTE, SYNC_SHAPE_ROUTE, PULLS_SHAPE_ROUTE, CHECKS_SHAPE_ROUTE]) {
        expect([route, (await shapeOf(h, route, "acme/gadgets")).status]).toEqual([route, 200])
      }
      // Without `?repo=`, the deployment's own.
      expect(values((await shape(h, ITEMS_SHAPE_ROUTE)).rows).map((row) => row.title)).toEqual(["Home"])
      expect(h.starts.map((start) => start.payload)).toEqual([
        { repo: "acme/gadgets", requestedAtMs: reconcileBucketStart(Date.now()) },
        { repo: "acme/home", requestedAtMs: reconcileBucketStart(Date.now()) },
      ])
      // Admitting one repository never suppresses another, and both completed buckets remain cached.
      expect((await shapeOf(h, ITEMS_SHAPE_ROUTE, "acme/gadgets")).status).toBe(200)
      expect((await shape(h, ITEMS_SHAPE_ROUTE)).status).toBe(200)
      expect(h.starts).toHaveLength(2)
      expect(h.count(Metrics.reconcileStarts, { outcome: "started" })).toBe(2)
    })

    test("a name GitHub couldn't have is 400; one the deployment doesn't act on is 404", async () => {
      const h = await githubHarness(runtime, { own: OWN, github: gadgets(), allowed: new Set([OWN.id]) })
      for (const repo of ["acme", "acme/gadgets/x", "-bad/x"]) {
        expect([repo, (await h.fetch(`${named(ITEMS_SHAPE_ROUTE, repo)}&offset=-1`)).status]).toEqual([repo, 400])
      }
      expect((await h.fetch(`${named(ITEMS_SHAPE_ROUTE, "acme/gadgets")}&offset=-1`)).status).toBe(404)
      expect((await h.fetch(compareRoute("acme", "gadgets", "a".repeat(40), "b".repeat(40)))).status).toBe(404)
      expect(h.starts).toEqual([])
      // Without the App, only the deployment's own repository syncs.
      const noApp = await githubHarness(runtime, { own: OWN, github: gadgets(), app: null })
      expect((await noApp.fetch(`${named(ITEMS_SHAPE_ROUTE, "acme/gadgets")}&offset=-1`)).status).toBe(404)
    })

    test("where the App isn't installed nobody has a role: a public repository's rows still reach anyone signed in", async () => {
      await seedGadgets()
      await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('${GADGETS}', 1, false)`)
      const person = await signedIn(runtime, { login: "maya", token: Redacted.make("ghu_unused") })
      const h = await githubHarness(runtime, { own: OWN, github: gadgets(), actor: { ...member(person.personId, person.sessionId), role: "admin", login: "maya" } })
      h.github.installed = false
      const listed = await shapeOf(h, ITEMS_SHAPE_ROUTE, "acme/gadgets")
      expect([listed.status, values(listed.rows).map((row) => row.title)]).toEqual([200, ["Gadget"]])
      // A private one is refused, as to anyone with no role.
      await sql(runtime, `UPDATE github_repositories SET private = true`)
      h.github.private = true
      expect((await shapeOf(h, ITEMS_SHAPE_ROUTE, "acme/gadgets")).status).toBe(403)
    })

    test("where an About read found the App absent, the shapes say app_not_installed, to anyone, asking GitHub nothing", async () => {
      await sql(runtime, `INSERT INTO repo_about (repo_id, app_absent_until) VALUES ('${GADGETS}', now() + interval '1 hour')`)
      try {
        for (const actor of [null, member()] as const) {
          const h = await githubHarness(runtime, { own: OWN, github: gadgets(), actor })
          const response = await h.fetch(`${named(ITEMS_SHAPE_ROUTE, "acme/gadgets")}&offset=-1`)
          expect([response.status, await response.json()]).toEqual([404, { code: "app_not_installed" }])
          expect(h.github.calls).toEqual([])
          expect(h.starts).toEqual([])
          expect(h.count(Metrics.shapes, { table: "items", status: "404", live: "false" })).toBe(1)
        }
        // An installation found since wins, and the deployment's own repository is never asked about.
        await sql(runtime, `INSERT INTO github_repositories (repo_id, installation_id) VALUES ('${GADGETS}', 77)`)
        const installed = await githubHarness(runtime, { own: OWN, github: gadgets(), actor: null })
        expect((await installed.fetch(`${named(ITEMS_SHAPE_ROUTE, "acme/gadgets")}&offset=-1`)).status).not.toBe(404)
        // Postgres not answering leaves it to the read, which says unavailable.
        const offline = await githubHarness(runtime, { own: OWN, github: gadgets(), actor: null, database: unreachable })
        expect((await offline.fetch(`${named(ITEMS_SHAPE_ROUTE, "acme/gadgets")}&offset=-1`)).status).toBe(503)
      } finally {
        await sql(runtime, `TRUNCATE repo_about`)
      }
    })
  })
})


test("untrusted webhook event names have bounded metric attributes", async () => {
  const h = await githubHarness(runtime)
  const event = "untrusted-" + crypto.randomUUID()
  expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery(event, {}, { signature: "sha256=bad" }))).status).toBe(401)
  expect(h.count(Metrics.webhooks, { event, outcome: "refused" })).toBe(0)
  expect(h.count(Metrics.webhooks, { event: "unknown", outcome: "refused" })).toBe(1)
})

test("Apply starts only after its delivery's received time is durable", async () => {
  const seen: unknown[] = []
  const h = await githubHarness(runtime, {
    starter: FlowStarter.of({ start: () => Effect.promise(async () => {
      seen.push(await sql(runtime, "SELECT delivery_id FROM github_deliveries"))
    }) }),
  })
  const id = crypto.randomUUID()
  expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("issues", issuesEvent(7), { id }))).status).toBe(200)
  expect(seen).toEqual([[{ delivery_id: id }]])
})

test("an item read whose Reconcile start never resolves answers at the timeout, and the start doesn't outlive it", async () => {
  let launchPending = false
  let interrupted = false
  const h = await githubHarness(runtime, {
    starter: FlowStarter.of({
      start: () =>
        Effect.sync(() => { launchPending = true }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })),
        ),
    }),
  })
  const startedAt = Date.now()
  const response = await h.fetch(`${ITEMS_SHAPE_ROUTE}?offset=-1`, { signal: AbortSignal.timeout(10_000) })
  expect(response.status).toBe(200)
  await response.arrayBuffer()
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(Duration.toMillis(RECONCILE_START_TIMEOUT))
  // Nothing keeps running after the read: the start was interrupted with it, not left in a scope that outlives requests.
  expect({ launchPending, interrupted }).toEqual({ launchPending: true, interrupted: true })
  expect(h.line("github.reconcile.start").map((line) => ({ level: line.level, ...line.annotations }))).toMatchObject([
    { level: "WARN", outcome: "timed_out", errorCode: "TimeoutError", durationMs: expect.any(Number) },
  ])
  expect(h.count(Metrics.reconcileStarts, { outcome: "timed_out" })).toBe(1)
})

test("cached public visibility cannot authorize rows after GitHub becomes private", async () => {
  await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('${REPOSITORY.id}', 1, false)`)
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  github.private = true
  const h = await githubHarness(runtime, { actor: null, github, app: app({ privateKey: await import("./test/scriptedGitHub.ts").then((m) => m.appKey()) }) })
  for (const route of [ITEMS_SHAPE_ROUTE, COMMENTS_SHAPE_ROUTE, SYNC_SHAPE_ROUTE]) {
    expect((await h.fetch(`${route}?offset=-1`)).status).toBe(401)
  }
  expect(h.count(Metrics.visibilityReads, { outcome: "private" })).toBe(3)
  expect(h.line("github.visibility")).toHaveLength(3)
})


test("a cached public grant fails closed when current GitHub metadata is unavailable", async () => {
  await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('${REPOSITORY.id}', 1, false)`)
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  github.faults.push({ match: (method, path) => method === "GET" && path === "/repos/acme/widgets", status: 502 })
  const h = await githubHarness(runtime, { actor: null, github })
  expect((await h.fetch(`${COMMENTS_SHAPE_ROUTE}?offset=-1`)).status).toBe(503)
  expect(h.count(Metrics.visibilityReads, { outcome: "unavailable" })).toBe(1)
  expect(h.line("github.visibility")[0]!.annotations).toMatchObject({ outcome: "unavailable" })
})


test("an encoded invalid repository is refused before a write is admitted", async () => {
  const h = await githubHarness(runtime)
  const response = await h.fetch("/api/repos/acme%2Fother/widgets/writes", post(createWrite()))
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ code: "not_found" })
  expect(await sql(runtime, "SELECT id FROM github_writes")).toEqual([])
})

test.each([undefined, "metadata-fixture-token"])("default metadata transport checks current visibility with configured token %s", async (token) => {
  const seen: Array<string | undefined> = []
  let status = 200
  const server = createServer((request, response) => {
    expect(request.url).toBe("/repos/acme/widgets")
    seen.push(request.headers.authorization)
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify(status === 200 ? { private: true } : { message: "Not Found" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('${REPOSITORY.id}', 1, false)`)
    const config = ConfigProvider.fromUnknown({
      ELECTRIC_URL: await runtime.runPromise(TestDatabase.electricUrl),
      GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      ...(token === undefined ? {} : { GITHUB_TOKEN: token }),
    })
    await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
      const scratch = yield* TestDatabase.Scratch
      const roles = rolesThatRead(REPOSITORY, "member")
      const routes = yield* make(scratch.database, { repository: REPOSITORY, app: Option.none(), roles })
      const handler = HttpEffect.toWebHandler(routes.fetch.pipe(
        Effect.provide(Actor.signedOut),
        Effect.provide(BranchRoles.layer(roles)),
        Effect.provideService(FlowStarter, FlowStarter.of({ start: () => Effect.void })),
        Effect.provide(FetchHttpClient.layer),
      ))
      for (status of [200, 404, 410]) {
        const response = yield* Effect.promise(() => handler(new Request(`http://app.test${COMMENTS_SHAPE_ROUTE}?offset=-1`)))
        expect(response.status).toBe(401)
        expect(yield* Effect.promise(() => response.json())).toEqual({ code: "authentication" })
      }
    })).pipe(Effect.provideService(ConfigProvider.ConfigProvider, config)))
    expect(seen).toEqual(Array(3).fill(token === undefined ? undefined : `Bearer ${token}`))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("the production metadata transport uses the configured read token and refuses a newly private repository", async () => {
  const seen: Array<{ path: string | undefined; authorization: string | undefined }> = []
  const server = createServer((request, response) => {
    seen.push({ path: request.url, authorization: request.headers.authorization })
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ private: true }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("No HTTP address")
    await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('${REPOSITORY.id}', 1, false)`)
    const h = await githubHarness(runtime, { actor: null, app: null, metadata: {
      url: `http://127.0.0.1:${address.port}`, token: "test-metadata-token",
    } })
    expect((await h.fetch(`${COMMENTS_SHAPE_ROUTE}?offset=-1`)).status).toBe(401)
    expect(seen).toEqual([{ path: "/repos/acme/widgets", authorization: "Bearer test-metadata-token" }])
    expect(h.count(Metrics.visibilityReads, { outcome: "private" })).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
