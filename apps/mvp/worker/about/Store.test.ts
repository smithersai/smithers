// The about read's store (worker/about/Store.ts) over this file's schema of the compose Postgres (`pnpm db:up`): one
// claim of a due read at a time, an older read never overwriting a newer, `not_found` dropping the answer, and an
// unreachable Postgres refusing every operation as `StoreUnavailable`.
import { Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { testFile } from "../test/harness.ts"
import * as Store from "./Store.ts"

const runtime = testFile("repo_about_store")

beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM repo_about`)))

const store = async () => Store.postgres((await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database)
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const ID = "github/octocat/spoon-knife"
const NOW = Date.UTC(2026, 9, 25, 12)
const MINUTE = 60_000

test("a read is claimed once while due: the first claim holds it for its 30 seconds, a fresh answer until it is stale", async () => {
  const kept = await store()
  expect(await run(kept.get(ID))).toEqual(Option.none())
  expect(await run(kept.claim(ID, NOW, NOW + 30_000))).toBe(true)
  expect(await run(kept.claim(ID, NOW + 1_000, NOW + 31_000))).toBe(false)
  expect(await run(kept.get(ID))).toEqual(Option.some({
    answer: Option.none(),
    nextReadAtMs: NOW + 30_000,
    refusal: null,
    appAbsentUntilMs: null,
  }))
  // A claim whose read never finished passes, and the read is due again.
  expect(await run(kept.claim(ID, NOW + 30_000, NOW + 60_000))).toBe(true)
  await run(kept.keep(ID, { text: "{\"a\":1}", via: "app", readAtMs: NOW, freshUntilMs: NOW + 10 * MINUTE }))
  expect(await run(kept.claim(ID, NOW + 9 * MINUTE, NOW + 9 * MINUTE + 30_000))).toBe(false)
  expect(await run(kept.claim(ID, NOW + 10 * MINUTE, NOW + 11 * MINUTE))).toBe(true)
})

test("an older read never overwrites a newer; a refusal keeps the answer, unless GitHub says not found", async () => {
  const kept = await store()
  await run(kept.keep(ID, { text: "new", via: "app", readAtMs: NOW, freshUntilMs: NOW + 10 * MINUTE }))
  await run(kept.keep(ID, { text: "old", via: "anonymous", readAtMs: NOW - MINUTE, freshUntilMs: NOW + 59 * MINUTE }))
  const answer = { text: "new", via: "app", readAtMs: NOW, freshUntilMs: NOW + 10 * MINUTE }
  expect(Option.flatMap(await run(kept.get(ID)), (row) => row.answer)).toEqual(Option.some(answer))
  await run(kept.refuse(ID, "rate_limited", NOW + 20 * MINUTE))
  expect(await run(kept.get(ID))).toEqual(Option.some({
    answer: Option.some(answer),
    nextReadAtMs: NOW + 20 * MINUTE,
    refusal: "rate_limited",
    appAbsentUntilMs: null,
  }))
  // A fresh answer forgets the refusal.
  await run(kept.keep(ID, { text: "newer", via: "app", readAtMs: NOW + MINUTE, freshUntilMs: NOW + 11 * MINUTE }))
  expect(Option.map(await run(kept.get(ID)), (row) => row.refusal)).toEqual(Option.some(null))
  await run(kept.appAbsent(ID, NOW + 60 * MINUTE))
  await run(kept.refuse(ID, "not_found", NOW + 21 * MINUTE))
  expect(await run(kept.get(ID))).toEqual(Option.some({
    answer: Option.none(),
    nextReadAtMs: NOW + 21 * MINUTE,
    refusal: "not_found",
    appAbsentUntilMs: NOW + 60 * MINUTE,
  }))
  // A refusal and the App's absence on a repository nobody read yet.
  await run(kept.refuse("github/a/b", "github_unavailable", NOW))
  await run(kept.appAbsent("github/c/d", NOW))
  expect(Option.map(await run(kept.get("github/a/b")), (row) => row.refusal)).toEqual(Option.some("github_unavailable"))
  expect(Option.map(await run(kept.get("github/c/d")), (row) => row.appAbsentUntilMs)).toEqual(Option.some(NOW))
})

test("Postgres that can't be reached refuses every operation as StoreUnavailable, naming it", async () => {
  const down = Store.postgres(Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))))
  const refused = async (effect: Effect.Effect<unknown, Store.StoreUnavailable>) => {
    const result = await Effect.runPromise(Effect.result(effect))
    return result._tag === "Failure" ? result.failure.op : "answered"
  }
  expect(await refused(down.get(ID))).toBe("get")
  expect(await refused(down.claim(ID, NOW, NOW))).toBe("claim")
  expect(await refused(down.keep(ID, { text: "x", via: "app", readAtMs: NOW, freshUntilMs: NOW }))).toBe("keep")
  expect(await refused(down.refuse(ID, "not_found", NOW))).toBe("refuse")
  expect(await refused(down.appAbsent(ID, NOW))).toBe("app_absent")
})


test("anonymous quota recovery is atomic, preserves authenticated holds, and clears refusal provenance", async () => {
  const kept = await store()
  for (const via of [undefined, "anonymous", "deployment", "app"] as const) {
    await run(kept.refuse(ID, "rate_limited", NOW + 10 * MINUTE, via))
    const claims = await Promise.all([run(kept.claim(ID, NOW, NOW + MINUTE, true)), run(kept.claim(ID, NOW, NOW + MINUTE, true))])
    expect(claims.filter(Boolean)).toHaveLength(via === undefined || via === "anonymous" ? 1 : 0)
    if (via === "deployment" || via === "app") expect(Option.getOrThrow(await run(kept.get(ID))).refusalVia).toBe(via)
    else expect(Option.getOrThrow(await run(kept.get(ID))).refusal).toBeNull()
  }
  await run(kept.refuse(ID, "github_unavailable", NOW + MINUTE, "anonymous"))
  expect(await run(kept.claim(ID, NOW, NOW + MINUTE, true))).toBe(false)
  await run(kept.keep(ID, { text: "ok", via: "deployment", readAtMs: NOW, freshUntilMs: NOW + MINUTE }))
  expect(Option.getOrThrow(await run(kept.get(ID))).refusalVia).toBeUndefined()
})
