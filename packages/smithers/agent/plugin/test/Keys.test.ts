import { Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Keys from "../src/Keys.vibe"

const parse = (text: string) => Result.getOrThrow(Keys.parse(text))
const press = (key: string, flags: Partial<Omit<Keys.Pressed, "key">> = {}): Keys.Pressed => ({
  key,
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  ...flags
})

describe("Keys.parse", () => {
  it("parses one or two strokes with modifiers", () => {
    expect(parse("g q").strokes.map((stroke) => stroke.key)).toEqual(["g", "q"])
    expect(parse("mod+shift+enter").strokes).toEqual([
      { key: "enter", mod: true, ctrl: false, alt: false, shift: true }
    ])
    for (
      const key of [
        "digit",
        "escape",
        "tab",
        "space",
        "arrowup",
        "arrowdown",
        "arrowleft",
        "arrowright",
        "/",
        "?",
        "[",
        "]",
        "7"
      ]
    ) {
      expect(Result.isSuccess(Keys.parse(`ctrl+alt+${key}`)), key).toBe(true)
    }
  })

  it("refuses anything outside the grammar", () => {
    for (const text of ["", "g  q", "a b c", "A", "f1", "hyper+a", "ctrl+ctrl+a", "a+", "+"]) {
      expect(Result.isFailure(Keys.parse(text)), text).toBe(true)
    }
    expect(Keys.parse("a b c")).toEqual(Result.fail("a binding is at most two strokes"))
    expect(Keys.parse("g Q")).toEqual(Result.fail("stroke 2 is outside the key grammar"))
  })
})

describe("Keys.match", () => {
  const mac = { mac: true }
  const pc = { mac: false }

  it("matches a sequence, and reports a proper prefix as partial", () => {
    const keys = parse("g q")
    expect(Keys.match(keys, [press("g")], pc)).toEqual({ matched: false, partial: true })
    expect(Keys.match(keys, [press("g"), press("Q")], pc)).toEqual({ matched: true, partial: false })
    expect(Keys.match(keys, [press("g"), press("x")], pc)).toEqual({ matched: false, partial: false })
    expect(Keys.match(keys, [], pc)).toEqual({ matched: false, partial: false })
    expect(Keys.match(keys, [press("g"), press("q"), press("q")], pc)).toEqual({ matched: false, partial: false })
  })

  it("maps mod to Meta on a Mac and to Control elsewhere", () => {
    const keys = parse("mod+enter")
    expect(Keys.match(keys, [press("Enter", { meta: true })], mac).matched).toBe(true)
    expect(Keys.match(keys, [press("Enter", { ctrl: true })], mac).matched).toBe(false)
    expect(Keys.match(keys, [press("Enter", { ctrl: true })], pc).matched).toBe(true)
    expect(Keys.match(keys, [press("Enter", { meta: true })], pc).matched).toBe(false)
    expect(Keys.match(parse("ctrl+a"), [press("a", { ctrl: true })], mac).matched).toBe(true)
  })

  it("compares alt and shift exactly, except for ?", () => {
    expect(Keys.match(parse("a"), [press("A", { shift: true })], pc).matched).toBe(false)
    expect(Keys.match(parse("shift+a"), [press("A", { shift: true })], pc).matched).toBe(true)
    expect(Keys.match(parse("a"), [press("a", { alt: true })], pc).matched).toBe(false)
    expect(Keys.match(parse("?"), [press("?", { shift: true })], pc).matched).toBe(true)
    expect(Keys.match(parse("space"), [press(" ")], pc).matched).toBe(true)
  })

  it("reports a digit's index", () => {
    const keys = parse("digit")
    expect(Keys.match(keys, [press("1")], pc)).toEqual({ matched: true, partial: false, index: 0 })
    expect(Keys.match(keys, [press("9")], pc)).toEqual({ matched: true, partial: false, index: 8 })
    expect(Keys.match(keys, [press("0")], pc).matched).toBe(false)
    expect(Keys.match(parse("g digit"), [press("g"), press("3")], pc)).toEqual({
      matched: true,
      partial: false,
      index: 2
    })
    expect(Keys.match(parse("digit g"), [press("3")], pc)).toEqual({ matched: false, partial: true, index: 2 })
  })
})
