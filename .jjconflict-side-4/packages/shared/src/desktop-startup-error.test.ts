import { describe, expect, it } from "bun:test"

import {
  buildDesktopStartupErrorInitScript,
  DESKTOP_STARTUP_ERROR_EVENT,
  parseDesktopStartupError,
} from "./desktop-startup-error"

describe("desktop startup error payload helpers", () => {
  it("parses a valid startup error payload", () => {
    expect(
      parseDesktopStartupError({
        title: "Burns is already running",
        message: "Close the existing Burns instance and retry.",
        details: "http://localhost:7332",
      })
    ).toEqual({
      title: "Burns is already running",
      message: "Close the existing Burns instance and retry.",
      details: "http://localhost:7332",
    })
  })

  it("returns null for malformed payloads", () => {
    expect(parseDesktopStartupError("%7Bnot-json")).toBeNull()
    expect(parseDesktopStartupError({ title: "", message: "missing title" })).toBeNull()
  })

  it("builds an init script that sets the startup error and emits the event", () => {
    const script = buildDesktopStartupErrorInitScript({
      title: "Burns is already running",
      message: "Close the existing Burns instance and retry.",
      details: "http://localhost:7332",
    })

    const receivedEvents: string[] = []
    const windowLike: {
      __BURNS_STARTUP_ERROR__?: unknown
      dispatchEvent: (event: Event) => boolean
      CustomEvent: typeof CustomEvent
    } = {
      dispatchEvent(event: Event) {
        receivedEvents.push(event.type)
        return true
      },
      CustomEvent,
    }

    const run = new Function("window", script) as (window: typeof windowLike) => void
    run(windowLike)

    expect(parseDesktopStartupError(windowLike.__BURNS_STARTUP_ERROR__)).toEqual({
      title: "Burns is already running",
      message: "Close the existing Burns instance and retry.",
      details: "http://localhost:7332",
    })
    expect(receivedEvents).toEqual([DESKTOP_STARTUP_ERROR_EVENT])
  })
})
