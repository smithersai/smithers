import { Effect } from "effect"
import { HttpClient } from "effect/http"
import { beforeEach, expect, test } from "vitest"
import { testFile } from "../test/harness.ts"
import { withToken } from "./Calls.ts"
import { fetchPull, projectPull, replaceCommits, upsertPull, upsertReview } from "./Pulls.ts"
import { REPOSITORY, reset, services, sql } from "./test/fixtures.ts"
import { BOT_LOGIN, scriptedGitHub } from "./test/scriptedGitHub.ts"

const runtime = testFile("github_ordering")
beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE pulls, pull_commits, reviews")
})
const snapshot = async () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  github.push("feature", { "A.md": "A" })
  const pull = github.openPull("feature", "A", BOT_LOGIN)
  const { services: built } = await services(runtime, github)
  const fetched = await runtime.runPromise(Effect.gen(function* () {
    const token = yield* built.tokens.forInstallation(REPOSITORY, "pulls")
    return yield* fetchPull(REPOSITORY, pull.number).pipe(withToken(token, built.apiBaseUrl))
  }).pipe(Effect.provideService(HttpClient.HttpClient, built.http), Effect.provide(built.database)))
  if (fetched.kind !== "found") throw new Error("missing pull")
  return fetched
}
const commitRows = () => sql(runtime, "SELECT sha FROM pull_commits ORDER BY position")

test("older pull snapshots cannot replace newer commits", async () => {
  const fetched = await snapshot()
  const newer = { ...fetched, fetchedAt: fetched.fetchedAt + 2000, commits: [{ ...fetched.commits[0]!, sha: "b".repeat(40) }] }
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, newer))
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, fetched))
  expect(await commitRows()).toEqual([{ sha: "b".repeat(40) }])
})

test("failed commit replacement rolls back its delete and all inserts", async () => {
  const fetched = await snapshot()
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, fetched))
  const before = await commitRows()
  await sql(runtime, "ALTER TABLE pull_commits ADD CONSTRAINT reject_commit CHECK (headline <> 'reject')")
  try {
    const commit = fetched.commits[0]!
    await runtime.runPromise(Effect.exit(replaceCommits(REPOSITORY.id, fetched.pull.number, [
      { ...commit, sha: "b".repeat(40) },
      { ...commit, sha: "c".repeat(40), commit: { ...commit.commit, message: "reject" } },
    ])))
    expect(await commitRows()).toEqual(before)
  } finally {
    await sql(runtime, "ALTER TABLE pull_commits DROP CONSTRAINT reject_commit")
  }
})

test("unchanged pull reads advance the freshness guard", async () => {
  const fetched = await snapshot()
  await runtime.runPromise(upsertPull(REPOSITORY.id, fetched.pull, fetched.baseHead, fetched.fetchedAt))
  await runtime.runPromise(upsertPull(REPOSITORY.id, fetched.pull, fetched.baseHead, fetched.fetchedAt + 2000))
  await runtime.runPromise(upsertPull(REPOSITORY.id, { ...fetched.pull, additions: 999 }, fetched.baseHead, fetched.fetchedAt + 1000))
  expect(await sql(runtime, "SELECT additions FROM pulls")).toEqual([{ additions: fetched.pull.additions }])
})

test("unchanged review reads advance the freshness guard", async () => {
  const fetched = await snapshot()
  const review = { id: 10, node_id: "R10", user: null, body: "ok", state: "APPROVED", commit_id: fetched.pull.head.sha, submitted_at: new Date().toISOString() } as const
  await runtime.runPromise(upsertReview(REPOSITORY.id, fetched.pull.number, review, fetched.fetchedAt))
  await runtime.runPromise(upsertReview(REPOSITORY.id, fetched.pull.number, review, fetched.fetchedAt + 2000))
  await runtime.runPromise(upsertReview(REPOSITORY.id, fetched.pull.number, { ...review, state: "DISMISSED" }, fetched.fetchedAt + 1000))
  expect(await sql(runtime, "SELECT state FROM reviews")).toEqual([{ state: "APPROVED" }])
})

test("a gone pull clears its pull, commits and reviews", async () => {
  const fetched = await snapshot()
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, fetched))
  await runtime.runPromise(upsertReview(REPOSITORY.id, fetched.pull.number, { id: 10, node_id: "R10", user: null, body: "ok", state: "APPROVED", commit_id: fetched.pull.head.sha, submitted_at: new Date().toISOString() }, fetched.fetchedAt))
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, { kind: "gone", fetchedAt: fetched.fetchedAt + 1000 }))
  expect(await sql(runtime, "SELECT item_id FROM pulls")).toEqual([])
  expect(await commitRows()).toEqual([])
  expect(await sql(runtime, "SELECT id FROM reviews")).toEqual([])
})


test("concurrent replacements publish one complete ordered commit list", async () => {
  const fetched = await snapshot()
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, fetched))
  const commit = fetched.commits[0]!
  const lists = ["b", "c"].map((digit) => Array.from({ length: 20 }, (_, index) => ({
    ...commit, sha: digit.repeat(38) + index.toString(16).padStart(2, "0"),
  })))
  const outcomes = await Promise.all(lists.map((list) => runtime.runPromise(Effect.exit(replaceCommits(REPOSITORY.id, fetched.pull.number, list)))))
  expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Success", "Success"])
  const held = await commitRows()
  expect(lists.map((list) => list.map(({ sha }) => ({ sha })))).toContainEqual(held)
})

test("a gone first observation fences an older initial pull snapshot", async () => {
  const fetched = await snapshot()
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, { kind: "gone", fetchedAt: fetched.fetchedAt + 2000 }))
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, fetched))
  expect(await sql(runtime, "SELECT item_id FROM pulls")).toEqual([])
  expect(await commitRows()).toEqual([])
  expect(await sql(runtime, "SELECT id FROM items")).toEqual([])
})

test("a failed review cursor commit rolls back the entire pull snapshot", async () => {
  const fetched = await snapshot()
  await sql(runtime, "ALTER TABLE github_sync ADD CONSTRAINT reject_review_cursor CHECK (cursor IS NULL)")
  try {
    const result = await runtime.runPromise(Effect.result(projectPull(REPOSITORY, fetched.pull.number, {
      ...fetched, reviewsNext: "next-review-page",
    })))
    expect(result._tag).toBe("Failure")
    expect(await sql(runtime, "SELECT item_id FROM pulls")).toEqual([])
    expect(await sql(runtime, "SELECT id FROM items")).toEqual([])
    expect(await commitRows()).toEqual([])
    expect(await sql(runtime, "SELECT cursor FROM github_sync")).toEqual([])
  } finally {
    await sql(runtime, "ALTER TABLE github_sync DROP CONSTRAINT reject_review_cursor")
  }
})

test("a stale gone observation cannot clear a pending review cursor; a current deletion clears it", async () => {
  const fetched = await snapshot()
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, {
    ...fetched, fetchedAt: fetched.fetchedAt + 2000, reviewsNext: "next-review-page",
  }))
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, { kind: "gone", fetchedAt: fetched.fetchedAt + 1000 }))
  expect(await sql(runtime, "SELECT cursor FROM github_sync")).toEqual([{ cursor: "next-review-page" }])
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, { kind: "gone", fetchedAt: fetched.fetchedAt + 3000 }))
  expect(await sql(runtime, "SELECT cursor FROM github_sync")).toEqual([{ cursor: null }])
  expect(await sql(runtime, "SELECT item_id FROM pulls")).toEqual([])
})

test("a malformed review fails the read without advancing its projection or cursor", async () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const head = github.push("feature", { "A.md": "A" })
  const pull = github.openPull("feature")
  pull.reviews.push({ id: Number.NaN, login: "maya", event: "COMMENT", body: "Untrusted content", commitId: head, at: Date.now() })
  const { services: built } = await services(runtime, github)
  const result = await runtime.runPromise(Effect.gen(function* () {
    const token = yield* built.tokens.forInstallation(REPOSITORY, "pulls")
    return yield* fetchPull(REPOSITORY, pull.number).pipe(withToken(token, built.apiBaseUrl), Effect.result)
  }).pipe(Effect.provideService(HttpClient.HttpClient, built.http), Effect.provide(built.database)))
  expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "decode-failed" } })
  expect(await sql(runtime, "SELECT item_id FROM pulls")).toEqual([])
  expect(await sql(runtime, "SELECT cursor FROM github_sync")).toEqual([])
})

test("a newer metadata batch cannot discard an edit to a review covered only by an earlier batch", async () => {
  const fetched = await snapshot()
  const review = {
    id: 10, node_id: "R10", user: null, body: "Original", state: "COMMENTED",
    commit_id: fetched.pull.head.sha, submitted_at: new Date().toISOString(),
  } as const
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, { ...fetched, reviews: [review] }))
  const laterBatch = {
    ...fetched, fetchedAt: fetched.fetchedAt + 2000, reviews: [{ ...review, id: 301, node_id: "R301" }],
    commits: [{ ...fetched.commits[0]!, sha: "b".repeat(40) }],
  }
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, laterBatch))
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, {
    ...fetched, fetchedAt: fetched.fetchedAt + 1000, reviews: [{ ...review, body: "Edited" }], reviewsNext: "older-cursor",
  }))
  expect(await sql(runtime, "SELECT body FROM reviews WHERE id LIKE '%/review/10'")).toEqual([{ body: "Edited" }])
  expect(await commitRows()).toEqual([{ sha: "b".repeat(40) }])
  expect(await sql(runtime, "SELECT cursor FROM github_sync")).toEqual([{ cursor: null }])
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, { kind: "gone", fetchedAt: fetched.fetchedAt + 3000 }))
  await runtime.runPromise(projectPull(REPOSITORY, fetched.pull.number, { ...fetched, reviews: [{ ...review, body: "Stale" }] }))
  expect(await sql(runtime, "SELECT id FROM reviews")).toEqual([])
})
