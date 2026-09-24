import { describe, expect, it } from "vitest"
import { BiomeCheck } from "../src/BiomeCheck.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import { plannedArgv, plannedCalls } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

describe("BiomeCheck paths", () => {
  it.each([
    { lint: true, format: false, commands: ["check"] },
    { lint: false, format: true, commands: ["format"] },
    { lint: true, format: true, commands: ["check", "format"] }
  ])("renders rooted configs and sources for $commands", ({ lint, format, commands }) => {
    const config = Input.file("//biome.json")
    const sources = [
      Input.glob("//packages/foo/src/**/*.ts"),
      Input.file("//packages/foo/index.ts"),
      Input.glob("test/**/*.ts"),
      Input.file("local.ts")
    ]
    const target = BiomeCheck({
      packageManager,
      sources,
      deps: [],
      config,
      lint,
      format,
      cwd: "packages/foo"
    })
    const calls = plannedCalls(target)
    expect(calls.map((call) => call.payload["argv"])).toEqual(commands.map((command) => [
      "pnpm",
      "exec",
      "biome",
      command,
      "--config-path=../../biome.json",
      "src",
      "index.ts",
      "test",
      "local.ts"
    ]))
    expect(calls.map((call) => call.payload["cwd"])).toEqual(commands.map(() => "packages/foo"))
    expect(Target.metadata(target).inputs).toEqual([...sources, config])
  })

  it.each([
    { cwd: "packages/foo", pattern: "//**/*.ts", expected: "../.." },
    { cwd: "packages/foo", pattern: "//{src,test}/**/*.ts", expected: "../.." },
    { cwd: ".", pattern: "//**/*.ts", expected: "." },
    { cwd: "packages/foo", pattern: "**/*.ts", expected: "." }
  ])("renders the static prefix of $pattern from $cwd", ({ cwd, pattern, expected }) => {
    const target = BiomeCheck({
      packageManager,
      sources: [Input.glob(pattern)],
      deps: [],
      config: Input.file("biome.json"),
      lint: true,
      format: false,
      cwd
    })
    expect(plannedArgv(target)).toEqual([
      "pnpm",
      "exec",
      "biome",
      "check",
      "--config-path=biome.json",
      expected
    ])
  })
})
