import { Data } from "effect"
import { describe, expect, test } from "vitest"
import { errorName } from "../src/internal/errorName.ts"

class Refused extends Data.TaggedError("Refused")<{}> {}
class Wrapper extends Data.TaggedError("Wrapper")<{ readonly cause: unknown }> {}

describe("errorName", () => {
  test("names a failure by its tag or its error's name, never its message", () => {
    expect(errorName(new Refused())).toBe("Refused")
    expect(errorName(new TypeError("someone's words"))).toBe("TypeError")
    expect(errorName("someone's words")).toBe("string")
    expect(errorName(undefined)).toBe("undefined")
  })

  test("names serialized errors only by a short identifier", () => {
    expect(errorName({ name: "@smthrs/platform-browser/PrepareFailed", message: "private text" })).toBe(
      "@smthrs/platform-browser/PrepareFailed"
    )
    for (const name of ["", "private text", 12, undefined]) expect(errorName({ name })).toBe("object")
    expect(errorName({})).toBe("object")
    expect(errorName(null)).toBe("object")
  })

  test("names a wrapper it is told to unwrap by what it wraps, however deep", () => {
    expect(errorName(new Wrapper({ cause: new Wrapper({ cause: new RangeError("x") }) }), ["Wrapper"])).toBe(
      "RangeError"
    )
    expect(errorName(new Wrapper({ cause: new RangeError("x") }))).toBe("Wrapper")
  })
})
