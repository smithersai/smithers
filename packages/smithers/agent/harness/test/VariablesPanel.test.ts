/**
 * The variables panel.
 *
 * The REPL mode's answer to the state manifest: what the realm holds, how fresh
 * each name is, and what the panel does when a run holds more names than one
 * frame block can print.
 */
import { describe, expect, it } from "vitest"
import * as CallLedger from "../src/CallLedger.ts"
import * as VariablesPanel from "../src/VariablesPanel.ts"

const binding = (name: string, type: string, size: string): VariablesPanel.Binding =>
  new VariablesPanel.Binding({ name, type, size })

const many = (count: number, frame: number): ReadonlyArray<VariablesPanel.Binding> =>
  Array.from({ length: count }, (_, index) => binding(`name${index}`, "number", String(index + frame)))

describe("VariablesPanel.stamp", () => {
  it("stamps a name the run has not held before with the frame that bound it", () => {
    const ledger = VariablesPanel.stamp([], [binding("kept", "string", "4 chars")], 3)
    expect(ledger).toEqual([
      new VariablesPanel.Stamp({ name: "kept", type: "string", size: "4 chars", frame: 3, since: 3 })
    ])
  })

  it("keeps both frames of a name whose cheap shape did not move", () => {
    const first = VariablesPanel.stamp([], [binding("kept", "string", "4 chars")], 1)
    const second = VariablesPanel.stamp(first, [binding("kept", "string", "4 chars")], 4)
    expect(second).toEqual(first)
  })

  it("moves the last-bound frame and keeps the first when a name changes shape", () => {
    const first = VariablesPanel.stamp([], [binding("moving", "number", "1")], 1)
    const second = VariablesPanel.stamp(first, [binding("moving", "array", "2 items")], 4)
    expect(second[0]).toEqual(
      new VariablesPanel.Stamp({ name: "moving", type: "array", size: "2 items", frame: 4, since: 1 })
    )
  })

  it("drops a name the realm no longer reports", () => {
    const first = VariablesPanel.stamp([], [binding("gone", "number", "1")], 1)
    expect(VariablesPanel.stamp(first, [], 2)).toEqual([])
  })
})

describe("VariablesPanel.render", () => {
  it("says plainly that a run holds nothing yet", () => {
    expect(VariablesPanel.render({ ledger: [], frame: 0 })).toContain("holds no names yet")
  })

  it("marks a name new, changed, or by the age of its binding", () => {
    const first = VariablesPanel.stamp([], [binding("aged", "number", "1"), binding("moving", "number", "1")], 0)
    const second = VariablesPanel.stamp(first, [
      binding("aged", "number", "1"),
      binding("moving", "array", "2 items"),
      binding("fresh", "string", "3 chars")
    ], 2)
    const rendered = VariablesPanel.render({ ledger: second, frame: 2 })
    expect(rendered).toContain("- aged (number, 1) — bound at frame 0, 2 frames ago")
    expect(rendered).toContain("- moving (array, 2 items) — changed this frame")
    expect(rendered).toContain("- fresh (string, 3 chars) — new this frame")
  })

  it("says one frame ago in the singular", () => {
    const ledger = VariablesPanel.stamp([], [binding("aged", "number", "1")], 0)
    expect(VariablesPanel.render({ ledger, frame: 1 })).toContain("bound at frame 0, 1 frame ago")
  })

  it("omits an empty size rather than printing an empty pair of brackets", () => {
    const ledger = VariablesPanel.stamp([], [binding("unset", "unset", "")], 0)
    expect(VariablesPanel.render({ ledger, frame: 0 })).toContain("- unset (unset) — new this frame")
  })

  it("clips one line rather than letting a model-chosen name take the block over", () => {
    const ledger = VariablesPanel.stamp([], [binding("Z".repeat(500), "number", "1")], 0)
    const line = VariablesPanel.render({ ledger, frame: 0 }).split("\n")[1] ?? ""
    expect(line.length).toBeLessThan(CallLedger.width + 80)
    expect(line).toContain("the name is what recalls the value")
  })

  it("counts the names past the bound instead of dropping them silently", () => {
    const ledger = VariablesPanel.stamp([], many(VariablesPanel.bound + 2, 0), 0)
    const rendered = VariablesPanel.render({ ledger, frame: 0 })
    expect(rendered).toContain(`Names your realm holds (${VariablesPanel.bound + 2})`)
    expect(rendered).toContain("… and 2 older names not listed here")
  })

  it("counts one name past the bound in the singular", () => {
    const ledger = VariablesPanel.stamp([], many(VariablesPanel.bound + 1, 0), 0)
    expect(VariablesPanel.render({ ledger, frame: 0 })).toContain("… and 1 older name not listed here")
  })

  it("lists a ledger of exactly the bound with no count line under it", () => {
    // One name more prints the line, so a panel that printed it here would be
    // telling a run that holds everything it can see that something is hidden.
    const ledger = VariablesPanel.stamp([], many(VariablesPanel.bound, 0), 0)
    const rendered = VariablesPanel.render({ ledger, frame: 0 })

    expect(rendered).toContain(`Names your realm holds (${VariablesPanel.bound})`)
    expect(rendered).not.toContain("… and")
    expect(rendered).not.toContain("not listed here")
    expect(rendered.split("\n")).toHaveLength(VariablesPanel.bound + 1)
  })

  it("lists least recently bound first, so the newest names sit closest to the cell", () => {
    const first = VariablesPanel.stamp([], [binding("older", "number", "1")], 0)
    const second = VariablesPanel.stamp(first, [binding("older", "number", "1"), binding("newer", "number", "2")], 5)
    const lines = VariablesPanel.render({ ledger: second, frame: 5 }).split("\n")
    expect(lines[1]).toContain("older")
    expect(lines[2]).toContain("newer")
  })
})
