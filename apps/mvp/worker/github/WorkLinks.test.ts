// Work links (decision 0147, docs/features/work-links.md) through the real handler over this file's schema of the
// compose Postgres: who may post, what a post writes, the status the issues list derives, and its `?work=` filter.
import { digestSync } from "@smthrs/crypto"
import { Effect, Layer, Redacted } from "effect"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { issuesRoute } from "../../src/features/issues/contract.ts"
import { MAX_LINKS_PER_POST, WORK_LINKS_SHAPE_ROUTE, workLinksRoute } from "../../src/features/issues/work.ts"
import * as Actor from "../Actor.vibe"
import * as Store from "../runners/Store.ts"
import { testFile } from "../test/harness.ts"
import { handles } from "./Api.ts"
import * as RepoRoles from "./RepoRoles.ts"
import * as Metrics from "./Metrics.vibe"
import { MAX_POST_BYTES, parseLinksPath } from "./WorkLinks.ts"
import { githubHarness as makeGithubHarness, member } from "./test/harness.ts"
import { REPOSITORY, reset, signedIn, sql } from "./test/fixtures.ts"

const githubHarness = (runtime: Parameters<typeof makeGithubHarness>[0], options: Parameters<typeof makeGithubHarness>[1] = {}) =>
  makeGithubHarness(runtime, { actor: member(undefined, null), ...options })

const runtime = testFile("github_work_links")

beforeEach(() => reset(runtime))

const RUNNER_TOKEN = "runner-token-for-work-links-test-0001"
const route = (number: number) => workLinksRoute(REPOSITORY.owner, REPOSITORY.name, number)
const list = issuesRoute(REPOSITORY.owner, REPOSITORY.name)
const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
})
const asRunner = { authorization: `Bearer ${RUNNER_TOKEN}` }

/** Issues #1 to #3, open; and a runner `lane-host` registered on the repository through its Admin role (decision 0148). */
const seed = async () => {
  await sql(
    runtime,
    `INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, created_at, updated_at, source_updated_at, fetched_at)
    SELECT '${REPOSITORY.id}#' || n, '${REPOSITORY.id}', n, 'issue', n, 'Issue ' || n, '', 'open',
      now() - n * interval '1 minute', now() - n * interval '1 minute', now(), now() FROM generate_series(1, 3) AS n`,
  )
  await sql(
    runtime,
    `INSERT INTO runners (repo_id, name, capacity, token_sha256, added_by, repo_authorized_at)
    VALUES ('${REPOSITORY.id}', 'lane-host', 1, '${digestSync(RUNNER_TOKEN)}', 'test', now())`,
  )
}

type Listed = { readonly number: number; readonly work: { readonly status: string; readonly links: ReadonlyArray<Record<string, unknown>> } }

describe("work links", () => {
  test("is the links route of an issue, and nothing else", () => {
    expect(handles(route(7))).toBe(true)
    expect(handles(WORK_LINKS_SHAPE_ROUTE)).toBe(true)
    expect(parseLinksPath(route(7))).toEqual({ owner: "acme", name: "widgets", number: 7 })
    for (const path of ["/api/repos/acme/widgets/issues/0/links", "/api/repos/acme/widgets/issues/x/links", "/api/repos/acme/widgets/issues/9999999999/links",
      "/api/repos/acme/widgets/pulls/7/links", "/api/repos/%E0%A4%A/widgets/issues/7/links", "/api/repos/-bad/widgets/issues/7/links", "/api/other"]) {
      expect([path, parseLinksPath(path)]).toEqual([path, undefined])
    }
  })

  test("a Member posts links; the status follows the latest of them, merged for good; posting again changes nothing", async () => {
    await seed()
    const h = await githubHarness(runtime)
    const first = await h.fetch(route(2), post({
      links: [
        { kind: "assignee", ref: "lane-a", label: "lane-a", at: "2026-11-01T09:00:00Z" },
        { kind: "session", ref: "lane:lane-a", state: "working", at: "2026-11-01T10:00:00Z", url: "https://example.test/lanes/lane-a" },
      ],
    }))
    expect([first.status, await first.json()]).toEqual([200, { links: 2, changed: 2 }])
    // The same post sent again (a retry) changes nothing.
    const again = await h.fetch(route(2), post({ links: [{ kind: "assignee", ref: "lane-a", label: "lane-a", at: "2026-11-01T09:00:00Z" }] }))
    expect(await again.json()).toEqual({ links: 1, changed: 0 })
    const statusOf = async (number: number) =>
      ((await (await h.fetch(`${list}?state=all`)).json()) as Array<Listed>).find((issue) => issue.number === number)!.work
    expect((await statusOf(2)).status).toBe("working")
    expect((await statusOf(1)).status).toBe("none")
    await h.fetch(route(2), post({ links: [{ kind: "queue", ref: "q-1", state: "queued", at: "2026-11-01T11:00:00Z" }] }))
    expect((await statusOf(2)).status).toBe("queued")
    // A queue entry that failed, posted late with its own time, and an older post that changes nothing.
    await h.fetch(route(2), post({ links: [{ kind: "queue", ref: "q-1", state: "failed", at: "2026-11-01T11:30:00Z" }] }))
    const stale = await h.fetch(route(2), post({ links: [{ kind: "queue", ref: "q-1", state: "queued", at: "2026-11-01T11:10:00Z" }] }))
    expect(await stale.json()).toEqual({ links: 1, changed: 0 })
    expect((await statusOf(2)).status).toBe("failed")
    // The lane starts working again after its queue entry failed: the same state, newer, is the newest word.
    await h.fetch(route(2), post({ links: [{ kind: "session", ref: "lane:lane-a", state: "working", at: "2026-11-01T11:40:00Z" }] }))
    expect((await statusOf(2)).status).toBe("working")
    await h.fetch(route(2), post({ links: [{ kind: "pr", ref: "12", state: "open", at: "2026-11-01T12:00:00Z", url: "https://github.com/acme/widgets/pull/12" }] }))
    expect((await statusOf(2)).status).toBe("in_review")
    await h.fetch(route(2), post({ links: [{ kind: "merge", ref: "abc123", state: "merged", at: "2026-11-01T12:30:00Z" }] }))
    await h.fetch(route(2), post({ links: [{ kind: "session", ref: "lane:lane-b", state: "working", at: "2026-11-01T13:00:00Z" }] }))
    const work = await statusOf(2)
    expect(work.status).toBe("merged")
    expect(work.links.map((link) => link.ref)).toEqual(["lane:lane-b", "abc123", "12", "lane:lane-a", "q-1", "lane-a"])
    expect(work.links[0]).toMatchObject({ kind: "session", state: "working", updated_at: "2026-11-01T13:00:00.000000Z" })
    expect(work.links.find((link) => link.kind === "pr")).toMatchObject({ url: "https://github.com/acme/widgets/pull/12", label: "12" })
    expect(h.count(Metrics.workLinkPosts, { outcome: "written", by: "person" })).toBe(9)
    expect(h.line("work.links")[0]!.annotations).toMatchObject({ outcome: "written", links: 2, changed: 2, status: 200 })
    expect(JSON.stringify(h.line("work.links").map((line) => line.annotations))).not.toContain("lane-a")
  })

  test("the dispatcher adds no session rechecks to bounded work-link writes or reads", async () => {
    await seed()
    const who = await signedIn(runtime, { login: "cost-member", token: Redacted.make("test-only-token") })
    const alias = crypto.randomUUID()
    await sql(runtime, `INSERT INTO host_sessions (id, token_digest, parent_id, host)
      VALUES ('${alias}', 'digest-${alias}', '${who.sessionId}', 'alias.example.test')`)
    const counts: Array<number> = []
    const reads: Array<number> = []
    for (const actor of [member(undefined, null), member(who.personId, who.sessionId), { ...member(who.personId, who.sessionId), alias }]) {
      const h = await githubHarness(runtime, { actor })
      const clients = () => h.spans.filter((span) => span.kind === "client").length
      expect((await h.fetch(route(1), post({ links: [{ kind: "queue", ref: "cost" }] }))).status).toBe(200)
      counts.push(clients())
      const before = clients()
      expect((await h.fetch(`${list}?state=all`)).status).toBe(200)
      reads.push(clients() - before)
    }
    // A session's write and read each read its confirmed deployment role once (`SessionStore.freshRole`, the role
    // check itself); the dispatcher adds no recheck beside it, and an alias costs nothing more than its home session.
    expect(counts.map((count) => count - counts[0]!)).toEqual([0, 1, 1])
    expect(reads.map((count) => count - reads[0]!)).toEqual([0, 1, 1])
  })

  test("a runner registered on the repository posts and reads with its token; any other token is nobody", async () => {
    await seed()
    await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private, installation_id) VALUES ('${REPOSITORY.id}', 1, true, 42)`)
    const h = await githubHarness(runtime, { actor: null })
    const posted = await h.fetch(route(3), post({ links: [{ kind: "queue", ref: "q-9", state: "queued" }] }, asRunner))
    expect([posted.status, await posted.json()]).toEqual([200, { links: 1, changed: 1 }])
    expect(await sql(runtime, `SELECT source FROM work_links`)).toEqual([{ source: "runner:lane-host" }])
    const read = await h.fetch(`${list}?work=pr-or-queue`, { headers: asRunner })
    expect(read.status).toBe(200)
    expect(((await read.json()) as Array<Listed>).map((issue) => [issue.number, issue.work.status])).toEqual([[3, "queued"]])
    for (const headers of [{}, { authorization: "Bearer someone-else" }] as Array<Record<string, string>>) {
      const refused = await h.fetch(route(3), post({ links: [{ kind: "queue", ref: "q-9" }] }, headers))
      expect([refused.status, await refused.json()]).toEqual([401, { code: "authentication" }])
      expect((await h.fetch(list, { headers })).status).toBe(401)
    }
    await sql(runtime, `UPDATE runners SET removed_at = now()`)
    expect((await h.fetch(route(3), post({ links: [{ kind: "queue", ref: "q-9" }] }, asRunner))).status).toBe(401)
  })

  // Decision 0148, migration `0095_runner_reauthorization`: a runner token posts and reads only while its runner is current as a claim requires.
  test("a runner no registration through the repository's Admin role authorized, or without a recorded installation, posts and reads nothing until registered again", async () => {
    await seed()
    await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private, installation_id) VALUES ('${REPOSITORY.id}', 1, true, 42)`)
    await sql(runtime, `UPDATE runners SET repo_authorized_at = NULL`)
    const h = await githubHarness(runtime, { actor: null })
    const links = () => h.fetch(route(3), post({ links: [{ kind: "queue", ref: "q-9", state: "queued" }] }, asRunner))
    const legacy = await links()
    expect([legacy.status, await legacy.json()]).toEqual([403, { code: "not_authorized" }])
    expect((await h.fetch(list, { headers: asRunner })).status).toBe(401)
    expect(await sql(runtime, `SELECT source FROM work_links`)).toEqual([])
    // Registered again by an Admin, with the same token's SHA-256.
    await runtime.runPromise(Store.addRunner({
      repoId: REPOSITORY.id, name: "lane-host", tokenSha256: digestSync(RUNNER_TOKEN), labels: [], capacity: 1, repoAuthorized: true,
    }, { actorId: "person-admin", invocationKey: crypto.randomUUID() }))
    expect((await links()).status).toBe(200)
    expect((await h.fetch(list, { headers: asRunner })).status).toBe(200)
    // The installation forgotten: refused again.
    await sql(runtime, `UPDATE github_repositories SET installation_id = NULL`)
    expect((await links()).status).toBe(403)
    expect((await h.fetch(list, { headers: asRunner })).status).toBe(401)
  })

  // Astra's review of f42f8b6b: the runner was authorized before its body arrived, and the write didn't check it again,
  // so a body held open past a revocation still wrote.
  test("a runner whose authorization is cleared while its body arrives writes nothing", async () => {
    await seed()
    await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private, installation_id) VALUES ('${REPOSITORY.id}', 1, true, 42)`)
    const h = await githubHarness(runtime, { actor: null })
    let finish = () => {}
    const finished = new Promise<void>((done) => (finish = done))
    const encoder = new TextEncoder()
    const text = JSON.stringify({ links: [{ kind: "queue", ref: "q-late", state: "queued" }] })
    let sentHead = false
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sentHead) {
          sentHead = true
          controller.enqueue(encoder.encode(text.slice(0, 5)))
          return
        }
        await finished
        controller.enqueue(encoder.encode(text.slice(5)))
        controller.close()
      },
    })
    const posting = h.fetch(route(3), { method: "POST", headers: { "content-type": "application/json", ...asRunner }, body, duplex: "half" } as RequestInit)
    await new Promise((done) => setTimeout(done, 300))
    await sql(runtime, `UPDATE runners SET repo_authorized_at = NULL`)
    finish()
    const answer = await posting
    expect([answer.status, await answer.json()]).toEqual([403, { code: "not_authorized" }])
    expect(await sql(runtime, `SELECT source FROM work_links`)).toEqual([])
  })

  test("filters the list to issues whose work reaches a pull request or a queue entry, or that have any link", async () => {
    await seed()
    const h = await githubHarness(runtime)
    await h.fetch(route(1), post({ links: [{ kind: "pr", ref: "5", state: "open" }] }))
    await h.fetch(route(2), post({ links: [{ kind: "assignee", ref: "maya" }] }))
    const numbers = async (query: string) => ((await (await h.fetch(`${list}?${query}`)).json()) as Array<Listed>).map((issue) => issue.number)
    expect(await numbers("work=pr-or-queue")).toEqual([1])
    expect(await numbers("work=any")).toEqual([1, 2])
    expect((await h.fetch(`${list}?work=everything`)).status).toBe(400)
  })

  test("refuses what it can't take, and who may not post", async () => {
    await seed()
    const h = await githubHarness(runtime)
    const answer = async (response: Response) => [response.status, response.status === 405 ? null : await response.json()]
    expect(await answer(await h.fetch(route(1)))).toEqual([405, null])
    for (const body of ["{", { links: [] }, { links: [{ kind: "elsewhere", ref: "x" }] }, { links: [{ kind: "pr", ref: " " }] },
      { links: [{ kind: "pr", ref: "1", url: "http://insecure.test/1" }] }, { links: [{ kind: "pr", ref: "1", url: "not a url" }] },
      { links: [{ kind: "pr", ref: "1", url: `https://example.test/${"a".repeat(2000)}` }] },
      { links: [{ kind: "pr", ref: "1", at: "yesterday" }] }, { links: [{ kind: "pr", ref: "1", at: "2999-01-01T00:00:00Z" }] },
      { links: Array.from({ length: MAX_LINKS_PER_POST + 1 }, (_, i) => ({ kind: "pr", ref: String(i) })) }]) {
      expect(await answer(await h.fetch(route(1), post(body)))).toEqual([400, { code: "invalid" }])
    }
    expect(await answer(await h.fetch(route(1), post("x".repeat(MAX_POST_BYTES + 1))))).toEqual([413, { code: "too_large" }])
    const guest = await githubHarness(runtime, { actor: { ...member(), role: "guest" } })
    expect(await answer(await guest.fetch(route(1), post({ links: [{ kind: "pr", ref: "1" }] })))).toEqual([403, { code: "forbidden" }])
    const elsewhere = await githubHarness(runtime, { allowed: new Set(["github/acme/home"]) })
    expect(await answer(await elsewhere.fetch(workLinksRoute("acme", "gadgets", 1), post({ links: [{ kind: "pr", ref: "1" }] }))))
      .toEqual([404, { code: "not_found" }])
    const sessionsDown = await githubHarness(runtime, {
      sessions: Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) })),
    })
    expect(await answer(await sessionsDown.fetch(route(1), post({ links: [{ kind: "pr", ref: "1" }] })))).toEqual([503, { code: "unavailable" }])
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const offline = await githubHarness(runtime, { database: unreachable })
    expect(await answer(await offline.fetch(route(1), post({ links: [{ kind: "pr", ref: "1" }] })))).toEqual([503, { code: "unavailable" }])
    const runnerOffline = await githubHarness(runtime, { actor: null, database: unreachable })
    expect(await answer(await runnerOffline.fetch(route(1), post({ links: [{ kind: "pr", ref: "1" }] }, asRunner)))).toEqual([503, { code: "unavailable" }])
    expect(h.count(Metrics.workLinkPosts, { outcome: "invalid", by: "person" })).toBe(10)
    // Bytes that aren't UTF-8 are no post.
    const bytes = { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0xff, 0xfe]) }
    expect(await answer(await h.fetch(route(1), bytes))).toEqual([400, { code: "invalid" }])
    // GitHub can't say the poster's role now: its refusal, with its wait.
    const busy = await githubHarness(runtime, {
      roles: { repository: REPOSITORY, resolve: () => Effect.fail(new RepoRoles.RoleRefused({ code: "rate_limited", retryAfterSeconds: 30 })) },
    })
    const limited = await busy.fetch(route(1), post({ links: [{ kind: "pr", ref: "1" }] }))
    expect([limited.status, limited.headers.get("retry-after"), await limited.json()]).toEqual([429, "30", { code: "rate_limited" }])
    // A runner's read with Postgres down: the shapes' refusal stands.
    const listOffline = await githubHarness(runtime, { actor: null, database: unreachable })
    expect((await listOffline.fetch(list, { headers: asRunner })).status).toBe(503)
  })

  test("syncs a repository's links through its shape, to whom may read its issues", async () => {
    await seed()
    const h = await githubHarness(runtime)
    await h.fetch(route(1), post({ links: [{ kind: "pr", ref: "5", state: "open" }] }))
    const response = await h.fetch(`${WORK_LINKS_SHAPE_ROUTE}?offset=-1`)
    expect([response.status, response.status === 200 ? "" : await response.clone().text()]).toEqual([200, ""])
    const rows = ((await response.json()) as Array<{ value?: Record<string, unknown> }>).flatMap((row) => row.value === undefined ? [] : [row.value])
    expect(rows).toEqual([expect.objectContaining({ id: `${REPOSITORY.id}#1/pr/5`, number: "1", kind: "pr", state: "open" })])
    await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('${REPOSITORY.id}', 1, true)`)
    const visitor = await githubHarness(runtime, { actor: null })
    expect((await visitor.fetch(`${WORK_LINKS_SHAPE_ROUTE}?offset=-1`)).status).toBe(401)
  })
})
