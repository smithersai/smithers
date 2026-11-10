import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import * as Target from "../src/Target.ts"
import * as ToolBuild from "../src/ToolBuild.ts"
import { CoverageReport, VitestCoverage } from "../src/VitestCoverage.vibe"
import { plannedValue } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

it("accepts the captured coverage result at the runner output verification boundary", async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-coverage-"))
  try {
    const cwd = "packages/example"
    const reportsDirectory = "coverage"
    await Fs.mkdir(Path.join(root, cwd, reportsDirectory), { recursive: true })
    await Fs.writeFile(Path.join(root, cwd, reportsDirectory, "coverage-final.json"), "{}")
    const target = VitestCoverage({
      packageManager,
      tests: [],
      sources: [],
      deps: [],
      config: null,
      provider: "v8",
      reportsDirectory,
      thresholds: { branches: 0, functions: 0, lines: 0, statements: 0 },
      cwd
    })
    const captured = await ToolBuild.measureOutputs(root, cwd, [reportsDirectory])
    const result = plannedValue(target, (call) => {
      if (call.action === "smithers-build/exec") return { exitCode: 0, stdout: "", stderr: "" }
      expect(call.action).toBe("smithers-build/capture-outputs")
      expect(call.payload).toEqual({ cwd, paths: [reportsDirectory] })
      return captured
    })
    expect(Schema.is(CoverageReport)(result)).toBe(true)
    const declared = Target.metadata(target).outputs!
    expect(ToolBuild.readOutputManifest(declared, result)).toEqual(captured)
    expect(await ToolBuild.verifyOutputs(root, declared, result)).toBeUndefined()
    const replay = Target.metadata(target).decodeSuccess(JSON.parse(JSON.stringify(result)))
    expect(await ToolBuild.verifyOutputs(root, declared, replay)).toBeUndefined()
    await Fs.writeFile(Path.join(root, cwd, reportsDirectory, "coverage-final.json"), "changed")
    expect(await ToolBuild.verifyOutputs(root, declared, result)).toMatch(/no longer matches/)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})
