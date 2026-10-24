import { describe, expect, it } from "vitest"
import * as Cargo from "../src/Cargo.ts"
import * as Compose from "../src/Compose.ts"
import * as Workflow from "../src/GithubWorkflow.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

describe("shell gate discovery", () => {
  it.each([
    "f() { echo \"escaped \\\" quote\"; pnpm test; }",
    "f() { echo 'quoted { brace'; { pnpm test; }; }",
    "f() { echo \\}; pnpm test; }",
    "f() { cat <<EOF\npnpm test\nEOF\n}",
    "f() { pnpm test",
    "cat << EOF\npnpm test\n",
    "cat <<-EOF\n\tpnpm test\n\tEOF\n",
    "cat <<\"\"",
    "echo $'pnpm test'",
    "echo $\"pnpm test\"",
    "echo \"unterminated pnpm test"
  ])("does not credit data or uninvoked function bodies as a gate", (script) => {
    expect(Workflow.runsCommand(script, "pnpm test")).toBe(false)
  })
  it.each([
    "f() { echo 'data'; }; pnpm test",
    "f() { { echo x; }; }; pnpm test",
    "cat <<-EOF\n\tdata\n\tEOF\npnpm test",
    "echo \"escaped \\\" data\"; pnpm test"
  ])("finds a real command after a quoted or nested region", (script) => {
    expect(Workflow.runsCommand(script, "pnpm test")).toBe(true)
  })
  it("does not search for an empty command", () => {
    expect(Workflow.runsCommand("pnpm test", " \t")).toBe(false)
  })
  it.each(["[]", "42"])("rejects a non-mapping workflow document", (source) => {
    expect(() => Workflow.parseWorkflow(source)).toThrow(/mapping/)
  })
})

describe("Cargo metadata parsing", () => {
  it("parses quoted package names, decimal metadata and quoted keys while ignoring array tables", () => {
    expect(Cargo.manifestFacts(`[package]
name = 'widget'
[package.metadata.values]
ratio = 1.5
'name' = 'quoted'
[[package.metadata.ignored]]
arrayValue = true
[unfinished
`)).toEqual({ name: "widget", metadata: { values: { ratio: 1.5, name: "quoted" } } })
  })
  it.each([null, [], 0, "value"])("does not match scalar or array metadata as an object", (metadata) => {
    expect(Cargo.metadataMatches(metadata, { enabled: true })).toBe(false)
  })
  it("rejects non-object selectors and unknown cargo rules", () => {
    expect(() => Cargo.Fetch(null as never)).toThrow(/object/)
    expect(() => Cargo.Build(null as never)).toThrow(/object/)
    expect(() => Cargo.packageArgs("unknown", {}, { _tag: "Workspace" })).toThrow()
  })
})

describe("generator plans", () => {
  it("plans a script check with explicit environment and secret defaults", () => {
    const calls = plannedCalls(
      Compose.Generate({ script: Input.file("scripts/generate.mjs"), changes: ["value"], mode: "check" })
    )
    expect(calls[0]?.action).toBe("smithers-build/generate-check")
    expect(calls[0]?.payload).toMatchObject({ changes: ["value"], run: { cwd: ".", env: {}, secrets: [] } })
  })
  it("refuses stdout forms on a flow host instead of silently losing their output", () => {
    for (const mode of ["check", "write"] as const) {
      const calls = plannedCalls(Compose.Generate({ command: "echo value", stdout: "value", mode }))
      expect(calls[0]?.action).toBe("smithers-build/not-implemented")
      expect(String(calls[0]?.payload.target)).toMatch(/Generate/)
    }
  })
  it("validates the generator attrs before planning", () => {
    expect(() => Compose.Generate(null as never)).toThrow(/object/)
  })
  it("reports malformed output cwd and null-byte paths at declaration time", () => {
    expect(Target.declaredOutputsFailure({ cwd: "/outside", paths: ["value"] })).toContain("absolute")
    expect(Target.declaredOutputsFailure({ cwd: ".", paths: ["bad\0path"] })).toContain("null byte")
    expect(Target.declaredOutputFailure("..", "value")).toMatch(/cwd/)
  })
})

it("checks generated files under lint even when the build declaration writes them", () => {
  const target = Compose.Generate({ command: "echo value > value", changes: ["value"], mode: "write" })
  expect(Target.metadata(target).forKind("lint").attrs).toMatchObject({ mode: "check" })
  expect(Target.metadata(target).forKind("build").attrs).toMatchObject({ mode: "write" })
})
