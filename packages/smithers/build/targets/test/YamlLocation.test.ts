import { describe, expect, it } from "vitest"
import * as Yaml from "yaml"
import * as Workflow from "../src/GithubWorkflow.ts"
import * as Location from "../src/internal/YamlLocation.ts"

describe("workflow YAML diagnostic locations", () => {
  const counter = () => {
    const value = new Yaml.LineCounter()
    value.addNewLine(0)
    value.addNewLine(3)
    return value
  }

  it("locates native YAML nodes before and after parser ranges are attached", () => {
    const lines = counter()
    const node = new Yaml.Scalar("value")
    expect(Location.nodeLine(lines, node)).toBe(1)
    expect(Location.nodeLine(lines, undefined)).toBe(1)
    node.range = [4, 5, 6]
    expect(Location.nodeLine(lines, node)).toBe(2)
  })

  it("locates unprepared parser errors and honors prepared locations", () => {
    const error = new Yaml.YAMLParseError([4, 5], "BAD_SCALAR_START", "fixture failure")
    const lines = counter()
    expect(Location.parseErrorLine(lines, error)).toBe(2)
    error.linePos = [{ line: 9, col: 1 }, { line: 9, col: 2 }]
    expect(Location.parseErrorLine(lines, error)).toBe(9)
  })

  it("does not vouch for a quoted initial command word", () => {
    const script = "'pnpm' run check"
    expect(Workflow.commandSpans(script)).toEqual([])
    expect(Workflow.runsCommand(script, "pnpm run check")).toBe(false)
  })
})
