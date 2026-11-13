// The issue tree on the server (decision 0153, steps 3): GitHub's relations into server-only tables, in order, by the walk
// that works with no webhook; a tree's scope through authorized edges only; and what a reader receives, over the compose
// Postgres and Electric and the scripted GitHub. Only who has which role is scripted where a test says so.
import { Effect, Exit, Layer, Logger, Metric, Option } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { beforeEach, describe, expect, test } from "vitest"
import { GitHub } from "@smthrs/integrations"
import { digestSync } from "@smthrs/crypto"
import {
  ISSUE_EDGE_COLUMNS,
  ISSUE_EDGES_SHAPE_ROUTE,
  ITEM_SUMMARIES_SHAPE_ROUTE,
  RELATIONS_STREAM,
  treeScopeRoute,
  type TreeScope,
} from "../../src/features/issues/contract.ts"
import type { Role } from "../../src/features/auth/contract.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as Apply from "./Apply.ts"
import * as Metrics from "./Metrics.ts"
import * as MachineWrite from "./MachineWrite.ts"
import * as Relations from "./Relations.ts"
import * as RepoRoles from "./RepoRoles.ts"
import * as Store from "./Store.ts"
import { reset, services, sql } from "./test/fixtures.ts"
import { delivery, githubHarness, member } from "./test/harness.ts"
import { type ScriptedGitHub, scriptedGitHub } from "./test/scriptedGitHub.ts"

const runtime = testFile("github_issue_tree")

beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, `TRUNCATE repo_about`)
})

const API = "https://api.github.test/repos"
const issue = (number: number, fields: { readonly parent?: string | null; readonly total?: number } = {}): GitHub.Issues.Issue => ({
  id: 1000 + number,
  node_id: `I_${number}`,
  number,
  title: "T",
  body: null,
  state: "open",
  state_reason: null,
  user: null,
  labels: [],
  comments: 0,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  closed_at: null,
  sub_issues_summary: { total: fields.total ?? 0, completed: 0 },
  ...(fields.parent === undefined ? {} : { parent_issue_url: fields.parent }),
})

const edges = async () =>
  (await sql(runtime, `SELECT child_id AS child, parent_id AS parent FROM issue_relations ORDER BY child_id`)) as unknown as ReadonlyArray<{ child: string; parent: string }>

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const REPO = "github/acme/widgets"

describe("a relation's fence (issue_relation_seen)", () => {
  const at = (effect: Effect.Effect<unknown, unknown, import("effect/sql").SqlClient.SqlClient>) => runtime.runPromise(effect as never)
  const parent = `${API}/acme/widgets/issues/1`

  test("an issue states its parent, and a read that states none removes it", async () => {
    await at(Store.upsertRelation(REPO, issue(2, { parent }), 1_000))
    expect(await edges()).toEqual([{ child: `${REPO}#2`, parent: `${REPO}#1` }])
    await at(Store.upsertRelation(REPO, issue(2), 2_000))
    expect(await edges()).toEqual([])
  })

  test("an older 'parent = A' after a newer 'no parent' changes nothing", async () => {
    await at(Store.upsertRelation(REPO, issue(2, { parent: null }), 2_000))
    await at(Store.upsertRelation(REPO, issue(2, { parent }), 1_000))
    expect(await edges()).toEqual([])
  })

  test("the fence survives a tombstone: an older read after it changes nothing, a newer one says so", async () => {
    await at(Store.upsertIssue(REPO, issue(2, { parent }), 1_000))
    await at(Store.tombstoneIssue(REPO, 2, 2_000))
    expect(await edges()).toEqual([])
    await at(Store.upsertRelation(REPO, issue(2, { parent }), 1_500))
    await at(Store.upsertIssue(REPO, issue(2, { parent }), 1_500))
    expect(await edges()).toEqual([])
    await at(Store.upsertIssue(REPO, issue(2, { parent }), 3_000))
    expect(await edges()).toEqual([{ child: `${REPO}#2`, parent: `${REPO}#1` }])
  })

  test("a pull request or a summary-less object leaves the relation alone; a URL naming no issue is skipped", async () => {
    await at(Store.upsertRelation(REPO, issue(2, { parent }), 1_000))
    const { sub_issues_summary: _, ...silent } = issue(2)
    await at(Store.upsertRelation(REPO, silent, 2_000))
    await at(Store.upsertRelation(REPO, { ...issue(2), sub_issues_summary: null, parent_issue_url: null, pull_request: {} }, 3_000))
    expect(await edges()).toEqual([{ child: `${REPO}#2`, parent: `${REPO}#1` }])
    await at(Store.upsertRelation(REPO, issue(3, { parent: "https://example.test/not/an/issue" }), 1_000))
    await at(Store.upsertRelation(REPO, issue(4, { parent: `${API}/acme/widgets/issues/4` }), 1_000))
    expect((await edges()).map((edge) => edge.child)).toEqual([`${REPO}#2`])
  })

  test("re-reading the same parent leaves the row untouched, so no shape hears of it", async () => {
    await at(Store.upsertRelation(REPO, issue(2, { parent }), 1_000))
    const before = await sql(runtime, `SELECT xmin::text AS version FROM issue_relations`)
    await at(Store.upsertRelation(REPO, issue(2, { parent }), 2_000))
    expect(await sql(runtime, `SELECT xmin::text AS version FROM issue_relations`)).toEqual(before)
  })
})

const ofGitHub = (github: ScriptedGitHub, number: number, parent: number | null, bump?: boolean) =>
  github.setParent(number, parent === null ? null : { owner: github.owner, name: github.name, number: parent }, bump)

const flow = async (value: Awaited<ReturnType<typeof services>>["services"], pages?: number, parents?: number) =>
  runFlow(Relations.Relations, { repo: "acme/widgets", requestedAtMs: Date.now() }, Relations.registration(value, pages, parents), {
    executionId: `github-relations:test:${crypto.randomUUID()}`,
    maxConnections: 3,
  })

const syncRow = async () =>
  ((await sql(runtime, `SELECT complete, cursor IS NOT NULL AS cursored FROM github_sync WHERE stream = '${RELATIONS_STREAM}'`)) as unknown as ReadonlyArray<unknown>)[0]

describe("github/Relations", () => {
  test("walks every issue into edges without writing an item, and a relation change with no updated_at is seen", async () => {
    const github = scriptedGitHub()
    github.open("Parent", null)
    github.open("Child", null)
    const pull = github.open("A pull request", null)
    github.issues.set(pull.number, { ...pull, pull: true })
    ofGitHub(github, 2, 1)
    const { services: value } = await services(runtime, github)
    expect((await flow(value)).status).toBe("completed")
    expect(await edges()).toEqual([{ child: `${REPO}#2`, parent: `${REPO}#1` }])
    expect(await sql(runtime, `SELECT count(*)::int AS n FROM items`)).toEqual([{ n: 0 }])
    expect(await syncRow()).toEqual({ complete: true, cursored: false })
    const before = github.issues.get(2)!.updatedAt
    ofGitHub(github, 2, null)
    expect(github.issues.get(2)!.updatedAt).toBe(before)
    await flow(value)
    expect(await edges()).toEqual([])
  })

  test("a walk that runs out of pages is never complete, and the next continues from GitHub's cursor", async () => {
    const github = scriptedGitHub()
    for (let n = 0; n < 101; n++) github.open(`Issue ${n}`, null)
    ofGitHub(github, 101, 1)
    const { services: value } = await services(runtime, github)
    const step = Relations.walk(value, 1)
    expect(await run(step({ repo: "acme/widgets", requestedAtMs: Date.now() }))).toEqual({ outcome: "partial", pages: 1, skipped: 0 })
    expect(await syncRow()).toEqual({ complete: false, cursored: true })
    expect(await edges()).toEqual([])
    github.calls.length = 0
    expect(await run(step({ repo: "acme/widgets", requestedAtMs: Date.now() }))).toEqual({ outcome: "complete", pages: 1, skipped: 0 })
    expect(await syncRow()).toEqual({ complete: true, cursored: false })
    expect(await edges()).toEqual([{ child: `${REPO}#101`, parent: `${REPO}#1` }])
  })

  test("a request from a bucket long gone settles superseded, calling nothing", async () => {
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    expect(await run(Relations.walk(value)({ repo: "acme/widgets", requestedAtMs: Date.now() - 24 * 60 * 60_000 })))
      .toEqual({ outcome: "superseded", pages: 0, skipped: 0 })
    expect(github.calls).toEqual([])
    expect(await syncRow()).toBeUndefined()
  })

  test("verify finds a child in another repository through its parent's count, only where the deployment acts", async () => {
    const github = scriptedGitHub()
    github.open("Parent", null)
    const child = (number: number, repo: string) => ({
      ...issue(number, { parent: `${API}/acme/widgets/issues/1` }),
      repository_url: `${API}/${repo}`,
    })
    github.foreignChildren.set(1, [child(5, "acme/other"), child(6, "acme/elsewhere")])
    const { services: value } = await services(runtime, github, { mayAct: (id) => id !== "github/acme/elsewhere" })
    const walked = await flow(value)
    expect(walked.exit).toEqual(Exit.succeed({ compared: 1, skipped: 1 }))
    expect(await edges()).toEqual([{ child: "github/acme/other#5", parent: `${REPO}#1` }])
  })

  test("verify reads a child GitHub no longer lists under its parent, and its own read removes the edge", async () => {
    const github = scriptedGitHub()
    github.open("Parent", null)
    github.open("Other", null)
    github.open("Child", null)
    const { services: value } = await services(runtime, github)
    // The projection says #3 is #1's; GitHub says #1 has none now, so the counts disagree.
    await runtime.runPromise(Store.upsertRelation(REPO, issue(3, { parent: `${API}/acme/widgets/issues/1` }), Date.now() - 60_000) as never)
    const walked = await run(Relations.verify(value)({ repo: "acme/widgets", requestedAtMs: Date.now() })) // no complete walk yet
    expect(walked).toEqual({ compared: 0, skipped: 0 })
    await sql(runtime, `INSERT INTO github_sync (repo_id, stream, synced_at, complete) VALUES ('${REPO}', '${RELATIONS_STREAM}', now(), true)`)
    await sql(runtime, `INSERT INTO issue_child_counts (parent_id, repo_id, sub_total, sub_completed, observed_at) VALUES ('${REPO}#1', '${REPO}', 0, 0, now())`)
    expect(await run(Relations.verify(value)({ repo: "acme/widgets", requestedAtMs: Date.now() }))).toEqual({ compared: 1, skipped: 0 })
    expect(await edges()).toEqual([])
  })

  test("parents that stay in disagreement take turns, so they don't starve the rest", async () => {
    const github = scriptedGitHub()
    github.open("One", null)
    github.open("Two", null)
    const { services: value } = await services(runtime, github)
    await sql(runtime, `INSERT INTO github_sync (repo_id, stream, synced_at, complete) VALUES ('${REPO}', '${RELATIONS_STREAM}', now(), true)`)
    await sql(runtime, `INSERT INTO issue_child_counts (parent_id, repo_id, sub_total, sub_completed, observed_at) VALUES
      ('${REPO}#1', '${REPO}', 3, 0, now()), ('${REPO}#2', '${REPO}', 3, 0, now())`)
    const step = Relations.verify(value, 1)
    const asked = async () => {
      github.calls.length = 0
      await run(step({ repo: "acme/widgets", requestedAtMs: Date.now() }))
      return github.calls.filter((call) => call.path.endsWith("/sub_issues")).map((call) => call.path.split("/").at(-2))
    }
    expect(await asked()).toEqual(["1"])
    expect(await asked()).toEqual(["2"])
  })
})

describe("github/Apply refreshes a changed issue's parents", () => {
  const apply = async (github: ScriptedGitHub, number: number, options: { readonly mayAct?: (id: string) => boolean; readonly fail?: boolean; readonly allowedRepositories?: ReadonlyArray<string> } = {}) => {
    const started: Array<{ deliveryId: string; repo: string; number: number; event: string }> = []
    const { services: value } = await services(runtime, github, options.mayAct === undefined ? {} : { mayAct: options.mayAct })
    const exit = await Effect.runPromiseExit(Apply.read({
      ...value,
      ...(options.allowedRepositories === undefined ? {} : { allowedRepositories: options.allowedRepositories }),
      startApply: (request) => options.fail === true ? Effect.fail("host down") : Effect.sync(() => void started.push(request)),
    })({ deliveryId: "d1", repo: "acme/widgets", number, event: "sub_issues" }))
    return { exit, started }
  }
  const of = (number: number) => ({ deliveryId: `d1:${REPO}#${number}`, repo: "acme/widgets", number, event: "sub_issues" })

  test("a move starts both parents, and a failed start fails the step before the projection, so a retry can't lose them", async () => {
    const github = scriptedGitHub()
    for (const title of ["Old", "New", "Child"]) github.open(title, null)
    ofGitHub(github, 3, 1)
    expect((await apply(github, 3)).started).toEqual([of(1)])
    ofGitHub(github, 3, 2)
    const failed = await apply(github, 3, { fail: true })
    expect(Exit.isFailure(failed.exit)).toBe(true)
    expect(await edges()).toEqual([{ child: `${REPO}#3`, parent: `${REPO}#1` }])
    const again = await apply(github, 3)
    expect(again.started).toEqual([of(1), of(2)])
    expect(await edges()).toEqual([{ child: `${REPO}#3`, parent: `${REPO}#2` }])
    expect((await apply(github, 3)).started).toEqual([])
  })

  test("a state change starts the parent; a repository the deployment doesn't act on isn't asked", async () => {
    const github = scriptedGitHub()
    for (const title of ["Parent", "Child"]) github.open(title, null)
    ofGitHub(github, 2, 1)
    await apply(github, 2)
    const child = github.issues.get(2)!
    child.state = "closed"
    child.updatedAt = github.now + 5_000
    expect((await apply(github, 2)).started).toEqual([of(1)])
    github.setParent(2, { owner: "acme", name: "elsewhere", number: 9 })
    expect((await apply(github, 2, { mayAct: (id) => id !== "github/acme/elsewhere" })).started).toEqual([of(1)])
  })

  test("a deleted issue without a parent starts no parent refresh", async () => {
    const github = scriptedGitHub()
    github.open("An independent issue", null)
    await apply(github, 1)
    github.remove(1)
    const result = await apply(github, 1)
    expect(result.exit).toMatchObject({ _tag: "Success", value: { outcome: "tombstoned" } })
    expect(result.started).toEqual([])
    expect(await edges()).toEqual([])
  })

  test("an unreadable parent reply preserves the known parent when the child's state changes", async () => {
    const github = scriptedGitHub()
    github.open("Parent", null)
    github.open("Child", null)
    ofGitHub(github, 2, 1)
    await apply(github, 2)
    // A self-parent reply is unreadable; it cannot replace the previously observed edge.
    github.setParent(2, { owner: "acme", name: "widgets", number: 2 })
    github.issues.get(2)!.state = "closed"
    github.issues.get(2)!.updatedAt = github.now + 5_000
    expect((await apply(github, 2)).started).toEqual([of(1)])
    expect(await edges()).toEqual([{ child: `${REPO}#2`, parent: `${REPO}#1` }])
    expect(await sql(runtime, "SELECT state FROM items WHERE number = 2")).toEqual([{ state: "closed" }])
  })

  test("a recorded parent refresh needs no optional repository configuration", async () => {
    const github = scriptedGitHub()
    github.open("Parent", null)
    github.open("Child", null)
    ofGitHub(github, 2, 1)
    const { services: value } = await services(runtime, github)
    const started: Array<{ repo: string; number: number }> = []
    const minimal: Apply.Services = {
      database: value.database, tokens: value.tokens, http: value.http, apiBaseUrl: value.apiBaseUrl,
      appLogin: value.appLogin, mayAct: value.mayAct,
      startApply: (request) => Effect.sync(() => void started.push({ repo: request.repo, number: request.number })),
    }
    await run(Apply.read(minimal)({ deliveryId: "recorded-parent", repo: "acme/widgets", number: 2, event: "issues" }))
    expect(started).toEqual([{ repo: "acme/widgets", number: 1 }])
    expect(await edges()).toEqual([{ child: `${REPO}#2`, parent: `${REPO}#1` }])
  })

  test("an explicitly configured repository can receive a parent refresh", async () => {
    const github = scriptedGitHub()
    github.open("Child", null)
    github.setParent(1, { owner: "acme", name: "other", number: 9 })
    const result = await apply(github, 1, { allowedRepositories: ["github/acme/other"] })
    expect(result.started).toEqual([{
      deliveryId: "d1:github/acme/other#9", repo: "acme/other", number: 9, event: "sub_issues",
    }])
    expect(await edges()).toEqual([{ child: `${REPO}#1`, parent: "github/acme/other#9" }])
  })

  test("a child GitHub no longer has starts its old parent and loses its edge", async () => {
    const github = scriptedGitHub()
    for (const title of ["Parent", "Child"]) github.open(title, null)
    ofGitHub(github, 2, 1)
    await apply(github, 2)
    github.issues.get(2)!.gone = true
    expect((await apply(github, 2)).started).toEqual([of(1)])
    expect(await edges()).toEqual([])
  })
})

describe("the webhook's sub_issues", () => {
  const repo = (full_name: string) => ({ full_name })
  const started = async (payload: unknown) => {
    const h = await githubHarness(runtime, { allowed: new Set(["github/acme/other"]) })
    const response = await h.fetch("/api/github/webhook", await delivery("sub_issues", payload, { id: "d-1" }))
    expect(response.status).toBe(200)
    return h.starts.map((start) => start.payload as { deliveryId: string; repo: string; number: number; event: string })
  }
  const inHere = repo("acme/widgets")

  test.each([
    ["parent_issue_added", { sub_issue: { number: 2 }, parent_issue: { number: 1 }, parent_issue_repo: repo("acme/other") }],
    ["parent_issue_removed", { sub_issue: { number: 2 }, parent_issue: { number: 1 }, parent_issue_repo: repo("acme/other") }],
  ] as const)("%s names the child here and the parent where the payload says", async (action, fields) => {
    expect(await started({ action, repository: inHere, ...fields })).toEqual([
      { deliveryId: "d-1", repo: "acme/widgets", number: 2, event: "sub_issues" },
      { deliveryId: "d-1:github/acme/other#1", repo: "acme/other", number: 1, event: "sub_issues" },
    ])
  })

  test.each([
    ["sub_issue_added", { parent_issue: { number: 1 }, sub_issue: { number: 2 }, sub_issue_repo: repo("acme/other") }],
    ["sub_issue_removed", { parent_issue: { number: 1 }, sub_issue: { number: 2 }, sub_issue_repo: repo("acme/other") }],
  ] as const)("%s names the parent here and the child where the payload says", async (action, fields) => {
    expect(await started({ action, repository: inHere, ...fields })).toEqual([
      { deliveryId: "d-1", repo: "acme/widgets", number: 1, event: "sub_issues" },
      { deliveryId: "d-1:github/acme/other#2", repo: "acme/other", number: 2, event: "sub_issues" },
    ])
  })

  test("a far side the payload leaves out is never guessed, and one in a repository the deployment doesn't act on isn't read", async () => {
    expect((await started({ action: "parent_issue_added", repository: inHere, sub_issue: { number: 2 }, parent_issue_id: 77 })).map((start) => start.number)).toEqual([2])
    await reset(runtime)
    expect((await started({ action: "parent_issue_added", repository: inHere, sub_issue: { number: 2 }, parent_issue: { number: 1 } })).map((start) => start.number)).toEqual([2])
    await reset(runtime)
    expect((await started({ action: "sub_issue_added", repository: inHere, parent_issue: { number: 1 }, sub_issue: { number: 2 }, sub_issue_repo: repo("acme/elsewhere") })).map((start) => start.number)).toEqual([1])
  })

  test("an action GitHub adds later starts nothing", async () => {
    expect(await started({ action: "sub_issue_renamed", repository: inHere, sub_issue: { number: 2 } })).toEqual([])
  })
})

// Several repositories, each its own scripted GitHub, behind one client: what the routes read of a repository's metadata.
const github = (privates: ReadonlyArray<string>, names: ReadonlyArray<string>) => {
  const each = names.map((name) => {
    const one = scriptedGitHub("acme", name)
    one.private = privates.includes(name)
    return one
  })
  const http = HttpClient.make((request) =>
    (each.find((one) => request.url.includes(`/repos/acme/${one.name}`)) ?? each[0]!).http.execute(request))
  return { ...each[0]!, http, layer: Layer.succeed(HttpClient.HttpClient, http) } as ScriptedGitHub
}

const seedRepositories = async (privates: ReadonlyArray<string>, names: ReadonlyArray<string>) => {
  for (const name of names) {
    await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('github/acme/${name}', ${names.indexOf(name) + 1}, ${privates.includes(name)})`)
  }
}

/** An edge, as a walk would write it: repository `a`'s issue `n` under repository `b`'s issue `m`. */
const edge = (a: string, n: number, b: string, m: number) =>
  sql(runtime, `INSERT INTO issue_relations (child_id, child_repo_id, parent_id, parent_repo_id, observed_at)
    VALUES ('github/acme/${a}#${n}', 'github/acme/${a}', 'github/acme/${b}#${m}', 'github/acme/${b}', now())`)

const rolesOn = (roles: Readonly<Record<string, Role | null | "down">>, calls: { n: number } = { n: 0 }): RepoRoles.RepoRoles<never> => ({
  repository: { owner: "acme", name: "a", id: "github/acme/a" },
  resolve: (actor, target) => Effect.suspend(() => {
    calls.n++
    const role = roles[target.name] ?? null
    if (role === "down") return Effect.fail(new RepoRoles.RoleRefused({ code: "github_unavailable", retryAfterSeconds: 7 }))
    return Effect.succeed({ role, held: role === null ? Option.none() : Option.some({ repoId: target.id, personId: actor.subject.id, role }) })
  }),
})

const OWN = { owner: "acme", name: "a", id: "github/acme/a" } as const

const harness = async (names: ReadonlyArray<string>, privates: ReadonlyArray<string>, roles: Parameters<typeof rolesOn>[0] | null, calls?: { n: number }) => {
  await seedRepositories(privates, names)
  return githubHarness(runtime, {
    own: OWN,
    github: github(privates, names),
    allowed: new Set(names.map((name) => `github/acme/${name}`)),
    actor: roles === null ? null : member(),
    roles: rolesOn(roles ?? {}, calls),
  })
}

const scope = async (h: Pick<Awaited<ReturnType<typeof harness>>, "fetch">, repo = "a") => {
  const response = await h.fetch(treeScopeRoute("acme", repo))
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  return { status: response.status, body: (await response.json()) as TreeScope }
}

const names = (body: TreeScope) => body.repos.map((each) => each.repo)

const shapeRows = async (h: Pick<Awaited<ReturnType<typeof harness>>, "fetch">, path: string) => {
  let next = path
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await h.fetch(next)
    const handle = response.headers.get("electric-handle")
    if (response.status !== 409 || handle === null) {
      const text = await response.text()
      return {
        status: response.status,
        cache: response.headers.get("cache-control"),
        handle,
        offset: response.headers.get("electric-offset"),
        rows: response.status === 200
          ? (JSON.parse(text) as Array<{ value?: Record<string, unknown> }>).flatMap((row) => (row.value === undefined ? [] : [row.value]))
          : [],
      }
    }
    await response.text()
    const url = new URL(next, "http://localhost")
    url.searchParams.set("offset", "-1")
    url.searchParams.set("handle", handle)
    next = `${url.pathname}${url.search}`
  }
  throw new Error("Electric kept answering 409")
}

const edgesOf = (repo: string) => `${ISSUE_EDGES_SHAPE_ROUTE}?repo=${encodeURIComponent(`acme/${repo}`)}&offset=-1`

describe("a tree's scope", () => {
  const every: Record<string, Role> = { a: "member", b: "member", c: "member", d: "member" }

  test("A -> B -> C reaches all three, nearest first; an unrelated tree in B brings nothing with it", async () => {
    const h = await harness(["a", "b", "c", "d"], ["a", "b", "c", "d"], every)
    await edge("a", 1, "b", 1)
    await edge("b", 1, "c", 1)
    await edge("b", 9, "b", 8)
    await edge("b", 8, "d", 1)
    const { status, body } = await scope(h)
    expect(status).toBe(200)
    expect(body).toEqual({
      repos: [{ repo: "acme/a", synced: false }, { repo: "acme/b", synced: false }, { repo: "acme/c", synced: false }],
      truncated: false,
      omitted: [],
    })
    expect(h.count(Metrics.treeCandidateReads, { outcome: "read" })).toBe(1)
    expect(h.spans.some((span) => span.name === "github.tree_candidates")).toBe(true)
  })

  test("a cycle in stale rows ends, and a repository with no relations is its own scope", async () => {
    const h = await harness(["a", "b", "c"], ["a", "b", "c"], every)
    await edge("a", 1, "b", 1)
    await edge("b", 1, "a", 1)
    await edge("a", 2, "a", 3)
    await edge("a", 3, "a", 2)
    // An edge outside the component: without a visited set, Postgres must walk the cycle forever to rule it out.
    await edge("c", 1, "c", 2)
    expect(names((await scope(h)).body)).toEqual(["acme/a", "acme/b"])
    expect(names((await scope(h, "c")).body)).toEqual(["acme/c"])
  })

  test("a component whose leaves are 14 edges apart loads whole from a leaf's repository", async () => {
    const list = Array.from({ length: 15 }, (_, i) => `r${i}`)
    const h = await harness(["a", ...list], [], Object.fromEntries(["a", ...list].map((name) => [name, "member"])))
    for (let i = 1; i < 15; i++) await edge(`r${i}`, 1, `r${i - 1}`, 1)
    expect(names((await scope(h, "r14")).body).length).toBe(15)
  })

  test("past 20 readable repositories it keeps the nearest 20 and names the readable rest", async () => {
    const list = Array.from({ length: 21 }, (_, i) => `n${String(i).padStart(2, "0")}`)
    const h = await harness(["a", ...list], [], Object.fromEntries(["a", ...list].map((name) => [name, "member"])))
    for (const name of list) await edge(name, 1, "a", 1)
    const { body } = await scope(h)
    expect(body.truncated).toBe(true)
    expect(body.repos.length).toBe(20)
    expect(names(body)[0]).toBe("acme/a")
    expect(body.omitted).toEqual(["acme/n19", "acme/n20"])
  })

  test("a repository in scope with no current walk starts one, once a bucket; a current one doesn't; an old one does", async () => {
    const h = await harness(["a", "b"], ["a", "b"], every)
    await edge("a", 1, "b", 1)
    await scope(h)
    expect(h.starts.filter((start) => start.flow === "github/Relations").map((start) => (start.payload as { repo: string }).repo).sort())
      .toEqual(["acme/a", "acme/b"])
    const before = h.starts.length
    await scope(h)
    expect(h.starts.length).toBe(before)
    await sql(runtime, `INSERT INTO github_sync (repo_id, stream, synced_at, complete) VALUES ('github/acme/a', '${RELATIONS_STREAM}', now(), true),
      ('github/acme/b', '${RELATIONS_STREAM}', now() - interval '31 minutes', true)`)
    expect((await scope(h)).body.repos).toEqual([{ repo: "acme/a", synced: true }, { repo: "acme/b", synced: false }])
  })

  test("a role that can't be read on another repository answers 503, not a smaller tree", async () => {
    const h = await harness(["a", "b"], ["a", "b"], { a: "member", b: "down" })
    await edge("a", 1, "b", 1)
    const response = await h.fetch(treeScopeRoute("acme", "a"))
    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBe("7")
  })
})

describe("the relation policy", () => {
  const ALL = ["a", "b", "c"]
  // public A -> private B -> public C.
  const chain = async () => {
    await edge("a", 1, "b", 1)
    await edge("b", 1, "c", 1)
  }

  test.each([
    ["signed out", null, ["acme/a"], "200", []],
    ["a Guest on B", { b: "guest" }, ["acme/a", "acme/b", "acme/c"], "200", [{ child_id: "github/acme/a#1", parent_id: "github/acme/b#1" }]],
    ["a Member on B", { b: "member" }, ["acme/a", "acme/b", "acme/c"], "200", [{ child_id: "github/acme/a#1", parent_id: "github/acme/b#1" }]],
    ["a Member with no role on B", { a: "member", c: "member" }, ["acme/a"], "200", []],
  ] as const)("%s: an edge needs both ends, and public A -> private B -> public C gives C nothing through B", async (_name, roles, repos, status, rows) => {
    const h = await harness(ALL, ["b"], roles as never)
    await chain()
    expect(names((await scope(h)).body)).toEqual(repos)
    const read = await shapeRows(h, edgesOf("a"))
    expect(String(read.status)).toBe(status)
    expect(read.cache).toContain("no-store")
    expect(read.rows).toEqual(rows)
    expect(read.rows.every((row) => Object.keys(row).sort().join() === [...ISSUE_EDGE_COLUMNS].sort().join())).toBe(true)
  })

  test("a traversal already inside readable edges stops at a hidden repository, in both directions", async () => {
    const h = await harness(ALL, ["b"], { a: "member", c: "member" })
    await edge("a", 1, "a", 2)
    await edge("a", 2, "b", 1)
    await edge("b", 1, "c", 1)
    await edge("b", 2, "a", 3)
    await edge("a", 3, "a", 4)
    await edge("c", 2, "b", 2)
    expect((await scope(h)).body).toEqual({ repos: [{ repo: "acme/a", synced: false }], truncated: false, omitted: [] })
    // A shape this file read before, with these parameters, can answer before Electric has the new rows: wait for them.
    await expect.poll(async () => (await shapeRows(h, edgesOf("a"))).rows.map((row) => row.child_id).sort())
      .toEqual(["github/acme/a#1", "github/acme/a#3"])
  })

  // Every pair it reports is readable on its own, so only the traversal can tell: D joins A's tree only through hidden B.
  test("a readable repository reached only through a hidden one stays out of the tree", async () => {
    const h = await harness(["a", "b", "c", "d"], ["b"], { a: "member", c: "member", d: "member" })
    // a#1 sits under c#1, readable; hidden b#1 sits under a#1; c#9 under b#1; d#1 under c#9.
    await edge("a", 1, "c", 1)
    await edge("b", 1, "a", 1)
    await edge("c", 9, "b", 1)
    await edge("d", 1, "c", 9)
    expect(names((await scope(h)).body)).toEqual(["acme/a", "acme/c"])
  })

  test("a private repository's scope and edges are refused to whoever may not read it", async () => {
    const out = await harness(ALL, ["b"], null)
    await chain()
    expect((await out.fetch(treeScopeRoute("acme", "b"))).status).toBe(401)
    expect((await out.fetch(edgesOf("b"))).status).toBe(401)
    const stranger = await githubHarness(runtime, { own: OWN, github: github(["b"], ALL), allowed: new Set(ALL.map((name) => `github/acme/${name}`)), roles: rolesOn({}) })
    expect((await stranger.fetch(treeScopeRoute("acme", "b"))).status).toBe(403)
    expect((await stranger.fetch(edgesOf("b"))).status).toBe(403)
  })

  test("a revoked Member loses the edge at the next request", async () => {
    await seedRepositories(["b"], ALL)
    const roles: Record<string, Role | null> = { a: "member", b: "member", c: "member" }
    const h = await githubHarness(runtime, { own: OWN, github: github(["b"], ALL), allowed: new Set(ALL.map((name) => `github/acme/${name}`)), roles: rolesOn(roles) })
    await chain()
    expect((await shapeRows(h, edgesOf("a"))).rows).toEqual([{ child_id: "github/acme/a#1", parent_id: "github/acme/b#1" }])
    roles.b = null
    expect(names((await scope(h)).body)).toEqual(["acme/a"])
    expect((await shapeRows(h, edgesOf("a"))).rows).toEqual([])
  })

  test("changing only hidden relations changes no answer, no message and no authorization call", async () => {
    const calls = { n: 0 }
    const h = await harness(ALL, ["b"], { a: "member", c: "member" }, calls)
    await chain()
    const first = { body: (await scope(h)).body, edges: await shapeRows(h, edgesOf("a")) }
    const counted = calls.n
    await edge("b", 5, "b", 6)
    await edge("b", 6, "a", 9)
    await edge("c", 9, "b", 5)
    await sql(runtime, `INSERT INTO issue_child_counts (parent_id, repo_id, sub_total, sub_completed, observed_at) VALUES ('github/acme/a#1', 'github/acme/a', 40, 0, now())`)
    calls.n = 0
    const second = { body: (await scope(h)).body, edges: await shapeRows(h, edgesOf("a")) }
    expect(second.body).toEqual(first.body)
    expect(second.edges.rows).toEqual(first.edges.rows)
    expect(calls.n).toBe(counted)
    const starts = h.count(Metrics.treeScopes, { outcome: "answered" })
    expect(starts).toBe(2)
  })

  test("a relation change sends no item message; only GitHub moving a readable field does", async () => {
    const h = await harness(["a"], [], { a: "member" })
    await runtime.runPromise(Store.upsertIssue("github/acme/a", issue(1), 1_000) as never)
    const items = await shapeRows(h, `${ITEM_SUMMARIES_SHAPE_ROUTE}?repo=acme%2Fa&offset=-1`)
    expect(items.rows.map((row) => row.number)).toEqual(["1"])
    // The relation arrives, with an identical re-read of the issue beside it. Electric carries the edge before it could
    // have carried anything from later in the log.
    await runtime.runPromise(Store.upsertIssue("github/acme/a", issue(1, { parent: `${API}/acme/a/issues/7` }), 2_000) as never)
    const edge = await shapeRows(h, edgesOf("a"))
    expect(edge.rows).toEqual([{ child_id: "github/acme/a#1", parent_id: "github/acme/a#7" }])
    const after = await h.fetch(`${ITEM_SUMMARIES_SHAPE_ROUTE}?repo=acme%2Fa&offset=${items.offset}&handle=${items.handle}`)
    const messages = (JSON.parse(await after.text()) as Array<{ value?: unknown }>).filter((row) => row.value !== undefined)
    expect(messages).toEqual([])
  })
})

describe("candidate repository availability", () => {
  test.each(["scope", "edges"])("%s refuses a failed candidate read instead of returning a smaller tree", async (route) => {
    const h = await harness(["a", "b"], ["a", "b"], { a: "member", b: "member" })
    await edge("a", 1, "b", 1)
    await sql(runtime, `ALTER TABLE github_repositories RENAME TO github_repositories_unavailable`)
    try {
      const response = await h.fetch(route === "scope" ? treeScopeRoute("acme", "a") : edgesOf("a"))
      expect(response.status).toBe(503)
      expect(response.headers.get("cache-control")).toContain("no-store")
      expect(await response.json()).toEqual({ code: "unavailable" })
      expect(h.count(Metrics.treeCandidateReads, { outcome: "unavailable" })).toBe(1)
      expect(h.line("github.tree_candidates").map((log) => log.annotations)).toMatchObject([{
        repoId: "github/acme/a", outcome: "unavailable", errorCode: expect.stringMatching(/^sql:/),
      }])
      expect(h.spans.some((span) => span.name === "github.tree_candidates" && span.attributes.get("smithers.github.outcome") === "unavailable")).toBe(true)
    } finally {
      await sql(runtime, `ALTER TABLE github_repositories_unavailable RENAME TO github_repositories`)
    }
  })
})

describe("review regressions", () => {
  const request = () => ({ repo: "acme/widgets", requestedAtMs: Date.now() })
  const completed = () => sql(runtime, `INSERT INTO github_sync (repo_id, stream, synced_at, complete)
    VALUES ('${REPO}', '${RELATIONS_STREAM}', now(), true)`)

  test("a walk records the metadata observation time", async () => {
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    expect((await run(Relations.walk(value)(request()))).outcome).toBe("complete")
    expect(await sql(runtime, `SELECT visibility_verified_at IS NOT NULL AS verified FROM github_repositories WHERE repo_id = '${REPO}'`))
      .toEqual([{ verified: true }])
  })

  test("a delayed public walk cannot replace or renew a newer private receipt", async () => {
    const github = scriptedGitHub()
    github.private = false
    const { services: value } = await services(runtime, github)
    let newer = ""
    const http = HttpClient.make((call) => Effect.gen(function* () {
      const response = yield* github.http.execute(call)
      if (call.method === "GET" && new URL(call.url).pathname === "/repos/acme/widgets") {
        github.private = true
        newer = yield* Store.repositoryObservation.pipe(Effect.provide(value.database), Effect.orDie)
        yield* Store.recordRepository(REPO, { private: true }, newer).pipe(Effect.provide(value.database), Effect.orDie)
      }
      return response
    }))
    expect((await run(Relations.walk({ ...value, http })(request()))).outcome).toBe("complete")
    expect(newer).not.toBe("")
    expect(await sql(runtime, `SELECT private, visibility_verified_at::text AS observed FROM github_repositories WHERE repo_id = '${REPO}'`))
      .toEqual([{ private: true, observed: newer }])
  })

  test("an equal-count replacement in another repository is discovered without a webhook", async () => {
    const github = scriptedGitHub()
    github.open("Parent", null)
    const parent = `${API}/acme/widgets/issues/1`
    // B's old hidden child and C's new readable child have the same total. C is already a deployment candidate.
    await runtime.runPromise(Store.upsertRelation("github/acme/b", issue(2, { parent }), Date.now() - 60_000) as never)
    await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('github/acme/c', 17, false)`)
    github.foreignChildren.set(1, [{ ...issue(3, { parent }), repository_url: `${API}/acme/c` }])
    const { services: value } = await services(runtime, github, { mayAct: (id) => id !== "github/acme/b" })
    expect((await run(Relations.walk(value)(request()))).outcome).toBe("complete")
    await run(Relations.verify(value)(request()))
    expect(await edges()).toContainEqual({ child: "github/acme/c#3", parent: `${REPO}#1` })
  })

  const twoParents = async (status: number, headers: Record<string, string> = {}) => {
    const github = scriptedGitHub()
    for (const title of ["Missing or failing", "Repairable", "Child"]) github.open(title, null)
    github.setParent(3, { owner: "acme", name: "widgets", number: 2 })
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith("/issues/1/sub_issues"), status, headers })
    const { services: value } = await services(runtime, github)
    await completed()
    await sql(runtime, `INSERT INTO issue_child_counts (parent_id, repo_id, sub_total, sub_completed, observed_at) VALUES
      ('${REPO}#1', '${REPO}', 3, 0, now()), ('${REPO}#2', '${REPO}', 3, 0, now())`)
    return { github, value }
  }

  test.each([404, 410])("a missing parent (%i) is retired and the next parent is repaired", async (status) => {
    const { value } = await twoParents(status)
    const result = await Effect.runPromiseExit(Relations.verify(value)(request()))
    expect(Exit.isSuccess(result)).toBe(true)
    expect(await edges()).toContainEqual({ child: `${REPO}#3`, parent: `${REPO}#2` })
    expect(await sql(runtime, `SELECT parent_id FROM issue_child_counts WHERE parent_id = '${REPO}#1'`)).toEqual([])
  })

  test("a recoverable failure still lets the rest of the batch progress before the durable retry", async () => {
    const { value } = await twoParents(500)
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const registry: Metric.MetricRegistry = new Map()
    const result = await Effect.runPromiseExit(Relations.verify(value)(request()).pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))])),
      Effect.provideService(Metric.MetricRegistry, registry),
    ))
    expect(Exit.isFailure(result)).toBe(true)
    expect(await edges()).toContainEqual({ child: `${REPO}#3`, parent: `${REPO}#2` })
    expect(await sql(runtime, `SELECT attempted_at IS NOT NULL AS attempted, verified_at IS NULL AS unverified
      FROM issue_parent_checks WHERE parent_id = '${REPO}#1'`)).toEqual([{ attempted: true, unverified: true }])
    expect(logs.filter((log) => log.message === "github.relations.verify.parent").map((log) => log.annotations)).toEqual([{
      repoId: REPO, number: 1, outcome: "failed", errorCode: expect.any(String), status: 500,
    }])
    expect(JSON.stringify(logs)).not.toContain("scripted fault")
    for (const outcome of ["failed", "verified"]) {
      expect(Effect.runSync(Metric.value(Metric.withAttributes(Metrics.relationParentChecks, { outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ))).toMatchObject({ count: 1 })
    }
  })

  test("a provider rate limit stops the batch and retains Retry-After for the durable retry", async () => {
    const { github, value } = await twoParents(429, { "retry-after": "7" })
    await expect(run(Relations.verify(value)(request()))).rejects.toMatchObject({ retryAfterMillis: 7_000 })
    expect(github.seen("GET", /\/issues\/2\/sub_issues$/)).toEqual([])
  })

  test("a failed one-parent batch gives the next parent its turn", async () => {
    const { github, value } = await twoParents(500)
    const step = Relations.verify(value, 1)
    expect(Exit.isFailure(await Effect.runPromiseExit(step(request())))).toBe(true)
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith("/issues/1/sub_issues"), status: 500 })
    expect(Exit.isSuccess(await Effect.runPromiseExit(step(request())))).toBe(true)
    expect(await edges()).toContainEqual({ child: `${REPO}#3`, parent: `${REPO}#2` })
  })
})

describe("review round 2 regressions", () => {
  test.each([["observation first", true], ["tombstone first", false]] as const)("an equal-time tombstone wins: %s", async (_name, observedFirst) => {
    const observe = () => runtime.runPromise(Store.upsertIssue(REPO, issue(2, { parent: `${API}/acme/widgets/issues/1` }), 1_000) as never)
    const remove = () => runtime.runPromise(Store.tombstoneIssue(REPO, 2, 1_000) as never)
    if (observedFirst) { await observe(); await remove() } else { await remove(); await observe() }
    expect(await sql(runtime, `SELECT id FROM items WHERE deleted_at IS NULL`)).toEqual([])
    expect(await edges()).toEqual([])
  })

  test("a parent and child both disappearing cannot strand their incoming edge", async () => {
    const github = scriptedGitHub()
    github.open("Parent", null)
    github.open("Child", null)
    github.setParent(2, { owner: "acme", name: "widgets", number: 1 })
    const { services: value } = await services(runtime, github)
    expect((await flow(value)).status).toBe("completed")
    expect(await edges()).toHaveLength(1)
    github.issues.get(1)!.gone = true
    github.issues.get(2)!.gone = true
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith("/issues/1/sub_issues"), status: 404 })
    await run(Relations.verify(value)({ repo: "acme/widgets", requestedAtMs: Date.now() }))
    expect(await edges()).toEqual([])
  })

  test("private child discovery respects repository-restricted installation tokens", async () => {
    const github = scriptedGitHub()
    github.private = true
    github.open("Parent", null)
    const child = { ...issue(7, { parent: `${API}/acme/widgets/issues/1` }), repository_url: `${API}/acme/private-child` }
    github.foreignChildren.set(1, [child])
    const { services: base } = await services(runtime, github)
    // This repository has been opened on the deployment and belongs to the same installation.
    await runtime.runPromise(Store.rememberInstallation("github/acme/private-child", 77) as never)
    const http = HttpClient.make((request) => Effect.suspend(() => {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname.endsWith("/issues/1/sub_issues")) {
        const bearer = request.headers["authorization"]?.slice("Bearer ".length)
        const minted = github.minted.find((entry) => entry.token === bearer)
        const repos = (minted?.body as { repositories?: ReadonlyArray<string> } | undefined)?.repositories ?? []
        const listed = repos.includes("widgets") && repos.includes("private-child") ? [child] : []
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(listed), {
          status: 200, headers: { "content-type": "application/json" },
        })))
      }
      return github.http.execute(request)
    }))
    const value = { ...base, http }
    await run(Relations.walk(value)({ repo: "acme/widgets", requestedAtMs: Date.now() }))
    await run(Relations.verify(value)({ repo: "acme/widgets", requestedAtMs: Date.now() }))
    expect(await edges()).toContainEqual({ child: "github/acme/private-child#7", parent: `${REPO}#1` })
    expect(github.minted.every((entry) => Array.isArray((entry.body as { repositories?: unknown }).repositories))).toBe(true)
  })

  test("a machine relation is ingested and reaches the reader's scope and edge shape", async () => {
    const github = scriptedGitHub()
    github.open("Parent", null)
    github.open("Child", null)
    const h = await githubHarness(runtime, { github })
    const token = "smm_issue_tree_round2"
    await sql(runtime, `INSERT INTO machine_tokens (token_sha256, repo_id, agent, lane, scope, issued_by, expires_at)
      VALUES ('${digestSync(token)}', '${REPO}', 'fixer', 'tree', ARRAY['issue/relate']::text[], 'test', now() + interval '1 day')`)
    const writeId = crypto.randomUUID()
    const response = await h.fetch("/api/repos/acme/widgets/writes", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ writeId, op: "issue/relate", number: 2, parent: { repo: "acme/widgets", number: 1 } }),
    })
    expect(response.status).toBe(202)
    const start = h.starts.find((entry) => entry.flow === "github/MachineDispatch")!
    const { services: value } = await services(runtime, github)
    const payload = start.payload as { owner: string; epoch: number }
    await run(MachineWrite.steps(value).tick({ ...payload, round: 0, waitMs: 0 }))
    expect(await sql(runtime, `SELECT status FROM machine_writes WHERE id = '${writeId}'`)).toEqual([{ status: "done" }])
    expect((await flow(value)).status).toBe("completed")
    expect(await edges()).toEqual([{ child: `${REPO}#2`, parent: `${REPO}#1` }])
    expect(names((await scope(h, "widgets")).body)).toEqual(["acme/widgets"])
    expect((await shapeRows(h, edgesOf("widgets"))).rows).toEqual([{ child_id: `${REPO}#2`, parent_id: `${REPO}#1` }])
  })
})

describe("hidden-parent refresh independence", () => {
  test("executing a hidden parent refresh cannot register a candidate or change authorization and answers", async () => {
    const own = scriptedGitHub()
    const hidden = scriptedGitHub("acme", "hidden-parent")
    hidden.private = true
    own.open("Visible child", null)
    hidden.open("Hidden parent", null)
    const http = HttpClient.make((request) =>
      (new URL(request.url).pathname.startsWith("/repos/acme/hidden-parent") ? hidden : own).http.execute(request))
    const combined = { ...own, http, layer: Layer.succeed(HttpClient.HttpClient, http) } as ScriptedGitHub
    const { services: value } = await services(runtime, combined)
    const starts: Array<string> = []
    const apply = (deliveryId: string) => Apply.read({ ...value, startApply: (request) => Effect.gen(function* () {
      starts.push(request.repo)
      yield* Effect.exit(Apply.read(value)(request))
    }) })({ deliveryId, repo: "acme/widgets", number: 1, event: "issues" })
    await run(apply("baseline"))
    const authCalls: Array<string> = []
    const roles: RepoRoles.RepoRoles<never> = {
      repository: { owner: "acme", name: "widgets", id: REPO },
      resolve: (actor, target) => Effect.suspend(() => {
        authCalls.push(target.id)
        return target.name === "hidden-parent"
          ? Effect.fail(new RepoRoles.RoleRefused({ code: "github_unavailable", retryAfterSeconds: 7 }))
          : Effect.succeed({ role: "member" as const, held: Option.some({ repoId: target.id, personId: actor.subject.id, role: "member" as const }) })
      }),
    }
    const h = await githubHarness(runtime, { github: combined, roles })
    const beforeScope = await h.fetch(treeScopeRoute("acme", "widgets"))
    const beforeBody = await beforeScope.json()
    const beforeEdges = await shapeRows(h, edgesOf("widgets"))
    const beforeCalls = [...authCalls]
    const beforeCandidates = await sql(runtime, `SELECT repo_id FROM github_repositories ORDER BY repo_id`)
    authCalls.length = 0
    own.setParent(1, { owner: "acme", name: "hidden-parent", number: 1 })
    await run(apply("hidden-change"))
    const afterScope = await h.fetch(treeScopeRoute("acme", "widgets"))
    const afterBody = await afterScope.json()
    const afterEdges = await shapeRows(h, edgesOf("widgets"))
    expect(afterScope.status).toBe(200)
    expect(afterBody).toEqual(beforeBody)
    expect(afterEdges.status).toBe(beforeEdges.status)
    expect(afterEdges.rows).toEqual(beforeEdges.rows)
    expect(authCalls).toEqual(beforeCalls)
    expect(await sql(runtime, `SELECT repo_id FROM github_repositories ORDER BY repo_id`)).toEqual(beforeCandidates)
    expect(starts).toEqual([])
  })

  test("a relation webhook cannot admit an unopened far repository with no configured candidacy", async () => {
    const h = await githubHarness(runtime)
    const response = await h.fetch("/api/github/webhook", await delivery("sub_issues", {
      action: "parent_issue_added", repository: { full_name: "acme/widgets" }, sub_issue: { number: 1 },
      parent_issue: { number: 2 }, parent_issue_repo: { full_name: "acme/hidden-parent" },
    }, { id: "independent-candidates" }))
    expect(response.status).toBe(200)
    expect(h.starts.map((start) => (start.payload as { repo: string }).repo)).toEqual(["acme/widgets"])
  })
})
