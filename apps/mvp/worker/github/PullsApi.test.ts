// The pull request routes (worker/github/Api.ts, docs/features/pulls.md#routes) through their real handler, over this
// file's schema of the compose Postgres and Electric (`pnpm db:up`), with remote flows recorded or run on the Node host
// against the scripted GitHub (worker/github/test/harness.ts): the merge write, which only a Maintainer's own press
// admits, the pull request webhooks, the compare route, and the shapes.
import { Effect } from "effect"
import { HttpClient } from "effect/http"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { ACTIONS_SHAPE_ROUTE } from "../../src/features/actions/contract.ts"
import { applyExecutionId, GITHUB_WEBHOOK_ROUTE, writesRoute } from "../../src/features/issues/contract.ts"
import {
  CHECKS_SHAPE_ROUTE,
  compareRoute,
  mergeExecutionId,
  PULL_COMMITS_SHAPE_ROUTE,
  PULLS_SHAPE_ROUTE,
  REVIEWS_SHAPE_ROUTE,
} from "../../src/features/pulls/contract.ts"
import * as Actor from "../Actor.ts"
import * as RepoRuns from "../RepoRuns.ts"
import { testFile } from "../test/harness.ts"
import { handles } from "./Api.ts"
import * as Compare from "./Compare.ts"
import * as RepoRoles from "./RepoRoles.ts"
import { upsertPull } from "./Pulls.ts"
import { REPOSITORY, reset, signedIn, sql } from "./test/fixtures.ts"
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
    const person = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
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
  test("a person with a role reads the files two commits differ by, kept forever", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const base = github.refs.get("main")!
    const head = github.push("feature", { "README.md": "# Widgets\n\nA line\n" })
    const h = await githubHarness(runtime, { github, app: app({ privateKey: await appKey() }) })
    const response = await h.fetch(compareRoute("acme", "widgets", base, head))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")
    const body = await response.json() as { files: Array<{ filename: string; status: string; patch: string }>; truncated: boolean }
    expect(body.truncated).toBe(false)
    expect(body.files.map((file) => [file.filename, file.status])).toEqual([["README.md", "modified"]])
    expect(body.files[0]!.patch).toContain("+A line")
  })

  test("refusals: no such commits 404, another repository 404, signed out 401, no App 503, another method 405", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const base = github.refs.get("main")!
    const h = await githubHarness(runtime, { github, app: app({ privateKey: await appKey() }) })
    expect((await h.fetch(compareRoute("acme", "widgets", base, SHA_A))).status).toBe(404)
    expect((await h.fetch(compareRoute("someone", "else", base, base))).status).toBe(404)
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
    const actor = member("second-repo-reader")
    const h = await githubHarness(runtime, { actor })
    await runtime.runPromise(RepoRuns.record({
      execution: "ci:second-delivery", repoId: "github/elsewhere/project", flow: "ci",
      sha: "d".repeat(40), ref: "main", event: "push", launchedBy: "github",
    }))
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role)
      VALUES ('github/elsewhere/project', 'second-repo-reader', 'member')`)
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
