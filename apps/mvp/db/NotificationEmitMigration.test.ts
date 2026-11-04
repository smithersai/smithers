import { Effect, ManagedRuntime, Redacted } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { afterAll, beforeAll, expect, test } from "vitest"
import * as Database from "./Database.ts"
import * as TestDatabase from "./TestDatabase.ts"

const runtime = ManagedRuntime.make(TestDatabase.layer("emit_migration"))
beforeAll(() => runtime.runPromise(Effect.void))
afterAll(() => runtime.dispose())

test("0107 preserves legacy rows and separates emit suppression from repository projection triggers", async () => {
  const schema = `emit_upgrade_${crypto.randomUUID().replaceAll("-", "")}`
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`CREATE SCHEMA ${sql(schema)}`))
  try {
    const url = await runtime.runPromise(TestDatabase.serverUrl)
    url.searchParams.set("options", `-c search_path=${schema}`)
    const database = Database.layer(Effect.succeed(Redacted.make(url.toString())))
    const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect.pipe(Effect.provide(database)))
    const through = (last: string) => on(Migrator.make({})({ loader: Migrator.fromRecord(
      Object.fromEntries(Object.entries(Database.migrations).filter(([name]) => name.slice(0, 4) <= last)),
    ) }))
    await through("0106")
    const query = (statement: string) => on(Effect.flatMap(SqlClient.SqlClient, sql => sql.unsafe(statement)))
    await query(`INSERT INTO notification_repository_access (recipient, repo_id, readable, checked_at)
      VALUES ('person', 'github/acme/repo', true, now())`)
    await query(`INSERT INTO notifications (recipient, subject, kind, state, mine, repo_id, href)
      VALUES ('person', 'main:legacy', 'main', 'update', false, 'github/acme/repo', '/app')`)
    const before = await query(`SELECT * FROM notifications`)
    expect((await through("0107")).map(([id, name]) => `${id}_${name}`)).toEqual(["107_notification_emit_projection"])
    expect(await query(`SELECT * FROM notifications`)).toEqual(before.map(row => ({ ...row, emit_readable: true })))
    await query(`UPDATE notifications SET emit_readable = false`)
    await query(`UPDATE notification_repository_access SET readable = false`)
    await query(`UPDATE notification_repository_access SET readable = true`)
    // Repository renewal and notification writes must not reopen a settled emit projection.
    await query(`UPDATE notifications SET repo_id = repo_id, title = 'updated'`)
    expect(await query(`SELECT feed_readable, emit_readable FROM notifications`)).toEqual([{ feed_readable: true, emit_readable: false }])
    expect(await through("0107")).toEqual([])
  } finally {
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`DROP SCHEMA ${sql(schema)} CASCADE`))
  }
})
