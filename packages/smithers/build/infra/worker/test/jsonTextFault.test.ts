import { describe, expect, it } from "vitest"
import { jsonTextFault } from "../jsonTextFault.ts"

describe("jsonTextFault", () => {
  it.each([
    ["sibling members", '{"a":1,"a":2}'],
    ["escaped members", String.raw`{"token":"raw","token":"other"}`],
    ["ancestor members", '{"props":{"env":{"a":1}},"props":{}}'],
    ["members in an array", '[{"extra":"raw","extra":null}]'],
    ["members after an escaped quote", String.raw`{"a":"x\"y","a":1}`]
  ])("finds duplicate %s", (_case, text) => {
    expect(jsonTextFault(text, { numbers: false })).toBe("duplicate-member")
    expect(jsonTextFault(text, { numbers: true })).toBe("duplicate-member")
  })

  it.each([
    ["equal names in separate objects", '{"a":{"a":1},"b":[{"a":1},{"a":2}]}'],
    ["a member name inside a string value", String.raw`{"a":"\"a\":1,\"a\"","b":1}`],
    ["strings in an array", '["a","a"]']
  ])("accepts %s", (_case, text) => {
    expect(jsonTextFault(text, { numbers: true })).toBeNull()
  })

  it.each([
    ["beyond double precision", "[12345678901234567890]"],
    ["negative zero", "[-0]"],
    ["a non-canonical exponent", "[1e2]"],
    ["an overflow", "[1e400]"]
  ])("finds a number %s only when numbers are checked", (_case, text) => {
    expect(jsonTextFault(text, { numbers: true })).toBe("lossy-number")
    expect(jsonTextFault(text, { numbers: false })).toBeNull()
  })

  it("accepts numbers that round-trip", () => {
    expect(jsonTextFault('{"a":-1.5,"b":[0,42]}', { numbers: true })).toBeNull()
  })
})
