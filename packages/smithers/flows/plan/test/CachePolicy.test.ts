/**
 * The one cache-policy declaration, and the one ceiling vocabulary.
 *
 * The annotation IDENTIFIER is the contract with `@smthrs/engine-store`, which
 * reads the policy off stored and dispatched actions by that string. A rename
 * would make every policy already written invisible at dispatch, so it is
 * pinned here rather than left to a reader to notice.
 */
import * as Context from "effect/Context"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as CachePolicy from "../src/CachePolicy.ts"
import * as Repetition from "../src/Repetition.ts"

const decode = Schema.decodeUnknownResult(CachePolicy.CachePolicy)

describe("CachePolicy", () => {
  it("keeps the identifier @smthrs/engine-store reads policies by", () => {
    expect(CachePolicy.CachePolicyAnnotation.key).toBe("@smthrs/flow/Action/CachePolicy")
  })

  it("accepts an empty policy and every declared scope", () => {
    expect(decode({})._tag).toBe("Success")
    for (const scope of CachePolicy.CacheScope.literals) expect(decode({ scope })._tag).toBe("Success")
    expect([...CachePolicy.CacheScope.literals]).toEqual(["run", "flow", "shared"])
  })

  it("refuses a scope the engine cannot honor", () => {
    expect(decode({ scope: "workflow" })._tag).toBe("Failure")
  })

  it("refuses a time-to-live that is not a positive whole millisecond count", () => {
    expect(decode({ ttlMs: 0 })._tag).toBe("Failure")
    expect(decode({ ttlMs: -1 })._tag).toBe("Failure")
    expect(decode({ ttlMs: 1.5 })._tag).toBe("Failure")
    expect(decode({ ttlMs: 1 })._tag).toBe("Success")
  })

  it("reads back the policy a bag carries, and nothing from a bag without one", () => {
    const bag = Context.add(Context.empty(), CachePolicy.CachePolicyAnnotation, { ttlMs: 1000, scope: "run" })

    expect(CachePolicy.cachePolicyOf(bag)).toEqual({ ttlMs: 1000, scope: "run" })
    expect(CachePolicy.cachePolicyOf(Context.empty())).toBeUndefined()
  })

  it("annotates a declaration without mutating it", () => {
    interface Declaration {
      readonly annotations: Context.Context<never>
      readonly annotate: (key: typeof CachePolicy.CachePolicyAnnotation, value: CachePolicy.CachePolicy) => Declaration
    }
    const make = (annotations: Context.Context<never>): Declaration => ({
      annotations,
      annotate: (key, value) => make(Context.add(annotations, key, value))
    })
    const original = make(Context.empty())

    const annotated = CachePolicy.annotate(original, { ttlMs: 250 })

    expect(CachePolicy.cachePolicyOf(annotated.annotations)).toEqual({ ttlMs: 250 })
    expect(CachePolicy.cachePolicyOf(original.annotations)).toBeUndefined()
  })
})

describe("Repetition", () => {
  it("names both ceiling outcomes once", () => {
    expect([...Repetition.AtCeiling.literals]).toEqual(["fail", "return-last"])
  })
})
