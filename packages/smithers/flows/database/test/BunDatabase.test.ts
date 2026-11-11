import { describe, expect, it } from "@effect/vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/bun-database.ts", import.meta.url))

// The adapter imports `bun:sqlite`, which Node cannot load, so only a real Bun
// process can show what it does: its guard probe, its owner-only pre-create and
// its read-only opens all run on Bun's own driver. A Node shim here once passed
// a `file:` open of a 0.x database that real Bun let through (issue #4504).
const bunInstalled = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0

describe("Bun database adapter under real Bun", () => {
  it.skipIf(!bunInstalled)("guards, creates and opens read-only on Bun's own driver", () => {
    const output = execFileSync("bun", [fixture], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" })
    const refused = { refused: "unsupported_database_file" }
    const selected = { value: [{ value: 1 }] }
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
      memory: selected,
      created: selected,
      // A directory is not a database: the open fails, and is not a refusal.
      directory: { refused: "failed" },
      // A `file:` URI names the same 0.x file as its path, whatever its query.
      zeroX: {
        path: refused,
        uri: refused,
        absoluteUri: refused,
        readWriteUri: refused,
        readOnly: refused,
        tables: ["_smithers_runs"]
      },
      lockedZeroX: refused,
      migrated: { path: selected, uri: selected },
      modes: { value: [0o600, 0o600, 0o600] },
      observe: { value: { readOnly: true, written: false } },
      readOnlyMissing: { refused: "failed", mode: "missing" },
      sqliteReadOnlyMissing: { refused: "failed", mode: "missing" },
      createDisabled: { refused: "failed", mode: "missing" },
      readWriteDisabled: { mode: 0o644 },
      corrupt: { refused: "failed" }
    })
  })
})
