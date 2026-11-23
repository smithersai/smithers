import { describe, expect, it } from "vitest"
import * as Zon from "../../../src/closure/zig/Zon.ts"

const value = (text: string): Zon.Zon => {
  const parsed = Zon.parse(text)
  if (!parsed.ok) throw new Error(`${parsed.message} at ${parsed.offset}`)
  return parsed.value
}

const refusal = (text: string): string => {
  const parsed = Zon.parse(text)
  return parsed.ok ? "parsed" : `${parsed.message} at ${parsed.offset}`
}

describe("Zon.parse", () => {
  it("reads structs, tuples and every scalar the serializer writes", () => {
    expect(value(`.{
      .name = "run test", // a comment
      .deps = .{ 20, 21 },
      .flags = .{ .tag = .run, .on = true, .off = false },
      .cwd = null,
      .@"quoted name" = -3,
      .size = 0x1F,
      .ratio = 1_000.5e1,
      .empty = .{},
    }`)).toEqual({
      name: "run test",
      deps: [20, 21],
      flags: { tag: "run", on: true, off: false },
      cwd: null,
      "quoted name": -3,
      size: 31,
      ratio: 10005,
      empty: []
    })
  })

  it("tells a tuple of names from a struct by the equals sign", () => {
    expect(value(".{ .a, .b }")).toEqual(["a", "b"])
    expect(value(".{ .@\"test\" }")).toEqual(["test"])
    expect(value(".{ .{ 1 }, .{ .x = 2 } }")).toEqual([[1], { x: 2 }])
    expect(value(".{ .a = .b }")).toEqual({ a: "b" })
    expect(value(".name")).toBe("name")
  })

  it("decodes string escapes", () => {
    expect(value("\"a\\n\\r\\t\\\\\\\"\\'\\x41\\u{1F600}\"")).toBe("a\n\r\t\\\"'A\u{1F600}")
  })

  it("reads UTF-8 byte escapes and signed hexadecimal numbers strictly", () => {
    expect(value(String.raw`"\xc3\xa9"`)).toBe("é")
    expect(value("-0x10")).toBe(-16)
    for (const escape of ["x4g", "u{41x}", "u{d800}"]) expect(refusal("\"\\" + escape + "\"")).toContain("bad escape")
  })

  it("keeps a field named like a prototype member as a field", () => {
    const parsed = value(".{ .__proto__ = 1, .constructor = 2 }")
    expect(Zon.field(parsed, "__proto__")).toBe(1)
    expect(Zon.field(parsed, "constructor")).toBe(2)
    expect(Zon.field(value(".{ .a = 1 }"), "toString")).toBeUndefined()
  })

  it("says where the text stops being ZON", () => {
    expect(refusal("")).toBe("a value was expected at 0")
    expect(refusal("\"open")).toBe("an unfinished string at 5")
    expect(refusal("\"line\nbreak\"")).toBe("an unfinished string at 5")
    expect(refusal("\"\\q\"")).toBe("a bad escape at 3")
    expect(refusal("\"\\")).toBe("a bad escape at 3")
    expect(refusal("\"\\xzz\"")).toBe("a bad escape at 3")
    expect(refusal("\"\\u{41\"")).toBe("a bad escape at 3")
    expect(refusal("\"\\u{110000}\"")).toBe("a bad escape at 3")
    expect(refusal("1 2")).toBe("text after the value at 2")
    expect(refusal(".{ 1 2 }")).toBe("a comma was expected at 5")
    expect(refusal(".{ .a = 1 .b = 2 }")).toBe("a field was expected at 10")
    expect(refusal(".{ .a = 1, 2 }")).toBe("a field was expected at 11")
    expect(refusal(".{ .a = 1, .b }")).toBe("= was expected at 14")
    expect(refusal(".{ .1 = 2 }")).toBe("a name was expected at 4")
    expect(refusal(".5")).toBe("a name was expected at 1")
    expect(refusal(".{ 1")).toBe("a comma was expected at 4")
  })

  it("refuses nesting deeper than the runtime can follow", () => {
    expect(refusal(".{".repeat(200_000))).toBe("nested too deeply at 0")
  })
})

describe("Zon accessors", () => {
  it("read a field only from a struct and items only from a tuple", () => {
    expect(Zon.field({ a: 1 }, "a")).toBe(1)
    expect(Zon.field([1], "0")).toBeUndefined()
    expect(Zon.field(null, "a")).toBeUndefined()
    expect(Zon.field("text", "length")).toBeUndefined()
    expect(Zon.field(undefined, "a")).toBeUndefined()
    expect(Zon.list([1, 2])).toEqual([1, 2])
    expect(Zon.list({ a: 1 })).toEqual([])
    expect(Zon.list(undefined)).toEqual([])
  })
})
