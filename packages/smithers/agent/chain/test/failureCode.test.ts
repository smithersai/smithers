import { describe, expect, it } from "vitest"
import { failureCode } from "../src/internal/failureCode.ts"

// The two seams that read a code off an unknown failure disagree on what
// counts as one, and the disagreement is deliberate: the memory door quotes
// only a shipped `code`, while the author seat accepts a tagged failure's
// `_tag` because that is the only stable thing an Effect error carries. The
// reader takes the accepted fields from its caller so one shared helper
// cannot silently widen either contract.
describe("failureCode", () => {
  it("reads the first named field that carries a string", () => {
    expect(failureCode({ code: "store" }, ["code"])).toBe("store")
    expect(failureCode({ _tag: "RateLimit", code: "rate_limited" }, ["code", "_tag"])).toBe("rate_limited")
  })

  it("falls back to a tag only for callers that name it", () => {
    expect(failureCode({ _tag: "RateLimit" }, ["code"])).toBe("unknown")
    expect(failureCode({ _tag: "RateLimit" }, ["code", "_tag"])).toBe("RateLimit")
  })

  it("answers unknown for anything that carries no string code", () => {
    expect(failureCode({ code: 42 }, ["code"])).toBe("unknown")
    expect(failureCode({ code: 42 }, ["code", "_tag"])).toBe("unknown")
    expect(failureCode("snap", ["code"])).toBe("unknown")
    expect(failureCode(null, ["code"])).toBe("unknown")
    expect(failureCode(undefined, ["code", "_tag"])).toBe("unknown")
    expect(failureCode({}, ["code"])).toBe("unknown")
  })
})
