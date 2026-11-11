// Real Postgres proves claim ownership, terminal fencing, refusal persistence, and atomic quota recovery.
import { Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { testFile } from "../test/harness.ts"
import * as Store from "./Store.vibe"

const runtime = testFile("repo_about_store")
beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM repo_about`)))
const store = async () => Store.postgres((await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database)
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const ID = "github/octocat/spoon-knife"
const NOW = Date.UTC(2026, 9, 25, 12)
const MINUTE = 60_000
const claim = async (kept: Store.AboutStore, id: string, now: number, recover = false) => {
  const generation = await run(kept.claim(id, now, now + 30_000, recover))
  expect(generation).toEqual(expect.any(String))
  if (generation === false) throw new Error("expected ownership")
  return generation
}

test("a read is claimed once while due: the first claim holds it for its 30 seconds, a fresh answer until it is stale", async () => {
  const kept = await store()
  expect(await run(kept.get(ID))).toEqual(Option.none())
  const first = await claim(kept, ID, NOW)
  expect(await run(kept.claim(ID, NOW + 1000, NOW + 31_000))).toBe(false)
  expect(await run(kept.get(ID))).toEqual(Option.some({ answer: Option.none(), nextReadAtMs: NOW + 30_000, refusal: null, appAbsentUntilMs: null }))
  const second = await claim(kept, ID, NOW + 30_000)
  expect(second).not.toBe(first)
  expect(await run(kept.keep(ID, { text: "new", via: "app", readAtMs: NOW, freshUntilMs: NOW + 10 * MINUTE }, second))).toBe(true)
  expect(await run(kept.claim(ID, NOW + 9 * MINUTE, NOW + 9 * MINUTE + 30_000))).toBe(false)
  await claim(kept, ID, NOW + 10 * MINUTE)
})

test("a superseded generation cannot save or refuse, and not_found retains its fence after clearing read_at", async () => {
  const kept = await store()
  const old = await claim(kept, ID, NOW)
  const current = await claim(kept, ID, NOW + 30_000)
  const answer = { text: "new", via: "app" as const, readAtMs: NOW + 30_000, freshUntilMs: NOW + 10 * MINUTE }
  expect(await run(kept.keep(ID, answer, current))).toBe(true)
  expect(await run(kept.keep(ID, { ...answer, text: "old" }, old))).toBe(false)
  expect(await run(kept.refuse(ID, "not_found", NOW + 20 * MINUTE, "anonymous", old))).toBe(false)
  expect(Option.flatMap(await run(kept.get(ID)), (row) => row.answer)).toEqual(Option.some(answer))
  const limit = await claim(kept, ID, NOW + 10 * MINUTE)
  expect(await run(kept.refuse(ID, "rate_limited", NOW + 20 * MINUTE, "app", limit))).toBe(true)
  expect(Option.flatMap(await run(kept.get(ID)), (row) => row.answer)).toEqual(Option.some(answer))
  const gone = await claim(kept, ID, NOW + 20 * MINUTE)
  await run(kept.appAbsent(ID, NOW + 60 * MINUTE))
  expect(await run(kept.refuse(ID, "not_found", NOW + 21 * MINUTE, undefined, gone))).toBe(true)
  for (const generation of [old, current, limit, gone]) {
    expect(await run(kept.keep(ID, answer, generation))).toBe(false)
    expect(await run(kept.refuse(ID, "github_unavailable", NOW + 30 * MINUTE, "app", generation))).toBe(false)
  }
  expect(await run(kept.get(ID))).toEqual(Option.some({ answer: Option.none(), nextReadAtMs: NOW + 21 * MINUTE, refusal: "not_found", appAbsentUntilMs: NOW + 60 * MINUTE }))
  const restored = await claim(kept, ID, NOW + 21 * MINUTE)
  expect(await run(kept.keep(ID, { ...answer, text: "public again" }, restored))).toBe(true)
  expect(Option.getOrThrow(await run(kept.get(ID))).refusal).toBeNull()
  const cold = await claim(kept, "github/a/b", NOW)
  expect(await run(kept.refuse("github/a/b", "github_unavailable", NOW, undefined, cold))).toBe(true)
  await run(kept.appAbsent("github/c/d", NOW))
  expect(Option.getOrThrow(await run(kept.get("github/a/b"))).refusal).toBe("github_unavailable")
  expect(Option.getOrThrow(await run(kept.get("github/c/d"))).appAbsentUntilMs).toBe(NOW)
})

test("Postgres that can't be reached refuses every operation as StoreUnavailable, naming it", async () => {
  const down = Store.postgres(Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))))
  const refused = async (effect: Effect.Effect<unknown, Store.StoreUnavailable>) => {
    const result = await Effect.runPromise(Effect.result(effect))
    return result._tag === "Failure" ? result.failure.op : "answered"
  }
  expect(await refused(down.get(ID))).toBe("get")
  expect(await refused(down.claim(ID, NOW, NOW))).toBe("claim")
  expect(await refused(down.keep(ID, { text: "x", via: "app", readAtMs: NOW, freshUntilMs: NOW }, "1"))).toBe("keep")
  expect(await refused(down.refuse(ID, "not_found", NOW, undefined, "1"))).toBe("refuse")
  expect(await refused(down.appAbsent(ID, NOW))).toBe("app_absent")
})

test("anonymous quota recovery is atomic, preserves authenticated holds, and clears refusal provenance", async () => {
  const kept = await store()
  for (const via of [undefined, "anonymous", "deployment", "app"] as const) {
    const id = ID + "/" + (via ?? "legacy")
    const initial = await claim(kept, id, NOW)
    expect(await run(kept.refuse(id, "rate_limited", NOW + 10 * MINUTE, via, initial))).toBe(true)
    const claims = await Promise.all([run(kept.claim(id, NOW, NOW + MINUTE, true)), run(kept.claim(id, NOW, NOW + MINUTE, true))])
    expect(claims.filter(Boolean)).toHaveLength(via === undefined || via === "anonymous" ? 1 : 0)
    const row = Option.getOrThrow(await run(kept.get(id)))
    if (via === "deployment" || via === "app") expect(row.refusalVia).toBe(via)
    else {
      expect(row.refusal).toBeNull()
      const generation = claims.find((value): value is string => value !== false)!
      expect(await run(kept.keep(id, { text: "ok", via: "deployment", readAtMs: NOW, freshUntilMs: NOW + MINUTE }, generation))).toBe(true)
      expect(Option.getOrThrow(await run(kept.get(id))).refusalVia).toBeUndefined()
    }
  }
  const initial = await claim(kept, ID, NOW)
  expect(await run(kept.refuse(ID, "github_unavailable", NOW + MINUTE, "anonymous", initial))).toBe(true)
  expect(await run(kept.claim(ID, NOW, NOW + MINUTE, true))).toBe(false)
})
