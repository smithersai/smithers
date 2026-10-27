import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { readFileSync } from "node:fs"
import { inspect } from "node:util"
import { expect, it } from "vitest"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as Migrations from "../src/Migrations.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"

it("prints exactly the SQLite row formatting shown in the quickstart", async () => {
  const notes: Migrations.MigrationSet = {
    namespace: "notes",
    idOffset: 0,
    migrations: {
      "0001_initial": Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)`
      })
    }
  }
  const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: ":memory:" }))
  const layer = Layer.provideMerge(Migrations.layer([notes]), database)
  const rows = await Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = yield* DurableWriter.DurableWriter
      yield* writer.write(sql`INSERT INTO notes (id, body) VALUES ('first', 'hello')`)
      return yield* sql<{ readonly body: string }>`SELECT body FROM notes ORDER BY id`
    }).pipe(Effect.provide(layer), Effect.scoped)
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]!.body).toBe("hello")
  expect(Object.getPrototypeOf(rows[0])).toBeNull()
  const page = readFileSync(new URL("../docs/quickstart.md", import.meta.url), "utf8")
  const documented = page.split("The output is the row you inserted:")[1]!.split("```text\n")[1]!.split("\n```")[0]
  expect(documented).toBe(inspect(rows))
})
