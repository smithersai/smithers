import { describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import * as Input from "../src/Input.ts"
import * as Reference from "../src/Reference.ts"
import { plannedCalls } from "./plan.ts"

describe("Generate process arguments", () => {
  it.each([{ args: [] }, { args: ["scripts/generate.mjs"] }])("refuses command args $args", ({ args }) => {
    expect(() => Compose.Generate({ command: "node", args, changes: ["generated/**"] }))
      .toThrow("Generate command cannot take args; put arguments in command or use bin")
  })

  it.each([{ args: [] }, { args: ["--write"] }])("refuses script args $args", ({ args }) => {
    expect(() => Compose.Generate({ script: Input.file("scripts/generate.mjs"), args, changes: ["generated/**"] }))
      .toThrow("Generate script cannot take args; use bin to pass arguments")
  })

  it("keeps every argument on the bin form", () => {
    const args = ["scripts/generate.mjs", "with spaces", "$(literal)", ""]
    const calls = plannedCalls(Compose.Generate({
      bin: Reference.runtimeBin,
      args,
      changes: ["generated/**"]
    }))
    expect(calls[0]?.payload["argv"]).toEqual([expect.any(String), ...args])
  })
})
