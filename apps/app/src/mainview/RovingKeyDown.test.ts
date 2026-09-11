import { describe, expect, test } from "bun:test"
import { rovingKeyDown } from "./RovingKeyDown"

/*
 * The seven handlers this helper replaced disagreed in three ways only, so the
 * three ways are what is pinned here: the ends wrap or clamp, Home and End are
 * a tablist's and a table's but not a menu's, and Escape is a menu's alone.
 */

describe("rovingKeyDown walks a list", () => {
  test("ArrowDown and ArrowUp step by one", () => {
    expect(rovingKeyDown("ArrowDown", { count: 4, current: 1 })).toEqual({ kind: "move", index: 2 })
    expect(rovingKeyDown("ArrowUp", { count: 4, current: 1 })).toEqual({ kind: "move", index: 0 })
  })

  test("a looping list wraps at both ends", () => {
    expect(rovingKeyDown("ArrowDown", { count: 3, current: 2 })).toEqual({ kind: "move", index: 0 })
    expect(rovingKeyDown("ArrowUp", { count: 3, current: 0 })).toEqual({ kind: "move", index: 2 })
  })

  test("a clamping list stops at both ends", () => {
    expect(rovingKeyDown("ArrowDown", { count: 3, current: 2, loop: false })).toEqual({ kind: "move", index: 2 })
    expect(rovingKeyDown("ArrowUp", { count: 3, current: 0, loop: false })).toEqual({ kind: "move", index: 0 })
  })

  /*
   * The composer menus read `current` off document.activeElement, which answers
   * -1 while focus is still on the trigger. ArrowDown opening onto the first
   * entry is what those menus have always done, so it is pinned.
   */
  test("nothing focused yet, ArrowDown opens onto the first entry", () => {
    expect(rovingKeyDown("ArrowDown", { count: 3, current: -1 })).toEqual({ kind: "move", index: 0 })
    expect(rovingKeyDown("ArrowUp", { count: 3, current: -1 })).toEqual({ kind: "move", index: 1 })
  })

  test("an empty list ignores the arrows, so the caller leaves the browser default alone", () => {
    expect(rovingKeyDown("ArrowDown", { count: 0, current: -1 })).toEqual({ kind: "ignore" })
    expect(rovingKeyDown("Home", { count: 0, current: -1, ends: true })).toEqual({ kind: "ignore" })
  })

  test("a key the list does not own is ignored", () => {
    expect(rovingKeyDown("a", { count: 3, current: 0 })).toEqual({ kind: "ignore" })
    expect(rovingKeyDown("Enter", { count: 3, current: 0 })).toEqual({ kind: "ignore" })
    expect(rovingKeyDown("ArrowRight", { count: 3, current: 0, ends: true })).toEqual({ kind: "ignore" })
  })
})

describe("Home and End are opt-in", () => {
  test("a list that asked for them jumps to the ends", () => {
    expect(rovingKeyDown("Home", { count: 5, current: 3, ends: true })).toEqual({ kind: "move", index: 0 })
    expect(rovingKeyDown("End", { count: 5, current: 3, ends: true })).toEqual({ kind: "move", index: 4 })
  })

  test("a list that did not leaves them to the browser", () => {
    expect(rovingKeyDown("Home", { count: 5, current: 3 })).toEqual({ kind: "ignore" })
    expect(rovingKeyDown("End", { count: 5, current: 3 })).toEqual({ kind: "ignore" })
  })
})

describe("Escape is a menu's key", () => {
  test("a menu is told to close", () => {
    expect(rovingKeyDown("Escape", { count: 3, current: 1, escape: true })).toEqual({ kind: "escape" })
  })

  test("an empty menu still closes", () => {
    expect(rovingKeyDown("Escape", { count: 0, current: -1, escape: true })).toEqual({ kind: "escape" })
  })

  test("a tablist ignores it, so whatever owns Escape above the strip still sees it", () => {
    expect(rovingKeyDown("Escape", { count: 3, current: 1 })).toEqual({ kind: "ignore" })
  })
})

/*
 * A menu that skips disabled entries roves over the enabled indices it already
 * builds; the helper stays index math and never learns what an entry is.
 */
describe("a caller skips disabled entries by roving over the enabled indices", () => {
  test("the ring walks only the enabled entries and wraps across a disabled one", () => {
    const disabled = [false, true, false, false]
    const enabled = disabled.flatMap((isDisabled, index) => (isDisabled ? [] : [index]))
    const walked: Array<number> = []
    let current = 0
    for (let step = 0; step < 4; step += 1) {
      const move = rovingKeyDown("ArrowDown", { count: enabled.length, current })
      if (move.kind !== "move") throw new Error("expected a move")
      current = move.index
      walked.push(enabled[current] ?? -1)
    }
    expect(walked).toEqual([2, 3, 0, 2])
  })
})
