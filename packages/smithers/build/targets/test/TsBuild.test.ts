import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { Attrs, distributionLayout, outputPaths, TsBuild } from "../src/TsBuild.vibe"
import { packageManager } from "./toolchain.ts"

const base = {
  packageManager,
  srcs: [Input.glob("src/**/*.ts")],
  entries: [Input.file("src/index.ts")],
  deps: [],
  tsconfig: Input.file("tsconfig.json"),
  outDir: "dist",
  cwd: "packages/example"
} as const

const program = { name: "program", entry: Input.file("scripts/build.mjs") } as const

describe("TsBuild output formats", () => {
  it("requires both halves of a dual distribution", () => {
    const target = TsBuild({ ...base, tool: program, format: "dual" })
    const metadata = Target.metadata(target)
    expect(metadata.target).toBe("TsBuild")
    expect(metadata.kinds).toEqual(["build"])
    expect(metadata.outputs).toEqual({ cwd: "packages/example", paths: ["dist/esm", "dist/cjs"] })
  })

  it("requires only the declared half of a single-format distribution", () => {
    expect(outputPaths(Attrs.make({ ...base, tool: { name: "tsc" }, format: "esm" }))).toEqual(["dist/esm"])
    expect(outputPaths(Attrs.make({ ...base, tool: { name: "tsc" }, format: "cjs" }))).toEqual(["dist/cjs"])
    expect(Target.metadata(TsBuild({ ...base, tool: { name: "tsc" }, format: "esm" })).outputs)
      .toEqual({ cwd: "packages/example", paths: ["dist/esm"] })
  })

  it("leaves a tsup bundle on its flat output directory", () => {
    const target = TsBuild({ ...base, tool: { name: "tsup", external: ["effect"] }, format: "dual" })
    expect(Target.metadata(target).outputs).toEqual({ cwd: "packages/example", paths: ["dist"] })
  })

  it("refuses tsc with the dual format, because one invocation emits one format", () => {
    expect(() => TsBuild({ ...base, tool: { name: "tsc" }, format: "dual" }))
      .toThrow(/one tsc invocation emits one module format/)
  })
})

describe("TsBuild program tool", () => {
  it("declares the build program as an input, so editing it re-keys the target", () => {
    const metadata = Target.metadata(TsBuild({ ...base, tool: program, format: "dual" }))
    expect(metadata.inputs).toContainEqual({ _tag: "File", path: "scripts/build.mjs" })
  })

  it("rejects a bare string where the program declaration belongs", () => {
    expect(() => TsBuild({ ...base, tool: { name: "program", entry: "scripts/build.mjs" }, format: "dual" } as never))
      .toThrow()
  })
})

describe("TsBuild with VibeLang sources", () => {
  it("names a .vibe entry's emitted JavaScript and declaration, as vibelang writes them", () => {
    const attrs = Attrs.make({ ...base, entries: [Input.file("src/index.vibe")], tool: program, format: "dual" })
    expect(distributionLayout(attrs)).toEqual([
      { format: "esm", directory: "dist/esm", entry: "dist/esm/index.js", declaration: "dist/esm/index.d.ts" },
      { format: "cjs", directory: "dist/cjs", entry: "dist/cjs/index.js", declaration: null }
    ])
  })
})
