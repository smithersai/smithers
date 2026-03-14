import { describe, expect, it } from "bun:test"

import { resolveDesktopDataRoot } from "./desktop-data-root"

describe("desktop data root resolution", () => {
  it("uses ~/.burns by default so desktop and CLI share state", () => {
    expect(
      resolveDesktopDataRoot({
        homeDirectory: "/Users/tester",
        platform: "darwin",
        env: {},
      })
    ).toBe("/Users/tester/.burns")
  })

  it("uses the shared BURNS_DATA_ROOT override when present", () => {
    expect(
      resolveDesktopDataRoot({
        homeDirectory: "C:\\Users\\tester",
        platform: "win32",
        env: {
          BURNS_DATA_ROOT: "/tmp/burns-data",
        },
      })
    ).toBe("/tmp/burns-data")
  })

  it("supports an explicit desktop data root override", () => {
    expect(
      resolveDesktopDataRoot({
        homeDirectory: "/Users/tester",
        platform: "darwin",
        env: {
          BURNS_DATA_ROOT: "/tmp/burns-data",
          BURNS_DESKTOP_DATA_ROOT: "/tmp/burns-desktop",
        },
      })
    ).toBe("/tmp/burns-desktop")
  })
})
