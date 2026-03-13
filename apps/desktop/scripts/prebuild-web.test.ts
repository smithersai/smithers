import { describe, expect, it } from "bun:test"

import { resolveBunExecutable, runWebPrebuild } from "./prebuild-web"

describe("desktop web prebuild", () => {
  it("uses the current Bun executable when available", () => {
    expect(resolveBunExecutable("/tmp/electrobun/bun")).toBe("/tmp/electrobun/bun")
  })

  it("falls back to bun when the current executable path is blank", () => {
    expect(resolveBunExecutable("   ")).toBe("bun")
  })

  it("spawns the web build with the resolved Bun executable", () => {
    const commands: string[][] = []

    runWebPrebuild({
      bunExecutable: "/tmp/electrobun/bun",
      cwd: "/tmp/web",
      spawnSync: (command, _options) => {
        commands.push(command)
        return { exitCode: 0 }
      },
      log: () => {},
    })

    expect(commands).toEqual([["/tmp/electrobun/bun", "run", "build"]])
  })
})
