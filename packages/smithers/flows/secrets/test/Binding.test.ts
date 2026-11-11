import { Effect, Exit, Redacted, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { Binding } from "../src/index.ts"

const decodes = (schema: Schema.Codec<any, any>, input: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema)(input))

describe("Binding", () => {
  test.each([
    ["API_KEY", true],
    ["_PRIVATE", true],
    ["A", true],
    [`A${"B".repeat(63)}`, true],
    [`A${"B".repeat(64)}`, false],
    ["api_key", false],
    ["1KEY", false],
    ["KEY-NAME", false],
    ["", false]
  ])("name %s is %s", (name, ok) => {
    expect(decodes(Binding.Name, name)).toBe(ok)
  })

  test.each([
    ["api.example.com", true],
    ["a.b", true],
    ["x-1.example.io", true],
    [`${"a".repeat(63)}.com`, true],
    [`${"a".repeat(64)}.com`, false],
    [`${"a.".repeat(126)}com`, false],
    ["localhost", false],
    ["127.0.0.1", false],
    ["[::1]", false],
    ["Api.Example.com", false],
    ["*.example.com", false],
    ["-api.example.com", false],
    ["api-.example.com", false],
    ["api.example.com:443", false],
    ["api..example.com", false],
    ["example.123", false]
  ])("host %s is %s", (host, ok) => {
    expect(Binding.isHost(host)).toBe(ok)
    expect(decodes(Binding.Host, host)).toBe(ok)
  })

  test("a binding names one to sixteen hosts and, when it names methods, at least one", () => {
    expect(decodes(Binding.Binding, { name: "K", hosts: ["a.com"] })).toBe(true)
    expect(decodes(Binding.Binding, { name: "K", hosts: ["a.com"], methods: ["GET", "POST"] })).toBe(true)
    expect(decodes(Binding.Binding, { name: "K", hosts: [] })).toBe(false)
    expect(decodes(Binding.Binding, { name: "K", hosts: Array.from({ length: 17 }, (_, i) => `h${i}.com`) })).toBe(
      false
    )
    expect(decodes(Binding.Binding, { name: "K", hosts: ["a.com"], methods: [] })).toBe(false)
    expect(decodes(Binding.Binding, { name: "K", hosts: ["a.com"], methods: ["TRACE"] })).toBe(false)
  })

  test.each([
    ["12345678", undefined],
    ["é".repeat(4), "non_ascii"],
    ["1234567", "too_short"],
    ["a".repeat(16 * 1024), undefined],
    ["a".repeat(16 * 1024 + 1), "too_long"],
    ["é".repeat(8 * 1024 + 1), "non_ascii"],
    ["token\r\nX-Injected: 1", "control_character"],
    ["token\u0000value", "control_character"],
    ["token\u007fvalue", "control_character"],
    ["token\tvalue", "control_character"],
    ["token\ud800value", "malformed_text"],
    ["token\udc00value", "malformed_text"],
    ["token😀value", "non_ascii"],
    ["token\u0080value", "non_ascii"],
    ["tokenÿvalue", "non_ascii"],
    ["token\u0100value", "non_ascii"],
    ["token\u2028value", "non_ascii"],
    ["token\ufffdvalue", "non_ascii"],
    ["token\u{10ffff}value", "non_ascii"],
    [" token-value", "surrounding_space"],
    ["token-value ", "surrounding_space"],
    [" token-value ", "surrounding_space"],
    [" ".repeat(8), "surrounding_space"],
    ["token value", undefined]
  ])("value %j has problem %s", (value, problem) => {
    expect(Binding.valueProblem(value)).toBe(problem)
  })

  test("every printable ASCII character survives a header unchanged inside a valid value", () => {
    for (let code = 0x20; code <= 0x7e; code++) {
      const value = `token${String.fromCharCode(code)}value`
      expect(Binding.valueProblem(value)).toBeUndefined()
      expect(new Headers({ "x-api-key": value }).get("x-api-key")).toBe(value)
    }
  })

  test("no non-ASCII code unit is accepted as a header credential", () => {
    for (let code = 0x80; code <= 0xffff; code++) {
      const value = `token${String.fromCharCode(code)}value`
      expect(Binding.valueProblem(value)).toBe(
        code >= 0xd800 && code <= 0xdfff ? "malformed_text" : "non_ascii"
      )
    }
  })

  test.each(
    [
      ["tokené-SENTINEL", "non_ascii"],
      ["token😀-SENTINEL", "non_ascii"],
      [" SENTINEL-value", "surrounding_space"],
      ["SENTINEL-value ", "surrounding_space"]
    ] as const
  )("checkValue refuses an unsendable value with %s", async (value, reason) => {
    const exit = await Effect.runPromiseExit(Binding.checkValue(Redacted.make(value)))
    expect(exit).toEqual(Exit.fail(new Binding.ValueInvalid({ reason })))
    expect(JSON.stringify(exit)).not.toContain("SENTINEL")
    expect(decodes(Binding.ValueInvalid, { _tag: "@smthrs/secrets/Binding/ValueInvalid", reason })).toBe(true)
  })

  test("checkValue fails with the reason and never the value", async () => {
    expect(await Effect.runPromise(Binding.checkValue(Redacted.make("long enough value")))).toBeUndefined()
    const exit = await Effect.runPromiseExit(Binding.checkValue(Redacted.make("bad\nvalue-SENTINEL")))
    const text = JSON.stringify(exit)
    expect(text).toContain("control_character")
    expect(text).not.toContain("SENTINEL")
  })
})
