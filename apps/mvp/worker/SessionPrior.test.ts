import { readFileSync } from "node:fs"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as Store from "./SessionStore.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import { testFile } from "./test/harness.ts"
import { configured, signInHarness } from "./test/signIn.ts"

const runtime = testFile("session_prior")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
const fixture = async () => {
  const h = await signInHarness(runtime, { config: { ...configured, APP_DOMAIN: "smithers.test", APP_ALIASES: "alias.test=/" } })
  const signed = await h.signInAs()
  const [row] = await query(sql => sql<{ id: string; tag: string; digest: string }>`SELECT id, session_tag AS tag, token_digest AS digest FROM sessions ORDER BY created_at DESC LIMIT 1`)
  const alias = crypto.randomUUID()
  await runtime.runPromise(Store.createHostSession({ id: alias, tokenDigest: alias, parentId: row!.id, host: "alias.test" }))
  const [a] = await query(sql => sql<{ tag: string }>`SELECT session_tag AS tag FROM host_sessions WHERE id = ${alias}`)
  return { h, signed, ...row!, alias, aliasTag: a!.tag }
}
const prior = async (h: Awaited<ReturnType<typeof signInHarness>>, tag: string, cookie?: string) => {
  const response = await h.fetch("/api/auth/session", { headers: { "x-smithers-session-tag": tag, ...(cookie ? { cookie } : {}) } })
  expect(response.headers.get("cache-control")).toContain("no-store")
  return response.json() as Promise<{ prior: string; signedIn?: boolean }>
}

test("prior reads a live home or alias without any cookie and ignores failed signatures", async () => {
  const f = await fixture()
  for (const tag of [f.tag, f.aliasTag]) {
    expect(await prior(f.h, tag)).toMatchObject({ prior: "live", signedIn: false })
    expect(await prior(f.h, tag, "smithers_session=garbage")).toMatchObject({ prior: "live", signedIn: false })
  }
  expect(await prior(f.h, "0".repeat(32))).toMatchObject({ prior: "absent" })
  await query(sql => sql`UPDATE sessions SET started_at = now() - interval '100 days', expires_at = now() + interval '2 days' WHERE id = ${f.id}`)
  expect(await prior(f.h, f.aliasTag)).toMatchObject({ prior: "live" })
})

test("expiry confirmation is final, transfers credentials and leaves receipts after erasure", async () => {
  const f = await fixture()
  await query(sql => sql`UPDATE sessions SET expires_at = now() - interval '31 days' WHERE id = ${f.id}`)
  expect(await prior(f.h, f.aliasTag)).toMatchObject({ prior: "ended" })
  const [row] = await query(sql => sql`SELECT revoked_reason, github_access, github_refresh FROM sessions WHERE id = ${f.id}`)
  expect(row).toEqual({ revoked_reason: "expired", github_access: null, github_refresh: null })
  expect(await runtime.runPromise(Store.renew(f.digest, null, 30 * 86400, "legacy"))).toBe(false)
  const candidate = await runtime.runPromise(Store.reauthCandidate(f.digest, (await query(sql => sql<{ id: string }>`SELECT id FROM people LIMIT 1`))[0]!.id, "legacy", ["legacy"]))
  expect(Option.isSome(candidate) && candidate.value.eligible).toBe(false)
  await runtime.runPromise(Store.sweepEnds())
  for (const tag of [f.tag, f.aliasTag]) expect(await prior(f.h, tag)).toMatchObject({ prior: "ended" })
})

test("an alias's own deadline ends only that alias", async () => {
  const f = await fixture()
  await query(sql => sql`UPDATE host_sessions SET started_at = now() - interval '401 days' WHERE id = ${f.alias}`)
  expect(await prior(f.h, f.aliasTag)).toMatchObject({ prior: "ended" })
  expect(await prior(f.h, f.tag)).toMatchObject({ prior: "live" })
  expect(await query(sql => sql`SELECT id FROM sessions WHERE id = ${f.id} AND revoked_at IS NULL AND github_access IS NOT NULL`)).toHaveLength(1)
})

test("a failed primary query answers failed, never absent, with no cookie", async () => {
  const scratch = await runtime.runPromise(TestDatabase.Scratch)
  const database = Layer.effect(SqlClient.SqlClient, Effect.map(SqlClient.SqlClient, real => new Proxy(real, {
    apply(target, receiver, args) {
      return String(args[0]).includes("session_end_receipts") ? Effect.fail(new Error("primary unavailable")) : Reflect.apply(target, receiver, args)
    },
  }))).pipe(Layer.provide(scratch.database))
  const h = await signInHarness(runtime, { database })
  expect(await prior(h, "0".repeat(32))).toMatchObject({ prior: "failed" })
})

test("the confirming statement never shares the authority predicate", () => {
  const source = readFileSync(new URL("./SessionPrior.ts", import.meta.url), "utf8")
  expect(source).not.toContain("sessionLive")
  expect(source).toContain("FOR UPDATE")
  expect(source).toContain("clock_timestamp()")
  expect(source).toContain("withTransaction")
})

const barrier = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
for (const first of ["confirmation", "renewal"] as const) test(`alias without cookie confirms across parent expiry, ${first} locks first`, async () => {
  const f = await fixture()
  const scratch = await runtime.runPromise(TestDatabase.Scratch)
  const locked = barrier(), release = barrier()
  await query(sql => sql`UPDATE sessions SET expires_at = clock_timestamp() + interval '2 seconds' WHERE id = ${f.id}`)
  const database = Layer.effect(SqlClient.SqlClient, Effect.map(SqlClient.SqlClient, real => new Proxy(real, {
    apply(target, receiver, args) {
      const statement = Reflect.apply(target, receiver, args)
      return first === "confirmation" && String(args[0]).includes("FOR UPDATE") && String(args[0]).includes("FROM sessions")
        ? Effect.andThen(statement, Effect.andThen(Effect.sync(locked.resolve), Effect.promise(() => release.promise))) : statement
    },
  }))).pipe(Layer.provide(scratch.database))
  const h = await signInHarness(runtime, { database })
  let confirmation: ReturnType<typeof prior>
  let renewal: Promise<boolean>
  if (first === "renewal") {
    renewal = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
      const result = yield* Store.renew(f.digest, null, 30 * 86400, "legacy")
      locked.resolve()
      yield* Effect.promise(() => release.promise)
      return result
    }))))
    await locked.promise
    confirmation = prior(h, f.aliasTag)
  } else {
    confirmation = prior(h, f.aliasTag)
    // A missing implementation must fail rather than leave this test waiting on a lock it never takes.
    await Promise.race([locked.promise, confirmation.then(() => { throw new Error("confirmation never locked the parent") })])
    renewal = runtime.runPromise(Store.renew(f.digest, null, 30 * 86400, "legacy"))
  }
  try {
    // Deliberately cross the original expiry on the database clock while the first transaction owns its lock.
    await query(sql => sql`SELECT pg_sleep(greatest(0, extract(epoch FROM expires_at - clock_timestamp())) + 0.05) FROM sessions WHERE id = ${f.id}`)
  } finally { release.resolve() }
  expect(await renewal).toBe(first === "renewal")
  expect(await confirmation).toMatchObject({ prior: first === "renewal" ? "live" : "ended" })
  expect(await prior(f.h, f.aliasTag)).toMatchObject({ prior: first === "renewal" ? "live" : "ended" })
})
