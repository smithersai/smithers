import { describe, expect, test } from "bun:test"
import { canonicalEventValue, canonicalStoredJsonValue, decodeEventValue, encodeEventValue } from "./EventValue"

describe("event value contract", () => {
  test("field clears survive a real wire round trip, including arrays and literal null", () => {
    const patch = { payload: { pending: undefined, answer: null, entries: [undefined, null, { error: undefined }] } }
    const decoded = decodeEventValue(JSON.parse(JSON.stringify(encodeEventValue(patch)))) as typeof patch
    expect(decoded).toEqual(patch)
    expect(Object.hasOwn(decoded.payload, "pending")).toBe(true)
    expect(Object.hasOwn(decoded.payload, "absent")).toBe(false)
    const prior = { pending: true, answer: "old" }
    expect({ ...prior, ...decoded.payload }.pending).toBeUndefined()
    expect({ ...prior, ...decoded.payload }.answer).toBeNull()
  })

  test("canonical bytes ignore object insertion order and distinguish absence from clear", () => {
    expect(canonicalEventValue({ b: undefined, a: { z: 2, a: 1 } }))
      .toBe(canonicalEventValue({ a: { a: 1, z: 2 }, b: undefined }))
    expect(canonicalEventValue({})).not.toBe(canonicalEventValue({ field: undefined }))
    expect(canonicalEventValue([1, 2])).not.toBe(canonicalEventValue([2, 1]))
  })

  test("encoding and decoding do not retain mutable input references", () => {
    const input = { nested: { name: "before" } }
    const encoded = encodeEventValue(input)
    input.nested.name = "after"
    const decoded = decodeEventValue(encoded) as typeof input
    decoded.nested.name = "changed again"
    expect(decodeEventValue(encoded)).toEqual({ nested: { name: "before" } })
  })

  test("reserved object keys are data and cannot change prototypes", () => {
    const input = Object.fromEntries([["__proto__", undefined], ["constructor", { value: 3 }]])
    const result = decodeEventValue(encodeEventValue(input)) as Record<string, unknown>
    expect(Object.hasOwn(result, "__proto__")).toBe(true)
    expect(result.__proto__).toBeUndefined()
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(result["constructor"] as unknown).toEqual({ value: 3 })
  })

  test("rejects values JSON would silently change and never invokes getters", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    const sparse = new Array(2); sparse[1] = "one"
    const extra = [1]; Object.assign(extra, { extra: true })
    const hidden = Object.defineProperty({}, "secret", { value: "private", enumerable: false })
    const symbol = { [Symbol("field")]: true }
    let getterCalls = 0
    const accessor = { get value() { getterCalls += 1; return "private" } }
    for (const value of [NaN, Infinity, -Infinity, -0, 1n, () => {}, Symbol("x"), new Date(), new Map(), cycle, sparse, extra, hidden, symbol, accessor]) {
      expect(() => encodeEventValue(value)).toThrow("unsupported value")
    }
    expect(getterCalls).toBe(0)
  })

  test("rejects corrupt clear paths instead of adding or erasing unrelated values", () => {
    for (const undefinedPaths of [
      [["missing"]], [["toString"]], [["a"], ["a"]], [["a", "x"]],
      [["b"]], [["items", "0"]], [["items", -1]], [["items", 2]], [[]],
      [["a"], ["a", "x"]]
    ]) {
      expect(() => decodeEventValue({ value: { a: null, b: 1, items: [null] }, undefinedPaths })).toThrow("field-clear path")
    }
    expect(decodeEventValue(encodeEventValue(undefined))).toBeUndefined()
  })

  test("stored-row canonical bytes match the original JSON materialization contract", () => {
    const reserved = Object.fromEntries([["__proto__", { value: undefined }], ["constructor", null]])
    const values = [null, true, 3.25, "quote\"\nline", [], {}, reserved,
      { "10": "ten", "2": "two", "00": "zeroes", "4294967295": "large", a: undefined, z: [undefined, null, { clear: undefined, keep: "yes" }] },
      Object.assign(Object.create(null), { absent: undefined, value: "present" })]
    for (const value of values) {
      const stored = JSON.parse(JSON.stringify(value))
      const original = JSON.stringify(encodeEventValue(stored).value)
      expect(canonicalStoredJsonValue(value)).toBe(original)
    }
  })

  test("stored-row serialization sees later mutations and never executes accessors", () => {
    const value = { nested: { text: "before" } }
    const before = canonicalStoredJsonValue(value)
    value.nested.text = "after"
    expect(canonicalStoredJsonValue(value)).not.toBe(before)
    let calls = 0
    Object.defineProperty(value.nested, "text", { enumerable: true, get: () => { calls++; return "after" } })
    expect(() => canonicalStoredJsonValue(value)).toThrow("unsupported value")
    expect(calls).toBe(0)
    for (const bad of [undefined, NaN, Infinity, -0, new Date(), [1, , 3], { value: () => {} }]) {
      expect(() => canonicalStoredJsonValue(bad)).toThrow("unsupported value")
    }
  })
})
