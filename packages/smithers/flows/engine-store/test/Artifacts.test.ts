import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

describe("built artifacts", () => {
  it("keeps migration implementations private in development and published exports", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      readonly exports: Readonly<Record<string, unknown>>
      readonly publishConfig: { readonly exports: Readonly<Record<string, unknown>> }
    }
    expect(manifest.exports["./migrations/*"]).toBeNull()
    expect(manifest.publishConfig.exports["./migrations/*"]).toBeNull()

    const specifier = "@smthrs/engine-store/migrations/0001_initial"
    execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(specifier)}).then(
        () => process.exitCode = 2,
        (error) => process.exitCode = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? 0 : 3
      )`
    ], { cwd: packageRoot })
    execFileSync(process.execPath, [
      "--eval",
      `try {
        require(${JSON.stringify(specifier)})
        process.exitCode = 2
      } catch (error) {
        process.exitCode = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? 0 : 3
      }`
    ], { cwd: packageRoot })
  })

  it(
    "preserves service identity between root and subpath exports",
    () => {
      const build = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: packageRoot, encoding: "utf8" })
      expect(build.status, `${build.error?.message ?? ""}\n${build.stdout ?? ""}\n${build.stderr ?? ""}`).toBe(0)
      execFileSync(process.execPath, ["--import=vibelang/register", "test/fixtures/artifact-esm.mjs"], {
        cwd: packageRoot
      })
      execFileSync(process.execPath, ["--import=vibelang/register", "test/fixtures/artifact-cjs.cjs"], {
        cwd: packageRoot
      })
    },
    // This case runs a real build and two cold Node processes: 11.2 s even on
    // an idle machine. The old 30 s left barely 3x headroom and blew past it
    // whenever the other workspaces built concurrently. Sized against that
    // measurement, and still finite so a wedged build fails the gate.
    180_000
  )
})
