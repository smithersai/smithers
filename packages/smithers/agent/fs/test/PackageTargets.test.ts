import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

describe("manifest type-test gate", () => {
  it("exports a CI build target covering the isolated manifest fixture", () => {
    // Load the declaration in Node so build-tool types do not join this
    // package's ordinary test compilation (or its manifest augmentation).
    const result = execFileSync(process.execPath, [
      "--import",
      import.meta.resolve("vibelang/register"),
      "--input-type=module",
      "-e",
      `
        import { Package } from "./PACKAGE.ts"
        import { metadata } from "@smthrs/targets/Target"
        const checks = Object.values(Package).map(metadata)
          .filter((target) => target.target === "Typecheck")
        const gate = checks.find((target) => target.attrs.tsconfig.path === "tsconfig.types.json")
        console.log(JSON.stringify(gate === undefined ? null : {
          kinds: gate.kinds,
          srcs: gate.attrs.srcs,
          cwd: gate.attrs.cwd,
          buildMode: gate.attrs.buildMode,
          incremental: gate.attrs.incremental,
          dependsOnLib: gate.dependencies.includes(Package.lib)
        }))
      `
    ], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 30_000
    })

    expect(JSON.parse(result)).toEqual({
      kinds: ["build"],
      srcs: [
        { _tag: "Glob", pattern: "src/**/*.{ts,vibe}", exclude: [] },
        { _tag: "Glob", pattern: "type-tests/**/*.ts", exclude: [] },
        { _tag: "File", path: "tsconfig.json" },
        { _tag: "File", path: "tsconfig.test.json" }
      ],
      cwd: "packages/smithers/agent/fs",
      buildMode: false,
      incremental: false,
      dependsOnLib: true
    })

    const config = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"))
    expect(config("tsconfig.types.json").include).toEqual(["src/**/*", "type-tests/**/*"])
    expect(config("tsconfig.test.json").include).toEqual(["src/**/*", "test/**/*", "examples/**/*"])
  })
})
