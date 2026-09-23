import { describe, expect, it } from "vitest"
import * as Std from "../src/index.ts"
import * as Internal from "../src/internal/SearchContract.ts"
import * as SearchContract from "../src/SearchContract.ts"

describe("SearchContract", () => {
  it("publishes the shared validation and matching surface from the package root", () => {
    expect(Std.SearchContract).toBe(SearchContract)
    expect(Object.keys(SearchContract).sort()).toEqual([
      "canonicalGlob",
      "expression",
      "includedByGlobs",
      "matchesGlob",
      "unsatisfiableNotice",
      "validateGlob",
      "validatePattern"
    ])
  })

  it("keeps only the failure constructors, the root-failure mapping, and the literal escape internal", () => {
    expect(Object.keys(Internal).sort()).toEqual([
      "escapeRegex",
      "invalidInput",
      "invalidPattern",
      "notFound",
      "rootFailure"
    ])
  })

  it("compiles fixed strings as literal expressions", () => {
    const expression = SearchContract.expression("foo?", true, false)
    expect(expression.test("foo?")).toBe(true)
    expect(expression.test("foo")).toBe(false)
  })
})
