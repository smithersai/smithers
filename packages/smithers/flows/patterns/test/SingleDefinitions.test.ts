/**
 * Every vocabulary this package shares with another has ONE declaration, in
 * `@smthrs/plan`.
 *
 * Identity, not equality: a structural copy of a literal union or an annotation
 * key passes a deep-equal check and forks the moment one side gains a member or
 * is retyped. These cases assert the same object, so a reintroduced copy fails
 * here rather than as a policy the engine silently stops reading.
 */
import * as CachePolicy from "@smthrs/plan/CachePolicy"
import * as Repetition from "@smthrs/plan/Repetition"
import { describe, expect, it } from "vitest"
import * as Loop from "../src/Loop.ts"
import * as WithCache from "../src/WithCache.ts"

describe("single definitions", () => {
  it("carries a cache policy under the one annotation key", () => {
    expect(WithCache.CachePolicyAnnotation).toBe(CachePolicy.CachePolicyAnnotation)
    expect(WithCache.policyOf).toBe(CachePolicy.cachePolicyOf)
  })

  it("keeps the identifier @smthrs/engine-store reads a dispatched policy by", () => {
    expect(WithCache.CachePolicyAnnotation.key).toBe("@smthrs/flow/Action/CachePolicy")
  })

  it("names the loop ceiling outcomes from the plan repetition vocabulary", () => {
    // `OnMaxReached` is a type, so the pin is that every member the plan
    // vocabulary declares is a `MakeOptions.onMaxReached` this package accepts.
    const accepted: ReadonlyArray<Loop.OnMaxReached> = Repetition.AtCeiling.literals
    expect([...accepted]).toEqual(["fail", "return-last"])
  })
})
