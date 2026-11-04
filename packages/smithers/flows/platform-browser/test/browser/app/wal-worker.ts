/** Counts real OPFS writes, and leaves an uncommitted transaction for a worker-crash recovery check. */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { BrowserSqlite } from "../../../src/index.ts"

const mode = new URL(self.location.href).searchParams.get("mode")
const program = Effect.gen(function*() {
  // Count the actual host calls, not SQLite's calls into its VFS. No simulated storage.
  const probe = yield* Effect.promise(async () => {
    const directory = await navigator.storage.getDirectory()
    const file = await directory.getFileHandle("counter-probe", { create: true })
    return (file as FileSystemFileHandle & {
      createSyncAccessHandle(): Promise<{ close(): void }>
    }).createSyncAccessHandle()
  })
  const prototype = Object.getPrototypeOf(probe)
  const write = prototype.write
  const flush = prototype.flush
  let writes = 0, syncs = 0
  prototype.write = function(...args: unknown[]) {
    writes++
    return write.apply(this, args)
  }
  prototype.flush = function(...args: unknown[]) {
    syncs++
    return flush.apply(this, args)
  }
  probe.close()
  const sqlite = BrowserSqlite.layerSqlite({
    directory: "wal-write-budget",
    build: {
      module: () => import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"),
      wasm: () => fetch("/wa-sqlite.wasm").then((response) => response.arrayBuffer())
    }
  })
  yield* Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    if (mode === "write") {
      yield* sql`CREATE TABLE data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`
      writes = 0
      syncs = 0
      yield* sql.withTransaction(
        Effect.forEach(
          Array.from({ length: 128 }, (_, id) => id),
          (id) => sql`INSERT INTO data VALUES (${id}, ${String(id).padStart(4, "0") + "x".repeat(1020)})`,
          { discard: true }
        )
      )
    }
    const cost = { writes, syncs }
    const rows = yield* sql<{ id: number; value: string }>`SELECT id, value FROM data ORDER BY id`
    const valid = rows.length === 128 &&
      rows.every((row, id) => row.id === id && row.value === String(id).padStart(4, "0") + "x".repeat(1020))
    const integrity = yield* sql`PRAGMA integrity_check`
    const journal = yield* sql`PRAGMA journal_mode`
    const synchronous = yield* sql`PRAGMA synchronous`
    if (mode === "write") {
      // Force dirty pages through SQLite before killing the worker, without acknowledging their commit.
      yield* sql`BEGIN IMMEDIATE`
      yield* sql`UPDATE data SET value = ${"uncommitted".repeat(1024)}`
    }
    self.postMessage({ ...cost, valid, integrity, journal, synchronous })
    return yield* Effect.never
  }).pipe(Effect.provide(BrowserSqlite.layer({ filename: "test.db" }).pipe(Layer.provide(sqlite))))
})
Effect.runFork(
  Effect.scoped(program).pipe(Effect.catchCause(() => Effect.sync(() => self.postMessage({ failed: true }))))
)
