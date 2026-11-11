// The error codes log lines carry (worker/ErrorCode.ts): a code, never a message.
import { Cause, Data } from "effect"
import { SqlError } from "effect/sql"
import { describe, expect, test } from "vitest"
import { codeOf } from "./ErrorCode.vibe"

class Tagged extends Data.TaggedError("SomethingFailed")<{ readonly message: string }> {}

describe("codeOf", () => {
  test("names a SQL failure by its reason", () => {
    const error = new SqlError.SqlError({ reason: new SqlError.ConnectionError({ cause: new Error("secret text") }) })
    expect(codeOf(error)).toBe("sql:ConnectionError")
  })

  test("names a tagged failure by its tag, never its message", () => {
    expect(codeOf(new Tagged({ message: "what someone wrote" }))).toBe("SomethingFailed")
  })

  test("names a scoped failure by its tag, and a platform failure by its own", () => {
    class Scoped extends Data.TaggedError("@smthrs/mvp/auth/SessionsUnavailable")<{}> {}
    expect(codeOf(new Scoped())).toBe("@smthrs/mvp/auth/SessionsUnavailable")
    expect(codeOf(new Cause.TimeoutError())).toBe("TimeoutError")
    // The other shapes the repository's failure classes use.
    class Chain extends Data.TaggedError("/chain/AuthorError")<{}> {}
    class Flow extends Data.TaggedError("flows/mcp/McpError")<{}> {}
    expect(codeOf(new Chain())).toBe("/chain/AuthorError")
    expect(codeOf(new Flow())).toBe("flows/mcp/McpError")
  })

  test.each([
    ["a tag on a plain value", { _tag: "PRIVATE_CANARY" }],
    ["a well-shaped tag on a plain value", { _tag: "PrivateCanary" }],
    ["a tag holding a value on an error", Object.assign(new Error("x"), { _tag: "person@example.com" })],
    ["a token in a tag", Object.assign(new Error("x"), { _tag: "sk-live-abc123" })],
    ["a tag that isn't text", Object.assign(new Error("x"), { _tag: 42 })],
  ])("names %s unknown, copying nothing", (_name, value) => {
    expect(codeOf(value)).toBe("unknown")
  })

  test("never throws on a failure whose tag or reason throws", () => {
    const hostile = (key: string) => Object.defineProperty(new Error("x"), key, { get: () => { throw new Error("boom") } })
    expect(codeOf(hostile("_tag"))).toBe("unknown")
    expect(codeOf(new Proxy({}, { has: () => { throw new Error("boom") }, get: () => { throw new Error("boom") } }))).toBe("unknown")
  })

  test.each([new Error("what someone wrote"), "a string", null])("names anything else unknown: %s", (value) => {
    expect(codeOf(value)).toBe("unknown")
  })
})
