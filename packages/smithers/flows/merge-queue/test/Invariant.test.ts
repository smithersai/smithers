import { describe, expect, it } from "vitest"
import * as Kernel from "../src/Kernel.ts"
import { laws, same, steps, theorems } from "./support/Theorems.ts"

/**
 * The theorems of the Lean reference, checked on the states this package's
 * kernel produces over random traces. Each `it` names the theorems it mirrors.
 */

const all = steps(Kernel, 250, 150)

describe("the reference's theorems hold on the kernel", () => {
  it("covers landings, blames, fixes, verdicts and cancels", () => {
    const tags = new Set(all.filter((entry) => !same(entry.before, entry.after)).map((entry) => entry.event._tag))
    expect([...tags].sort()).toEqual(
      [
        "blame",
        "cancel",
        "enqueue",
        "fixed",
        "foreign",
        "gaveUp",
        "land",
        "probe",
        "push",
        "result",
        "start",
        "withdraw"
      ]
    )
    expect(all.length).toBeGreaterThan(20_000)
  })

  it.each(theorems)("$name: $statement", (theorem) => {
    const failing = all.find((entry) => !theorem.holds(Kernel, entry))
    expect(failing === undefined ? "holds" : `fails at seed ${failing.seed} on ${failing.event._tag}`).toBe("holds")
  })

  it.each(laws)("$name: $statement", (law) => {
    expect(law.holds(Kernel)).toBe(true)
  })
})
