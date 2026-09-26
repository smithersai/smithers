/**
 * The exact runtime boundary for custom package-manifest JSON values.
 *
 * JavaScript values that JSON.stringify would omit, coerce, or execute are
 * refused, while accepted objects are copied onto null prototypes and frozen
 * deeply so later caller mutation cannot alter a target's key material.
 */
import { describe, expect, it } from "vitest"
import * as ManifestJson from "../src/ManifestJson.ts"

describe("ManifestJson primitive refusals", () => {
  it.each([
    [Symbol("field"), "manifest value is a symbol"],
    [() => "value", "manifest value is a function"],
    ["bad\ud800text", "manifest value contains an unpaired UTF-16 surrogate"]
  ])("rejects a value JSON cannot preserve", (value, message) => {
    expect(() => ManifestJson.cloneValue(value)).toThrow(TypeError)
    expect(() => ManifestJson.cloneValue(value)).toThrow(message)
  })
})

describe("ManifestJson collection refusals", () => {
  it("copies null, both booleans and a multi-element array unchanged", () => {
    const value = [null, true, false, ["a", 1]]
    const copied = ManifestJson.cloneValue(value)
    expect(copied).toEqual(value)
    expect(copied).not.toBe(value)
    expect(Object.isFrozen(copied)).toBe(true)
  })

  it("rejects array subclasses even when their elements are ordinary JSON", () => {
    class Values extends Array<string> {}

    expect(() => ManifestJson.cloneValue(new Values("a", "b"))).toThrow(TypeError)
    expect(() => ManifestJson.cloneValue(new Values("a", "b"))).toThrow("manifest value is an array subclass instance")
  })

  it("rejects sparse and decorated arrays rather than changing their shape", () => {
    const sparse = ["a", "b"]
    delete sparse[0]
    const decorated = ["a"] as Array<string> & { extra?: string }
    decorated.extra = "b"

    for (const value of [sparse, decorated]) {
      expect(() => ManifestJson.cloneValue(value)).toThrow(TypeError)
      expect(() => ManifestJson.cloneValue(value)).toThrow(/sparse array or carries extra own properties/)
    }
  })

  it("rejects symbol-keyed fields and accessor fields without invoking them", () => {
    let reads = 0
    const symbolic = { okay: true, [Symbol("hidden")]: true }
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        reads += 1
        return "value"
      }
    })
    const arrayAccessor = Object.defineProperty(["value"], "0", {
      enumerable: true,
      get: () => {
        reads += 1
        return "value"
      }
    })

    expect(() => ManifestJson.cloneValue(symbolic)).toThrow(/symbol-keyed own properties/)
    expect(() => ManifestJson.cloneValue(accessor)).toThrow(/accessor or non-enumerable property/)
    expect(() => ManifestJson.cloneValue(arrayAccessor)).toThrow(/accessor or non-enumerable property/)
    expect(reads).toBe(0)
  })

  it("returns a detached, deeply frozen null-prototype copy", () => {
    const nested = { values: [{ enabled: true }] }
    const copy = ManifestJson.cloneObject(nested)

    expect(copy).toEqual(nested)
    expect(copy).not.toBe(nested)
    expect(Object.getPrototypeOf(copy)).toBeNull()
    expect(Object.isFrozen(copy)).toBe(true)
    expect(Object.isFrozen(copy["values"])).toBe(true)
    expect(Object.isFrozen((copy["values"] as ReadonlyArray<object>)[0])).toBe(true)
  })

  it("bounds aggregate bytes, members, and nesting depth", () => {
    expect(() => ManifestJson.cloneValue("x".repeat(ManifestJson.maximumBytes + 1))).toThrow(/byte manifest JSON limit/)
    expect(() =>
      ManifestJson.cloneValue(
        Array.from({ length: ManifestJson.maximumMembers + 1 }, () => null)
      )
    ).toThrow(/member manifest JSON limit/)
    let nested: unknown = null
    for (let depth = 0; depth <= ManifestJson.maximumDepth; depth += 1) nested = [nested]
    expect(() => ManifestJson.cloneValue(nested)).toThrow(/maximum manifest JSON depth/)
  })
})

describe("ManifestJson array shape", () => {
  it("refuses a sparse array, which JSON would fill with nulls", () => {
    const sparse = ["first", "second"]
    delete sparse[0]

    expect(() => ManifestJson.cloneValue(sparse)).toThrow(TypeError)
    expect(() => ManifestJson.cloneValue(sparse)).toThrow(/sparse array or carries extra own properties/)
  })

  it("refuses an array carrying an own property beside its members", () => {
    const decorated: Array<string> = ["first"]
    Object.defineProperty(decorated, "extra", { value: "kept", enumerable: true, configurable: true })

    expect(() => ManifestJson.cloneValue(decorated)).toThrow(/sparse array or carries extra own properties/)
  })
})
