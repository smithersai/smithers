/**
 * `AttemptStore.listRun`: every attempt row of one run in one read, which a
 * resumed run's replay answers its recorded steps from instead of reading
 * each step's rows as it reaches it. Runs on the test database the matrix
 * selects: SQLite, or PostgreSQL under `SMITHERS_TEST_PG_URL`.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import type * as Statement from "effect/sql/Statement"
import { AttemptStore } from "../src/AttemptStore.ts"
import * as AttemptStoreLive from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"

const owner = { hostId: "host-a", pid: 42, nonce: "nonce-a" }

/** The SQL statements the code under it builds, counted at the client. */
const counted = (count: { statements: number }) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.map(SqlClient.SqlClient, (base) =>
      new Proxy(base, {
        apply(target, receiver, args) {
          count.statements++
          return Reflect.apply(target, receiver, args) as Statement.Statement<unknown>
        }
      }))
  )

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | AttemptStore>
) =>
  effect.pipe(
    Effect.provide(AttemptStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer)
  )

const createRun = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`
      INSERT INTO flows_runs (
        run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
      ) VALUES (${runId}, 'running', 1, ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 1, '{}')
    `
  })

const put = (runId: string, stepKeyDigest: string, attempt: number, extra: Partial<AttemptStoreLive.Attempt> = {}) =>
  Effect.flatMap(
    AttemptStore,
    (store) =>
      store.put(
        { runId, stepKeyDigest, attempt, state: "running", startedAtMs: 10 + attempt, meta: {}, ...extra },
        owner
      )
  )

describe("AttemptStore.listRun", () => {
  it.effect("reads every attempt of one run, in step key and attempt order, exactly as get reads each", () =>
    migrated(Effect.gen(function*() {
      yield* createRun("run-1")
      yield* createRun("run-2")
      const store = yield* AttemptStore
      yield* put("run-1", "digest-b", 2, { checkpoint: { cursor: 2 } })
      yield* put("run-1", "digest-b", 1)
      yield* store.finish({
        runId: "run-1",
        stepKeyDigest: "digest-b",
        attempt: 1,
        state: "failed",
        finishedAtMs: 15,
        error: { _tag: "Boom" }
      }, owner)
      yield* put("run-1", "digest-a", 1, { meta: { tier: "sealed" } })
      yield* store.finish({
        runId: "run-1",
        stepKeyDigest: "digest-a",
        attempt: 1,
        state: "succeeded",
        finishedAtMs: 12,
        outcome: { value: "a" }
      }, owner)
      yield* put("run-2", "digest-a", 1)

      const listed = yield* store.listRun!("run-1")
      const each = yield* Effect.forEach(
        [["digest-a", 1], ["digest-b", 1], ["digest-b", 2]] as const,
        ([stepKeyDigest, attempt]) =>
          Effect.map(store.get({ runId: "run-1", stepKeyDigest, attempt }), Option.getOrThrow)
      )
      expect(listed).toEqual(each)
      expect(listed.map((row) => [row.stepKeyDigest, row.attempt, row.state])).toEqual([
        ["digest-a", 1, "succeeded"],
        ["digest-b", 1, "failed"],
        ["digest-b", 2, "running"]
      ])
      expect(yield* store.listRun!("run-3")).toEqual([])
    })))

  it.effect("is one statement however many attempts the run holds", () =>
    Effect.gen(function*() {
      const count = { statements: 0 }
      const statements = yield* Effect.gen(function*() {
        yield* createRun("run-1")
        for (let index = 0; index < 12; index++) yield* put("run-1", `digest-${index}`, 1)
        const store = yield* AttemptStore
        count.statements = 0
        const listed = yield* store.listRun!("run-1")
        expect(listed).toHaveLength(12)
        return count.statements
      }).pipe(
        Effect.provide(AttemptStoreLive.layer),
        Effect.provide(Layer.provideMerge(counted(count), Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
      )
      expect(statements).toBe(1)
    }))

  it.effect("reads a long run in keyset pages of bounded size, in the listing's order", () =>
    Effect.gen(function*() {
      const count = { statements: 0 }
      const total = AttemptStoreLive.maximumListRunPage + 44
      yield* Effect.gen(function*() {
        yield* createRun("run-1")
        yield* createRun("run-2")
        const sql = yield* Effect.service(SqlClient.SqlClient)
        // Two attempts per step key, so a page boundary can fall inside one key.
        for (let index = 0; index < total; index++) {
          const digest = `digest-${String(Math.floor(index / 2)).padStart(4, "0")}`
          yield* sql`
            INSERT INTO flows_attempts (run_id, step_key_digest, attempt, state, started_at_ms, meta_json)
            VALUES (${"run-1"}, ${digest}, ${(index % 2) + 1}, 'running', 1, '{}')
          `
        }
        yield* put("run-2", "digest-0000", 1)
        const store = yield* AttemptStore
        const identity = (row: AttemptStoreLive.Attempt) => `${row.stepKeyDigest}#${row.attempt}`

        // Unpaged, the whole run is still answered, read one bounded page at a time.
        count.statements = 0
        const all = yield* store.listRun!("run-1")
        expect(all).toHaveLength(total)
        expect(count.statements).toBe(2)
        expect(all.map(identity)).toEqual([...all.map(identity)].sort())
        expect(new Set(all.map((row) => row.runId))).toEqual(new Set(["run-1"]))

        // Paged, each read holds at most `limit` rows and resumes after the last one.
        const paged: Array<AttemptStoreLive.Attempt> = []
        let after: AttemptStoreLive.ListRunPage["after"] = undefined
        let reads = 0
        while (true) {
          count.statements = 0
          const page: ReadonlyArray<AttemptStoreLive.Attempt> = yield* store.listRun!("run-1", { limit: 7, after })
          expect(count.statements).toBe(1)
          expect(page.length).toBeLessThanOrEqual(7)
          reads++
          paged.push(...page)
          const last = page.at(-1)
          if (page.length < 7 || last === undefined) break
          after = { stepKeyDigest: last.stepKeyDigest, attempt: last.attempt }
        }
        expect(reads).toBe(Math.ceil((total + 1) / 7))
        expect(paged).toEqual(all)
        // A cursor at the last row answers an empty page, and one page can hold the maximum.
        const end = all.at(-1)!
        expect(yield* store.listRun!("run-1", { limit: 1, after: end })).toEqual([])
        expect(yield* store.listRun!("run-1", { limit: AttemptStoreLive.maximumListRunPage })).toEqual(
          all.slice(0, AttemptStoreLive.maximumListRunPage)
        )
      }).pipe(
        Effect.provide(AttemptStoreLive.layer),
        Effect.provide(Layer.provideMerge(counted(count), Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
      )
    }))

  it.effect("stops an unpaged read when the last page is exactly full", () =>
    Effect.gen(function*() {
      const count = { statements: 0 }
      yield* Effect.gen(function*() {
        yield* createRun("run-1")
        const sql = yield* Effect.service(SqlClient.SqlClient)
        for (let index = 0; index < AttemptStoreLive.maximumListRunPage; index++) {
          yield* sql`
            INSERT INTO flows_attempts (run_id, step_key_digest, attempt, state, started_at_ms, meta_json)
            VALUES (${"run-1"}, ${`digest-${String(index).padStart(4, "0")}`}, 1, 'running', 1, '{}')
          `
        }
        const store = yield* AttemptStore
        count.statements = 0
        expect(yield* store.listRun!("run-1")).toHaveLength(AttemptStoreLive.maximumListRunPage)
        // A full page cannot say it was the last, so one more read finds the end.
        expect(count.statements).toBe(2)
      }).pipe(
        Effect.provide(AttemptStoreLive.layer),
        Effect.provide(Layer.provideMerge(counted(count), Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
      )
    }))

  it.effect("refuses a page whose limit or cursor is out of contract", () =>
    migrated(Effect.gen(function*() {
      const store = yield* AttemptStore
      const pages: ReadonlyArray<AttemptStoreLive.ListRunPage> = [
        { limit: 0 },
        { limit: -1 },
        { limit: 1.5 },
        { limit: AttemptStoreLive.maximumListRunPage + 1 },
        { limit: 1, after: { stepKeyDigest: "", attempt: 1 } },
        { limit: 1, after: { stepKeyDigest: "digest-a", attempt: 1.5 } }
      ]
      for (const page of pages) {
        const failure = yield* Effect.flip(store.listRun!("run-1", page))
        expect([failure.code, failure.method]).toEqual(["invalid_attempt", "listRun"])
      }
    })))

  it.effect(
    "refuses meta, error and outcome over the value ceiling at put, finish and patch",
    () =>
      migrated(Effect.gen(function*() {
        yield* createRun("run-1")
        const store = yield* AttemptStore
        // Thirty-three 1 MiB strings: no one string is over the ceiling, their sum is.
        const mebibyte = "x".repeat(1024 * 1024)
        const large = {
          parts: Array.from({ length: AttemptStoreLive.maximumValueBytes / mebibyte.length + 1 }, () => mebibyte)
        }
        const id = { runId: "run-1", stepKeyDigest: "digest-a", attempt: 1 }
        const attempt = { ...id, state: "running", startedAtMs: 1, meta: {} }
        const refused = <A>(effect: Effect.Effect<A, AttemptStoreLive.AttemptStoreError>, method: string) =>
          Effect.map(Effect.flip(effect), (failure) => {
            expect([failure.code, failure.method]).toEqual(["invalid_attempt", method])
            expect(failure.message).toContain("exceeds the JSON byte limit")
          })

        yield* refused(store.put({ ...attempt, meta: large }, owner), "put")
        yield* refused(store.put({ ...attempt, error: large }, owner), "put")
        yield* refused(store.put({ ...attempt, outcome: large }, owner), "put")
        expect(Option.isNone(yield* store.get(id))).toBe(true)

        expect(yield* store.put(attempt, owner)).toEqual({ _tag: "Inserted" })
        for (const field of ["meta", "error", "outcome"] as const) {
          yield* refused(store.patch(id, { [field]: large }, owner), "patch")
          yield* refused(
            store.finish({ ...id, state: "failed", finishedAtMs: 2, [field]: large }, owner),
            "finish"
          )
        }
        // Nothing oversized was stored: the row is as it was put, and still finishes.
        expect(Option.getOrThrow(yield* store.get(id))).toMatchObject({ state: "running", meta: {} })
        const fits = { note: "x".repeat(1024) }
        expect(yield* store.finish({ ...id, state: "failed", finishedAtMs: 2, error: fits, outcome: fits }, owner))
          .toEqual({ _tag: "Finished" })
        expect(Option.getOrThrow(yield* store.get(id))).toMatchObject({ state: "failed", error: fits, outcome: fits })
      })),
    { timeout: 120_000 }
  )

  it.effect("refuses a run id outside the durable identifier contract", () =>
    migrated(Effect.gen(function*() {
      const store = yield* AttemptStore
      const failure = yield* Effect.flip(store.listRun!(""))
      expect(failure.code).toBe("invalid_attempt")
      expect(failure.method).toBe("listRun")
    })))

  it.effect("fails decode_failed on a corrupt row rather than listing part of the run", () =>
    migrated(Effect.gen(function*() {
      yield* createRun("run-1")
      yield* put("run-1", "digest-a", 1)
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* TestDatabase.checks(sql, false)
      yield* sql.unsafe(`UPDATE flows_attempts SET meta_json = 'not-json' WHERE run_id = 'run-1'`)
      const store = yield* AttemptStore
      const failure = yield* Effect.flip(store.listRun!("run-1"))
      expect(failure.code).toBe("decode_failed")
      expect(failure.method).toBe("listRun")
    })))

  it.effect("names itself in a persistence failure", () =>
    Effect.gen(function*() {
      const sql = new Proxy(() => Effect.fail("down"), {
        apply: () => Effect.fail("down"),
        get: (target, property) => property === "in" ? () => "" : Reflect.get(target, property)
      }) as unknown as SqlClient.SqlClient
      const failure = yield* Effect.flip(
        Effect.flatMap(AttemptStore, (store) => store.listRun!("run-1")).pipe(
          Effect.provide(AttemptStoreLive.layer),
          Effect.provide(Layer.merge(
            Layer.succeed(SqlClient.SqlClient)(sql),
            Layer.succeed(DurableWriter.DurableWriter)(
              DurableWriter.DurableWriter.of({ write: () => Effect.die("no writes here") })
            )
          ))
        )
      )
      expect(failure.code).toBe("persistence_failed")
      expect(failure.message).toBe("persistence_failed: AttemptStore.listRun: attempt persistence failed")
    }))

  it("is absent from the closed stub, so a caller falls back to reading each attempt", () => {
    expect(AttemptStoreLive.makeNoop().listRun).toBeUndefined()
  })
})
