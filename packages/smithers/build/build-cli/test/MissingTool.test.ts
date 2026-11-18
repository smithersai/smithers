import { describe, expect, it } from "vitest"
import * as MissingTool from "../src/internal/MissingTool.ts"

describe("the tool a failed command could not find", () => {
  it.each([
    ["bash: line 1: npm: command not found", "npm"],
    ["bash: npm: command not found\n", "npm"],
    ["/bin/sh: 1: pnpm: not found", "pnpm"],
    ["sh: 1: tsc: not found\nnpm error code 127", "tsc"],
    ["> test\n> zig build\n\nsh: 1: zig: not found\r\n", "zig"],
    ["/bin/sh: npm: command not found", "npm"],
    ["zsh:1: command not found: bun", "bun"],
    ["env: ‘node’: No such file or directory", "node"],
    ["env: node: No such file or directory", "node"],
    ["bwrap: execvp pnpm: No such file or directory", "pnpm"]
  ])("reads %j", (output, tool) => {
    expect(MissingTool.named(127, output)).toBe(tool)
  })

  it("names nothing for another exit code or another failure", () => {
    expect(MissingTool.named(1, "bash: line 1: npm: command not found")).toBeUndefined()
    expect(MissingTool.named(127, "the page was not found on the server")).toBeUndefined()
    expect(MissingTool.named(127, "")).toBeUndefined()
  })

  it("leads with the tool's name in one line", () => {
    const headline = MissingTool.headline("npm")
    expect(headline).toBe(
      "npm: not found. No directory on PATH holds npm; install it or add its directory to PATH (exit 127)"
    )
    expect(headline).not.toContain("\n")
  })
})
