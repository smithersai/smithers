import * as Pg from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as PostgresDatabase from "../src/postgres/PostgresDatabase.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import { schemaName } from "../src/TestSchemas.ts"
import { describeContract, type Harness } from "./contract/DatabaseWriteContract.ts"
import { connect } from "./harness/connect.ts"

const url = process.env.SMITHERS_TEST_PG_URL

const postgresHarness: Harness = {
  label: "PostgresDatabase, two independent pools over one schema",
  realDriver: true,
  // These two cases assert SQLite's specific SQLITE_BUSY behavior.
  crossConnection: false,
  run: (body) =>
    Effect.scoped(Effect.gen(function*() {
      const schema = schemaName("contract")
      const a = yield* connect(PostgresDatabase.layer({ url: url!, driver: Pg, schema }))
      yield* Effect.addFinalizer(() => TestDatabase.dropSchema(a, schema).pipe(Effect.orDie))
      const b = yield* connect(PostgresDatabase.layer({ url: url!, driver: Pg, schema }))
      expect(a).not.toBe(b)
      return yield* body({
        a: { sql: a, write: DurableWriter.make(a).write },
        b: { sql: b, write: DurableWriter.make(b).write }
      })
    }))
}

describe.skipIf(url === undefined)("PostgreSQL write contract", () => {
  describeContract(postgresHarness, { describe, expect, it })
})
