import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import { describeContract, type Harness } from "./contract/DatabaseWriteContract.ts"
import { connect } from "./harness/connect.ts"

/** Builds one client/writer pair and keeps its connection open for the scope. */
const connectPair = (layer: typeof TestDatabase.layer) =>
  Effect.map(connect(layer), (sql) => ({ sql, write: DurableWriter.make(sql).write }))

/**
 * The matrix-selected test client: SQLite in memory, or an isolated PostgreSQL
 * schema. Sharing one pair exercises client serialization; the independent
 * driver harnesses additionally exercise cross-client isolation and rollback.
 */
const memoryHarness: Harness = {
  label: "TestDatabase, one shared client",
  realDriver: false,
  crossConnection: false,
  run: (body) =>
    Effect.scoped(Effect.gen(function*() {
      const side = yield* connectPair(TestDatabase.layer)
      return yield* body({ a: side, b: side })
    })) as Effect.Effect<never>
}

describeContract(memoryHarness, { describe, expect, it })
