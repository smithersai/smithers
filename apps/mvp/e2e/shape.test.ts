import { request as playwrightRequest, type APIRequestContext } from "@playwright/test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import * as TestDatabase from "../db/TestDatabase"
import { testFile } from "../worker/test/harness"
import { shapeRows } from "./shape"

const database = testFile("mobile_shapes")
let request: APIRequestContext
let path: string
beforeAll(async () => {
  const origin = await Effect.runPromise(TestDatabase.electricUrl)
  request = await playwrightRequest.newContext({ baseURL: origin })
  const { name } = await database.runPromise(Effect.service(TestDatabase.Scratch))
  path = `/v1/shape?table=${name}.mobile_snapshot`
  await database.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`CREATE TABLE mobile_snapshot (id text PRIMARY KEY, text text NOT NULL)`))
  await database.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`CREATE TABLE mobile_empty (id text PRIMARY KEY)`))
})
afterAll(async () => { await request?.dispose() })

test("a real Electric snapshot finishes empty, then includes every row across its chunks", async () => {
  expect(await shapeRows(request, path.replace("mobile_snapshot", "mobile_empty"))).toEqual([])
  await database.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`INSERT INTO mobile_snapshot SELECT n::text, repeat('x', 8000) FROM generate_series(1, 3000) n`))
  // Seed before opening this shape so the initial snapshot reads the committed fixture directly.
  // The separate empty shape above never creates a partial replay baseline for this 24 MB transaction.
  const origin = await Effect.runPromise(TestDatabase.electricUrl)
  let pages = 0
  const keys = new Set<string>()
  // Observe real requests without replacing their answers or the Electric server.
  const observed = Object.create(request) as APIRequestContext
  observed.get = async (...args) => {
    pages++
    const key = new URL(args[0], origin).searchParams.get("cache-buster")
    expect(key, "fixture polls cannot reuse the previous immutable snapshot cache key").toMatch(/^[0-9a-f-]{36}$/)
    keys.add(key!)
    return request.get(...args)
  }
  const rows = await shapeRows<{ id: string; text: string }>(observed, path)
  expect(pages).toBeGreaterThan(1)
  expect(keys.size, "pagination keeps one consistent snapshot cache identity").toBe(1)
  expect(rows).toHaveLength(3000)
  expect(new Set(rows.map((row) => row.id)).size).toBe(3000)
  expect(rows.every((row) => row.text.length === 8000)).toBe(true)
  await database.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(Effect.gen(function* () {
    yield* sql`UPDATE mobile_snapshot SET text = 'changed' WHERE id = '1'`
    yield* sql`DELETE FROM mobile_snapshot WHERE id = '2'`
  }))))
  await vi.waitFor(async () => {
    const changed = await shapeRows<{ id: string; text: string }>(observed, path)
    expect(changed).toHaveLength(2999)
    expect(changed.find((row) => row.id === "1")?.text).toBe("changed")
    expect(changed.some((row) => row.id === "2")).toBe(false)
  }, { timeout: 30_000 })
  expect(keys.size, "a read after a write uses a fresh snapshot cache identity").toBeGreaterThan(1)
}, 60_000)

test("a real shape refusal fails the prerequisite instead of returning an empty list", async () => {
  await expect(shapeRows(request, "/v1/shape?table=absent_mobile_fixture.rows")).rejects.toThrow("complete fixture snapshot")
  await expect(shapeRows(request, "/v1/shape")).rejects.toThrow("complete fixture snapshot")
})
