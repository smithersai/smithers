import { describe, expect, it } from "bun:test"

import { resolveBunExecutable, runWebPrebuild } from "./prebuild-web"

describe("desktop web prebuild", () => {
  it("prefers an explicit Bun override from the environment", () => {
    expect(
      resolveBunExecutable("/tmp/electrobun/bun", {
        BURNS_DESKTOP_PREBUILD_BUN: "/opt/homebrew/bin/bun",
      })
    ).toBe("/opt/homebrew/bin/bun")
  })

  it("uses the current Bun executable when available", () => {
    expect(resolveBunExecutable("/tmp/electrobun/bun", {})).toBe("/tmp/electrobun/bun")
  })

  it("falls back to bun when the current executable path is blank", () => {
    expect(resolveBunExecutable("   ", {})).toBe("bun")
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

  it("skips the web build when the skip flag is enabled", () => {
    const commands: string[][] = []
    const logMessages: string[] = []

    runWebPrebuild({
      bunExecutable: "/tmp/electrobun/bun",
      cwd: "/tmp/web",
      spawnSync: (command, _options) => {
        commands.push(command)
        return { exitCode: 0 }
      },
      log: (message) => {
        logMessages.push(message)
      },
      env: {
        BURNS_DESKTOP_SKIP_WEB_PREBUILD: "1",
      },
    })

    expect(commands).toEqual([])
    expect(logMessages).toContain("[desktop][preBuild] Skipping web build because BURNS_DESKTOP_SKIP_WEB_PREBUILD=1")
  })
})
