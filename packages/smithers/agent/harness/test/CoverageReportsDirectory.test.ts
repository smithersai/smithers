import { spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const packageDir = join(import.meta.dirname, "..")
const vitest = join(dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))), "vitest.mjs")

// vitest.config.ts names the report directory after the vitest process id, so
// every run gets a fresh one; a run that leaves it behind grows the temp dir by
// one report per invocation.
it("removes its per-process coverage report directory when the run ends", () => {
  const result = spawnSync(process.execPath, [
    vitest,
    "run",
    "test/bytes.test.ts",
    "--maxWorkers=1",
    // One test file cannot meet the package thresholds; zero them so the exit
    // status reports the run itself.
    ...["branches", "functions", "lines", "statements"].map((key) => `--coverage.thresholds.${key}=0`)
  ], { cwd: packageDir, encoding: "utf8", timeout: 120_000 })
  const reportsDirectory = join(tmpdir(), `flows-harness-coverage-${result.pid}`)
  try {
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    // The console table proves the run measured coverage instead of skipping it.
    expect(result.stdout).toContain("% Stmts")
    expect(existsSync(reportsDirectory)).toBe(false)
  } finally {
    rmSync(reportsDirectory, { recursive: true, force: true })
  }
}, 150_000)
