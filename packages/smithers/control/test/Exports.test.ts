import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

// The migration step body is applied by the control store layer in order; it
// is sealed implementation detail, not importable API.
describe("package exports", () => {
  it.each(["ControlFacts", "JevSessionChecker"])(
    "resolves %s through development and published entry points",
    (name) => {
      const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
      const specifier = `@smthrs/control/${name}`
      const resolved = execFileSync(process.execPath, [
        "--input-type=module",
        "--eval",
        `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`
      ], { cwd: packageRoot, encoding: "utf8" }).trim()
      expect(resolved).toBe(new URL(`../src/${name}.ts`, import.meta.url).href)
      expect(manifest.publishConfig.exports[`./${name}`]).toEqual({
        import: { types: `./dist/esm/${name}.d.ts`, default: `./dist/esm/${name}.js` },
        require: { types: `./dist/cjs/${name}.d.ts`, default: `./dist/cjs/${name}.js` }
      })
    }
  )

  it("keeps migration implementations private in development and published exports", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      readonly exports: Readonly<Record<string, unknown>>
      readonly publishConfig: { readonly exports: Readonly<Record<string, unknown>> }
    }
    expect(manifest.exports["./migrations/*"]).toBeNull()
    expect(manifest.publishConfig.exports["./migrations/*"]).toBeNull()

    const specifier = "@smthrs/control/migrations/0001_control_tables"
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
})
