/**
 * Colour detection follows the NO_COLOR and FORCE_COLOR conventions, and
 * the text helpers count visible cells rather than bytes.
 */
import { describe, expect, it } from "vitest"
import * as Ansi from "../src/Ansi.ts"

describe("Ansi.colorSupport", () => {
  it("refuses colour when NO_COLOR is set, even on a terminal", () => {
    expect(Ansi.colorSupport({ NO_COLOR: "1" }, true)).toBe(false)
    expect(Ansi.colorSupport({ NO_COLOR: "" }, true)).toBe(true)
  })

  it("forces colour under a pipe when FORCE_COLOR asks for it", () => {
    expect(Ansi.colorSupport({ FORCE_COLOR: "1" }, false)).toBe(true)
    expect(Ansi.colorSupport({ FORCE_COLOR: "" }, false)).toBe(true)
    expect(Ansi.colorSupport({ FORCE_COLOR: "0" }, true)).toBe(false)
    expect(Ansi.colorSupport({ FORCE_COLOR: "false" }, true)).toBe(false)
  })

  it("lets NO_COLOR win over FORCE_COLOR", () => {
    expect(Ansi.colorSupport({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false)
  })

  it("refuses a dumb terminal and a pipe, accepts a terminal", () => {
    expect(Ansi.colorSupport({ TERM: "dumb" }, true)).toBe(false)
    expect(Ansi.colorSupport({}, false)).toBe(false)
    expect(Ansi.colorSupport({ TERM: "xterm-256color" }, true)).toBe(true)
  })

  it("hands out the matching palette", () => {
    expect(Ansi.palette({}, true)).toBe(Ansi.colors)
    expect(Ansi.palette({}, false)).toBe(Ansi.none)
  })
})

describe("Ansi text helpers", () => {
  it("wraps and strips SGR sequences", () => {
    const red = Ansi.colors.red("ab")
    expect(red).toBe("\u001b[31mab\u001b[39m")
    expect(Ansi.strip(red)).toBe("ab")
    expect(Ansi.visibleWidth(Ansi.colors.bold(Ansi.colors.dim("✓ ok")))).toBe(4)
    expect(Ansi.none.red("ab")).toBe("ab")
  })

  it("truncates on visible cells and closes any open style", () => {
    expect(Ansi.truncate("abcdef", 4)).toBe("abc…")
    expect(Ansi.truncate("abcd", 4)).toBe("abcd")
    const styled = Ansi.truncate(Ansi.colors.red("abcdef"), 4)
    expect(Ansi.strip(styled)).toBe("abc…")
    expect(styled.endsWith("\u001b[0m")).toBe(true)
    expect(styled.startsWith("\u001b[31m")).toBe(true)
  })

  it("emits the cursor motions", () => {
    expect(Ansi.cursorUp(0)).toBe("")
    expect(Ansi.cursorUp(3)).toBe("\u001b[3A")
    expect(Ansi.eraseDown).toBe("\u001b[0J")
  })
})

describe("Ansi.truncate with a broken escape", () => {
  const esc = String.fromCharCode(27)

  it("stops at an unterminated escape sequence", () => {
    expect(Ansi.truncate(`ab${esc}[`, 1)).toBe("…")
    expect(Ansi.truncate(`abc${esc}[9`, 2)).toBe("a…")
  })
})

it("ends truncation safely when an unfinished escape is reached before the visible limit", () => {
  expect(Ansi.truncate("a\u001b[123", 3)).toBe("a…")
  expect(Ansi.truncate("\u001b[123", 3)).toBe("…")
})
