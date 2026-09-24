import { expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Log from "../src/log.ts"

it("appends private redacted diagnostics without losing earlier failures", () => {
  const previous = process.env.SMITHERS_TUI_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), "tui-log-"))
  process.env.SMITHERS_TUI_SESSION_DIR = root
  try {
    const token = `ghp_${"x".repeat(36)}`
    Log.write("discovery", new Error(`refused ${token}`))
    Log.write("compaction", "seat unavailable")
    const saved = readFileSync(Log.path(), "utf8")
    const records = saved.trim().split("\n").map((line) => JSON.parse(line))
    expect(records.map((r) => r.tag)).toEqual(["discovery", "compaction"])
    expect(records[0].detail).toContain("Error: refused")
    expect(saved.includes(token)).toBe(false)
    expect(statSync(Log.path()).mode & 0o777).toBe(0o600)
  } finally {
    if (previous === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})
