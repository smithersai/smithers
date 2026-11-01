import { describe, expect, it } from "vitest"
import * as CallKey from "../src/CallKey.vibe"

describe("CallKey", () => {
  it("builds the identity of one settled call", () => {
    expect(CallKey.make(2, "sd", 5, "ed")).toEqual({
      entryDigest: "ed",
      link: 2,
      ordinal: 5,
      scriptDigest: "sd"
    })
  })

  it("keys harness-issued calls to the empty script digest", () => {
    expect(CallKey.harnessDigest).toBe("")
  })
})
