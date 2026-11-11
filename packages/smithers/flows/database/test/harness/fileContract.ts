/**
 * Two independently scoped native SQLite clients over one temporary file.
 *
 * @since 1.0.0
 */
import { Effect, type Layer } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DurableWriter from "../../src/DurableWriter.ts"
import type { Harness } from "../contract/DatabaseWriteContract.ts"
import { connect } from "./connect.ts"

/** Builds the same file-backed contract harness for the Node and Bun drivers. */
export const fileContract = (
  label: string,
  layer: (filename: string) => Layer.Layer<SqlClient.SqlClient>
): Harness => ({
  label,
  realDriver: true,
  crossConnection: true,
  run: (body) =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "flows-db-contract-"))),
      (directory) =>
        Effect.scoped(Effect.gen(function*() {
          const filename = join(directory, "contract.sqlite")
          const a = yield* connect(layer(filename))
          const b = yield* connect(layer(filename))
          return yield* body({
            a: { sql: a, write: DurableWriter.make(a).write },
            b: { sql: b, write: DurableWriter.make(b).write }
          })
        })),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
    )
})
