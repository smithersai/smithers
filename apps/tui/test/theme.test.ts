import { afterEach, describe, expect, it } from "bun:test"
import { activeTheme, color, isTheme, setTheme, themes } from "../src/theme.ts"
import * as View from "../src/view.tsx"

afterEach(() => setTheme("purple"))

describe("TUI themes", () => {
  it("offers purple, blue, green, and orange", () => {
    expect(Object.keys(themes)).toEqual(["purple", "blue", "green", "orange"])
    expect(isTheme("unknown")).toBe(false)
  })

  it("updates the accent and user bubble when selected", () => {
    const oldBubble = color.bubble
    setTheme("blue")
    expect(activeTheme()).toBe("blue")
    expect(color.brand).toBe(themes.blue)
    expect(color.bubble).not.toBe(oldBubble)
  })

  it("paints a writing cell in the accent chosen after load", () => {
    setTheme("green")
    expect(View.statusColor("writing")).toBe(themes.green)
  })
})
