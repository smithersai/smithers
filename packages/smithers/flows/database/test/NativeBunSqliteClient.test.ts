import { describe, expect, it } from "@effect/vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/bun-sqlite-client.ts", import.meta.url))

// BunSqliteClient.test.ts shims bun:sqlite with Node, so only a real Bun process
// proves what the vendored client does with Bun's own driver: its error codes,
// its `file:` opens and its transaction state.
const bunInstalled = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0

describe("Bun SQLite client under real Bun", () => {
  it.skipIf(!bunInstalled)(
    "rolls back a rejected COMMIT, releases savepoints and opens read-only by path and URI",
    () => {
      const output = execFileSync("bun", [fixture], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" })
      expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
        writable: {
          driver: "sqlite-bun",
          // A deferred foreign key rejects the COMMIT: typed, and rolled back.
          rejected: "constraint",
          afterRejected: [],
          // A nested write is a savepoint, and its raw write still counts rows.
          nested: 1,
          journal: [{ journal_mode: "wal" }]
        },
        readOnly: { rows: [{ id: 1 }], writeRefused: true },
        readOnlyUri: { rows: [{ id: 1 }], writeRefused: true },
        unopened: true
      })
    }
  )
})
