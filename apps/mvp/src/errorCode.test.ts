import { Data } from "effect"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import { describe, expect, it } from "vitest"
import { codeOf } from "./errorCode"

class Refused extends Data.TaggedError("Refused")<{ readonly code?: string }> {}

describe("codeOf", () => {
  it("names a failure by its code, tag or error name, never its message", () => {
    expect(codeOf(new Refused({ code: "too_large" }))).toBe("too_large")
    expect(codeOf(new Refused({}))).toBe("Refused")
    expect(codeOf(new TypeError("someone's words"))).toBe("TypeError")
    expect(codeOf(new Error("someone's words"))).toBe("unknown")
    const reason = new ConnectionError({ cause: "gone", message: "someone's words", operation: "execute" })
    expect(codeOf(new SqlError({ reason }))).toBe("sql:ConnectionError")
    expect(codeOf({ _tag: "HttpClientError", reason: { _tag: "TransportError" } })).toBe("http:TransportError")
  })

  it("skips a value that isn't a short identifier, and reads anything else as unknown", () => {
    expect(codeOf({ code: "has spaces in it", _tag: "Tagged" })).toBe("Tagged")
    expect(codeOf({ _tag: "SqlError", reason: { _tag: "not an identifier" } })).toBe("SqlError")
    expect(codeOf({ name: "x".repeat(65) })).toBe("unknown")
    expect(codeOf("a string")).toBe("unknown")
    expect(codeOf(null)).toBe("unknown")
    expect(codeOf(undefined)).toBe("unknown")
  })
})
