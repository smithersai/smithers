import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"
import { testFile } from "../worker/test/harness"
import { clearGrants, SharingCleanup } from "./sharingCleanup"

const runtime = testFile("e2e_sharing_cleanup")

it("clears known and discovered grants from a real store and safely repeats an empty cleanup", async () => {
  const sql = await runtime.runPromise(SqlClient.SqlClient)
  await runtime.runPromise(sql`CREATE TABLE cleanup_grants (grantee text PRIMARY KEY)`)
  await runtime.runPromise(sql`INSERT INTO cleanup_grants (grantee) VALUES ('member'), ('guest'), ('repository')`)
  // A real Postgres adapter for the cleanup algorithm; production API authorization is proved by the browser spec.
  const api = {
    remove: (grantee: string) => sql`DELETE FROM cleanup_grants WHERE grantee = ${grantee}`.pipe(Effect.asVoid),
    discover: sql<{ grantee: string }>`SELECT grantee FROM cleanup_grants`.pipe(Effect.map((rows) => rows.map((row) => row.grantee))),
  }
  await runtime.runPromise(clearGrants(["member", "member"]).pipe(Effect.provideService(SharingCleanup, api)))
  expect(await runtime.runPromise(sql`SELECT grantee FROM cleanup_grants`)).toEqual([])
  await runtime.runPromise(clearGrants([]).pipe(Effect.provideService(SharingCleanup, api)))
  expect(await runtime.runPromise(sql`SELECT grantee FROM cleanup_grants`)).toEqual([])
})

describe("grant cleanup with faulty Effect services", () => {
  it("revokes existing known grants before failed discovery and reports the discovery failure", async () => {
    const grants = new Set(["member", "guest", "repository"])
    const result = await Effect.runPromise(Effect.result(clearGrants([...grants, "member"]).pipe(Effect.provideService(SharingCleanup, {
      remove: (grantee) => Effect.sync(() => { grants.delete(grantee) }),
      discover: Effect.suspend(() => {
        expect(grants.size, "revocation must not wait for Electric").toBe(0)
        return Effect.fail(new Error("Electric unavailable"))
      }),
    }))))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.errors.map((error: Error) => error.message)).toEqual(["Electric unavailable"])
    expect(grants.size).toBe(0)
  })

  it("attempts the remaining known and discovered revocations after a write fails", async () => {
    const grants = new Set(["member", "guest", "repository", "earlier-account"])
    const result = await Effect.runPromise(Effect.result(clearGrants(["member", "guest"]).pipe(Effect.provideService(SharingCleanup, {
      remove: (grantee) => grantee === "member" ? Effect.fail(new Error("member revoke unavailable"))
        : Effect.sync(() => { grants.delete(grantee) }),
      discover: Effect.sync(() => ["guest", "repository", "earlier-account", "earlier-account"]),
    }))))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.errors.map((error: Error) => error.message)).toEqual(["member revoke unavailable"])
    expect([...grants]).toEqual(["member"])
  })

  it("reports both write and discovery failures after still attempting every known grant", async () => {
    const attempted: string[] = []
    const result = await Effect.runPromise(Effect.result(clearGrants(["member", "guest", "repository"]).pipe(Effect.provideService(SharingCleanup, {
      remove: (grantee) => Effect.suspend(() => {
        attempted.push(grantee)
        return Effect.fail(new Error("write unavailable"))
      }),
      discover: Effect.fail(new Error("Electric unavailable")),
    }))))
    expect(attempted).toEqual(["member", "guest", "repository"])
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.errors).toHaveLength(4)
  })
})
