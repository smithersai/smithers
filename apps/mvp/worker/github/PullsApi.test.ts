// The pull request routes (worker/github/Api.ts, docs/features/pulls.md#routes) through their real handler, over this
// file's schema of the compose Postgres and Electric (`pnpm db:up`), with remote flows recorded or run on the Node host
// against the scripted GitHub (worker/github/test/harness.ts): the merge write, which only a Maintainer's own press
// admits, the pull request webhooks, the compare route, and the shapes.
import { Effect, Logger, Option, Redacted } from "effect"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ShapeSource } from "@smthrs/effect-electric"
import { HttpClient } from "effect/http"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { ACTIONS_SHAPE_ROUTE } from "../../src/features/actions/contract.ts"
import { applyExecutionId, GITHUB_WEBHOOK_ROUTE, itemId, writesRoute } from "../../src/features/issues/contract.ts"
import {
  CHECKS_SHAPE_ROUTE,
  compareRoute,
  mergeExecutionId,
  PULL_COMMITS_SHAPE_ROUTE,
  PULLS_SHAPE_ROUTE,
  PULL_RECEIPT_HEADER,
  REVIEWS_SHAPE_ROUTE,
} from "../../src/features/pulls/contract.ts"
import * as Actor from "../Actor.ts"
import * as RepoRuns from "../RepoRuns.ts"
import * as Database from "../../db/Database.ts"
import { FlowStarter, StartUnavailable } from "../Flows.ts"
import * as PullRefresh from "./PullRefresh.ts"
import { refreshingSource } from "../../src/features/pulls/refresh.ts"
import { PullsView, VIEW } from "../../src/features/pulls/schema.ts"
import { testFile } from "../test/harness.ts"
import { handles } from "./Api.ts"
import { withToken } from "./Calls.ts"
import * as Compare from "./Compare.ts"
import * as Reconcile from "./Reconcile.ts"
import { runFlow } from "../test/flowHost.ts"
import * as RepoRoles from "./RepoRoles.ts"
import { fetchPull, projectPull, pullCurrent, REVIEW_PAGES, reviewStream, upsertPull } from "./Pulls.ts"
import { REPOSITORY, reset, services, signedIn, sql } from "./test/fixtures.ts"
import { app, delivery, githubHarness, member } from "./test/harness.ts"
import { appKey, BOT_LOGIN, scriptedGitHub } from "./test/scriptedGitHub.ts"

const runtime = testFile("github_pulls_api")

beforeAll(async () => {
  const health = `${await runtime.runPromise(TestDatabase.electricUrl)}/v1/health`
  const response = await fetch(health).catch((error: unknown) => {
    throw TestDatabase.explain("Electric", new URL(health).host)(error)
  })
  if (!response.ok) throw new Error(`Electric answered ${response.status} to ${health}`)
})

beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE pulls, pull_commits, reviews, runs")
})

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)

const merge = (overrides: Record<string, unknown> = {}) => ({
  writeId: crypto.randomUUID(),
  op: "pr/merge",
  number: 2,
  headSha: SHA_A,
  baseSha: SHA_B,
  ...overrides,
})

const maintainer = (): Actor.Actor => ({ ...member(), role: "maintainer" })

describe("a merge through the writes route", () => {
  test("a Maintainer's own press: recorded with their session, squash by default, pr/Merge started under its id", async () => {
    const actor = maintainer()
    const h = await githubHarness(runtime, { actor })
    const write = merge()
    const response = await h.fetch(writesRoute("acme", "widgets"), post(write))
    expect(response.status).toBe(202)
    expect(h.starts).toEqual([
      { flow: "pr/Merge", executionId: mergeExecutionId(write.writeId), payload: { writeId: write.writeId } },
    ])
    expect(await sql(runtime, `SELECT via, op, payload, session_id::text AS "sessionId" FROM github_writes`)).toEqual([
      {
        via: "person",
        op: "pr/merge",
        payload: { op: "pr/merge", number: 2, headSha: SHA_A, baseSha: SHA_B, method: "squash" },
        sessionId: actor.session,
      },
    ])
  })

  test.each([
    ["a Member", { ...member(), role: "member" as const }, 403, "forbidden"],
    ["a Guest", { ...member(), role: "guest" as const }, 403, "forbidden"],
    ["the agent acting for a Maintainer", { ...maintainer(), act: { kind: "agent" as const, id: "answer-1" } }, 403, "forbidden"],
    ["a flow acting for a Maintainer", { ...maintainer(), act: { kind: "flow" as const, id: "todo:1" } }, 403, "forbidden"],
    ["a Maintainer with no session", { subject: { kind: "person" as const, id: "dev" }, role: "maintainer" as const }, 401, "authentication"],
  ])("refuses %s: %i %s, nothing recorded or started", async (_, actor, status, code) => {
    const h = await githubHarness(runtime, { actor: actor as Actor.Actor })
    const response = await h.fetch(writesRoute("acme", "widgets"), post(merge()))
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ code })
    expect(h.starts).toEqual([])
    expect(await sql(runtime, `SELECT * FROM github_writes`)).toEqual([])
  })

  test("refuses a SHA that isn't one, and a method GitHub doesn't name", async () => {
    const h = await githubHarness(runtime, { actor: maintainer() })
    for (const write of [merge({ headSha: "abc" }), merge({ baseSha: SHA_A.toUpperCase() }), merge({ method: "fast" })]) {
      expect((await h.fetch(writesRoute("acme", "widgets"), post(write))).status).toBe(400)
    }
    expect(h.starts).toEqual([])
  })

  test("end to end on the Node host: the Maintainer's merge reaches GitHub as them and the pull request reads merged", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const baseSha = github.refs.get("main")!
    const headSha = github.push("smithers/t1", { "README.md": "# Widgets\n\nA line\n" })
    const pull = github.openPull("smithers/t1", "T1", BOT_LOGIN)
    const person = await signedIn(runtime, { login: "maya", token: github.userToken("maya"), role: "maintainer" })
    const actor: Actor.Actor = {
      subject: { kind: "person", id: person.personId },
      role: "maintainer",
      session: person.sessionId,
    }
    const h = await githubHarness(runtime, { actor, github, run: true })
    const response = await h.fetch(writesRoute("acme", "widgets"), post(merge({ number: pull.number, headSha, baseSha })))
    expect(response.status).toBe(202)
    await h.settled()
    expect([pull.merged, pull.mergedBy]).toEqual([true, "maya"])
    expect(await sql(runtime, `SELECT number, merged FROM pulls`)).toEqual([{ number: pull.number, merged: true }])
  })
})

describe("pull request webhooks", () => {
  test("pull_request and pull_request_review deliveries start github/Apply for their pull request", async () => {
    const h = await githubHarness(runtime)
    const opened = crypto.randomUUID()
    const reviewed = crypto.randomUUID()
    const payload = { action: "opened", repository: { full_name: "acme/widgets" }, pull_request: { number: 4 } }
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("pull_request", payload, { id: opened }))).status).toBe(200)
    expect(
      (await h.fetch(
        GITHUB_WEBHOOK_ROUTE,
        await delivery("pull_request_review", { ...payload, action: "submitted" }, { id: reviewed }),
      )).status,
    ).toBe(200)
    expect(h.starts).toEqual([
      {
        flow: "github/Apply",
        executionId: applyExecutionId(opened),
        payload: { deliveryId: opened, repo: "acme/widgets", number: 4, event: "pull_request" },
      },
      {
        flow: "github/Apply",
        executionId: applyExecutionId(reviewed),
        payload: { deliveryId: reviewed, repo: "acme/widgets", number: 4, event: "pull_request_review" },
      },
    ])
  })

  test("Apply reads the pull request with its commits and reviews into the projection", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const head = github.push("feature", { "A.md": "a\n" })
    const pull = github.openPull("feature", "Add A")
    pull.reviews.push({ id: 900, login: "ben", event: "COMMENT", body: "Looks fine.", commitId: head, at: Date.now() })
    const h = await githubHarness(runtime, { github, run: true })
    const payload = { action: "synchronize", repository: { full_name: "acme/widgets" }, pull_request: { number: pull.number } }
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("pull_request", payload))
    await h.settled()
    expect(await sql(runtime, `SELECT kind, title FROM items`)).toEqual([{ kind: "pull", title: "Add A" }])
    expect(
      await sql(
        runtime,
        `SELECT head_ref AS "headRef", head_sha AS "headSha", default_branch AS "defaultBranch", changed_files AS "files"
           FROM pulls`,
      ),
    ).toEqual([{ headRef: "feature", headSha: head, defaultBranch: "main", files: 1 }])
    expect(await sql(runtime, `SELECT sha FROM pull_commits`)).toEqual([{ sha: head }])
    expect(await sql(runtime, `SELECT author_login AS "author", state, body FROM reviews`)).toEqual([
      { author: "ben", state: "COMMENTED", body: "Looks fine." },
    ])
    // Read again, nothing changes: the guard and the commits' comparison write nothing.
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("pull_request", payload))
    await h.settled()
    expect(await sql(runtime, `SELECT count(*)::int AS n FROM pull_commits`)).toEqual([{ n: 1 }])
  })

  test.each([300, 301, 601])("Apply projects all %i reviews across durable rounds, including a later edit beyond page three", async (count) => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const head = github.push("feature", { "A.md": "a\n" })
    const pull = github.openPull("feature", "Add A")
    const at = Date.now()
    for (let index = 1; index <= count; index += 1) {
      const newest = index === count
      pull.reviews.push({
        id: 1_000 + index,
        login: newest ? "maya" : "ben",
        event: newest ? "APPROVE" : "COMMENT",
        body: newest ? "Ship it." : `Round ${index}.`,
        commitId: head,
        at: at + index * 1_000,
      })
    }
    if (count === 301) {
      let reads = 0
      github.faults.push({
        match: (method, path) => method === "GET" && path.endsWith("/reviews") && ++reads === 4,
        status: 502,
      })
    }
    const h = await githubHarness(runtime, { github, run: true })
    const payload = { action: "submitted", repository: { full_name: "acme/widgets" }, pull_request: { number: pull.number } }
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("pull_request_review", payload))
    await h.settled()
    expect(await sql(runtime, `SELECT count(*)::int AS n FROM reviews`)).toEqual([{ n: count }])
    expect(await sql(runtime, `SELECT author_login AS "author", state, body FROM reviews ORDER BY submitted_at DESC LIMIT 1`))
      .toEqual([{ author: "maya", state: "APPROVED", body: "Ship it." }])
    expect(await sql(runtime, `SELECT cursor FROM github_sync WHERE stream = 'pull-reviews/${pull.number}'`)).toEqual([{ cursor: null }])
    // A later delivery must start a fresh walk and update a review in the tail.
    pull.reviews[count - 1] = { ...pull.reviews[count - 1]!, event: "REQUEST_CHANGES", body: "Please revise." }
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("pull_request_review", { ...payload, action: "edited" }))
    await h.settled()
    expect(await sql(runtime, `SELECT state, body FROM reviews WHERE author_login = 'maya'`))
      .toEqual([{ state: "CHANGES_REQUESTED", body: "Please revise." }])
    expect(h.logs.filter((log) => log.message === "github.pull.reviews").map((log) => log.annotations["count"]))
      .toEqual([...Array.from({ length: Math.ceil(count / 300) }, (_, index) => Math.min(300, count - index * 300)),
        ...Array.from({ length: Math.ceil(count / 300) }, (_, index) => Math.min(300, count - index * 300))])
  })

  test("a review cursor commits with its projection and a fresh read resumes it after a stopped run", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const head = github.push("feature", { "A.md": "a\n" })
    const pull = github.openPull("feature", "Add A")
    const walked = REVIEW_PAGES * 100
    const at = Date.now()
    for (let index = 1; index <= walked + 1; index += 1) {
      pull.reviews.push({ id: 1_000 + index, login: "ben", event: "COMMENT", body: `Round ${index}.`, commitId: head, at: at + index * 1_000 })
    }
    const { services: built } = await services(runtime, github)
    const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const fetched = await runtime.runPromise(Effect.gen(function* () {
      const token = yield* built.tokens.forInstallation(REPOSITORY, "pulls")
      return yield* fetchPull(REPOSITORY, pull.number).pipe(withToken(token, built.apiBaseUrl))
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, built.http),
      Effect.provide(built.database),
      Effect.provide(Logger.layer([Logger.make((log) => void logs.push(StructuredLogger.formatStructured.log(log)))])),
    ))
    if (fetched.kind !== "found") throw new Error("missing pull")
    expect(fetched.reviews).toHaveLength(walked)
    expect(fetched.reviewsNext).toMatch(/page=4/)
    await runtime.runPromise(projectPull(REPOSITORY, pull.number, fetched))
    expect(await runtime.runPromise(pullCurrent(REPOSITORY.id, fetched.issue.issue))).toBe(false)
    expect(await sql(runtime, `SELECT complete FROM github_sync WHERE stream = '${reviewStream(pull.number)}'`))
      .toEqual([{ complete: false }])
    const tail = await runtime.runPromise(Effect.gen(function* () {
      const token = yield* built.tokens.forInstallation(REPOSITORY, "pulls")
      return yield* fetchPull(REPOSITORY, pull.number).pipe(withToken(token, built.apiBaseUrl))
    }).pipe(Effect.provideService(HttpClient.HttpClient, built.http), Effect.provide(built.database)))
    if (tail.kind !== "found") throw new Error("missing pull")
    expect(tail.reviews.map((review) => review.id)).toEqual([1_000 + walked + 1])
    expect(tail.reviewsNext).toBeNull()
    await runtime.runPromise(projectPull(REPOSITORY, pull.number, tail))
    expect(await runtime.runPromise(pullCurrent(REPOSITORY.id, tail.issue.issue))).toBe(true)
    expect(await sql(runtime, `SELECT complete FROM github_sync WHERE stream = '${reviewStream(pull.number)}'`))
      .toEqual([{ complete: true }])
    expect(await sql(runtime, `SELECT count(*)::int AS n FROM reviews`)).toEqual([{ n: walked + 1 }])
    // A stale projection must not put the earlier cursor back.
    await runtime.runPromise(projectPull(REPOSITORY, pull.number, fetched))
    expect(await sql(runtime, `SELECT cursor FROM github_sync WHERE stream = '${reviewStream(pull.number)}'`))
      .toEqual([{ cursor: null }])
    // A new delivery starts at page one even if another run left a pending cursor.
    await runtime.runPromise(projectPull(REPOSITORY, pull.number, { ...fetched, fetchedAt: tail.fetchedAt + 1 }))
    pull.reviews[0] = { ...pull.reviews[0]!, body: "Edited while the earlier walk was stopped." }
    const h = await githubHarness(runtime, { github, run: true })
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("pull_request_review", {
      action: "edited", repository: { full_name: "acme/widgets" }, pull_request: { number: pull.number },
    }))
    await h.settled()
    expect(await sql(runtime, `SELECT body FROM reviews WHERE id LIKE '%/review/1001'`))
      .toEqual([{ body: "Edited while the earlier walk was stopped." }])
    // Never a body or a login: the repository, the number and how far the read walked.
    expect(logs.filter((log) => log.message === "github.pull.reviews").map((log) => log.annotations)).toEqual([
      expect.objectContaining({ repoId: REPOSITORY.id, number: pull.number, outcome: "partial", count: walked }),
    ])
  })

  test("Reconcile finishes a pull's review tail before advancing past it to a newer issue", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const head = github.push("feature", { "A.md": "a" })
    const pull = github.openPull("feature")
    for (let index = 1; index <= 301; index += 1) {
      pull.reviews.push({ id: 1_000 + index, login: "maya", event: "COMMENT", body: `Round ${index}`, commitId: head, at: Date.now() + index * 1000 })
    }
    github.open("A newer issue", "Moves the issue-list cursor past the pull.")
    const { services: built } = await services(runtime, github)
    const ran = await runFlow(Reconcile.Reconcile,
      { repo: "acme/widgets", requestedAtMs: Date.now() },
      Reconcile.registration(built), { maxConnections: 3 },
    )
    expect(ran.exit).toMatchObject({ _tag: "Success", value: { outcome: "complete" } })
    expect(await sql(runtime, "SELECT count(*)::int AS n FROM reviews")).toEqual([{ n: 301 }])
    expect(await sql(runtime, "SELECT cursor, complete FROM github_sync WHERE stream LIKE 'pull-reviews/%'"))
      .toEqual([{ cursor: null, complete: true }])
  })

  test("a pull request whose answer leaves out its base repository keeps no default branch (ruling GH-9)", async () => {
    const at = "2026-10-21T00:00:00Z"
    const pull = {
      id: 7_002,
      node_id: "PR_2",
      number: 2,
      title: "T2",
      body: null,
      state: "open" as const,
      draft: false,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      merged_by: null,
      mergeable_state: "clean",
      user: null,
      head: { ref: "feature", sha: SHA_A },
      base: { ref: "main", sha: SHA_B, repo: null },
      commits: 1,
      additions: 1,
      deletions: 0,
      changed_files: 1,
      created_at: at,
      updated_at: at,
      closed_at: null,
    }
    expect(await runtime.runPromise(upsertPull(REPOSITORY.id, pull, pull.base.sha, Date.now()))).toBe(true)
    expect(await sql(runtime, `SELECT base_ref AS "baseRef", default_branch AS "defaultBranch" FROM pulls`)).toEqual([
      { baseRef: "main", defaultBranch: null },
    ])
    // A later read that names it is a change, and the row takes it.
    const named = { ...pull, base: { ...pull.base, repo: { default_branch: "main" } } }
    expect(await runtime.runPromise(upsertPull(REPOSITORY.id, named, named.base.sha, Date.now() + 1_000))).toBe(true)
    expect(await sql(runtime, `SELECT default_branch AS "defaultBranch" FROM pulls`)).toEqual([{ defaultBranch: "main" }])
  })

  test("a pull request GitHub no longer has is tombstoned, as an issue is", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("feature", { "A.md": "a\n" })
    const pull = github.openPull("feature", "Add A")
    const h = await githubHarness(runtime, { github, run: true })
    const payload = { action: "opened", repository: { full_name: "acme/widgets" }, pull_request: { number: pull.number } }
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("pull_request", payload))
    await h.settled()
    github.remove(pull.number)
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("pull_request", { ...payload, action: "closed" }))
    await h.settled()
    expect(await sql(runtime, `SELECT kind, deleted_at IS NOT NULL AS gone FROM items`)).toEqual([{ kind: "pull", gone: true }])
  })

  test("a commit and a review by no account project with no author", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const head = github.push("feature", { "A.md": "a\n" })
    github.commits.set(head, { ...github.commits.get(head)!, login: null })
    const pull = github.openPull("feature", "Add A")
    pull.reviews.push({ id: 901, login: null, event: "COMMENT", body: "Fine.", commitId: head, at: Date.now() })
    const h = await githubHarness(runtime, { github, run: true })
    const payload = { action: "synchronize", repository: { full_name: "acme/widgets" }, pull_request: { number: pull.number } }
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("pull_request", payload))
    await h.settled()
    expect(await sql(runtime, `SELECT sha, author_login AS "author", authored_at AS "at" FROM pull_commits`))
      .toEqual([{ sha: head, author: null, at: null }])
    expect(await sql(runtime, `SELECT author_login AS "author", body FROM reviews`)).toEqual([{ author: null, body: "Fine." }])
  })
})

describe("GET .../compare/<base>...<head>", () => {
  test("a person with a role reads the files without allowing HTTP caching", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const base = github.refs.get("main")!
    const head = github.push("feature", { "README.md": "# Widgets\n\nA line\n" })
    const h = await githubHarness(runtime, { github, app: app({ privateKey: await appKey() }) })
    const response = await h.fetch(compareRoute("acme", "widgets", base, head))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const body = await response.json() as {
      files: Array<{ filename: string; status: string; patch: string }>
      truncated: boolean
      commits: Array<{ sha: string; headline: string }>
      commitsTruncated: boolean
    }
    expect(body.truncated).toBe(false)
    expect([body.commits.map((commit) => commit.sha), body.commitsTruncated]).toEqual([[head], false])
    expect(body.files.map((file) => [file.filename, file.status])).toEqual([["README.md", "modified"]])
    expect(body.files[0]!.patch).toContain("+A line")
  })

  test("refusals: no such commits 404, a repository the deployment doesn't act on 404, signed out 401, no App 503, another method 405", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const base = github.refs.get("main")!
    const h = await githubHarness(runtime, { github, app: app({ privateKey: await appKey() }) })
    expect((await h.fetch(compareRoute("acme", "widgets", base, SHA_A))).status).toBe(404)
    // A repository the person has no role on, and GitHub doesn't call public, is refused as the shapes refuse it.
    expect((await h.fetch(compareRoute("someone", "else", base, base))).status).toBe(403)
    expect((await h.fetch(`/api/repos/-bad/else/compare/${base}...${base}`)).status).toBe(404)
    // GITHUB_ALLOWED_REPOSITORIES leaves someone/else out (decision 0079).
    const narrowed = await githubHarness(runtime, { github, app: app({ privateKey: await appKey() }), allowed: new Set([REPOSITORY.id]) })
    expect((await narrowed.fetch(compareRoute("someone", "else", base, base))).status).toBe(404)
    expect((await h.fetch(compareRoute("acme", "widgets", base, base), { method: "POST" })).status).toBe(405)
    const signedOut = await githubHarness(runtime, { github, actor: null, app: app({ privateKey: await appKey() }) })
    expect((await signedOut.fetch(compareRoute("acme", "widgets", base, base))).status).toBe(401)
    const noApp = await githubHarness(runtime, { github, app: null })
    expect((await noApp.fetch(compareRoute("acme", "widgets", base, base))).status).toBe(503)
    github.installed = false
    expect((await h.fetch(compareRoute("acme", "widgets", base, base))).status).toBe(503)
  })

  test("a compare whose provider dies returns 503 without a partial diff", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const base = github.refs.get("main")!
    const http = HttpClient.make(() => Effect.die("provider defect"))
    const h = await githubHarness(runtime, { github: { ...github, http }, app: app({ privateKey: await appKey() }) })
    const response = await h.fetch(compareRoute("acme", "widgets", base, SHA_A))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: "unavailable" })
  })

  test("the route's paths: two SHAs, nothing else", () => {
    expect(handles(compareRoute("acme", "widgets", SHA_A, SHA_B))).toBe(true)
    expect(handles(`/api/repos/acme/widgets/compare/main...${SHA_B}`)).toBe(false)
    expect(handles(`/api/repos/acme/widgets/compare/${SHA_A}`)).toBe(false)
    expect(handles(`/api/repos/acme/widgets/compare/${SHA_A}...${SHA_B}/x`)).toBe(false)
    expect(handles(`/api/repos/%E0%A4%A/widgets/compare/${SHA_A}...${SHA_B}`)).toBe(false)
    expect(Compare.parseComparePath("/api/shapes/pulls")).toBeUndefined()
  })

  test("without a client the route reads GitHub with fetch: GitHub out of reach is 503 unavailable", async () => {
    const unreachable = app({ privateKey: await appKey(), apiBaseUrl: "http://127.0.0.1:1" })
    const response = await runtime.runPromise(Effect.gen(function* () {
      const { database } = yield* TestDatabase.Scratch
      const route = yield* Compare.make(unreachable)
      return yield* route(REPOSITORY, SHA_A, SHA_B).pipe(Effect.provide(database))
    }))
    expect(response.status).toBe(503)
  })
})

describe("the repository's runs", () => {
  test("the actions shape selects the requested repository and its role, never the deployment's rows", async () => {
    const reader = crypto.randomUUID()
    const actor = member(reader)
    const h = await githubHarness(runtime, { actor })
    await runtime.runPromise(RepoRuns.record({
      execution: "ci:second-delivery", repoId: "github/elsewhere/project", flow: "ci",
      sha: "d".repeat(40), ref: "main", event: "push", launchedBy: "github",
    }))
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role)
      VALUES ('github/elsewhere/project', '${reader}', 'member')`)
    const response = await h.fetch(`${ACTIONS_SHAPE_ROUTE}?repo=elsewhere%2Fproject&offset=-1`)
    expect(response.status).toBe(200)
    const messages = await response.json() as Array<{ value?: { execution: string; repo_id: string } }>
    expect(messages.flatMap(({ value }) => value === undefined ? [] : [[value.execution, value.repo_id]]))
      .toEqual([["ci:second-delivery", "github/elsewhere/project"]])
    await sql(runtime, `UPDATE github_repo_roles SET role = NULL WHERE repo_id = 'github/elsewhere/project'`)
    expect((await h.fetch(`${ACTIONS_SHAPE_ROUTE}?repo=elsewhere%2Fproject&offset=-1`)).status).toBe(403)
    for (const repo of ["", "owner", "owner/name/extra", "owner/..", "api/repo"]) {
      expect((await h.fetch(`${ACTIONS_SHAPE_ROUTE}?repo=${encodeURIComponent(repo)}&offset=-1`)).status).toBe(400)
    }
  })

  test.each(["unavailable", "rate_limited", "not_found"] as const)("the actions shape refuses a repository role failure %s before contacting Electric", async (code) => {
    const h = await githubHarness(runtime, { roles: {
      repository: REPOSITORY,
      resolve: () => Effect.fail(new RepoRoles.RoleRefused({ code })),
    } })
    const response = await h.fetch(`${ACTIONS_SHAPE_ROUTE}?repo=elsewhere%2Fproject&offset=-1`)
    expect(response.status).toBe(code === "not_found" ? 403 : 503)
  })

  test("the actions shape carries its flows' runs and the Checks shape its checks, never who launched one", async () => {
    await sql(runtime, `DELETE FROM runs WHERE repo_id = '${REPOSITORY.id}'`)
    await runtime.runPromise(RepoRuns.record({
      execution: "ci:delivery-1",
      repoId: REPOSITORY.id,
      flow: "ci",
      sha: "c".repeat(40),
      ref: "main",
      event: "push",
      launchedBy: "github",
    }))
    await sql(runtime, `
      INSERT INTO runs (id, flow, status, launched_by, repo_id, sha)
      VALUES ('${crypto.randomUUID()}', 'check/lint', 'working', 'person-1', '${REPOSITORY.id}', '${"c".repeat(40)}')`)
    const h = await githubHarness(runtime)
    const rows = async (route: string) => {
      const response = await h.fetch(`${route}?offset=-1`)
      const messages = (await response.json()) as Array<{ value?: Record<string, unknown> }>
      return messages.flatMap((message) => (message.value === undefined ? [] : [message.value]))
    }
    const actions = await rows(ACTIONS_SHAPE_ROUTE)
    expect(actions.map((row) => [row.execution, row.flow, row.status, row.event, row.ref])).toEqual([
      ["ci:delivery-1", "ci", "working", "push", "main"],
    ])
    expect(actions.every((row) => !("launched_by" in row))).toBe(true)
    expect((await rows(CHECKS_SHAPE_ROUTE)).map((row) => row.flow)).toEqual(["check/lint"])
  })
})

describe("the pull request shapes", () => {
  test("the browser's real shape adapter applies only its PR's fresh absence receipt", async () => {
    const h = await githubHarness(runtime)
    await sql(runtime, `INSERT INTO github_projection_fences(item_id, gone_at) VALUES ('${itemId(REPOSITORY.id, 42)}', now())`)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const view = yield* Collection.local({ id: "pull-refresh-test", schema: PullsView, getKey: (row) => row.id,
        initialData: [{ id: VIEW, owner: "acme", name: "widgets", repoId: REPOSITORY.id, number: 42, tab: "conversation" as const,
          merging: false, mergeWriteId: null, mergeRefused: null, reviewing: false, reviewNotice: null, installed: true,
          pullStatus: "allowed" as const }],
      })
      const source: ShapeSource.Source = { request: (url, init) => Effect.tryPromise({
        try: () => h.fetch(url, init), catch: () => new ShapeSource.RequestFailed({}),
      }) }
      const reader = refreshingSource(source, view, REPOSITORY.id)
      yield* reader.request(`http://app.test${REVIEWS_SHAPE_ROUTE}?offset=-1`, {})
      expect(Option.getOrThrow(yield* view.get(VIEW)).pullAbsent).toBe(true)
      yield* view.update(VIEW, (row) => { row.number = null })
      const noSubject = yield* reader.request(`http://app.test${REVIEWS_SHAPE_ROUTE}?offset=-1`, {})
      expect(noSubject.headers.has(PULL_RECEIPT_HEADER)).toBe(false)
      yield* view.update(VIEW, (row) => { row.repoId = "another"; row.number = 42 })
      expect((yield* reader.request(`http://app.test${REVIEWS_SHAPE_ROUTE}?offset=-1`, {})).headers.has(PULL_RECEIPT_HEADER)).toBe(false)
    })))
  })

  test.each(["failed", "stalled"] as const)("a %s durable admission never turns projection absence into deletion", async (failure) => {
    const h = await githubHarness(runtime, { starter: FlowStarter.of({ start: () => failure === "failed"
      ? Effect.fail(new StartUnavailable({ errorCode: "unreachable" })) : Effect.never }) })
    const response = await h.fetch(`${REVIEWS_SHAPE_ROUTE}?offset=-1&refresh=42`)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.headers.get(PULL_RECEIPT_HEADER)!)).toMatchObject({ missing: false })
    expect(h.count(PullRefresh.refreshes, { outcome: failure === "failed" ? "not_started" : "timed_out" })).toBe(1)
  })

  test("no configured App starts nothing; an unavailable receipt cannot prove deletion", async () => {
    const h = await githubHarness(runtime, { app: null })
    expect((await h.fetch(`${REVIEWS_SHAPE_ROUTE}?offset=-1&refresh=42`)).status).toBe(200)
    expect(h.starts).toEqual([])
    const unavailable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const reader = await Effect.runPromise(PullRefresh.make(unavailable, false, "1 second"))
    expect(JSON.parse(await Effect.runPromise(reader.receipt(REPOSITORY, 42)))).toMatchObject({ number: 42, missing: false })
  })
  test("a detail read recovers an existing PR missing from a completed projection, including its metadata", async () => {
    const h = await githubHarness(runtime, { run: true })
    h.github.refs.set("feature", h.github.refs.get("main")!)
    const pull = h.github.openPull("feature", "Recover the PR")
    const path = `${PULL_COMMITS_SHAPE_ROUTE}?offset=-1&refresh=${pull.number}`
    const response = await h.fetch(path)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.headers.get(PULL_RECEIPT_HEADER)!)).toMatchObject({ number: pull.number, missing: false })
    expect(h.starts.map((start) => start.flow)).toEqual(["github/Apply"])
    await h.settled()
    expect(await sql(runtime, `SELECT title FROM items WHERE number = ${pull.number}`)).toEqual([{ title: "Recover the PR" }])
    expect(await sql(runtime, `SELECT head_ref AS "head" FROM pulls WHERE number = ${pull.number}`)).toEqual([{ head: "feature" }])
    await h.fetch(path)
    expect(h.starts).toHaveLength(1)
  })

  test("only the selected item's authoritative absence is reported, and shape refusals never launch recovery", async () => {
    const h = await githubHarness(runtime)
    await sql(runtime, `INSERT INTO github_projection_fences(item_id, gone_at) VALUES ('${itemId(REPOSITORY.id, 42)}', now())`)
    // The existing per-item fence is keyed by the same canonical item id as the projection.
    const path = `${REVIEWS_SHAPE_ROUTE}?offset=-1&refresh=42`
    const response = await h.fetch(path)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.headers.get(PULL_RECEIPT_HEADER)!)).toMatchObject({ number: 42, missing: true })
    expect(h.starts).toHaveLength(1)
    for (const number of ["0", "-1", "1.2", "9007199254740992", "no"]) {
      expect((await h.fetch(`${REVIEWS_SHAPE_ROUTE}?offset=-1&refresh=${number}`)).status).toBe(400)
    }
    const visitor = await githubHarness(runtime, { actor: null })
    expect((await visitor.fetch(path)).status).toBe(401)
    expect(visitor.starts).toEqual([])
    await sql(runtime, `INSERT INTO items(id,repo_id,number,kind,github_id,title,body,state,created_at,updated_at,source_updated_at,fetched_at)
      VALUES ('${itemId(REPOSITORY.id, 42)}','${REPOSITORY.id}',42,'pull',42,'Restored','','open',now(),now(),now(),now()+interval '1 second')`)
    const restored = await h.fetch(path)
    expect(JSON.parse(restored.headers.get(PULL_RECEIPT_HEADER)!)).toMatchObject({ missing: false })
    expect(h.count(PullRefresh.receipts, { outcome: "missing" })).toBe(1)
    expect(h.count(PullRefresh.receipts, { outcome: "unproven" })).toBe(1)
    expect(h.line("pull.refresh.receipt").map((line) => line.annotations.missing)).toEqual([true, false])
  })
  test.each([PULLS_SHAPE_ROUTE, PULL_COMMITS_SHAPE_ROUTE, REVIEWS_SHAPE_ROUTE, CHECKS_SHAPE_ROUTE, ACTIONS_SHAPE_ROUTE])(
    "%s serves a person with a role, and refuses one signed out",
    async (route) => {
      const h = await githubHarness(runtime)
      const response = await h.fetch(`${route}?offset=-1`)
      expect(response.status).toBe(200)
      const signedOut = await githubHarness(runtime, { actor: null })
      expect((await signedOut.fetch(`${route}?offset=-1`)).status).toBe(401)
    },
  )
})
