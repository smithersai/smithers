// Projecting a re-read (worker/github/Project.ts): a comment listing cut short by its page budget tombstones nothing,
// because a comment it didn't reach may still be on GitHub. The full path runs in worker/github/Flows.test.ts.
import { beforeEach, describe, expect, test } from "vitest"
import { testFile } from "../test/harness.ts"
import { Effect } from "effect"
import { HttpClient } from "effect/http"
import { withToken } from "./Calls.ts"
import { project, readIssue } from "./Project.vibe"
import * as Store from "./Store.vibe"
import { admit, comments, REPOSITORY, reset, items, services, writeRow } from "./test/fixtures.ts"
import { scriptedGitHub } from "./test/scriptedGitHub.ts"

const runtime = testFile("github_project")

beforeEach(() => reset(runtime))

const at = new Date().toISOString()
const issue = {
  id: 1,
  node_id: "I_1",
  number: 1,
  title: "Long thread",
  body: "Body",
  state: "open" as const,
  state_reason: null,
  user: null,
  comments: 2,
  created_at: at,
  updated_at: at,
  closed_at: null,
  labels: [],
}
const comment = (id: number) => ({
  id,
  node_id: `IC_${id}`,
  body: `Comment ${id}`,
  user: null,
  created_at: at,
  updated_at: at,
  issue_url: "https://api.github.test/repos/acme/widgets/issues/1",
})

describe("project", () => {
  test("a listing cut short tombstones nothing; a complete one tombstones what it lacks", async () => {
    const fetched = (ids: ReadonlyArray<number>, complete: boolean, fetchedAt: number) =>
      ({ kind: "found", issue, comments: ids.map(comment), complete, fetchedAt }) as const
    await runtime.runPromise(project(REPOSITORY, 1, fetched([1, 2], true, Date.now())))
    expect(await runtime.runPromise(project(REPOSITORY, 1, fetched([1], false, Date.now() + 1_000)))).toEqual({
      outcome: "applied",
      changed: 0,
    })
    expect((await comments(runtime)).map((row) => row.deleted)).toEqual([false, false])
    expect(await runtime.runPromise(project(REPOSITORY, 1, fetched([1], true, Date.now() + 2_000)))).toEqual({
      outcome: "applied",
      changed: 1,
    })
    expect((await comments(runtime)).map((row) => row.deleted)).toEqual([false, true])
  })
})

test("reading an issue projects its conversation, and a 410 tombstones it with its comments", async () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const opened = github.open("Read back", "Issue body")
  github.comment(opened.number, "Still here")
  const { services: built } = await services(runtime, github)
  const read = () => runtime.runPromise(Effect.gen(function* () {
    const token = yield* built.tokens.forInstallation(REPOSITORY, "read")
    return yield* readIssue(REPOSITORY, opened.number).pipe(withToken(token, built.apiBaseUrl))
  }).pipe(Effect.provideService(HttpClient.HttpClient, built.http)))

  expect(await read()).toEqual({ outcome: "applied", changed: 2 })
  expect(await items(runtime)).toMatchObject([{ title: "Read back", deleted: false }])
  expect(await comments(runtime)).toMatchObject([{ body: "Still here", deleted: false }])

  github.faults.push({ match: (method, path) => method === "GET" && path.endsWith("/issues/" + opened.number), status: 410 })
  expect(await read()).toEqual({ outcome: "tombstoned", changed: 1 })
  expect(await items(runtime)).toMatchObject([{ title: "Read back", deleted: true }])
  expect(await comments(runtime)).toMatchObject([{ body: "Still here", deleted: true }])
})

describe("settleWrite", () => {
  test("a write settles once: a second settling, done or not, writes no row and projects nothing", async () => {
    const writeId = await admit(runtime, {
      actorId: "someone",
      sessionId: null,
      via: "agent",
      payload: { op: "issue/create", title: "Once", body: "" },
    })
    let projected = 0
    const projection = Effect.sync(() => void (projected += 1))
    const done = { status: "done", itemNumber: 4, githubId: 40 } as const
    expect(await runtime.runPromise(Store.settleWrite(writeId, done, projection))).toBe(true)
    expect(await runtime.runPromise(Store.settleWrite(writeId, done, projection))).toBe(false)
    expect(await runtime.runPromise(Store.settleWrite(writeId, { status: "failed", failure: "unavailable" }))).toBe(false)
    expect(projected).toBe(1)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", itemNumber: 4 })
  })
})


describe("observation ordering regressions", () => {
  const base = Date.now() - 10_000
  test("an unchanged comment read fences an older listing tombstone", async () => {
    await runtime.runPromise(Store.upsertComment(REPOSITORY.id, 1, comment(1), base))
    await runtime.runPromise(Store.upsertComment(REPOSITORY.id, 1, comment(1), base + 2000))
    await runtime.runPromise(Store.tombstoneCommentsExcept(REPOSITORY.id, 1, [], base + 1000))
    expect((await comments(runtime))[0]!.deleted).toBe(false)
  })
  test("an older comment read cannot resurrect a listing tombstone", async () => {
    await runtime.runPromise(Store.upsertComment(REPOSITORY.id, 1, comment(1), base))
    await runtime.runPromise(Store.tombstoneCommentsExcept(REPOSITORY.id, 1, [], base + 2000))
    await runtime.runPromise(Store.upsertComment(REPOSITORY.id, 1, comment(1), base + 1000))
    expect((await comments(runtime))[0]!.deleted).toBe(true)
  })
  test("an older gone issue observation cannot tombstone a newer read", async () => {
    await runtime.runPromise(Store.upsertIssue(REPOSITORY.id, issue, base + 2000))
    await runtime.runPromise(project(REPOSITORY, 1, { kind: "gone", fetchedAt: base + 1000 }))
    expect((await items(runtime))[0]!.deleted).toBe(false)
  })
  test("an older found issue observation cannot undo a newer tombstone", async () => {
    await runtime.runPromise(Store.upsertIssue(REPOSITORY.id, issue, base))
    await runtime.runPromise(project(REPOSITORY, 1, { kind: "gone", fetchedAt: base + 2000 }))
    await runtime.runPromise(Store.upsertIssue(REPOSITORY.id, { ...issue, updated_at: new Date(Date.now() + 1000).toISOString() }, base + 1000))
    expect((await items(runtime))[0]!.deleted).toBe(true)
  })
})


test("repeated comment absence advances the tombstone fence without counting another deletion", async () => {
  const base = Date.now() - 10_000
  await runtime.runPromise(Store.upsertComment(REPOSITORY.id, 1, comment(1), base))
  expect(await runtime.runPromise(Store.tombstoneCommentsExcept(REPOSITORY.id, 1, [], base + 1000))).toBe(1)
  expect(await runtime.runPromise(Store.tombstoneCommentsExcept(REPOSITORY.id, 1, [], base + 3000))).toBe(0)
  await runtime.runPromise(Store.upsertComment(REPOSITORY.id, 1, comment(1), base + 2000))
  expect((await comments(runtime))[0]!.deleted).toBe(true)
})

test("a gone first observation fences an older initial issue read", async () => {
  const base = Date.now() - 10_000
  await runtime.runPromise(project(REPOSITORY, 1, { kind: "gone", fetchedAt: base + 2000 }))
  await runtime.runPromise(Store.upsertIssue(REPOSITORY.id, issue, base + 1000))
  expect(await items(runtime)).toEqual([])
})

test("a complete listing fences an unseen comment from an older listing", async () => {
  const base = Date.now() - 10_000
  await runtime.runPromise(project(REPOSITORY, 1, { kind: "found", issue, comments: [], complete: true, fetchedAt: base + 2000 }))
  await runtime.runPromise(project(REPOSITORY, 1, { kind: "found", issue, comments: [comment(1)], complete: true, fetchedAt: base + 1000 }))
  expect(await comments(runtime)).toEqual([])
})
