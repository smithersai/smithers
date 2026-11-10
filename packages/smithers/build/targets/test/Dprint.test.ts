import { describe, expect, it } from "vitest"
import { Dprint } from "../src/Dprint.vibe"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { plannedArgv } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

describe("Dprint", () => {
  it.each([false, true])("renders a workspace-rooted config with fix %s", (fix) => {
    const config = Input.file("//dprint.json")
    const target = Dprint({
      packageManager,
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      config,
      fix,
      cwd: "packages/foo"
    })
    expect(plannedArgv(target)).toEqual([
      "pnpm",
      "exec",
      "dprint",
      fix ? "fmt" : "check",
      "--config",
      "../../dprint.json"
    ])
    expect(Target.metadata(target).inputs).toContainEqual(config)
  })

  it("declares a lint-kind, non-cacheable formatting check", () => {
    const target = Dprint({
      packageManager,
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      config: Input.file("dprint.json"),
      fix: false,
      cwd: "packages/example"
    })
    const metadata = Target.metadata(target)
    expect(metadata.target).toBe("Dprint")
    expect(metadata.kinds).toEqual(["lint"])
    expect(metadata.cacheable).toBe(false)
    expect(metadata.inputs).toHaveLength(2)
  })
})
