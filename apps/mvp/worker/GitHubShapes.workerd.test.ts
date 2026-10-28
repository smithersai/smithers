// Real GitHub shape routes + sign-in's sessions + Postgres + Electric under workerd's request-owned I/O rules, while the
// deployment has the GitHub App. A signed-out cache miss checks GitHub's visibility with the App's read token
// (worker/github/ReadToken.ts); a Member's read takes the role path, through a session whose role check is due. Node's
// concurrent tests can't detect a request waiting on another request's permit or mint; workerd cancels it as hung
// (2026-10-25 production incident).
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import {
  COMMENTS_SHAPE_ROUTE,
  ITEMS_SHAPE_ROUTE,
  SYNC_SHAPE_ROUTE,
  TRIAGE_SETTINGS_SHAPE_ROUTE,
} from "../src/features/issues/contract.ts"
import {
  CHECKS_SHAPE_ROUTE,
  PULL_COMMITS_SHAPE_ROUTE,
  PULLS_SHAPE_ROUTE,
  REVIEWS_SHAPE_ROUTE,
} from "../src/features/pulls/contract.ts"
import { repoId } from "../src/features/repo/contract.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as SessionStore from "./SessionStore.ts"
import { testFile } from "./test/harness.ts"
import { answer, assertBodiesConsumed, bundle, COMPATIBILITY } from "./test/workerd/bundle.ts"
import { REPOSITORY, SESSION_SECRET } from "./test/workerd/shapesFixture.ts"

const SHAPES = [
  ITEMS_SHAPE_ROUTE,
  COMMENTS_SHAPE_ROUTE,
  PULLS_SHAPE_ROUTE,
  REVIEWS_SHAPE_ROUTE,
  CHECKS_SHAPE_ROUTE,
  PULL_COMMITS_SHAPE_ROUTE,
  TRIAGE_SETTINGS_SHAPE_ROUTE,
  SYNC_SHAPE_ROUTE,
]

const runtime = testFile("shapes_workerd")
let worker: Miniflare
let restore: (() => void) | undefined
/** A Member's session cookie, as sign-in sets it over plain http. */
let member = ""
beforeAll(async () => {
  restore = assertBodiesConsumed()
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const url = await runtime.runPromise(TestDatabase.serverUrl)
  const electric = await runtime.runPromise(TestDatabase.electricUrl)
  // A database public flag alone cannot authorize a visitor; the isolate starts without a metadata answer.
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO github_repositories (repo_id, github_id, private)
    VALUES (${repoId(REPOSITORY.owner, REPOSITORY.name)}, 1, false)`))
  // A Member signed in a day ago: their role check is due, so each of their reads starts one, as production's do.
  const token = crypto.randomUUID()
  await runtime.runPromise(Effect.gen(function* () {
    const personId = yield* SessionStore.upsertPerson({ id: crypto.randomUUID(), githubId: 4242, login: "member" })
    const id = crypto.randomUUID()
    yield* SessionStore.createSession({
      id,
      tokenDigest: SessionKeys.digest(token),
      personId,
      role: "member",
      roleGeneration: yield* SessionStore.roleObservation,
      access: { ciphertext: "unused", nonce: "unused" },
      accessExpiresAt: null,
      refresh: null,
      refreshDigest: null,
      maxAgeSeconds: 3600,
    })
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE sessions SET role_checked_at = now() - interval '1 day' WHERE id = ${id}`
  }))
  const keys = await Effect.runPromise(SessionKeys.make(Redacted.make(SESSION_SECRET)))
  member = `smithers_session=${await Effect.runPromise(keys.sign("session", token))}`
  const output = await bundle(fileURLToPath(new URL("./test/workerd/shapes.ts", import.meta.url)))
  const modules = Object.fromEntries(output.map((file) => file.type === "chunk"
    ? [file.fileName, { type: "esm" as const, contents: file.code }]
    : [file.fileName, { type: "wasm" as const, contents: Buffer.from(file.source) }]))
  worker = new Miniflare({ workers: [{ config: {
    name: "shapes",
    compatibilityDate: COMPATIBILITY.date,
    compatibilityFlags: COMPATIBILITY.flags,
    manifest: { mainModule: "worker.js", modules },
    env: {
      HYPERDRIVE: { type: "hyperdrive", id: "shapes", dev: { connectionString: url.toString() } },
      SCHEMA: { type: "text", value: scratch.name },
      ELECTRIC_URL: { type: "text", value: electric },
    },
  } }] })
  expect((await answer(worker, "http://shapes/initialize")).status).toBe(200)
}, 120_000)
afterAll(async () => {
  await worker?.dispose()
  restore?.()
})

test("signed-out and signed-in first, catch-up and live reads of the eight GitHub shapes all return 200 in workerd", async () => {
  const readers = [{ who: "signed out", init: undefined }, { who: "member", init: { headers: { cookie: member } } }]
  type Read = { readonly who: string; readonly init: (typeof readers)[number]["init"]; readonly route: string }
  // Each body is read as its response arrives (bundle.ts `answer`): a body left unread while live reads wait could be
  // collected. A failure names the reader, the route, the status and the body.
  const fire = async (reads: ReadonlyArray<Read>) => {
    const answers = await Promise.all(reads.map((read) => answer(worker, `http://shapes${read.route}`, read.init)))
    expect(answers.flatMap((got, index) =>
      got.status === 200 ? [] : [`${reads[index]!.who} ${reads[index]!.route} ${got.status}: ${got.body}`]
    )).toEqual([])
    return answers
  }
  // A cold isolate: no read token is held, so every signed-out first reader arrives while a mint is in flight, and the
  // Member's first reads run beside them.
  const firstReads = readers.flatMap((reader) => SHAPES.map((route) => ({ ...reader, route: `${route}?offset=-1` })))
  const first = await fire(firstReads)
  // Then each reader's catch-up and live requests on the handles it got, all at once. Each request holds a Postgres
  // connection while it decides who may read (one per request, about 30 more for the fixture), and the test Postgres
  // takes 100 that test files running beside this one share: 16 requests at a time peaked at 47 alone and 76 beside the
  // About tests, 32 at 65 and 95 (2026-10-25, Latitude).
  for (const reader of readers) {
    await fire(firstReads.flatMap((read, index) => {
      if (read.who !== reader.who) return []
      const handle = first[index]!.headers.get("electric-handle")
      const offset = first[index]!.headers.get("electric-offset")
      expect(handle).not.toBeNull()
      expect(offset).not.toBeNull()
      const route = `${read.route.split("?")[0]}?handle=${encodeURIComponent(handle!)}&offset=${encodeURIComponent(offset!)}`
      return [{ ...read, route }, { ...read, route: `${route}&live=true` }]
    }))
  }
  const counts = JSON.parse((await answer(worker, "http://shapes/counts")).body) as { mints: number; roleChecks: number }
  // Each cold signed-out reader may mint for itself; once one token is held, the warm reads mint no more.
  expect(counts.mints).toBeGreaterThanOrEqual(1)
  expect(counts.mints).toBeLessThanOrEqual(SHAPES.length)
  // Every Member read resolved its session through sign-in, starting the role check that was due.
  expect(counts.roleChecks).toBe(SHAPES.length * 3)
}, 90_000)
