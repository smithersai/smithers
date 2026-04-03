import { describe, expect, it } from "bun:test"

import {
  DesktopStartupBlockedError,
  readDesktopStartupBlockedError,
  readDesktopStartupBlockedErrorFromWindow,
} from "./desktop-startup-blocked-error"

describe("desktop startup blocked error", () => {
  it("reads a structured startup error payload", () => {
    const error = readDesktopStartupBlockedError({
      title: "Burns is already running",
      message: "Close the existing Burns instance and retry.",
      details: "http://localhost:7332",
    })

    expect(error).toBeInstanceOf(DesktopStartupBlockedError)
    expect(error?.title).toBe("Burns is already running")
    expect(error?.message).toBe("Close the existing Burns instance and retry.")
    expect(error?.details).toBe("http://localhost:7332")
  })

  it("reads a startup-blocked error from the window global", () => {
    const error = readDesktopStartupBlockedErrorFromWindow({
      __BURNS_STARTUP_ERROR__: {
        title: "Burns is already running",
        message: "Close the existing Burns instance and retry.",
        details: null,
      },
    } as Window)

    expect(error).toBeInstanceOf(DesktopStartupBlockedError)
    expect(error?.details).toBeNull()
  })

  it("ignores malformed startup errors", () => {
    expect(readDesktopStartupBlockedError("%7Bnope")).toBeNull()
    expect(
      readDesktopStartupBlockedErrorFromWindow({
        __BURNS_STARTUP_ERROR__: { title: "", message: "broken" },
      } as Window)
    ).toBeNull()
  })
})
