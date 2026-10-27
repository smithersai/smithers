/** Real CLI/TUI validation boundaries; no model, credentials, or terminal needed. */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it } from "vitest"
import * as Tui from "../src/commands/Tui.ts"

const bin = fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url))
const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const run = (args: Array<string>) => {
  const root = mkdtempSync(join(tmpdir(), "tui-flags-"))
  roots.push(root)
  return spawnSync(process.execPath, [bin, "tui", ...args], {
    encoding: "utf8",
    timeout: 120_000,
    cwd: root,
    env: {
      PATH: process.env["PATH"],
      HOME: root,
      XDG_DATA_HOME: root,
      // Keep the VibeLang loader but remove the farm's webstorage suppression.
      NODE_OPTIONS: (process.env["NODE_OPTIONS"] ?? "").replaceAll("--no-experimental-webstorage", ""),
      SMITHERS_BUN: "bun",
      SMITHERS_TUI_SESSION_DIR: join(root, "sessions")
    }
  })
}

it("forwards daily and workspace flags, including explicit cap opt-outs", () => {
  expect(Tui.argv({})).toEqual([])
  for (const budgetDailyTokens of ["5", "0", "none"]) {
    expect(Tui.argv({ budgetDailyTokens, box: "owner/repo/workspace", directory: "two words" })).toEqual([
      "--budget-daily-tokens",
      budgetDailyTokens,
      "--box",
      "owner/repo/workspace",
      "two words"
    ])
  }
})

it("the documented daily flag reaches native budget validation", () => {
  const result = run(["--budget-daily-tokens", "abc"])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("--budget-daily-tokens")
  expect(result.stderr).toContain("positive whole number")
  expect(`${result.stdout}${result.stderr}`).not.toContain("Unknown flag")
}, 150_000)

it("the documented workspace flag reaches native workspace validation", () => {
  const result = run(["--box", "invalid"])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("--box needs owner/repo/workspace-id")
  expect(`${result.stdout}${result.stderr}`).not.toContain("Unknown flag")
}, 150_000)

it("help names the real default and both ways to disable the per-turn cap", () => {
  const result = run(["--help"])
  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/budget-tokens[^\n]*200M[^\n]*0 or none/)
  expect(result.stdout).not.toContain("unbounded by default")
}, 150_000)

it("Node startup retains the validation diagnostic without probing browser localStorage", () => {
  const result = run(["--budget-tokens", "abc"])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("--budget-tokens")
  expect(result.stderr).not.toContain("localStorage")
  expect(result.stderr).not.toContain("ExperimentalWarning")
}, 150_000)
