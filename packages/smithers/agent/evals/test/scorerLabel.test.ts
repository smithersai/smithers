import { describe, expect, it } from "vitest"
import { scorerLabel } from "../src/internal/scorerLabel.ts"

describe("scorerLabel", () => {
  it("prints the name beside the first eight key characters", () => {
    expect(scorerLabel({ scorer: "0123456789abcdef", scorerName: "exact" })).toBe("exact (01234567)")
  })

  // The rule the runner, the reporter and the gate now share: one scorer with
  // no name is labelled the same way in a diagnostic and in a report row.
  it("falls back to the whole key when the scorer has no name", () => {
    expect(scorerLabel({ scorer: "0123456789abcdef" })).toBe("0123456789abcdef")
    expect(scorerLabel({ scorer: "0123456789abcdef", scorerName: undefined })).toBe("0123456789abcdef")
  })

  // A flow declared as an anonymous function has an empty `name`. That is an
  // absent name, not a name, and it must not render as a blank before a digest.
  it("treats an empty name as absent", () => {
    expect(scorerLabel({ scorer: "0123456789abcdef", scorerName: "" })).toBe("0123456789abcdef")
  })

  it("leaves a key shorter than eight characters whole", () => {
    expect(scorerLabel({ scorer: "bare-key", scorerName: "exact" })).toBe("exact (bare-key)")
  })
})
