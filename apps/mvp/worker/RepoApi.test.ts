import { CodeStorage } from "@smthrs/effect-code-storage"
import * as Conversations from "./branch/Conversations.ts"
// RepoApi (worker/RepoApi.ts, docs/features/repo.md#repoapi) through its real handler, over this file's schema of the
// compose Postgres and Electric (`pnpm db:up`), with the scripted Code Storage and GitHub (worker/test/codeStorage.ts).
// Clones run on the Node host in this process (worker/test/repos.ts). Unhappy paths arm a fault on the scripted
// provider, or give RepoApi a faulty service; nothing intercepts a request.
import { Action } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import * as Database from "../db/Database.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import { aboutRoute, blobRoute, cloneExecutionId, rawRoute, refsRoute, treeRoute } from "../src/features/repo/contract.ts"
import * as RepoFlows from "../src/features/repo/flows.ts"
import * as Actor from "./Actor.ts"
import { FlowStarter, StartConflict, StartUnavailable } from "./Flows.ts"
import * as RepoMetrics from "./RepoMetrics.ts"
import * as Repos from "./Repos.ts"
import { fixture, scripted, shaOf } from "./test/codeStorage.ts"
import { runFlow } from "./test/flowHost.ts"
import { recorded, testFile } from "./test/harness.ts"
import { APP_ID, appKey } from "./github/test/scriptedGitHub.ts"
import { scriptedGitHub, spoonKnife } from "./test/githubRest.ts"
import { repoHarness, repositoryRow, resetRepos, usageRow } from "./test/repos.ts"

const runtime = testFile("repo_api")

beforeAll(async () => {
  const health = `${await runtime.runPromise(TestDatabase.electricUrl)}/v1/health`
  const response = await fetch(health).catch((error: unknown) => {
    throw TestDatabase.explain("Electric", new URL(health).host)(error)
  })
  if (!response.ok) throw new Error(`Electric answered ${response.status} to ${health}`)
})

beforeEach(() => resetRepos(runtime))

const sql = (statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe(statement))))

describe("POST /api/repos", () => {
  test("clones a public repository: 202 with the txid, cloning at once, then ready with its head", async () => {
    const h = await repoHarness(runtime)
    h.scripted.publish("octocat", "Spoon-Knife")
    const response = await h.clone("octocat", "Spoon-Knife")
    expect(response.status).toBe(202)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.json()
    expect(body).toEqual({ txid: expect.any(Number), id: "github/octocat/spoon-knife", attempt: 1, cloneId: expect.any(String) })
    await h.settled()
    const row = await repositoryRow(runtime, "github/octocat/spoon-knife")
    // The execution is named by the attempt's own id, a UUID, never the attempt counter.
    expect(row!.cloneId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const executionId = cloneExecutionId("github/octocat/spoon-knife", row!.cloneId)
    expect(h.started()).toEqual([executionId])
    expect(await sql(`SELECT nspname FROM pg_namespace WHERE nspname = '${h.engineSchema()}'`))
      .toEqual([{ nspname: h.engineSchema() }])
    expect(row).toMatchObject({
      owner: "octocat",
      name: "Spoon-Knife",
      status: "ready",
      failure: null,
      capacity: null,
      storedBytes: String(640 * 1024),
      defaultBranch: "main",
      headSha: fixture().commit.sha,
      headMessage: "Add the fixture",
      headAuthor: "Mona",
      attempt: 1,
    })
    expect(row!.settledAt).toBeInstanceOf(Date)
    expect(await h.status(executionId)).toBe("completed")
    expect(h.scripted.calls.filter((call) => call.startsWith("createRepo"))).toEqual([
      "createRepo:github/octocat/spoon-knife",
    ])
    expect(h.count(RepoMetrics.cloneRequests, { outcome: "requested" })).toBe(1)
    expect(h.count(RepoMetrics.cloneLaunches, { outcome: "launched" })).toBe(1)
    expect(h.count(RepoMetrics.clones, { outcome: "ready", reason: "none" })).toBe(1)
    expect(h.only("repo.clone.request").annotations).toMatchObject({
      id: "github/octocat/spoon-knife",
      attempt: 1,
      cloneId: row!.cloneId,
      outcome: "requested",
      status: 202,
    })
    expect(h.only("repo.clone.launch").annotations).toMatchObject({
      id: "github/octocat/spoon-knife",
      attempt: 1,
      cloneId: row!.cloneId,
      outcome: "launched",
      status: 202,
    })
    expect(h.line("repo.clone.step").map((log) => log.annotations.step)).toEqual([
      "inspect",
      "import",
      "pull",
      "await_sync",
      "index",
    ])
    expect(h.only("repo.clone.settle").annotations).toMatchObject({
      id: "github/octocat/spoon-knife",
      cloneId: row!.cloneId,
      status: "ready",
      settled: true,
      reason: "none",
    })
    expect((await usageRow(runtime))?.imported).toBe(640 * 1024)
  })

  test("a second request starts nothing: 200 with the row's status, and its launch finds it settled", async () => {
    const h = await repoHarness(runtime)
    await h.seed("octocat", "Spoon-Knife")
    const { cloneId } = (await repositoryRow(runtime, "github/octocat/spoon-knife"))!
    const again = await h.request("OctoCat", "spoon-knife")
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ txid: null, id: "github/octocat/spoon-knife", status: "ready", cloneId })
    const launched = await h.launch("OctoCat", "spoon-knife", cloneId)
    expect([launched.status, await launched.json()]).toEqual([200, { launched: false, status: "ready" }])
    expect(h.started()).toHaveLength(1)
    expect(h.count(RepoMetrics.cloneRequests, { outcome: "existing" })).toBe(1)
    expect(h.count(RepoMetrics.cloneLaunches, { outcome: "settled" })).toBe(1)
  })

  test("the request answers at once and starts nothing; the attempt's launch starts it, and only that attempt's", async () => {
    // Before, the request waited for the clone's Durable Object to take the start before it answered (the
    // instant-acknowledgment rule), and a start that failed left the row cloning until some later request.
    const starts: Array<string> = []
    const h = await repoHarness(runtime, {
      starter: FlowStarter.of({ start: (_flow, start) => Effect.sync(() => void starts.push(start.executionId)) }),
    })
    const requested = await h.request("octocat", "Spoon-Knife")
    expect(requested.status).toBe(202)
    const { cloneId } = await requested.json() as { readonly cloneId: string }
    expect(starts).toEqual([])
    expect(await repositoryRow(runtime, "github/octocat/spoon-knife")).toMatchObject({ status: "cloning", stage: "requested", cloneId })
    // Another attempt's id, or none the row holds, launches nothing.
    const stale = await h.launch("octocat", "Spoon-Knife", crypto.randomUUID())
    expect([stale.status, await stale.json()]).toEqual([200, { launched: false, status: "cloning" }])
    expect((await h.launch("octocat", "Hello-World", cloneId)).status).toBe(404)
    expect(starts).toEqual([])
    const launched = await h.launch("octocat", "Spoon-Knife", cloneId)
    expect([launched.status, await launched.json()]).toEqual([202, { launched: true }])
    expect(starts).toEqual([cloneExecutionId("github/octocat/spoon-knife", cloneId)])
  })

  test("a launch the Durable Object can't take is 503 and leaves the row cloning; launched again, it starts", async () => {
    let down = true
    const starts: Array<string> = []
    const h = await repoHarness(runtime, {
      starter: FlowStarter.of({
        start: (_flow, start) =>
          down ? Effect.fail(new StartUnavailable({ errorCode: "do" })) : Effect.sync(() => void starts.push(start.executionId)),
      }),
    })
    const { cloneId } = await (await h.request("octocat", "Spoon-Knife")).json() as { readonly cloneId: string }
    const refused = await h.launch("octocat", "Spoon-Knife", cloneId)
    expect([refused.status, await refused.json()]).toEqual([503, { code: "unavailable" }])
    expect(await repositoryRow(runtime, "github/octocat/spoon-knife")).toMatchObject({ status: "cloning" })
    expect(h.only("repo.clone.launch").annotations).toMatchObject({
      outcome: "unavailable",
      status: 503,
      errorCode: "@smthrs/mvp/flows/StartUnavailable",
    })
    down = false
    expect((await h.launch("octocat", "Spoon-Knife", cloneId)).status).toBe(202)
    expect(starts).toEqual([cloneExecutionId("github/octocat/spoon-knife", cloneId)])
  })

  test("a launch refuses whom a request refuses: signed out, below Member, no Code Storage, bad input", async () => {
    const body = JSON.stringify({ owner: "octocat", name: "Spoon-Knife", cloneId: "c" })
    const post = (h: Awaited<ReturnType<typeof repoHarness>>, text = body, method = "POST") =>
      h.fetch("/api/repos/launch", { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: text } : {}) })
    expect((await post(await repoHarness(runtime, { actor: null }))).status).toBe(401)
    expect((await post(await repoHarness(runtime, { actor: { subject: { kind: "person", id: "g" }, role: "guest" } }))).status).toBe(403)
    expect((await post(await repoHarness(runtime, { codeStorage: "none" }))).status).toBe(503)
    const h = await repoHarness(runtime)
    expect((await post(h, "{")).status).toBe(400)
    expect((await post(h, JSON.stringify({ owner: "app", name: "x", cloneId: "c" }))).status).toBe(400)
    expect((await post(h, "x".repeat(70_000))).status).toBe(413)
    expect((await post(h, body, "GET")).status).toBe(405)
  })

  test("a request while the clone runs starts the same execution again, which changes nothing", async () => {
    const starts: Array<string> = []
    const h = await repoHarness(runtime, {
      starter: FlowStarter.of({ start: (_flow, start) => Effect.sync(() => void starts.push(start.executionId)) }),
    })
    expect((await h.clone("octocat", "Spoon-Knife")).status).toBe(202)
    const again = await h.clone("octocat", "Spoon-Knife")
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ status: "cloning" })
    const { cloneId } = (await repositoryRow(runtime, "github/octocat/spoon-knife"))!
    expect(starts).toEqual([
      cloneExecutionId("github/octocat/spoon-knife", cloneId),
      cloneExecutionId("github/octocat/spoon-knife", cloneId),
    ])
  })

  test("Try again on a failed clone starts attempt 2, under an id of its own", async () => {
    const h = await repoHarness(runtime)
    // GitHub doesn't have it yet: not_found.
    expect((await h.clone("octocat", "Spoon-Knife")).status).toBe(202)
    await h.settled()
    const failed = await repositoryRow(runtime, "github/octocat/spoon-knife")
    expect(failed).toMatchObject({ status: "failed", failure: "not_found" })
    h.scripted.publish("octocat", "Spoon-Knife")
    const retried = await h.clone("octocat", "Spoon-Knife")
    expect(retried.status).toBe(202)
    expect(await retried.json()).toMatchObject({ attempt: 2 })
    await h.settled()
    const ready = await repositoryRow(runtime, "github/octocat/spoon-knife")
    expect(ready).toMatchObject({ status: "ready", failure: null, attempt: 2 })
    expect(ready!.cloneId).not.toBe(failed!.cloneId)
    expect(h.started()).toEqual([
      cloneExecutionId("github/octocat/spoon-knife", failed!.cloneId),
      cloneExecutionId("github/octocat/spoon-knife", ready!.cloneId),
    ])
  })

  test("after a database reset that kept the Durable Objects, attempt 1 again starts cleanly and settles", async () => {
    const h = await repoHarness(runtime)
    h.scripted.publish("octocat", "Spoon-Knife")
    expect((await h.clone("octocat", "Spoon-Knife")).status).toBe(202)
    await h.settled()
    const before = await repositoryRow(runtime, "github/octocat/spoon-knife")
    // The database is reset: the row is gone and the attempt counter restarts. The first clone's Durable Object keeps
    // its intent, whose payload (its own requestedAt) differs from any new attempt's.
    await resetRepos(runtime)
    const again = await h.clone("octocat", "Spoon-Knife")
    expect(again.status).toBe(202)
    expect(await again.json()).toMatchObject({ attempt: 1 })
    await h.settled()
    const after = await repositoryRow(runtime, "github/octocat/spoon-knife")
    expect(after).toMatchObject({ status: "ready", attempt: 1, headSha: fixture().commit.sha })
    expect(after!.cloneId).not.toBe(before!.cloneId)
    const executions = [before!, after!].map((row) => cloneExecutionId("github/octocat/spoon-knife", row.cloneId))
    expect(h.started()).toEqual(executions)
    expect(await h.status(executions[1]!)).toBe("completed")
    expect(h.count(RepoMetrics.cloneRequests, { outcome: "requested" })).toBe(2)
    expect(h.count(RepoMetrics.cloneLaunches, { outcome: "launched" })).toBe(2)
  })

  test("a start another payload holds settles that attempt failed, never leaving it cloning", async () => {
    // Attempt ids never repeat, so a conflict is a bug; the starter here answers one to every start after the first.
    let conflicts = false
    const h = await repoHarness(runtime, {
      starter: FlowStarter.of({ start: () => (conflicts ? Effect.fail(new StartConflict()) : Effect.void) }),
    })
    // A new clone's launch conflicts.
    conflicts = true
    const fresh = await h.request("octocat", "Spoon-Knife")
    expect(fresh.status).toBe(202)
    const { cloneId } = await fresh.json() as { readonly cloneId: string }
    const launched = await h.launch("octocat", "Spoon-Knife", cloneId)
    expect([launched.status, await launched.json()]).toEqual([200, { launched: false, status: "failed" }])
    expect(await repositoryRow(runtime, "github/octocat/spoon-knife")).toMatchObject({
      status: "failed",
      failure: "unavailable",
      attempt: 1,
    })
    expect(h.only("repo.clone.launch").annotations).toMatchObject({ outcome: "conflict", status: 200, errorCode: "conflict" })
    expect(h.only("repo.clone.launch").level).toBe("ERROR")
    expect(h.count(RepoMetrics.cloneLaunches, { outcome: "conflict" })).toBe(1)
    // Try again starts attempt 2; while it runs, a launch of it again that conflicts settles it too.
    conflicts = false
    expect((await h.clone("octocat", "Spoon-Knife")).status).toBe(202)
    const second = (await repositoryRow(runtime, "github/octocat/spoon-knife"))!.cloneId
    conflicts = true
    expect(await (await h.launch("octocat", "Spoon-Knife", second)).json()).toEqual({ launched: false, status: "failed" })
    expect(await repositoryRow(runtime, "github/octocat/spoon-knife")).toMatchObject({
      status: "failed",
      failure: "unavailable",
      attempt: 2,
    })
    expect(h.count(RepoMetrics.cloneLaunches, { outcome: "conflict" })).toBe(2)
  })

  test("signed out: 401 authentication, and nothing is written", async () => {
    const h = await repoHarness(runtime, { actor: null })
    const response = await h.clone("octocat", "Spoon-Knife")
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: "authentication" })
    expect(await repositoryRow(runtime, "github/octocat/spoon-knife")).toBeUndefined()
    expect(h.count(RepoMetrics.cloneRequests, { outcome: "authentication" })).toBe(1)
  })

  test.each([
    ["a Guest", "guest" as const],
    ["a person with no role", null],
  ])("%s: 403 forbidden, and nothing is written or started", async (_, role) => {
    const h = await repoHarness(runtime, { actor: { subject: { kind: "person", id: "person-other" }, role } })
    const response = await h.clone("octocat", "Spoon-Knife")
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ code: "forbidden" })
    expect(await repositoryRow(runtime, "github/octocat/spoon-knife")).toBeUndefined()
    expect(h.count(RepoMetrics.cloneRequests, { outcome: "forbidden" })).toBe(1)
  })

  test("refuses what it can't take: method, body, names, size, and a deployment without Code Storage", async () => {
    const h = await repoHarness(runtime)
    const get = await h.fetch("/api/repos")
    expect(get.status).toBe(405)
    expect(get.headers.get("allow")).toBe("POST")
    const post = (body: string, headers: Record<string, string> = {}) =>
      h.fetch("/api/repos", { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
    for (const body of ["{", "[]", JSON.stringify({ owner: "octocat" }), JSON.stringify({ owner: "-x", name: "y" })]) {
      expect((await post(body)).status).toBe(400)
    }
    for (const [owner, name] of [["app", "x"], ["API", "x"], ["assets", "x"], ["octocat", ".."], ["octocat", "a/b"]]) {
      const response = await h.clone(owner!, name!)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ code: "invalid" })
    }
    expect((await post("x".repeat(2048))).status).toBe(413)
    const raw = await h.fetch("/api/repos", { method: "POST", body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) })
    expect(raw.status).toBe(400)
    const none = await repoHarness(runtime, { codeStorage: "none" })
    const unconfigured = await none.clone("octocat", "Spoon-Knife")
    expect(unconfigured.status).toBe(503)
    expect(await unconfigured.json()).toEqual({ code: "not_configured" })
  })

  test("sessions that can't be read: 503 unavailable, neither signed in nor out", async () => {
    const h = await repoHarness(runtime, {
      sessions: Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) })),
    })
    const response = await h.clone("octocat", "Spoon-Knife")
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: "unavailable" })
  })

  test("past REPO_MAX_REPOSITORIES: 429 repository_limit", async () => {
    const h = await repoHarness(runtime, { config: { REPO_MAX_REPOSITORIES: "1" } })
    await h.seed("octocat", "Spoon-Knife")
    const response = await h.clone("octocat", "Hello-World")
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ code: "repository_limit" })
    expect(await repositoryRow(runtime, "github/octocat/hello-world")).toBeUndefined()
  })

  test("Postgres unreachable: 503 unavailable, logged by code", async () => {
    const down = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const h = await repoHarness(runtime, { database: down })
    const response = await h.clone("octocat", "Spoon-Knife")
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: "unavailable" })
    expect(h.only("repo.clone.request").annotations).toMatchObject({ status: 503, errorCode: expect.stringMatching(/^sql:/) })
  })
})

describe("reads", () => {
  test("a tree lists every file at a commit, cached forever: the second read costs Code Storage nothing", async () => {
    const h = await repoHarness(runtime)
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    const first = await h.fetch(treeRoute("octocat", "Spoon-Knife", headSha))
    expect(first.status).toBe(200)
    expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(first.headers.get("content-type")).toContain("application/json")
    expect(await first.json()).toEqual({
      paths: ["README.md", "big.txt", "docs/guide.md", "logo.png", "src/index.ts"],
      truncated: false,
    })
    const second = await h.fetch(treeRoute("octocat", "Spoon-Knife", headSha))
    expect(second.status).toBe(200)
    // The clone's Index listed it once into the cache, so even the first visit cost Code Storage nothing.
    expect(h.scripted.calls.filter((call) => call.startsWith("listFiles"))).toHaveLength(1)
    expect(h.count(RepoMetrics.reads, { kind: "tree", status: "200" })).toBe(2)
    expect(h.line("repo.tree")[0]!.annotations).toMatchObject({ repoId: "github/octocat/spoon-knife", sha: headSha })
    expect((await usageRow(runtime))!.read).toBeGreaterThan(0)
  })

  test("a tree reads page by page, and stops at REPO_TREE_MAX_PATHS saying it is truncated", async () => {
    const files = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`f${index}.txt`, "x"]))
    const all = Array.from({ length: 7 }, (_, index) => `f${index}.txt`)
    const paged = scripted({ pageSize: 2 })
    const h = await repoHarness(runtime, { scripted: paged })
    const { headSha } = await h.seed("octocat", "Many", fixture({ files }))
    expect(await (await h.fetch(treeRoute("octocat", "Many", headSha))).json()).toEqual({ paths: all, truncated: false })
    expect(paged.calls.filter((call) => call.startsWith("listFiles"))).toHaveLength(4)
    const bounded = await repoHarness(runtime, { scripted: paged, config: { REPO_TREE_MAX_PATHS: "3" } })
    const stopped = bounded.fetch(`${treeRoute("octocat", "Many", headSha)}`)
    // A cache of its own: the bounded listing is read again, two pages, and cut at three paths.
    expect(await (await stopped).json()).toEqual({ paths: all.slice(0, 3), truncated: true })
    const exact = await repoHarness(runtime, { scripted: scripted(), config: { REPO_TREE_MAX_PATHS: "3" } })
    const few = await exact.seed("octocat", "Few", fixture({ files: { "a.txt": "a", "b.txt": "b", "c.txt": "c" } }))
    expect(await (await exact.fetch(treeRoute("octocat", "Few", few.headSha))).json()).toEqual({
      paths: ["a.txt", "b.txt", "c.txt"],
      truncated: false,
    })
  })

  test("Code Storage's quirks: a file with no blob id, one too large with no declared size, a client that dies", async () => {
    const source = await repoHarness(runtime)
    const { headSha } = await source.seed("octocat", "Spoon-Knife")
    const client = source.scripted.client
    const quirky = await repoHarness(runtime, {
      scripted: source.scripted,
      codeStorage: {
        ...client,
        readFile: (repo, read) =>
          read.path === "README.md"
            ? Effect.map(client.readFile(repo, read), (file) => ({ bytes: file.bytes, blobSha: undefined }))
            : read.path === "big.txt"
            ? Effect.fail(source.scripted.error("readFile", "too_large", 200))
            : Effect.die(new Error("boom")),
      },
    })
    const readme = await quirky.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "README.md"))
    expect(readme.status).toBe(200)
    expect(readme.headers.get("x-blob-sha")).toBeNull()
    const big = await quirky.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "big.txt"))
    expect(big.status).toBe(413)
    expect(await big.json()).toEqual({ code: "too_large" })
    const reader = await Effect.runPromise(Effect.service(RepoFlows.RepoReader).pipe(Effect.provide(quirky.reader())))
    expect(await Effect.runPromise(reader.read("octocat", "Spoon-Knife", headSha, "big.txt"))).toEqual({
      state: "too-large",
      size: 512 * 1024 + 1,
    })
    const died = await quirky.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "src/index.ts"))
    expect(died.status).toBe(503)
    expect(quirky.line("repo.blob").at(-1)!.annotations).toMatchObject({ status: 503, errorCode: "unknown" })
  })

  test("a file: its bytes and blob id; a binary as bytes; one over 512 KiB is 413 with its size", async () => {
    const h = await repoHarness(runtime)
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    const readme = await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "README.md"))
    expect(readme.status).toBe(200)
    expect(readme.headers.get("x-blob-sha")).toMatch(/^[0-9a-f]{40}$/)
    expect(readme.headers.get("content-type")).toBe("application/octet-stream")
    expect(await readme.text()).toContain("# Fixture")
    const nested = await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "docs/guide.md"))
    expect(await nested.text()).toContain("# Guide")
    const logo = await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "logo.png"))
    expect(new Uint8Array(await logo.arrayBuffer())[1]).toBe(0x50)
    const big = await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "big.txt"))
    expect(big.status).toBe(413)
    expect(await big.json()).toEqual({ code: "too_large", size: 600 * 1024 })
    expect(h.count(RepoMetrics.reads, { kind: "blob", status: "413" })).toBe(1)
    const missing = await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "nope.md"))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ code: "not_found" })
  })

  test("refuses bad input: a method, a SHA, a path, a name, a route", async () => {
    const h = await repoHarness(runtime)
    const sha = "a".repeat(40)
    expect((await h.fetch(treeRoute("octocat", "x", sha), { method: "DELETE" })).status).toBe(405)
    expect((await h.fetch(treeRoute("octocat", "x", "main"))).status).toBe(400)
    expect((await h.fetch(`/api/repos/octocat/x/blob/${sha}/a%2F..%2Fb`)).status).toBe(400)
    expect((await h.fetch(`/api/repos/octocat/x/blob/${sha}/${"a/".repeat(70)}b`)).status).toBe(400)
    expect((await h.fetch(`/api/repos/octocat/x/blob/${sha}`)).status).toBe(400)
    expect((await h.fetch(treeRoute("app", "x", sha))).status).toBe(404)
    expect((await h.fetch(`/api/repos/octocat/x/tree/${sha}/extra`)).status).toBe(404)
    expect((await h.fetch(`/api/repos/octocat/x/commits/${sha}`)).status).toBe(404)
    expect((await h.fetch(`/api/repos/octocat/%E0%A4%A/tree/${sha}`)).status).toBe(404)
    expect((await h.fetch("/api/elsewhere")).status).toBe(404)
    const none = await repoHarness(runtime, { codeStorage: "none" })
    expect((await none.fetch(treeRoute("octocat", "x", sha))).status).toBe(503)
  })

  test("Code Storage busy: 503 with its Retry-After, never cached; the next read answers", async () => {
    const h = await repoHarness(runtime)
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    h.scripted.fail("readFile", h.scripted.error("readFile", "repository_thawing", 409, { retryAfterMillis: 2_500 }))
    const busy = await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "README.md"))
    expect(busy.status).toBe(503)
    expect(busy.headers.get("retry-after")).toBe("3")
    expect(await busy.json()).toEqual({ code: "unavailable" })
    h.scripted.fail("listFiles", h.scripted.error("listFiles", "internal_error", 500))
    // The head's file list is cached since the clone indexed it: another commit's is a miss.
    const failed = await h.fetch(treeRoute("octocat", "Spoon-Knife", shaOf("uncached")))
    expect(failed.status).toBe(503)
    expect(failed.headers.get("retry-after")).toBeNull()
    expect((await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "README.md"))).status).toBe(200)
  })

  test("this month's reads spent: a miss is 503 capacity, a cached answer still serves", async () => {
    const h = await repoHarness(runtime, { config: { REPO_MAX_READ_GB_PER_MONTH: "0.000001" } })
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    expect((await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "README.md"))).status).toBe(200)
    await sql(`UPDATE code_storage_usage SET bytes_read = 1000000`)
    expect((await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "README.md"))).status).toBe(200)
    const miss = await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "docs/guide.md"))
    expect(miss.status).toBe(503)
    expect(await miss.json()).toEqual({ code: "capacity" })
  })

  test("a read budget Postgres can't check is 503 unavailable; a meter it can't write is logged and the read answers", async () => {
    const down = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const source = await repoHarness(runtime)
    const { headSha } = await source.seed("octocat", "Spoon-Knife")
    const h = await repoHarness(runtime, { database: down, scripted: source.scripted })
    const response = await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "README.md"))
    expect(response.status).toBe(503)
    expect(h.only("repo.blob").annotations).toMatchObject({ status: 503, errorCode: "unavailable" })
    // A database that answers the budget check and is gone for the meter: every second connection fails.
    const { database } = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    let opened = 0
    const flaky = Layer.unwrap(Effect.sync(() => (++opened % 2 === 1 ? database : down)))
    const metered = await repoHarness(runtime, { database: flaky, scripted: source.scripted })
    const answered = await metered.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "docs/guide.md"))
    expect(answered.status).toBe(200)
    expect(metered.only("repo.meter").annotations).toMatchObject({ errorCode: expect.stringMatching(/^sql:/) })
  })

  test("telemetry carries ids, statuses and sizes, never file contents, commit messages or Code Storage's text", async () => {
    const h = await repoHarness(runtime)
    const secret = "SENTINEL-c0ffee"
    const { headSha } = await h.seed("octocat", "Spoon-Knife", fixture({
      files: { "README.md": `# ${secret}` },
      commit: { sha: fixture().commit.sha, message: secret, author: secret, date: "2026-10-19T12:00:00Z" },
    }))
    await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "README.md"))
    await h.fetch(treeRoute("octocat", "Spoon-Knife", headSha))
    expect(h.line("repo.blob")).toHaveLength(1)
    expect(recorded(h)).not.toContain(secret)
  })
})

describe("branches and tags", () => {
  const branched = (count = 1) =>
    fixture({
      branches: Array.from({ length: count }, (_, index) => ({
        name: `b${index}`,
        sha: shaOf(`b${index}`),
        files: { "a.md": `# b${index}` },
      })),
      tags: [{ name: "v1", sha: shaOf("b0") }],
    })

  test("the default branch, its head, and every branch and tag, cached under the head: a repeat costs Code Storage nothing", async () => {
    const h = await repoHarness(runtime)
    const { headSha } = await h.seed("octocat", "Spoon-Knife", branched())
    const first = await h.fetch(refsRoute("octocat", "Spoon-Knife"))
    expect(first.status).toBe(200)
    expect(first.headers.get("cache-control")).toBe("private, no-store")
    expect(first.headers.get("content-type")).toContain("application/json")
    expect(await first.json()).toEqual({
      defaultBranch: "main",
      head: headSha,
      branches: [{ name: "b0", sha: shaOf("b0") }, { name: "main", sha: headSha }],
      tags: [{ name: "v1", sha: shaOf("b0") }],
      truncated: false,
    })
    expect((await h.fetch(refsRoute("octocat", "Spoon-Knife"))).status).toBe(200)
    expect(h.scripted.calls.filter((call) => call.startsWith("listBranches") || call.startsWith("listTags"))).toEqual([
      "listBranches:github/octocat/spoon-knife",
      "listTags:github/octocat/spoon-knife",
    ])
    expect(h.count(RepoMetrics.reads, { kind: "refs", status: "200" })).toBe(2)
    expect(h.line("repo.refs")[0]!.annotations).toMatchObject({ repoId: "github/octocat/spoon-knife", status: 200 })
    expect(h.line("repo.refs")[0]!.annotations).not.toHaveProperty("sha")
    expect((await usageRow(runtime))!.read).toBeGreaterThan(0)
  })

  test("a branch made with the default branch's head where it was is listed at once: the refs are keyed by their last change too", async () => {
    // Before, the listing was cached under the head commit alone, so a branch the app made on the forge stayed out of
    // every listing until the default branch moved.
    const h = await repoHarness(runtime)
    const { id } = await h.seed("octocat", "Spoon-Knife", branched())
    const names = async () =>
      ((await (await h.fetch(refsRoute("octocat", "Spoon-Knife"))).json()) as { branches: Array<{ name: string }> }).branches
        .map((branch) => branch.name)
    expect(await names()).toEqual(["b0", "main"])
    // What worker/branch/Branches.ts does for a new branch: make it on the forge, then record the change.
    await Effect.runPromise(h.scripted.client.createBranch(id, { branch: "made", from: "main" }))
    await runtime.runPromise(Repos.refsChanged(id))
    expect(await names()).toEqual(expect.arrayContaining(["b0", "main", "made"]))
  })

  test("a created ephemeral ref is visible to its owner while GitHub and ordinary refs stay unchanged", async () => {
    const h = await repoHarness(runtime)
    const { id } = await h.seed("octocat", "Spoon-Knife", branched())
    const source = h.scripted.github.get("octocat/spoon-knife")
    await Effect.runPromise(h.scripted.client.createBranch(id, {
      branch: "private-ref", from: "main", namespace: "ephemeral", fromNamespace: "default",
    }))
    await Effect.runPromise(h.scripted.client.createBranch(id, {
      branch: "unowned-private-ref", from: "main", namespace: "ephemeral", fromNamespace: "default",
    }))
    await runtime.runPromise(Conversations.track(id, "private-ref", "open", source!.commit.sha, "octocat", undefined, "ephemeral"))
    await runtime.runPromise(Repos.refsChanged(id))
    const answer = await h.fetch(refsRoute("octocat", "Spoon-Knife"))
    expect(answer.status).toBe(200)
    const visible = await answer.json() as { branches: Array<{ name: string; sha: string }> }
    expect(visible.branches).toContainEqual({ name: "private-ref", sha: source!.commit.sha })
    expect(visible.branches.map((branch) => branch.name)).not.toContain("unowned-private-ref")
    expect(h.scripted.github.get("octocat/spoon-knife")).toEqual(source)
    const ordinary = await Effect.runPromise(h.scripted.client.listBranches(id))
    expect(ordinary.branches.map((branch) => branch.name)).toEqual(["b0", "main"])
    const other = await repoHarness(runtime, { scripted: h.scripted, actor: { subject: { kind: "person", id: "other" }, role: "member" } })
    expect(await (await other.fetch(refsRoute("octocat", "Spoon-Knife"))).text()).not.toContain("private-ref")
  })

  test("pages of branches and tags, stopped at REPO_MAX_REFS saying so", async () => {
    const h = await repoHarness(runtime, { config: { REPO_MAX_REFS: "120" } })
    await h.seed("octocat", "Many", branched(150))
    const listed = (response: Response) =>
      response.json() as Promise<{ readonly branches: ReadonlyArray<unknown>; readonly truncated: boolean }>
    const refs = await listed(await h.fetch(refsRoute("octocat", "Many")))
    expect(refs.branches).toHaveLength(120)
    expect(refs.truncated).toBe(true)
    expect(h.scripted.calls.filter((call) => call.startsWith("listBranches"))).toHaveLength(2)
    const all = await repoHarness(runtime, { scripted: h.scripted })
    expect((await listed(await all.fetch(refsRoute("octocat", "Many")))).branches).toHaveLength(151)
  })

  test("a repository that isn't ready is 404; Code Storage busy is 503, never cached; bad input is refused", async () => {
    const h = await repoHarness(runtime)
    expect((await h.fetch(refsRoute("octocat", "Spoon-Knife"))).status).toBe(404)
    await h.seed("octocat", "Spoon-Knife", branched())
    h.scripted.fail("listTags", h.scripted.error("listTags", "rate_limited", 429, { retryAfterMillis: 1_200 }))
    const busy = await h.fetch(refsRoute("octocat", "Spoon-Knife"))
    expect(busy.status).toBe(503)
    expect(busy.headers.get("retry-after")).toBe("2")
    expect((await h.fetch(refsRoute("octocat", "Spoon-Knife"))).status).toBe(200)
    expect((await h.fetch(`${refsRoute("octocat", "Spoon-Knife")}/extra`)).status).toBe(404)
    expect((await h.fetch(refsRoute("octocat", "Spoon-Knife"), { method: "POST" })).status).toBe(405)
    const down = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const unreachable = await repoHarness(runtime, { database: down, scripted: h.scripted })
    expect((await unreachable.fetch(refsRoute("octocat", "Spoon-Knife"))).status).toBe(503)
    const none = await repoHarness(runtime, { codeStorage: "none" })
    expect((await none.fetch(refsRoute("octocat", "Spoon-Knife"))).status).toBe(503)
  })
})

describe("raw", () => {
  test("a text file as plain UTF-8, a binary as bytes, never sniffed or run; cached forever like the file", async () => {
    const h = await repoHarness(runtime)
    const { headSha } = await h.seed("octocat", "Spoon-Knife", fixture({
      files: { "index.html": "<script>alert(1)</script>", "logo.png": new Uint8Array([0x89, 0x50, 0, 1]) },
    }))
    const page = await h.fetch(rawRoute("octocat", "Spoon-Knife", headSha, "index.html"))
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(page.headers.get("x-content-type-options")).toBe("nosniff")
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox")
    expect(page.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(await page.text()).toBe("<script>alert(1)</script>")
    const logo = await h.fetch(rawRoute("octocat", "Spoon-Knife", headSha, "logo.png"))
    expect(logo.headers.get("content-type")).toBe("application/octet-stream")
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0, 1]))
    // The file route and the raw route share one cached read.
    await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "index.html"))
    expect(h.scripted.calls.filter((call) => call.startsWith("readFile"))).toHaveLength(2)
    expect(h.count(RepoMetrics.reads, { kind: "raw", status: "200" })).toBe(2)
    expect(h.line("repo.raw")[0]!.annotations).toMatchObject({ sha: headSha, status: 200 })
    expect((await h.fetch(rawRoute("octocat", "Spoon-Knife", headSha, "nope.md"))).status).toBe(404)
    expect((await h.fetch(`/api/repos/octocat/Spoon-Knife/raw/${headSha}`)).status).toBe(400)
    expect((await h.fetch(rawRoute("octocat", "Spoon-Knife", "main", "index.html"))).status).toBe(400)
  })
})

describe("the agent's reads on the server", () => {
  test("repo/tree and repo/read run on the Node host over RepoApi's own reads and cache", async () => {
    const h = await repoHarness(runtime)
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    const registration = RepoFlows.registration.pipe(
      Layer.provide(h.reader()),
      Layer.provideMerge(Action.layerImplementations),
    )
    const tree = await runFlow(RepoFlows.RepoTree, { repo: "octocat/Spoon-Knife", revision: headSha }, registration)
    expect(tree.exit).toEqual(Exit.succeed({
      paths: ["README.md", "big.txt", "docs/guide.md", "logo.png", "src/index.ts"],
      truncated: false,
    }))
    const read = (path: string) =>
      runFlow(RepoFlows.RepoRead, { repo: "octocat/Spoon-Knife", revision: headSha, path }, registration)
    expect((await read("src/index.ts")).exit).toEqual(Exit.succeed({
      state: "text",
      contents: "export const one = 1\nexport const two = 2\nexport const three = 3\n",
      size: 65,
    }))
    expect((await read("logo.png")).exit).toEqual(Exit.succeed({ state: "binary", size: 12 }))
    expect((await read("big.txt")).exit).toEqual(Exit.succeed({ state: "too-large", size: 600 * 1024 }))
    const missing = await read("nope.md")
    expect(Exit.isFailure(missing.exit) && Cause.squash(missing.exit.cause)).toBeInstanceOf(RepoFlows.RepoNotFound)
    // One Code Storage read of the tree serves the GET route and the flow alike.
    await h.fetch(treeRoute("octocat", "Spoon-Knife", headSha))
    expect(h.scripted.calls.filter((call) => call.startsWith("listFiles"))).toHaveLength(1)
    const refs = await runFlow(RepoFlows.RepoRefs, { repo: "octocat/Spoon-Knife" }, registration)
    expect(refs.exit).toEqual(Exit.succeed({
      defaultBranch: "main",
      head: headSha,
      branches: [{ name: "main", sha: headSha }],
      tags: [],
      truncated: false,
    }))
    const unknown = await runFlow(RepoFlows.RepoRefs, { repo: "octocat/Hello-World" }, registration)
    expect(Exit.isFailure(unknown.exit) && Cause.squash(unknown.exit.cause)).toBeInstanceOf(RepoFlows.RepoNotFound)
    // Each `runFlow` builds an engine of its own: seven builds take a loaded machine more than the default 30 s.
  }, 90_000)

  test("the agent refs reader maps an unavailable ready-head database to its declared failure without querying Code Storage", async () => {
    const down = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const h = await repoHarness(runtime, { database: down })
    const reader = await Effect.runPromise(Effect.service(RepoFlows.RepoReader).pipe(Effect.provide(h.reader())))
    const exit = await Effect.runPromiseExit(reader.refs("octocat", "Spoon-Knife"))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(new RepoFlows.RepoReadUnavailable({}))
    expect(h.scripted.calls).toEqual([])
  })

  test("a reader's failures are the flows' declared ones: paused reads and a busy Code Storage", async () => {
    const h = await repoHarness(runtime, { config: { REPO_MAX_READ_GB_PER_MONTH: "0.000001" } })
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    const reader = await Effect.runPromise(Effect.service(RepoFlows.RepoReader).pipe(Effect.provide(h.reader())))
    h.scripted.fail("readFile", h.scripted.error("readFile", "rate_limited", 429, { retryAfterMillis: 700 }))
    const busy = await Effect.runPromiseExit(reader.read("octocat", "Spoon-Knife", headSha, "README.md"))
    expect(Exit.isFailure(busy) && Cause.squash(busy.cause)).toEqual(new RepoFlows.RepoReadUnavailable({ retryAfterMillis: 700 }))
    h.scripted.fail("listFiles", h.scripted.error("listFiles", "internal_error", 500))
    const failed = await Effect.runPromiseExit(reader.tree("octocat", "Spoon-Knife", shaOf("uncached")))
    expect(Exit.isFailure(failed) && Cause.squash(failed.cause)).toEqual(new RepoFlows.RepoReadUnavailable({}))
    await sql(`UPDATE code_storage_usage SET bytes_read = 1000000`)
    const paused = await Effect.runPromiseExit(reader.read("octocat", "Spoon-Knife", headSha, "docs/guide.md"))
    expect(Exit.isFailure(paused) && Cause.squash(paused.cause)).toBeInstanceOf(RepoFlows.RepoReadsPaused)
    const none = await repoHarness(runtime, { codeStorage: "none" })
    expect(() => none.reader()).toThrow("no Code Storage")
  })
})

describe("spend", () => {
  test("a read that crosses a threshold of REPO_BUDGET_USD alerts once a month, and the gauges follow", async () => {
    // $0.000001 a month: the 640 KiB the clone stores is worth about 0.0024 cents, past every threshold.
    const h = await repoHarness(runtime, { config: { REPO_BUDGET_USD: "0.000001" } })
    const { headSha } = await h.seed("octocat", "Spoon-Knife")
    expect(h.only("repo.spend.alert").annotations).toMatchObject({ pct: 100 })
    expect(h.count(RepoMetrics.spendAlerts, { pct: "100" })).toBe(1)
    expect(h.gauge(RepoMetrics.storedBytes)).toBe(640 * 1024)
    expect(h.gauge(RepoMetrics.spendEstimate)).toBeGreaterThanOrEqual(0)
    await h.fetch(blobRoute("octocat", "Spoon-Knife", headSha, "README.md"))
    expect(h.line("repo.spend.alert")).toHaveLength(1)
    expect((await usageRow(runtime))!.alerted).toBe(100)
  })

  test("each threshold alerts on its own as the month's spend grows", async () => {
    // $1 a month; each step below adds stored bytes worth a fixed share of it.
    const budgets = { maxRepositories: 100, maxStoredBytes: 1e12, maxReadBytes: 1e12, maxRepositoryBytes: 1e12, budgetUsd: 1 }
    const alerts: Array<number | null> = []
    const store = (id: string, gb: number) =>
      sql(`INSERT INTO repositories (id, owner, name, status, stored_bytes) VALUES ('${id}', 'a', '${id}', 'cloning', ${Math.round(gb * 1e9)})`)
    const meter = async () => alerts.push((await runtime.runPromise(Repos.meterRead(0, budgets))).alert)
    await meter()
    await store("github/a/half", 0.14) // $0.504
    await meter()
    await meter()
    await store("github/a/more", 0.09) // $0.828
    await meter()
    await store("github/a/all", 0.06) // $1.044
    await meter()
    expect(alerts).toEqual([null, 50, null, 80, 100])
  })
})

describe("GET /api/repos/<owner>/<name>/about", () => {
  test("a visitor gets 200 for a repository the App is installed on while GitHub's anonymous quota is spent", async () => {
    // Will's bug bash, 2026-10-23: a visitor got 503 where a Member got 200 for the same repository, because a visitor's
    // read was anonymous: 60 calls an hour per address, shared by every Worker on Cloudflare's egress.
    const key = await appKey()
    const h = await repoHarness(runtime, {
      actor: null,
      config: { GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: Redacted.value(key), GITHUB_REPOSITORY: "smithersai/smithers" },
    })
    h.github.publish("smithersai", "vibelang", spoonKnife({ fullName: "smithersai/vibelang" }))
    h.github.install("smithersai", "vibelang")
    h.github.fail("", "rate_limited")
    const response = await h.fetch(aboutRoute("smithersai", "vibelang"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ name: "smithersai/vibelang" })
    expect(h.only("repo.about").annotations).toMatchObject({ status: 200, cache: "miss", via: "app", read: "answered" })
    expect(h.count(RepoMetrics.aboutAnswers, { cache: "miss" })).toBe(1)
    expect(recorded(h)).not.toMatch(/ghs_about|PRIVATE KEY/)
  })

  test("a read of a repository without the App spends the deployment's token only for a Member; a visitor or a Guest reads anonymously", async () => {
    // Before, every read went out with the deployment's token: anyone naming arbitrary repositories spent the GitHub
    // App's quota, which the git loop needs too.
    const read = async (actor: Actor.Actor | null, name: string) => {
      const h = await repoHarness(runtime, { actor, config: { GITHUB_TOKEN: "ghp_deployment" } })
      h.github.publish("octocat", name)
      expect((await h.fetch(aboutRoute("octocat", name))).status).toBe(200)
      return { authorizations: new Set(h.github.authorizations), via: h.only("repo.about").annotations.via }
    }
    expect(await read(null, "Visitor")).toEqual({ authorizations: new Set([null]), via: "anonymous" })
    expect(await read({ subject: { kind: "person", id: "person-guest" }, role: "guest" }, "Guest")).toEqual({ authorizations: new Set([null]), via: "anonymous" })
    expect(await read({ subject: { kind: "person", id: "person-member" }, role: "member" }, "Member")).toEqual({ authorizations: new Set(["Bearer ghp_deployment"]), via: "deployment" })
  })

  test("what GitHub says, before any clone, kept for every data center: ten anonymous calls once, then the store", async () => {
    const h = await repoHarness(runtime, { actor: null })
    h.github.publish("octocat", "Spoon-Knife")
    const response = await h.fetch(aboutRoute("octocat", "Spoon-Knife"))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600")
    expect(await response.json()).toEqual({
      name: "octocat/Spoon-Knife",
      description: "This repo is for demonstration purposes only.",
      homepage: null,
      topics: ["demo", "forking"],
      stars: 14126,
      forks: 160292,
      watchers: 908,
      license: "MIT",
      defaultBranch: "main",
      archived: false,
      languages: [{ name: "HTML", bytes: 355 }, { name: "CSS", bytes: 256 }],
      release: { tag: "v1.0.0", name: "First", publishedAt: "2026-10-01T12:00:00Z" },
      releases: 2,
      // A contributor GitHub names without a login (an anonymous email) isn't shown, but is counted.
      contributors: [{ login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" }],
      contributorCount: 2,
      commits: 1,
      branches: 3,
      tags: 0,
      head: {
        sha: "d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9",
        message: "Pointing to the guide for forking",
        author: "octocat",
        at: "2014-02-12T23:20:44Z",
      },
      root: [{ name: "README.md", kind: "file" }, { name: "index.html", kind: "file" }, { name: "docs", kind: "dir" }],
      readme: { path: "README.md", text: "### Well hello there!\n\nFork me.\n" },
      home: null,
      installUrl: "https://github.com/apps/smithers/installations/new",
    })
    // Ten reads of GitHub, once (twelve before): no home without .smithers, no count of one page of contributors.
    expect(h.github.calls).toHaveLength(10)
    expect(h.github.calls).not.toContain("/contents/.smithers/home.json")
    const again = await h.fetch(aboutRoute("octocat", "spoon-knife"))
    expect(again.status).toBe(200)
    expect(Number(again.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1])).toBeLessThanOrEqual(3600)
    expect(h.github.calls).toHaveLength(10)
    expect(h.line("repo.about").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ repoId: "github/octocat/spoon-knife", status: 200, cache: "miss", via: "anonymous", read: "answered", rateRemaining: 59 }),
      expect.objectContaining({ repoId: "github/octocat/spoon-knife", status: 200, cache: "hit", via: "anonymous" }),
    ])
    expect(h.count(RepoMetrics.reads, { kind: "about", status: "200" })).toBe(2)
    expect(h.count(RepoMetrics.aboutAnswers, { cache: "hit" })).toBe(1)
  })

  test("a repository's own home, at its newest commit: its text, or none when GitHub refuses it or it is too large", async () => {
    const h = await repoHarness(runtime, { actor: null })
    const text = JSON.stringify({ docs: "https://docs.example.com/llms.txt", blocks: [{ type: "text", text: "Hi" }] })
    h.github.publish("octocat", "Homed", spoonKnife({ fullName: "octocat/Homed", home: { text } }))
    expect(await (await h.fetch(aboutRoute("octocat", "Homed"))).json()).toMatchObject({ home: text })

    h.github.publish("octocat", "Huge", spoonKnife({ fullName: "octocat/Huge", home: { text, size: 600 * 1024 } }))
    expect(await (await h.fetch(aboutRoute("octocat", "Huge"))).json()).toMatchObject({ home: null })

    h.github.publish("octocat", "Empty", spoonKnife({ fullName: "octocat/Empty", home: { text }, commits: [] }))
    const empty = await (await h.fetch(aboutRoute("octocat", "Empty"))).json()
    expect(empty).toMatchObject({ home: null, head: null })

    h.github.publish("octocat", "Refused", spoonKnife({ fullName: "octocat/Refused", home: { text } }))
    h.github.fail("/contents/.smithers/home.json", 500)
    expect(await (await h.fetch(aboutRoute("octocat", "Refused"))).json()).toMatchObject({ home: null })
    expect(h.line("repo.about").at(-1)?.annotations).toMatchObject({ read: "partial" })
  })

  test("only the repository must answer: parts GitHub refuses are left out; its license and homepage as it has them", async () => {
    const h = await repoHarness(runtime, { config: { GITHUB_APP_SLUG: "smithers-dev" } })
    h.github.publish("octocat", "Sparse", spoonKnife({
      fullName: "octocat/Sparse",
      homepage: "https://example.com/docs/",
      license: { spdx: "NOASSERTION", name: "Other" },
      release: null,
      releases: 0,
      contributors: null,
      readme: { path: "README.md", text: "big", size: 600 * 1024 },
      root: null,
      commits: [],
      topics: [],
    }))
    h.github.fail("/languages", 500)
    const sparse = await (await h.fetch(aboutRoute("octocat", "Sparse"))).json()
    expect(sparse).toMatchObject({
      homepage: "https://example.com/docs/",
      license: "Other",
      languages: [],
      release: null,
      releases: 0,
      contributors: [],
      commits: 0,
      head: null,
      root: null,
      readme: null,
      installUrl: "https://github.com/apps/smithers-dev/installations/new",
    })
    h.github.clear()
    h.github.publish("octocat", "Odd", spoonKnife({
      fullName: "octocat/Odd",
      homepage: "javascript:alert(1)",
      license: null,
      description: "   ",
      readme: { path: "README.md", text: "\u0000binary" },
      root: [{ name: "lib", type: "submodule" }, { name: "link", type: "symlink" }, { name: "x", type: "unknown" }],
    }))
    expect(await (await h.fetch(aboutRoute("octocat", "Odd"))).json()).toMatchObject({
      homepage: null,
      license: null,
      description: null,
      readme: null,
      root: [{ name: "lib", kind: "dir" }, { name: "link", kind: "file" }],
    })
  })

  test("a part GitHub rate limits is left out; the repository rate limited is 503 with its wait, kept until GitHub's reset", async () => {
    // Before, a rate limit on any part failed the whole read with 503 and nothing was kept, so every visitor asked again.
    const h = await repoHarness(runtime)
    h.github.publish("octocat", "Spoon-Knife")
    h.github.fail("/tags", "rate_limited")
    const partial = await h.fetch(aboutRoute("octocat", "Spoon-Knife"))
    expect(partial.status).toBe(200)
    expect(await partial.json()).toMatchObject({ tags: null, branches: 3 })
    expect(Number(partial.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1])).toBeLessThanOrEqual(300)
    h.github.clear()
    h.github.publish("octocat", "Limited")
    h.github.fail("", "rate_limited")
    const limited = await h.fetch(aboutRoute("octocat", "Limited"))
    expect(limited.status).toBe(503)
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(limited.headers.get("cache-control")).toBe("no-store")
    expect(await limited.json()).toEqual({ code: "rate_limited" })
    expect(h.line("repo.about").at(-1)?.annotations).toMatchObject({
      status: 503, errorCode: "rate_limited", cache: "miss", read: "rate_limited", stage: "repository", upstreamStatus: 403,
    })
    // Every request until GitHub's reset gets the kept refusal, with the wait to it, and GitHub isn't asked.
    h.github.clear()
    const calls = h.github.calls.length
    const kept = await h.fetch(aboutRoute("octocat", "Limited"))
    expect([kept.status, await kept.json()]).toEqual([503, { code: "rate_limited" }])
    expect(Number(kept.headers.get("retry-after"))).toBeGreaterThan(500)
    expect(h.line("repo.about").at(-1)?.annotations).toMatchObject({ cache: "refusal", errorCode: "rate_limited" })
    expect(h.github.calls).toHaveLength(calls)
    await sql(`UPDATE repo_about SET next_read_at = now() WHERE repo_id = 'github/octocat/limited'`)
    expect((await h.fetch(aboutRoute("octocat", "Limited"))).status).toBe(200)
  })

  test("a repository GitHub doesn't have, or keeps private, is 404; GitHub down is 503 github_unavailable; bad input is refused", async () => {
    const h = await repoHarness(runtime)
    expect((await h.fetch(aboutRoute("octocat", "Gone"))).status).toBe(404)
    h.github.publish("octocat", "Secret", spoonKnife({ fullName: "octocat/Secret", private: true }))
    expect(await (await h.fetch(aboutRoute("octocat", "Secret"))).json()).toEqual({ code: "not_found" })
    h.github.publish("octocat", "Down")
    h.github.fail("", 502)
    const down = await h.fetch(aboutRoute("octocat", "Down"))
    expect(down.status).toBe(503)
    expect(await down.json()).toEqual({ code: "github_unavailable" })
    expect(down.headers.get("retry-after")).toBeNull()
    expect(down.headers.get("cache-control")).toBe("no-store")
    expect(h.line("repo.about").map((line) => line.annotations)).toEqual([
      expect.objectContaining({ status: 404, errorCode: "not_found", stage: "repository", upstreamStatus: 404 }),
      expect.objectContaining({ status: 404, errorCode: "not_found", stage: "repository" }),
      expect.objectContaining({ status: 503, errorCode: "github_unavailable", stage: "repository", upstreamStatus: 502, cache: "miss" }),
    ])
    expect((await h.fetch("/api/repos/app/x/about")).status).toBe(404)
    expect((await h.fetch("/api/repos/%E0%A4%A/x/about")).status).toBe(404)
    expect((await h.fetch(aboutRoute("octocat", "Gone"), { method: "POST" })).status).toBe(405)
    expect(h.line("repo.about").map((line) => line.annotations.errorCode).filter(Boolean)).toEqual([
      "not_found",
      "not_found",
      "github_unavailable",
    ])
  })

  test("thirty visitors' first reads at once, here and in another data center: every one 200, one read of GitHub", async () => {
    // Production, 2026-10-25: 23 of 30 concurrent visitors got 500, because requests shared one lookup and resumed on
    // the first request's I/O. Each request now reads on its own; those that didn't claim the read wait in the store.
    const github = scriptedGitHub()
    github.publish("smithersai", "vibelang", spoonKnife({ fullName: "smithersai/vibelang" }))
    const here = await repoHarness(runtime, { actor: null, github })
    const there = await repoHarness(runtime, { actor: null, github, keepAbout: true })
    const release = github.hold()
    const crowd = Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? here : there).fetch(aboutRoute("smithersai", "vibelang"))))
    await vi.waitFor(() => expect(github.holding()).toBeGreaterThan(0), { timeout: 10_000, interval: 10 })
    release()
    const responses = await crowd
    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 30 }, () => 200))
    expect(new Set(await Promise.all(responses.map(async (response) => (await response.json() as { readonly name: string }).name))))
      .toEqual(new Set(["smithersai/vibelang"]))
    // One anonymous read: ten calls, the repository once.
    expect(github.calls.filter((call) => call === "")).toHaveLength(1)
    expect(github.calls).toHaveLength(10)
    const lines = [...here.line("repo.about"), ...there.line("repo.about")].map((line) => line.annotations)
    expect(lines.filter((line) => line.cache === "miss")).toHaveLength(1)
    expect(lines.filter((line) => line.cache === "hit")).toHaveLength(29)
    expect(lines.some((line) => typeof line.waitedMs === "number")).toBe(true)
    expect([...here.line("repo.about.read"), ...there.line("repo.about.read")]).toHaveLength(1)
  })

  test("a deployment whose GitHub URL isn't one answers 503, logged by the defect's name", async () => {
    const h = await repoHarness(runtime, { config: { GITHUB_API_URL: "not a url" } })
    const broken = await h.fetch(aboutRoute("octocat", "Spoon-Knife"))
    expect(broken.status).toBe(503)
    expect(await broken.json()).toEqual({ code: "unavailable" })
    expect(h.only("repo.about").annotations).toMatchObject({ status: 503, errorCode: expect.any(String) })
  })
})

describe("GET /api/shapes/repositories", () => {
  test("serves Electric's repositories, whole, with no subset requests", async () => {
    const h = await repoHarness(runtime, { actor: null })
    await sql(`INSERT INTO repositories (id, owner, name, status, stage) VALUES ('github/a/b', 'a', 'b', 'cloning', 'requested')`)
    const response = await h.fetch("/api/shapes/repositories?offset=-1&table=messages&where=true")
    expect(response.status).toBe(200)
    // The stage and the reclaim mark sync with the row; who asked for the clone is in a table of its own, never synced.
    const rows = (await response.clone().json() as ReadonlyArray<{ readonly value?: Record<string, unknown> }>)
      .flatMap((message) => (message.value === undefined ? [] : [message.value]))
    expect(rows).toEqual([expect.objectContaining({ id: "github/a/b", stage: "requested", reclaimable: "false" })])
    expect(Object.keys(rows[0]!).some((column) => column.includes("request") && column !== "requested_at")).toBe(false)
    expect(response.headers.get("electric-handle")).toEqual(expect.any(String))
    // No browser or CDN keeps it: Electric's `public, max-age=604800` is replaced.
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    // A subset request's parameters are dropped, so it reads the whole shape too.
    const subset = await h.fetch("/api/shapes/repositories?offset=-1&subset__limit=1&subset__where=id")
    expect(subset.status).toBe(200)
  })
})

test("clone launch fails closed when sessions or the request body cannot be read", async () => {
  const down = await repoHarness(runtime, { sessions: Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) })) })
  expect((await down.launch("octocat", "Spoon-Knife", crypto.randomUUID())).status).toBe(503)
  const h = await repoHarness(runtime)
  const response = await h.fetch("/api/repos/launch", { method: "POST", body: new ReadableStream({
    start(controller) { controller.error(new Error("injected request body fault")) },
  }), duplex: "half" } as RequestInit)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ code: "invalid" })
})

test("ephemeral ref listing failures stay private and never fall back to the ordinary namespace", async () => {
  const h = await repoHarness(runtime)
  h.scripted.publish("octocat", "Spoon-Knife")
  await h.clone("octocat", "Spoon-Knife")
  await h.settled()
  await runtime.runPromise(Conversations.track("github/octocat/spoon-knife", "private-ref", "open", "a".repeat(40), "octocat", undefined, "ephemeral"))
  const seen: Array<string | undefined> = []
  const faulty = await repoHarness(runtime, { scripted: h.scripted, codeStorage: {
    ...h.scripted.client,
    listBranches: (repo, options) => {
      seen.push(options?.namespace)
      return options?.namespace === "ephemeral"
        ? Effect.fail(new CodeStorage.CodeStorageError({ operation: "listBranches", code: "transport" }))
        : h.scripted.client.listBranches(repo, options)
    },
  } })
  expect((await faulty.fetch(refsRoute("octocat", "Spoon-Knife"))).status).toBe(503)
  expect(seen).toContain("ephemeral")
  const other = await repoHarness(runtime, { scripted: h.scripted, actor: { subject: { kind: "person", id: "elsewhere" }, role: "member" } })
  const answer = await other.fetch(refsRoute("octocat", "Spoon-Knife"))
  expect(answer.status).toBe(200)
  expect(await answer.text()).not.toContain("private-ref")
})
