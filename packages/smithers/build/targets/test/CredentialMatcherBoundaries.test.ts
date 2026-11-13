import { describe, expect, it } from "vitest"
import { redactCredentials } from "../src/LlmLint.ts"

describe("credential spelling boundaries", () => {
  it.each([
    "PASSWORD=\"abcdefgh\" TOKEN=\"abcdefghijkl\"",
    "PASSWORD=\"abcd\" TOKEN=\"zabcdx\"",
    "service-account-private-key=\"fixture-sensitive-value\""
  ])("masks prefix, suffix and overlapping name spellings: %s", (source) => {
    const masked = redactCredentials(source)
    expect(masked).toContain("<credential:")
    for (const value of ["abcdefgh", "abcdefghijkl", "zabcdx", "fixture-sensitive-value"]) {
      expect(masked).not.toContain(value)
    }
    expect(masked).toContain("=")
  })

  it("masks an out-of-range Unicode escape as literal source data", () => {
    const escaped = String.raw`prefix\u{110000}suffix`
    const masked = redactCredentials(`API_KEY="${escaped}"`)
    expect(masked).toContain("<credential:api-key:")
    expect(masked).not.toContain(escaped)
    expect(masked).not.toContain("110000")
  })
})
