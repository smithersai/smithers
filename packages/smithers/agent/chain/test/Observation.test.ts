import { describe, expect, it } from "vitest"
import * as Observation from "../src/Observation.vibe"

describe("Observation", () => {
  it("builds a typed observation", () => {
    expect(Observation.make("catalog", `"x" is not a catalog entry`)).toEqual({
      kind: "catalog",
      message: `"x" is not a catalog entry`
    })
  })

  it("renders one context line", () => {
    expect(Observation.render(Observation.make("shape", "no block"))).toBe("[shape] no block")
  })
})
