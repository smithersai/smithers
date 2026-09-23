import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import * as Effect from "effect/Effect"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunHost from "../src/BunHost.ts"

describe("BunHost startup", () => {
  it.live("propagates a native executable's unsupported version as a typed construction failure", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "flows-bun-host-version-"))),
      (root) =>
        Effect.gen(function*() {
          // The host must propagate the real startup probe's typed refusal.
          // The running native binary reports a version that is not a jj version.
          const binary = process.execPath
          const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim()
          const previous = process.env.SMITHERS_JJ_PATH
          process.env.SMITHERS_JJ_PATH = binary
          try {
            const error = yield* Effect.flip(Effect.provide(Jj, BunHost.layerAt(root)))
            expect(error).toMatchObject({ code: "unsupported_version", method: "version" })
            expect(error.message).toContain("0.39.0")
            expect(error.message).toContain(`found ${version}`)
          } finally {
            if (previous === undefined) delete process.env.SMITHERS_JJ_PATH
            else process.env.SMITHERS_JJ_PATH = previous
          }
        }),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true }))
    ))
})

describe("test lane", () => {
  it("runs Bun compatibility assertions inside a Bun worker", () => {
    if (process.env.SMITHERS_PLATFORM_BUN_LANE === "1") {
      expect(process.versions.bun).toMatch(/^\d+\.\d+\.\d+/)
    }
  })

  it.skipIf(process.env.SMITHERS_PLATFORM_BUN_LANE === "1")("executes the declared Bun lane in a Bun worker", () => {
    const cwd = join(import.meta.dirname, "..")
    const plan = JSON.parse(execFileSync("node", [
      "--input-type=module",
      "-e",
      `
      import { Package } from "./PACKAGE.ts";
      import { plannedCalls } from "../../build/targets/test/plan.ts";
      console.log(JSON.stringify(plannedCalls(Package.bunTest)[0].payload));
    `
    ], { cwd, encoding: "utf8", timeout: 60_000 })) as {
      argv: [string, ...Array<string>]
      env?: Record<string, string>
    }
    const result = spawnSync(plan.argv[0], [
      ...plan.argv.slice(1),
      "test/BunHostVersion.test.ts",
      "-t",
      "runs Bun compatibility assertions"
    ], {
      cwd,
      env: { ...process.env, ...plan.env, SMITHERS_PLATFORM_BUN_LANE: "1" },
      encoding: "utf8",
      timeout: 60_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain("1 passed")
  }, 90_000)

  it("isolates coverage output and removes it when the runner exits", () => {
    const output = execFileSync("node", [
      "--input-type=module",
      "-e",
      `
      import config from "./vitest.config.ts";
      import { statSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const directory = config.test.coverage.reportsDirectory;
      const info = statSync(directory);
      console.log(JSON.stringify({ directory, mode: info.mode & 0o777, isDirectory: info.isDirectory() }));
      writeFileSync(join(directory, "probe.json"), "{}");
    `
    ], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" })
    const { directory, isDirectory, mode } = JSON.parse(output) as {
      directory: string
      mode: number
      isDirectory: boolean
    }
    expect(isDirectory).toBe(true)
    // Every host proves creation, a successful write, and exit cleanup.
    // Owner-only POSIX mode bits are an additional POSIX-host assertion.
    if (process.platform !== "win32") expect(mode).toBe(0o700)
    expect(existsSync(directory)).toBe(false)
  })
})
