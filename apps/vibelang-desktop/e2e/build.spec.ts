// Stays .ts: Playwright discovers and loads test files by JS/TS extension only.
import { test, expect } from "@playwright/test"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

test("stable test-mode builds stop before Electrobun can fall back to default configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "vibelang-desktop-build-"))
  try {
    copyFileSync(resolve("electrobun.config.ts"), join(directory, "electrobun.config.ts"))
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "desktop-build-test", version: "0.0.0", type: "module" }))
    const result = spawnSync(process.execPath, [resolve("node_modules/electrobun/bin/electrobun.cjs"), "build", "--env=stable"], {
      cwd: directory,
      env: { ...process.env, VIBELANG_DESKTOP_TEST: "1" },
      encoding: "utf8",
      timeout: 90000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("VIBELANG_DESKTOP_TEST must be unset for stable builds")
    expect(result.stderr).not.toContain("using default config instead")
    expect(result.stdout).not.toContain("Building app")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
