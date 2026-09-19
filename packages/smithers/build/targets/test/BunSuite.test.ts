/**
 * The attrs `BunSuite` emits.
 *
 * The macro replaced a central `ci/PACKAGE.ts` that spelled one Bun re-run per
 * package from outside the package. What is asserted here is what moving the
 * declaration inside the package bought: real package-relative globs and the
 * package's own vitest config, on a target that still names Bun and still
 * refuses coverage.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { BunSuite } from "../src/BunSuite.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import type * as Vitest from "../src/Vitest.ts"
import { plannedArgv } from "./plan.ts"

const attrsOf = (target: unknown): Vitest.Attrs => Target.metadata(target as never).attrs as Vitest.Attrs

describe("BunSuite", () => {
  it("runs the declared suite in Bun despite the installed Node shebang", () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-bun-suite-"))
    const packageDirectory = fileURLToPath(new URL("..", import.meta.url))
    try {
      symlinkSync(
        fileURLToPath(new URL("../node_modules", import.meta.url)),
        join(directory, "node_modules"),
        "junction"
      )
      writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }))
      writeFileSync(
        join(directory, "vitest.config.mjs"),
        `export default {
        root: ${JSON.stringify(directory)},
        test: { include: ["runtime.test.mjs"], maxWorkers: 1, fileParallelism: false, coverage: { enabled: false } }
      }\n`
      )
      writeFileSync(
        join(directory, "runtime.test.mjs"),
        `import { writeFileSync } from "node:fs";
        import { test } from "vitest";
        test("actual interpreter", () => writeFileSync(${
          JSON.stringify(join(directory, "runtime.json"))
        }, JSON.stringify({ bun: process.versions.bun })));
      `
      )
      const argv = plannedArgv(BunSuite({
        cwd: packageDirectory,
        config: Input.file(join(directory, "vitest.config.mjs")),
        tests: Input.glob("runtime.test.mjs")
      }))
      const ran = spawnSync(argv[0]!, argv.slice(1), {
        cwd: packageDirectory,
        env: { ...process.env, VITEST_MAX_WORKERS: "1" },
        encoding: "utf8",
        timeout: 30_000
      })
      expect(ran.error).toBeUndefined()
      expect(ran.status, ran.stdout + ran.stderr).toBe(0)
      const observed = JSON.parse(readFileSync(join(directory, "runtime.json"), "utf8")) as { bun?: string }
      expect(observed.bun).toEqual(expect.any(String))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("declares the package's own suite, sources, and vitest config", () => {
    const attrs = attrsOf(BunSuite({ cwd: "packages/smithers/flows/keys" }))
    expect(attrs.cwd).toBe("packages/smithers/flows/keys")
    expect(attrs.tests).toEqual([Input.glob("test/**/*.test.ts")])
    expect(attrs.sources).toEqual([Input.glob("src/**/*.ts")])
    expect(attrs.config).toEqual(Input.file("vitest.config.ts"))
    expect(attrs.deps).toEqual([])
    expect(attrs.environment).toBe("node")
    expect(attrs.passWithNoTests).toBe(false)
  })

  it("names Bun as the interpreter rather than restating a package manager", () => {
    const attrs = attrsOf(BunSuite({ cwd: "packages/smithers/flows/keys" }))
    expect(attrs.runtime).toEqual({ name: "bun", version: ">=1.4.0", executable: "bun" })
    expect(attrs.packageManager).toBeUndefined()
  })

  it("refuses coverage, because Bun runs JavaScriptCore", () => {
    const attrs = attrsOf(BunSuite({ cwd: "packages/smithers/flows/keys" }))
    expect(attrs.coverage).toBe(false)
    expect(plannedArgv(BunSuite({ cwd: "packages/smithers/flows/keys" }))).toEqual([
      "bun",
      "x",
      "--bun",
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      "--environment",
      "node",
      "--coverage.enabled=false"
    ])
  })

  it("participates in the test verb", () => {
    expect(Target.metadata(BunSuite({ cwd: "packages/smithers/flows/keys" })).kinds).toEqual(["test"])
  })

  it("lets a package override the suite, the sources, the config, and the environment", () => {
    const attrs = attrsOf(BunSuite({
      cwd: "packages/smithers/flows/platform-browser",
      tests: Input.glob("test/**/*.contract.test.ts"),
      sources: Input.glob("src/**/*.mts"),
      config: null,
      environment: "happy-dom"
    }))
    expect(attrs.tests).toEqual([Input.glob("test/**/*.contract.test.ts")])
    expect(attrs.sources).toEqual([Input.glob("src/**/*.mts")])
    expect(attrs.config).toBeNull()
    expect(attrs.environment).toBe("happy-dom")
    expect(plannedArgv(BunSuite({ cwd: "packages/x", config: null }))).not.toContain("--config")
  })

  it("keys on the declared suite and sources, which a central declaration could not do", () => {
    // `ci/PACKAGE.ts` had to pass `tests: []` and `sources: []`: a glob written
    // there resolved against `ci/`, not against the package the suite belongs
    // to, so it expanded to nothing and read as a contract it was not.
    const inputs = Target.metadata(BunSuite({ cwd: "packages/smithers/flows/keys" })).inputs
    expect(inputs).toContainEqual(Input.glob("test/**/*.test.ts"))
    expect(inputs).toContainEqual(Input.glob("src/**/*.ts"))
  })
})
