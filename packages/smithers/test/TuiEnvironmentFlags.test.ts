/** Saved local execution environments use the same real TUI flag parser. */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import * as Environment from "../src/ExecutionEnvironment.ts"

it("forwards daily budgets and cloud workspace references through a saved environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-environment-flags-"))
  const bin = fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url))
  const directory = join(root, "bin")
  mkdirSync(directory)
  symlinkSync(bin, join(directory, "smthrs"))
  const env = {
    PATH: `${directory}:${process.env["PATH"] ?? ""}`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    SMITHERS_BUN: "bun",
    NODE_OPTIONS: process.env["NODE_OPTIONS"] ?? ""
  }
  try {
    await Environment.add({ name: "saved", transport: "local", directory: root, home: root }, env)
    for (
      const [flags, message] of [
        [
          ["--budget-daily-tokens", "abc", "--box", "owner/repo/workspace"],
          "--budget-daily-tokens must be a positive whole number"
        ],
        [["--budget-daily-tokens", "none", "--box", "invalid"], "--box needs owner/repo/workspace-id"]
      ] as const
    ) {
      const result = spawnSync(process.execPath, [bin, "tui", "--environment", "saved", "-p", "hello", ...flags], {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
        env
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(message)
      expect(`${result.stdout}${result.stderr}`).not.toContain("Unknown flag")
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 240_000)
