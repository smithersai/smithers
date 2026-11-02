// Every reader of a repository's issues answers one access matrix the same way (devpriv FINAL §1.1, step 0): the
// repository shapes (summaries, an issue's item and its comments, the issue page's `?number=` shapes) and the issue
// list route `GET /api/repos/<owner>/<name>/issues`. Each cell is a real request through the routes' handler, over the
// compose Postgres and Electric; only who has which role is scripted, as `RepoRoles` would answer it. The table pins
// today's answers, ordering included (the deployment's checks, then a request's own validation, then who reads), so
// the extraction of `repositoryReadable` changes none of them. The list route's one documented difference: a runner
// registered on the repository reads its issues with its token.
import { Effect, Layer, Option } from "effect"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { digestSync } from "@smthrs/crypto"
import { COMMENTS_SHAPE_ROUTE, issuesRoute, ITEMS_SHAPE_ROUTE, ITEM_SUMMARIES_SHAPE_ROUTE } from "../../src/features/issues/contract.ts"
import type { Role } from "../../src/features/auth/contract.ts"
import * as Actor from "../Actor.ts"
import { testFile } from "../test/harness.ts"
import * as RepoRoles from "./RepoRoles.ts"
import { reset, sql } from "./test/fixtures.ts"
import { githubHarness, member } from "./test/harness.ts"
import { scriptedGitHub } from "./test/scriptedGitHub.ts"

const runtime = testFile("github_readers")

beforeAll(async () => {
  const health = `${await runtime.runPromise(TestDatabase.electricUrl)}/v1/health`
  const response = await fetch(health).catch((error: unknown) => {
    throw TestDatabase.explain("Electric", new URL(health).host)(error)
  })
  if (!response.ok) throw new Error(`Electric answered ${response.status} to ${health}`)
})

beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, `TRUNCATE repo_about`)
})

// The deployment's own repository, a second one it acts on, and one GITHUB_ALLOWED_REPOSITORIES leaves out.
const OWN = { owner: "acme", name: "readers-own", id: "github/acme/readers-own" } as const
const OTHER = { owner: "acme", name: "readers-other", id: "github/acme/readers-other" } as const
const ELSEWHERE = { owner: "acme", name: "readers-elsewhere", id: "github/acme/readers-elsewhere" } as const
const ACTED_ON = new Set([OWN.id, OTHER.id])
const RUNNER_TOKEN = "runner-token-readers-5f1c"

type Repo = typeof OWN | typeof OTHER | typeof ELSEWHERE

/** Who asks: signed out, a person whose role there `RepoRoles` gives, or sessions that can't be read. */
type Viewer =
  | { readonly kind: "signed_out" }
  | { readonly kind: "person"; readonly role: Role | null }
  | { readonly kind: "person_cant_act" }
  | { readonly kind: "person_roles_down" }
  | { readonly kind: "sessions_down" }

interface Cell {
  readonly name: string
  readonly repo: Repo
  /** What GitHub and Postgres say of the repository: private or public, and whether an About read found the App absent. */
  readonly visibility: "private" | "public"
  readonly appAbsent?: boolean
  /** The deployment has no App: only its own repository is acted on. */
  readonly noApp?: boolean
  readonly viewer: Viewer
  /** A runner token registered on `runnerOn` rides along as `Authorization: Bearer`. */
  readonly runnerOn?: Repo
  /** A request that fails its own validation: a list query or an item number that can't be. */
  readonly invalid?: boolean
  /** The answer of every repository shape, and of the list route. */
  readonly shapes: string
  readonly list: string
}

const person = { kind: "person" } as const
const MATRIX: ReadonlyArray<Cell> = [
  // The deployment's own repository.
  { name: "own private, signed out", repo: OWN, visibility: "private", viewer: { kind: "signed_out" }, shapes: "401 authentication", list: "401 authentication" },
  { name: "own private, guest", repo: OWN, visibility: "private", viewer: { ...person, role: "guest" }, shapes: "200", list: "200" },
  { name: "own private, member", repo: OWN, visibility: "private", viewer: { ...person, role: "member" }, shapes: "200", list: "200" },
  { name: "own private, admin", repo: OWN, visibility: "private", viewer: { ...person, role: "admin" }, shapes: "200", list: "200" },
  { name: "own private, no role", repo: OWN, visibility: "private", viewer: { ...person, role: null }, shapes: "403 forbidden", list: "403 forbidden" },
  { name: "own public, signed out", repo: OWN, visibility: "public", viewer: { kind: "signed_out" }, shapes: "200", list: "200" },
  { name: "own public, no role", repo: OWN, visibility: "public", viewer: { ...person, role: null }, shapes: "200", list: "200" },
  { name: "own private, roles unavailable", repo: OWN, visibility: "private", viewer: { kind: "person_roles_down" }, shapes: "503 unavailable retry-after=7", list: "503 unavailable retry-after=7" },
  { name: "own private, sessions down", repo: OWN, visibility: "private", viewer: { kind: "sessions_down" }, shapes: "503 unavailable", list: "503 unavailable" },
  { name: "own private, the App absent is never asked of its own", repo: OWN, visibility: "private", appAbsent: true, viewer: { ...person, role: "member" }, shapes: "200", list: "200" },
  // A registered runner's token: the list route's one exception; the shapes read only who the session says.
  { name: "own private, runner token, signed out", repo: OWN, visibility: "private", viewer: { kind: "signed_out" }, runnerOn: OWN, shapes: "401 authentication", list: "200" },
  // A request with a bearer token is read by that credential, never its cookie: a runner's token is no run
  // credential, so the shapes read it as nobody, whoever the cookie names (RunCredentials.resolveWith).
  { name: "own private, runner token, no role", repo: OWN, visibility: "private", viewer: { ...person, role: null }, runnerOn: OWN, shapes: "401 authentication", list: "200" },
  { name: "own private, runner token, member", repo: OWN, visibility: "private", viewer: { ...person, role: "member" }, runnerOn: OWN, shapes: "401 authentication", list: "200" },
  { name: "own private, another repository's runner token", repo: OWN, visibility: "private", viewer: { kind: "signed_out" }, runnerOn: OTHER, shapes: "401 authentication", list: "401 authentication" },
  { name: "own private, runner token, sessions down", repo: OWN, visibility: "private", viewer: { kind: "sessions_down" }, runnerOn: OWN, shapes: "503 unavailable", list: "200" },
  // Another repository the deployment acts on.
  { name: "other private, member", repo: OTHER, visibility: "private", viewer: { ...person, role: "member" }, shapes: "200", list: "200" },
  { name: "other private, guest", repo: OTHER, visibility: "private", viewer: { ...person, role: "guest" }, shapes: "200", list: "200" },
  { name: "other private, no role", repo: OTHER, visibility: "private", viewer: { ...person, role: null }, shapes: "403 forbidden", list: "403 forbidden" },
  { name: "other private, signed out", repo: OTHER, visibility: "private", viewer: { kind: "signed_out" }, shapes: "401 authentication", list: "401 authentication" },
  // Where the App can't act (CANT_ACT), nobody has a role: the public check decides (Api.ts readRefusal).
  { name: "other private, the App can't act there", repo: OTHER, visibility: "private", viewer: { kind: "person_cant_act" }, shapes: "403 forbidden", list: "403 forbidden" },
  { name: "other public, the App can't act there", repo: OTHER, visibility: "public", viewer: { kind: "person_cant_act" }, shapes: "200", list: "200" },
  { name: "other public, signed out", repo: OTHER, visibility: "public", viewer: { kind: "signed_out" }, shapes: "200", list: "200" },
  // An About read found the App absent: nobody reads, a runner's token included.
  { name: "other, App absent, member", repo: OTHER, visibility: "private", appAbsent: true, viewer: { ...person, role: "member" }, shapes: "404 app_not_installed", list: "404 app_not_installed" },
  { name: "other, App absent, signed out", repo: OTHER, visibility: "public", appAbsent: true, viewer: { kind: "signed_out" }, shapes: "404 app_not_installed", list: "404 app_not_installed" },
  { name: "other, App absent, runner token", repo: OTHER, visibility: "private", appAbsent: true, viewer: { kind: "signed_out" }, runnerOn: OTHER, shapes: "404 app_not_installed", list: "404 app_not_installed" },
  { name: "other private, runner token, signed out", repo: OTHER, visibility: "private", viewer: { kind: "signed_out" }, runnerOn: OTHER, shapes: "401 authentication", list: "200" },
  // Not acted on: GITHUB_ALLOWED_REPOSITORIES leaves it out, or the deployment has no App.
  { name: "elsewhere, member", repo: ELSEWHERE, visibility: "public", viewer: { ...person, role: "member" }, shapes: "404 not_found", list: "404 not_found" },
  { name: "elsewhere, runner token", repo: ELSEWHERE, visibility: "public", viewer: { kind: "signed_out" }, runnerOn: ELSEWHERE, shapes: "404 not_found", list: "404 not_found" },
  { name: "other with no App, member", repo: OTHER, visibility: "public", noApp: true, viewer: { ...person, role: "member" }, shapes: "404 not_found", list: "404 not_found" },
  // Order: the deployment's checks, then the request's own validation, then who reads.
  { name: "own private, invalid request, signed out", repo: OWN, visibility: "private", viewer: { kind: "signed_out" }, invalid: true, shapes: "400 invalid", list: "400 invalid" },
  { name: "other, App absent, invalid request", repo: OTHER, visibility: "private", appAbsent: true, viewer: { kind: "signed_out" }, invalid: true, shapes: "404 app_not_installed", list: "404 app_not_installed" },
  { name: "elsewhere, invalid request", repo: ELSEWHERE, visibility: "private", viewer: { kind: "signed_out" }, invalid: true, shapes: "404 not_found", list: "404 not_found" },
]

/** `RepoRoles` as GitHub answers `viewer`'s role on every repository. */
const rolesFor = (viewer: Viewer): RepoRoles.RepoRoles<never> => ({
  repository: OWN,
  resolve: (actor, target) =>
    viewer.kind === "person_cant_act"
      ? Effect.fail(new RepoRoles.RoleRefused({ code: "app_not_installed" }))
      : viewer.kind === "person_roles_down"
      ? Effect.fail(new RepoRoles.RoleRefused({ code: "github_unavailable", retryAfterSeconds: 7 }))
      : Effect.succeed({
        role: viewer.kind === "person" ? viewer.role : null,
        held: viewer.kind === "person" && viewer.role !== null
          ? Option.some({ repoId: target.id, personId: actor.subject.id, role: viewer.role })
          : Option.none(),
      }),
})

const seed = async (cell: Cell) => {
  const repo = cell.repo
  await sql(
    runtime,
    `INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, created_at, updated_at, source_updated_at, fetched_at)
    VALUES ('${repo.id}#7', '${repo.id}', 7, 'issue', 7, 'Seven', 'Body', 'open', now(), now(), now(), now())`,
  )
  await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('${repo.id}', 1, ${cell.visibility === "private"})`)
  if (cell.appAbsent === true) {
    await sql(runtime, `INSERT INTO repo_about (repo_id, app_absent_until) VALUES ('${repo.id}', now() + interval '1 hour')`)
  }
  if (cell.runnerOn !== undefined) {
    await sql(
      runtime,
      `INSERT INTO runners (repo_id, name, capacity, token_sha256, added_by)
      VALUES ('${cell.runnerOn.id}', 'readers-runner', 1, '${digestSync(RUNNER_TOKEN)}', 'test')`,
    )
  }
}

const harnessFor = async (cell: Cell) => {
  const github = scriptedGitHub(cell.repo.owner, cell.repo.name)
  github.private = cell.visibility === "private"
  const viewer = cell.viewer
  return githubHarness(runtime, {
    own: OWN,
    github,
    allowed: ACTED_ON,
    roles: rolesFor(viewer),
    ...(cell.noApp === true ? { app: null } : {}),
    ...(viewer.kind === "signed_out"
      ? { actor: null }
      : viewer.kind === "sessions_down"
      ? { sessions: Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) })) }
      : { actor: { ...member(), role: viewer.kind === "person" ? viewer.role : "member" } }),
  })
}

/** A response as the matrix writes it: its status, a refusal's code, and how long it asks to wait. */
const answerOf = async (response: Response) => {
  const wait = response.headers.get("retry-after")
  if (response.status === 200) {
    await response.arrayBuffer()
    return "200"
  }
  const body = await response.text()
  const code = (() => {
    try {
      return (JSON.parse(body) as { code?: string }).code
    } catch {
      return undefined
    }
  })()
  return [String(response.status), code, wait === null ? undefined : `retry-after=${wait}`].filter((part) => part !== undefined).join(" ")
}

const repoParam = (repo: Repo) => `repo=${encodeURIComponent(`${repo.owner}/${repo.name}`)}`

/** The repository shapes a page reads: the list's summaries, and the issue page's item and comments. */
const shapeReaders = (cell: Cell): ReadonlyArray<readonly [string, string]> => {
  const number = cell.invalid === true ? "not-a-number" : "7"
  return [
    ["summaries", `${ITEM_SUMMARIES_SHAPE_ROUTE}?${repoParam(cell.repo)}&offset=-1`],
    ["items", `${ITEMS_SHAPE_ROUTE}?${repoParam(cell.repo)}&offset=-1`],
    ["issue item", `${ITEMS_SHAPE_ROUTE}?${repoParam(cell.repo)}&number=${number}&offset=-1`],
    ["issue comments", `${COMMENTS_SHAPE_ROUTE}?${repoParam(cell.repo)}&number=${number}&offset=-1`],
  ]
}

const listPath = (cell: Cell) => `${issuesRoute(cell.repo.owner, cell.repo.name)}?state=all&limit=${cell.invalid === true ? "lots" : "5"}`

describe("one access matrix for every reader of a repository's issues", () => {
  test.each(MATRIX)("$name", async (cell) => {
    await seed(cell)
    const h = await harnessFor(cell)
    const headers: Record<string, string> = cell.runnerOn === undefined ? {} : { authorization: `Bearer ${RUNNER_TOKEN}` }
    const answers: Record<string, string> = {}
    // An invalid request names an item number that can't be: only the issue page's shapes take one.
    const readers = shapeReaders(cell).filter(([reader]) => cell.invalid !== true || reader.startsWith("issue "))
    for (const [reader, path] of readers) answers[reader] = await answerOf(await h.fetch(path, { headers }))
    answers.list = await answerOf(await h.fetch(listPath(cell), { headers }))
    expect(answers).toEqual({
      ...Object.fromEntries(readers.map(([reader]) => [reader, cell.shapes])),
      list: cell.list,
    })
  }, 60_000)
})
