import { describe, expect, it } from "@effect/vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/bun-database-busy-timeout.ts", import.meta.url))
const bunInstalled = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0

describe("Bun database busy timeout under real Bun", () => {
  it.skipIf(!bunInstalled)("matches Node defaults and honors explicit timeout precedence", () => {
    const output = execFileSync("bun", [fixture], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" })
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
      writable: [{ timeout: 0 }],
      readOnly: [{ timeout: 1_000 }],
      sqliteReadOnly: [{ timeout: 1_000 }],
      explicitWritable: [{ timeout: 0 }],
      readOnlyWins: [{ timeout: 1_000 }],
      topLevelDuration: [{ timeout: 7 }],
      nestedDuration: [{ timeout: 11 }],
      topLevelWins: [{ timeout: 13 }],
      topLevelZeroWins: [{ timeout: 0 }],
      readOnlyOverride: [{ timeout: 19 }],
      readOnlyNestedOverride: [{ timeout: 23 }],
      sqliteReadOnlyOverride: [{ timeout: 29 }],
      readOnlyZeroWins: [{ timeout: 0 }]
    })
  })
})
