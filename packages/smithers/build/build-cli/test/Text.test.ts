import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import { byCodeUnit, posix, sha256Hex } from "../src/internal/Text.ts"

describe("cache-key text primitives", () => {
  it("orders by code units, including ties and non-ASCII text", () => {
    expect(byCodeUnit("a", "b")).toBe(-1)
    expect(byCodeUnit("b", "a")).toBe(1)
    expect(byCodeUnit("same", "same")).toBe(0)
    expect(["ä", "z", "A"].sort(byCodeUnit)).toEqual(["A", "z", "ä"])
  })

  it("uses the same SHA-256 identity for UTF-8 text and its bytes", () => {
    const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    expect(sha256Hex("abc")).toBe(expected)
    expect(sha256Hex(Buffer.from("abc", "utf8"))).toBe(expected)
    expect(sha256Hex("café")).toBe(sha256Hex(Buffer.from("café", "utf8")))
  })

  it("renders host path segments with portable separators", () => {
    expect(posix(["pkg", "nested", "file.ts"].join(Path.sep))).toBe("pkg/nested/file.ts")
  })
})
