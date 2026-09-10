import { describe, expect, it } from "vitest"
import { tupleKey } from "../src/internal/tupleKey.ts"

describe("tupleKey", () => {
  it("gives one key to one tuple", () => {
    expect(tupleKey("a", "b")).toBe(tupleKey("a", "b"))
  })

  // The property every caller depends on: a component may hold any character,
  // including whatever a delimiter join would have used to separate them.
  it("gives distinct keys to tuples a delimiter join would collide", () => {
    expect(tupleKey("a", "b c")).not.toBe(tupleKey("a b", "c"))
    expect(tupleKey("a", "")).not.toBe(tupleKey("a"))
    expect(tupleKey("a\u0000b", "c")).not.toBe(tupleKey("a", "b\u0000c"))
  })

  it("orders by component, so a tuple key sorts as its components do", () => {
    expect([tupleKey("b", "a"), tupleKey("a", "z")].sort()).toEqual([tupleKey("a", "z"), tupleKey("b", "a")])
  })
})
