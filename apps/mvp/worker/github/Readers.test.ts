// Every reader of a repository's issues answers one access matrix the same way (devpriv FINAL §1.1, step 0): the
// repository shapes (summaries, an issue's item and its comments, the issue page's `?number=` shapes) and the issue
// list route `GET /api/repos/<owner>/<name>/issues`. Each cell is a real request through the routes' handler, over the
// compose Postgres and Electric; only who has which role is scripted, as `RepoRoles` would answer it. The table pins
// today's answers, ordering included (the deployment's checks, then a request's own validation, then who reads), so
// the extraction of `repositoryReadable` changes none of them. The list route's one documented difference: a runner
// registered on the repository reads its issues with its token.
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { digestSync } from "@smthrs/crypto"
import {
  COMMENTS_SHAPE_ROUTE,
  issuesRoute,
  ITEMS_SHAPE_ROUTE,
  ITEM_SUMMARIES_SHAPE_ROUTE,
  SYNC_SHAPE_ROUTE,
  TRIAGE_SETTINGS_SHAPE_ROUTE,
} from "../../src/features/issues/contract.ts"
import { CHECKS_SHAPE_ROUTE, compareRoute, PULL_COMMITS_SHAPE_ROUTE, PULL_RECEIPT_HEADER, PULLS_SHAPE_ROUTE, REVIEWS_SHAPE_ROUTE } from "../../src/features/pulls/contract.ts"
import { WORK_LINKS_SHAPE_ROUTE } from "../../src/features/issues/work.ts"
import { ACTIONS_SHAPE_ROUTE } from "../../src/features/actions/contract.ts"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA, type Role, type SessionState } from "../../src/features/auth/contract.ts"
import * as Actor from "../Actor.ts"
import * as RunCredentials from "../RunCredentials.ts"
import { signedIn as signedInAs, testFile } from "../test/harness.ts"
import { cookie, signInHarness } from "../test/signIn.ts"
import * as Metrics from "./Metrics.ts"
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

/** `RepoRoles` as GitHub answers `viewer`'s role on every repository, counting each read. */
const rolesFor = (viewer: Viewer, calls: { roles: number }): RepoRoles.RepoRoles<never> => ({
  repository: OWN,
  resolve: (actor, target) =>
    Effect.suspend(() => {
      calls.roles++
      return viewer.kind === "person_cant_act"
        ? Effect.fail(new RepoRoles.RoleRefused({ code: "app_not_installed" }))
        : viewer.kind === "person_roles_down"
        ? Effect.fail(new RepoRoles.RoleRefused({ code: "github_unavailable", retryAfterSeconds: 7 }))
        : Effect.succeed({
          role: viewer.kind === "person" ? viewer.role : null,
          held: viewer.kind === "person" && viewer.role !== null
            ? Option.some({ repoId: target.id, personId: actor.subject.id, role: viewer.role })
            : Option.none(),
        })
    }),
})

const seed = async (cell: Cell) => {
  const repo = cell.repo
  await sql(
    runtime,
    `INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, created_at, updated_at, source_updated_at, fetched_at)
    VALUES ('${repo.id}#7', '${repo.id}', 7, 'issue', 7, 'Seven', 'Body', 'open', now(), now(), now(), now())`,
  )
  await sql(
    runtime,
    `INSERT INTO comments (id, repo_id, item_id, github_id, body, created_at, updated_at, source_updated_at, fetched_at)
    VALUES ('${repo.id}/comment/70', '${repo.id}', '${repo.id}#7', 70, 'Seventy', now(), now(), now(), now())`,
  )
  await sql(runtime, `INSERT INTO github_repositories (repo_id, github_id, private) VALUES ('${repo.id}', 1, ${cell.visibility === "private"})`)
  if (cell.appAbsent === true) {
    await sql(runtime, `INSERT INTO repo_about (repo_id, app_absent_until) VALUES ('${repo.id}', now() + interval '1 hour')`)
  }
  if (cell.runnerOn !== undefined) {
    await sql(
      runtime,
      `INSERT INTO runners (repo_id, name, capacity, token_sha256, added_by, repo_authorized_at)
      VALUES ('${cell.runnerOn.id}', 'readers-runner', 1, '${digestSync(RUNNER_TOKEN)}', 'test', now())`,
    )
    // A runner reads only while it is current as a claim requires (decision 0148): registered through the
    // repository's Admin role, with the App's installation on its repository recorded, where the App is there.
    if (cell.appAbsent !== true) {
      await sql(
        runtime,
        `INSERT INTO github_repositories (repo_id, github_id, installation_id) VALUES ('${cell.runnerOn.id}', 2, 42)
        ON CONFLICT (repo_id) DO UPDATE SET installation_id = 42`,
      )
    }
  }
}

/** `base`, counting each request's resolution of who asks. */
const countedSessions = (base: Layer.Layer<Actor.Sessions>, calls: { sessions: number }) =>
  Layer.effect(
    Actor.Sessions,
    Effect.map(Effect.service(Actor.Sessions), (sessions) =>
      Actor.Sessions.of({ ...sessions, resolve: Effect.andThen(Effect.sync(() => void calls.sessions++), sessions.resolve) })),
  ).pipe(Layer.provide(base))

const harnessFor = async (cell: Cell) => {
  const github = scriptedGitHub(cell.repo.owner, cell.repo.name)
  github.private = cell.visibility === "private"
  const viewer = cell.viewer
  const calls = { roles: 0, sessions: 0 }
  const base = viewer.kind === "signed_out"
    ? Actor.signedOut
    : viewer.kind === "sessions_down"
    ? Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }))
    : signedInAs({ ...member(), role: viewer.kind === "person" ? viewer.role : "member" })
  const h = await githubHarness(runtime, {
    own: OWN,
    github,
    allowed: ACTED_ON,
    roles: rolesFor(viewer, calls),
    ...(cell.noApp === true ? { app: null } : {}),
    sessions: countedSessions(base, calls),
  })
  return { ...h, calls }
}

/** A response as the matrix writes it: its status, a refusal's code, and how long it asks to wait; and a 200's body. */
const answerOf = async (response: Response) => {
  const wait = response.headers.get("retry-after")
  const body = await response.text()
  if (response.status === 200) return { answer: "200", body, receipt: response.headers.get(PULL_RECEIPT_HEADER) }
  const code = (() => {
    try {
      return (JSON.parse(body) as { code?: string }).code
    } catch {
      return undefined
    }
  })()
  return {
    answer: [String(response.status), code, wait === null ? undefined : `retry-after=${wait}`].filter((part) => part !== undefined).join(" "),
    body,
    receipt: null,
  }
}

/**
 * One shape read as a device's Electric client makes it: the route's answer, the same request again when it answers
 * `409 must-refetch`.
 */
const readShape = async (h: Awaited<ReturnType<typeof harnessFor>>, path: string, headers: Record<string, string>) => {
  let next = path
  for (let attempt = 0;; attempt++) {
    const response = await h.fetch(next, { headers })
    const handle = response.headers.get("electric-handle")
    // Electric's client (`@electric-sql/client`): a 409 names the shape's new handle; ask again from its start.
    if (response.status !== 409 || handle === null || attempt === 3) return response
    await response.text()
    const url = new URL(next, "http://localhost")
    url.searchParams.set("offset", "-1")
    url.searchParams.set("handle", handle)
    url.searchParams.delete("live")
    next = `${url.pathname}${url.search}`
  }
}

const repoParam = (repo: Repo) => `repo=${encodeURIComponent(`${repo.owner}/${repo.name}`)}`

/** One repository shape a page reads: its name, its path, the table its metric counts under, and whether it refreshes a pull. */
interface Reader {
  readonly reader: string
  readonly path: string
  readonly table: string
  readonly refresh?: boolean
  /** It takes an item number, or a pull's to refresh: an invalid request names one that can't be. */
  readonly numbered?: boolean
}

/** Every repository shape (Api.ts REPOSITORY_SHAPES), the issue page's numbered ones, and the pull shapes' refresh paths. */
const shapeReaders = (cell: Cell): ReadonlyArray<Reader> => {
  const number = cell.invalid === true ? "not-a-number" : "7"
  const at = (route: string, extra = "") => `${route}?${repoParam(cell.repo)}${extra}&offset=-1`
  const all: ReadonlyArray<Reader> = [
    { reader: "summaries", path: at(ITEM_SUMMARIES_SHAPE_ROUTE), table: "items" },
    { reader: "items", path: at(ITEMS_SHAPE_ROUTE), table: "items" },
    { reader: "comments", path: at(COMMENTS_SHAPE_ROUTE), table: "comments" },
    { reader: "sync", path: at(SYNC_SHAPE_ROUTE), table: "github_sync" },
    { reader: "triage settings", path: at(TRIAGE_SETTINGS_SHAPE_ROUTE), table: "triage_settings" },
    { reader: "pulls", path: at(PULLS_SHAPE_ROUTE), table: "pulls" },
    { reader: "pull commits", path: at(PULL_COMMITS_SHAPE_ROUTE), table: "pull_commits" },
    { reader: "reviews", path: at(REVIEWS_SHAPE_ROUTE), table: "reviews" },
    { reader: "checks", path: at(CHECKS_SHAPE_ROUTE), table: "runs" },
    { reader: "work links", path: at(WORK_LINKS_SHAPE_ROUTE), table: "work_links" },
    { reader: "issue item", path: at(ITEMS_SHAPE_ROUTE, `&number=${number}`), table: "items", numbered: true },
    { reader: "issue comments", path: at(COMMENTS_SHAPE_ROUTE, `&number=${number}`), table: "comments", numbered: true },
    { reader: "refresh pull commits", path: at(PULL_COMMITS_SHAPE_ROUTE, `&refresh=${number}`), table: "pull_commits", refresh: true, numbered: true },
    { reader: "refresh reviews", path: at(REVIEWS_SHAPE_ROUTE, `&refresh=${number}`), table: "reviews", refresh: true, numbered: true },
    { reader: "refresh checks", path: at(CHECKS_SHAPE_ROUTE, `&refresh=${number}`), table: "runs", refresh: true, numbered: true },
  ]
  // An invalid request names a number that can't be: only the readers that take one.
  return cell.invalid === true ? all.filter((reader) => reader.numbered === true) : all
}

/**
 * The repository readers outside the issues: its actions shape (its runs), a comparison of two commits, and the role
 * route's `readable`. A comparison the gate lets through asks GitHub for it.
 */
const otherReaders = async (h: Awaited<ReturnType<typeof harnessFor>>, cell: Cell, headers: Record<string, string>) => {
  const actions = (await answerOf(await h.fetch(`${ACTIONS_SHAPE_ROUTE}?${repoParam(cell.repo)}&offset=-1`, { headers }))).answer
  const compared = (await answerOf(await h.fetch(compareRoute(cell.repo.owner, cell.repo.name, "a".repeat(40), "b".repeat(40)), { headers }))).answer
  const asked = h.github.calls.some((call) => call.path.includes("/compare/"))
  return {
    actions,
    compare: cell.shapes === "200" ? { asked } : { answer: compared, asked },
    readable: await h.mayRead({ owner: cell.repo.owner, name: cell.repo.name, id: cell.repo.id }, headers),
  }
}

const listPath = (cell: Cell) => `${issuesRoute(cell.repo.owner, cell.repo.name)}?state=all&limit=${cell.invalid === true ? "lots" : "5"}`

const values = (body: string) =>
  (JSON.parse(body) as Array<{ value?: Record<string, unknown> }>).flatMap((row) => (row.value === undefined ? [] : [row.value]))

/** A refusal at the deployment or the request's own validation: nothing about the viewer is read. */
const beforeViewer = (answer: string) => ["404 not_found", "404 app_not_installed", "400 invalid"].includes(answer)

// Main's landing of 6d9e7853, 2026-11-02: "other public, signed out" read `409` for the work links. The truncate of the
// last cell's rows was still replicating, so Electric answered the fresh request `409 must-refetch`, which a device's
// client follows and this file's reader didn't. Forced here: a request under the shape's handle from before a truncate
// Electric has replicated.
test("a shape read after a truncate follows Electric's 409 must-refetch, as a device's client does", async () => {
  const cell = MATRIX.find((each) => each.name === "other public, signed out")!
  await seed(cell)
  const h = await harnessFor(cell)
  const path = `${WORK_LINKS_SHAPE_ROUTE}?${repoParam(cell.repo)}&offset=-1`
  const opened = await h.fetch(path)
  expect(opened.status).toBe(200)
  await opened.text()
  const handle = opened.headers.get("electric-handle")!
  await sql(runtime, `TRUNCATE work_links`)
  // Electric has replicated the truncate once the handle's live request answers 409.
  let offset = opened.headers.get("electric-offset")!
  for (;;) {
    const live = await h.fetch(`${WORK_LINKS_SHAPE_ROUTE}?${repoParam(cell.repo)}&offset=${offset}&handle=${handle}&live=true`)
    await live.text()
    if (live.status === 409) break
    expect(live.status).toBe(200)
    offset = live.headers.get("electric-offset")!
  }
  // The device asks on from where it was, under its handle: Electric answers must-refetch, which the client follows.
  const answered = await answerOf(
    await readShape(h, `${WORK_LINKS_SHAPE_ROUTE}?${repoParam(cell.repo)}&offset=${offset}&handle=${handle}`, {}),
  )
  expect(answered.answer).toBe("200")
})

describe("one access matrix for every reader of a repository's issues", () => {
  test.each(MATRIX)("$name", async (cell) => {
    await seed(cell)
    const h = await harnessFor(cell)
    const headers: Record<string, string> = cell.runnerOn === undefined ? {} : { authorization: `Bearer ${RUNNER_TOKEN}` }
    const readers = shapeReaders(cell)
    const answers: Record<string, string> = {}
    const bodies: Record<string, string> = {}
    const receipts: Record<string, string | null> = {}
    for (const { reader, path } of readers) {
      const answered = await answerOf(await readShape(h, path, headers))
      answers[reader] = answered.answer
      bodies[reader] = answered.body
      receipts[reader] = answered.receipt
    }
    const listed = await answerOf(await h.fetch(listPath(cell), { headers }))
    answers.list = listed.answer
    expect(answers).toEqual({
      ...Object.fromEntries(readers.map(({ reader }) => [reader, cell.shapes])),
      list: cell.list,
    })

    // Step 5 (devpriv FINAL): the actions shape, compare and the role route's `readable` answer the same matrix; they
    // checked only the viewer before, so a repository the deployment doesn't act on, or where the App is absent, was
    // read by its public check. Each is one more request through the viewer stage when it reaches it.
    // (An invalid request names an item number; these readers take none, so they sit those cells out.)
    if (cell.invalid !== true) {
      const others = await otherReaders(h, cell, headers)
      expect(others).toEqual({
        actions: cell.shapes,
        // A comparison the gate lets through asks GitHub for it, whatever GitHub then answers; a refused one never does.
        compare: cell.shapes === "200" ? { asked: true } : { answer: cell.shapes, asked: false },
        readable: cell.shapes === "200",
      })
    }

    // What was read to answer: nothing of the viewer before the deployment's checks and the request's own pass; once
    // they pass, who asks is resolved once per request, and a person's role read once per request.
    // The other readers below (actions, compare, readable) each reach the viewer stage when the shapes do.
    const reached = readers.filter(() => !beforeViewer(cell.shapes)).length + (beforeViewer(cell.list) ? 0 : 1) +
      (beforeViewer(cell.shapes) || cell.invalid === true ? 0 : 3)
    const personal = cell.viewer.kind !== "signed_out" && cell.viewer.kind !== "sessions_down"
    // A request carrying a runner's token is read by its credential, which reads as nobody: no role is read for it.
    const asPerson = personal && cell.runnerOn === undefined
    expect(h.calls).toEqual({ sessions: reached, roles: asPerson ? reached : 0 })
    if (beforeViewer(cell.shapes)) {
      // Refused before anyone was asked about: GitHub never asked, nothing started.
      expect(h.github.calls).toEqual([])
      expect(h.starts).toEqual([])
    } else {
      // Reconcile's admission runs beside the viewer's check for items and summaries, refused or not.
      expect(h.starts.some((start) => start.flow === "github/Reconcile")).toBe(true)
    }
    // A pull's refresh starts its Apply only once the viewer may read (one execution for pull 7, whichever of its
    // three shapes asked); its answer carries the refresh's receipt.
    const refreshed = h.starts.filter((start) => start.flow === "github/Apply").length
    expect(refreshed).toBe(cell.shapes === "200" ? 1 : 0)
    for (const { reader, refresh } of readers) {
      if (refresh === true) expect([reader, receipts[reader] !== null]).toEqual([reader, cell.shapes === "200"])
    }

    // The shapes count a refusal at the App's absence or the viewer's under their table, a refresh's viewer refusal
    // excepted; never a deployment's not_found or an invalid request.
    const status = cell.shapes.split(" ")[0]!
    const counted = (reader: Reader) =>
      cell.shapes === "404 app_not_installed" || (!beforeViewer(cell.shapes) && cell.shapes !== "200" && reader.refresh !== true)
    // (A served read is counted by the shape proxy itself, as every 200 is.)
    if (cell.shapes !== "200") {
      for (const table of new Set(readers.map((reader) => reader.table))) {
        // The actions shape counts under `runs` as the checks shape does.
        const actionsCounted = cell.invalid !== true && table === "runs" && counted({ reader: "actions", path: "", table: "runs" }) ? 1 : 0
        const expected = readers.filter((reader) => reader.table === table && counted(reader)).length + actionsCounted
        expect([table, h.count(Metrics.shapes, { table, status, live: "false" })]).toEqual([table, expected])
      }
    }
    const listOutcome = cell.list === "200" ? "listed" : beforeViewer(cell.list) ? cell.list.split(" ")[1]! : "refused"
    expect(h.count(Metrics.issueLists, { outcome: listOutcome })).toBe(1)

    // A read that answers carries the repository's rows (Electric sends values as text).
    if (cell.list === "200") expect((JSON.parse(listed.body) as Array<{ number: number }>).map((issue) => issue.number)).toEqual([7])
    if (cell.shapes === "200") {
      expect(values(bodies["summaries"]!).map((row) => row.title)).toEqual(["Seven"])
      expect(values(bodies["issue item"]!).map((row) => [row.number, row.title, row.body])).toEqual([["7", "Seven", "Body"]])
      expect(values(bodies["issue comments"]!).map((row) => row.body)).toEqual(["Seventy"])
    }
  }, 60_000)
})

// Sign-in's own sessions (worker/SignIn.ts): a real signed session cookie, resolved through its store, alone and beside
// a run credential, valid or forged, and with a device header naming its person, another, or no device data.
describe("a real signed session cookie reads every reader as its person", () => {
  const cell: Cell = { name: "own private", repo: OWN, visibility: "private", viewer: { ...person, role: "member" }, shapes: "200", list: "200" }

  const signedInBrowser = async () => {
    const signIn = await signInHarness(runtime)
    const { cookies } = await signIn.signInAs()
    const identity = await signIn.session(cookies) as SessionState
    if (!identity.signedIn) throw new Error("expected a signed-in person")
    const personId = identity.personId!
    const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) =>
      Effect.orDie(client<{ readonly id: string }>`SELECT id FROM sessions WHERE person_id = ${personId}`)))
    // A run credential minted in that session, as the credential route mints one for the person's agent.
    const credential = await runtime.runPromise(Effect.gen(function* () {
      const credentials = yield* RunCredentials.RunCredentials
      const claims = RunCredentials.claimsFor(
        { subject: { kind: "person", id: personId }, role: "member", session: row!.id },
        crypto.randomUUID(),
        { flow: "chat/Answer" },
        Date.now(),
      )
      if (claims._tag === "Failure") return yield* Effect.die("no claims")
      return yield* credentials.sign(claims.success)
    }).pipe(Effect.provide(signIn.sessions)))
    return { signIn, cookies, personId, credential }
  }

  test.each([
    ["the cookie alone", (_: string, __: string) => ({}), "200"],
    ["the device naming its person", (personId: string, __: string) => ({ [DEVICE_PERSON_HEADER]: personId }), "200"],
    ["a page with no device data", (_: string, __: string) => ({ [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA }), "200"],
    ["the device naming another person", (_: string, __: string) => ({ [DEVICE_PERSON_HEADER]: "person-someone-else" }), "401 authentication"],
    ["a valid run credential beside it", (_: string, credential: string) => ({ authorization: `Bearer ${credential}` }), "200"],
    ["a forged credential beside it", (_: string, __: string) => ({ authorization: "Bearer forged" }), "401 authentication"],
    ["a valid credential and another person's device", (_: string, credential: string) => ({ authorization: `Bearer ${credential}`, [DEVICE_PERSON_HEADER]: "person-someone-else" }), "401 authentication"],
  ] as const)("%s", async (_name, extra, expected) => {
    await seed(cell)
    const browser = await signedInBrowser()
    const calls = { roles: 0, sessions: 0 }
    const github = scriptedGitHub(OWN.owner, OWN.name)
    github.private = true
    const h = await githubHarness(runtime, { own: OWN, github, allowed: ACTED_ON, roles: rolesFor(cell.viewer, calls), sessions: browser.signIn.sessions })
    const headers = { cookie: cookie(browser.cookies), ...extra(browser.personId, browser.credential) }
    const answers: Record<string, string> = {}
    for (const { reader, path } of shapeReaders(cell).filter(({ refresh }) => refresh !== true)) {
      answers[reader] = (await answerOf(await h.fetch(path, { headers }))).answer
    }
    answers.list = (await answerOf(await h.fetch(listPath(cell), { headers }))).answer
    expect(new Set(Object.values(answers))).toEqual(new Set([expected]))
  }, 60_000)

  test("without the cookie the same requests are signed out", async () => {
    await seed(cell)
    const browser = await signedInBrowser()
    const github = scriptedGitHub(OWN.owner, OWN.name)
    github.private = true
    const h = await githubHarness(runtime, { own: OWN, github, allowed: ACTED_ON, roles: rolesFor(cell.viewer, { roles: 0 }), sessions: browser.signIn.sessions })
    expect((await answerOf(await h.fetch(listPath(cell)))).answer).toBe("401 authentication")
    expect((await answerOf(await h.fetch(`${ITEMS_SHAPE_ROUTE}?${repoParam(OWN)}&offset=-1`))).answer).toBe("401 authentication")
  }, 60_000)
})

// A pull shape with `?refresh=` decides who may read once, before both the refresh and the read: neither runs on a
// refusal, and an answer that would change during the request is not asked again (the single-check contract).
describe("a pull's refresh is authorized once, before both the refresh and the read", () => {
  test.each([PULL_COMMITS_SHAPE_ROUTE, REVIEWS_SHAPE_ROUTE, CHECKS_SHAPE_ROUTE])("%s", async (route) => {
    const cell: Cell = { name: "own private", repo: OWN, visibility: "private", viewer: { ...person, role: "member" }, shapes: "200", list: "200" }
    await seed(cell)
    // A role that is held at the first read and gone at any later one.
    let reads = 0
    const roles: RepoRoles.RepoRoles<never> = {
      repository: OWN,
      resolve: (actor, target) => Effect.sync(() => {
        reads++
        const role = reads === 1 ? "member" as const : null
        return { role, held: role === null ? Option.none() : Option.some({ repoId: target.id, personId: actor.subject.id, role }) }
      }),
    }
    const github = scriptedGitHub(OWN.owner, OWN.name)
    github.private = true
    const h = await githubHarness(runtime, { own: OWN, github, allowed: ACTED_ON, roles })
    const answered = await answerOf(await h.fetch(`${route}?${repoParam(OWN)}&refresh=7&offset=-1`))
    expect([answered.answer, answered.receipt !== null]).toEqual(["200", true])
    expect(reads).toBe(1)
    expect(h.starts.filter((start) => start.flow === "github/Apply")).toHaveLength(1)
    // Refused at that one check: no refresh starts, nothing is read.
    const refused = await answerOf(await h.fetch(`${route}?${repoParam(OWN)}&refresh=7&offset=-1`))
    expect(refused.answer).toBe("403 forbidden")
    expect(reads).toBe(2)
    expect(h.starts.filter((start) => start.flow === "github/Apply")).toHaveLength(1)
  }, 60_000)
})
