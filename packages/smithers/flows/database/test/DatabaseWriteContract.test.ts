import { Effect } from "effect"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import { describeContract, type Harness } from "./contract/DatabaseWriteContract.ts"
import { connect } from "./harness/connect.ts"

/** Builds one client/writer pair and keeps its connection open for the scope. */
const connectPair = (layer: typeof TestDatabase.layer) =>
  Effect.map(connect(layer), (sql) => ({ sql, write: DurableWriter.make(sql).write }))

/**
 * The in-memory path used by every other suite. `:memory:` is private to a
 * connection, so both handles are the same pair and serialization comes
 * from the client's in-process transaction mutex rather than the database —
 * a weaker mechanism that must still satisfy the same contract.
 */
const memoryHarness: Harness = {
  label: "TestDatabase, one shared in-memory connection",
  realDriver: false,
  crossConnection: false,
  run: (body) =>
    Effect.scoped(Effect.gen(function*() {
      const side = yield* connectPair(TestDatabase.layer)
      return yield* body({ a: side, b: side })
    })) as Effect.Effect<never>
}

describeContract(memoryHarness)
