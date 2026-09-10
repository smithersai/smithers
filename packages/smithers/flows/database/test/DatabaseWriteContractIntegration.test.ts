import { Duration, Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import { describeContract, type Harness } from "./contract/DatabaseWriteContract.ts"
import { connect } from "./harness/connect.ts"

/** Builds one real client/writer pair and keeps its connection open for the scope. */
const connectPair = (filename: string) =>
  Effect.map(
    connect(NodeDatabase.layer({ filename, sqlite: { busyTimeout: Duration.millis(5) } })),
    (sql) => ({ sql, write: DurableWriter.make(sql).write })
  )

/**
 * The production Node path: two independent connections over one database
 * file, so serialization can only come from SQLite's cross-connection lock.
 */
const nodeFileHarness: Harness = {
  label: "NodeDatabase, two connections over one file",
  realDriver: true,
  crossConnection: true,
  run: (body) =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "flows-db-contract-"))),
      (directory) =>
        Effect.scoped(Effect.gen(function*() {
          const filename = join(directory, "contract.sqlite")
          const a = yield* connectPair(filename)
          const b = yield* connectPair(filename)
          return yield* body({ a, b })
        })),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
    )
}

describeContract(nodeFileHarness)
