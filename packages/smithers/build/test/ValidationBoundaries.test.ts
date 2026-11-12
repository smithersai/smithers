import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Diagnostic, diagnostic } from "../src/internal/diagnostic.ts"
import { normalizePlatform } from "../src/internal/platform.ts"
import * as Validate from "../src/internal/validate.ts"

describe("diagnostic boundaries", () => {
  it("reads data from a null prototype and retains a nested-only message", () => {
    const failure = Object.assign(Object.create(null), {
      _tag: "Failure",
      cause: { message: "nested", code: "EIO" }
    })
    expect(diagnostic(failure)).toEqual({ name: "Failure", message: "nested", code: "EIO" })
    expect(diagnostic({ message: "", cause: { message: "" } })).toEqual({
      name: "Error",
      message: "unknown failure"
    })
    expect(diagnostic({ message: "outer", cause: 0 })).toEqual({ name: "Error", message: "outer" })
  })

  it("bounds labels and prefers the outer code over the nested one", () => {
    const result = diagnostic({ name: "n".repeat(129), code: "c".repeat(129), cause: { code: "EIO" } })
    expect(result).toEqual({ name: "n".repeat(128), code: "c".repeat(128), message: "unknown failure" })
    expect(Schema.decodeUnknownSync(Diagnostic)(result)).toEqual(result)
    expect(diagnostic(function failure() {})).toEqual({ name: "failure", message: "unknown failure" })
  })
})

describe("construction inspection", () => {
  it("refuses unknown symbol keys without rendering their value", () => {
    expect(() => Validate.exactKeys({ [Symbol("secret")]: "secret" }, new Set(), "options"))
      .toThrow("options contains unknown property symbol")
    expect(() => Validate.exactKeys({ typo: true }, new Set(), "options"))
      .toThrow("options contains unknown property \"typo\"")
  })

  it("converts reflective traps into a bounded option refusal", () => {
    for (
      const traps of [
        {
          getPrototypeOf: () => {
            throw new Error("private")
          }
        },
        {
          ownKeys: () => {
            throw new Error("private")
          }
        },
        {
          getOwnPropertyDescriptor: () => {
            throw new Error("private")
          }
        }
      ]
    ) {
      const value = new Proxy({ os: "linux", arch: "x64", libc: null }, traps)
      expect(() => normalizePlatform(value, "platform")).toThrow("platform could not be inspected safely")
    }
  })

  it("refuses missing, hidden and accessor platform members", () => {
    expect(() => normalizePlatform({ arch: "x64", libc: null }, "platform")).toThrow(/os and arch/)
    expect(() => normalizePlatform({ os: "linux", arch: "", libc: null }, "platform")).toThrow(/os and arch/)
    expect(() => normalizePlatform({ os: "linux", arch: "x64" }, "platform")).toThrow(/libc/)
    expect(() => Validate.ownData(Object.defineProperty({}, "value", { value: "hidden" }), "value", "options"))
      .toThrow("options.value must be an enumerable data property")
    expect(Validate.ownData({}, "value", "options")).toBeUndefined()
  })

  it("refuses vanished environment descriptors and throwing enumeration", () => {
    const vanished = new Proxy({}, { ownKeys: () => ["PATH"] })
    expect(() => Validate.normalizeEnvironment(vanished, false, "environment"))
      .toThrow("environment PATH must be an enumerable data property")
    const trapped = new Proxy({}, {
      ownKeys: () => {
        throw new Error("private")
      }
    })
    expect(() => Validate.normalizeEnvironment(trapped, false, "environment"))
      .toThrow("environment could not be inspected safely")
    expect(() => Validate.normalizeEnvironment({ "BAD=NAME": "x" }, true, "environment"))
      .toThrow(/name is not portable/)
  })

  it("detects every incomplete surrogate and preserves a complete pair", () => {
    for (const value of ["\ud800", "\ud800x", "\ud800\ue000", "\udc00"]) {
      expect(Validate.isWellFormedText(value)).toBe(false)
    }
    expect(Validate.isWellFormedText("\ud800\udc00")).toBe(true)
  })
})
