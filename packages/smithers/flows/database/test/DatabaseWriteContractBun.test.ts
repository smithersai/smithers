import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/bun-write-contract.ts", import.meta.url))
const bunInstalled = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0

describe("native Bun write contract", () => {
  it.skipIf(!bunInstalled)("runs every shared assertion on two Bun SQLite connections", () => {
    const result = spawnSync("bun", ["test", fixture], { encoding: "utf8", timeout: 60_000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain("12 pass")
    expect(result.stderr).toContain("0 fail")
  })
})
