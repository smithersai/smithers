import { describe, expect, it } from "bun:test"

import { resolveBurnsDataRoot, resolveDefaultWorkspaceRoot } from "@/config/paths"

describe("daemon path defaults", () => {
  it("uses ~/.burns for direct daemon data by default", () => {
    expect(
      resolveBurnsDataRoot({
        env: {},
        homeDirectory: "/Users/tester",
      })
    ).toBe("/Users/tester/.burns")
  })

  it("uses ~/Documents/Burns for the default workspace root", () => {
    expect(
      resolveDefaultWorkspaceRoot({
        env: {},
        homeDirectory: "/Users/tester",
      })
    ).toBe("/Users/tester/Documents/Burns")
  })

  it("honors explicit environment overrides", () => {
    expect(
      resolveBurnsDataRoot({
        env: {
          BURNS_DATA_ROOT: "/tmp/burns-data",
        },
        homeDirectory: "/Users/tester",
      })
    ).toBe("/tmp/burns-data")

    expect(
      resolveDefaultWorkspaceRoot({
        env: {
          BURNS_WORKSPACES_ROOT: "/tmp/burns-workspaces",
        },
        homeDirectory: "/Users/tester",
      })
    ).toBe("/tmp/burns-workspaces")
  })
})
