// Real Postgres proves claim ownership, terminal fencing, refusal persistence, and atomic quota recovery.
import { Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { testFile } from "../test/harness.ts"
import * as Store from "./Store.ts"

const runtime = testFile("owner_profile_store")
beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM owner_profile`)))
const store = async () => Store.postgres((await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database)
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const OWNER = "roninjin10"
const NOW = Date.UTC(2026, 10, 23, 12)
const MINUTE = 60_000
const claim = async (kept: Store.ProfileStore, owner: string, now: number, recover = false) => {
  const generation = await run(kept.claim(owner, now, now + 30_000, recover))
  expect(generation).toEqual(expect.any(String))
  if (generation === false) throw new Error("expected ownership")
  return generation
}

test("a read is claimed once while due: the first claim holds it for 30 seconds, a fresh answer until it is stale", async () => {
  const kept = await store()
  expect(await run(kept.get(OWNER))).toEqual(Option.none())
  const first = await claim(kept, OWNER, NOW)
  expect(await run(kept.claim(OWNER, NOW + 1000, NOW + 31_000))).toBe(false)
  expect(await run(kept.get(OWNER))).toEqual(Option.some({ answer: Option.none(), nextReadAtMs: NOW + 30_000, refusal: null }))
  const second = await claim(kept, OWNER, NOW + 30_000)
  expect(second).not.toBe(first)
  expect(await run(kept.keep(OWNER, { text: "{\"login\":\"roninjin10\"}", via: "deployment", readAtMs: NOW, freshUntilMs: NOW + 10 * MINUTE }, second))).toBe(true)
  expect(await run(kept.claim(OWNER, NOW + 9 * MINUTE, NOW + 9 * MINUTE + 30_000))).toBe(false)
  await claim(kept, OWNER, NOW + 10 * MINUTE)
})

test("a superseded generation cannot save or refuse, and not_found retains its fence after clearing profile", async () => {
  const kept = await store()
  const old = await claim(kept, OWNER, NOW)
  const current = await claim(kept, OWNER, NOW + 30_000)
  const answer = { text: "{\"login\":\"roninjin10\"}", via: "deployment" as const, readAtMs: NOW + 30_000, freshUntilMs: NOW + 10 * MINUTE }
  expect(await run(kept.keep(OWNER, answer, current))).toBe(true)
  expect(await run(kept.keep(OWNER, { ...answer, text: "{\"login\":\"stale\"}" }, old))).toBe(false)
  expect(await run(kept.refuse(OWNER, "not_found", NOW + 20 * MINUTE, "anonymous", old))).toBe(false)
  expect(Option.flatMap(await run(kept.get(OWNER)), (row) => row.answer)).toEqual(Option.some(answer))
  const limit = await claim(kept, OWNER, NOW + 10 * MINUTE)
  expect(await run(kept.refuse(OWNER, "rate_limited", NOW + 20 * MINUTE, "deployment", limit))).toBe(true)
  expect(Option.flatMap(await run(kept.get(OWNER)), (row) => row.answer)).toEqual(Option.some(answer))
  const gone = await claim(kept, OWNER, NOW + 20 * MINUTE)
  expect(await run(kept.refuse(OWNER, "not_found", NOW + 21 * MINUTE, undefined, gone))).toBe(true)
  for (const generation of [old, current, limit, gone]) {
    expect(await run(kept.keep(OWNER, answer, generation))).toBe(false)
    expect(await run(kept.refuse(OWNER, "github_unavailable", NOW + 30 * MINUTE, "deployment", generation))).toBe(false)
  }
  expect(await run(kept.get(OWNER))).toEqual(Option.some({ answer: Option.none(), nextReadAtMs: NOW + 21 * MINUTE, refusal: "not_found" }))
  const restored = await claim(kept, OWNER, NOW + 21 * MINUTE)
  expect(await run(kept.keep(OWNER, { ...answer, text: "{\"login\":\"restored\"}" }, restored))).toBe(true)
  expect(Option.getOrThrow(await run(kept.get(OWNER))).refusal).toBeNull()
})

test("Postgres that can't be reached refuses every operation as StoreUnavailable, naming it", async () => {
  const down = Store.postgres(Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))))
  const refused = async (effect: Effect.Effect<unknown, Store.StoreUnavailable>) => {
    const result = await Effect.runPromise(Effect.result(effect))
    return result._tag === "Failure" ? result.failure.op : "answered"
  }
  expect(await refused(down.get(OWNER))).toBe("get")
  expect(await refused(down.claim(OWNER, NOW, NOW))).toBe("claim")
  expect(await refused(down.keep(OWNER, { text: "{}", via: "deployment", readAtMs: NOW, freshUntilMs: NOW }, "1"))).toBe("keep")
  expect(await refused(down.refuse(OWNER, "not_found", NOW, undefined, "1"))).toBe("refuse")
})

test("anonymous quota recovery is atomic, preserves authenticated holds, and clears refusal provenance", async () => {
  const kept = await store()
  for (const via of [undefined, "anonymous", "deployment"] as const) {
    const owner = OWNER + "-" + (via ?? "legacy")
    const initial = await claim(kept, owner, NOW)
    expect(await run(kept.refuse(owner, "rate_limited", NOW + 10 * MINUTE, via, initial))).toBe(true)
    const claims = await Promise.all([run(kept.claim(owner, NOW, NOW + MINUTE, true)), run(kept.claim(owner, NOW, NOW + MINUTE, true))])
    expect(claims.filter(Boolean)).toHaveLength(via === undefined || via === "anonymous" ? 1 : 0)
    const row = Option.getOrThrow(await run(kept.get(owner)))
    if (via === "deployment") expect(row.refusalVia).toBe(via)
    else {
      expect(row.refusal).toBeNull()
      const generation = claims.find((value): value is string => value !== false)!
      expect(await run(kept.keep(owner, { text: "{}", via: "deployment", readAtMs: NOW, freshUntilMs: NOW + MINUTE }, generation))).toBe(true)
      expect(Option.getOrThrow(await run(kept.get(owner))).refusalVia).toBeUndefined()
    }
  }
  const initial = await claim(kept, OWNER, NOW)
  expect(await run(kept.refuse(OWNER, "github_unavailable", NOW + MINUTE, "anonymous", initial))).toBe(true)
  expect(await run(kept.claim(OWNER, NOW, NOW + MINUTE, true))).toBe(false)
})
