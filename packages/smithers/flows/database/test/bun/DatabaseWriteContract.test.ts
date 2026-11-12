// Execute the shared assertions with native bun:sqlite, without a Node shim.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as BunDatabase from "../../src/bun/BunDatabase.ts"
import { describeContract } from "../contract/DatabaseWriteContract.ts"
import { fileContract } from "../harness/fileContract.ts"

const run = (name: string, body: () => Effect.Effect<unknown, unknown>) =>
  test(name, () => Effect.runPromise(body()), 30_000)

describeContract(
  fileContract(
    "BunDatabase, two native connections over one file",
    (filename) => BunDatabase.layer({ filename, sqlite: { busyTimeout: 5 } })
  ),
  { describe, expect, it: { effect: run, live: run } }
)
