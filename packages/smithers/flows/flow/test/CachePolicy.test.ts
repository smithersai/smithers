/**
 * The caller-declared cache policy: what decays, and how widely a recorded
 * result is allowed to travel.
 *
 * The policy is an annotation rather than a field on the action so it stays
 * data the engine reads, exactly like the placement and effect declarations.
 */
import { Action } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

const { CachePolicy, CachePolicyAnnotation, cachePolicyOf, CacheScope, withCache } = Action

const decode = Schema.decodeUnknownResult(CachePolicy)

describe("CachePolicy", () => {
  it("accepts an empty policy and every declared scope", () => {
    expect(decode({})._tag).toBe("Success")
    for (const scope of CacheScope.literals) {
      expect(decode({ scope })._tag).toBe("Success")
    }
  })

  it("decodes historical scopes and encodes current scopes", () => {
    for (const [historical, current] of [["workflow", "flow"], ["global", "shared"]] as const) {
      const policy = Schema.decodeUnknownSync(CachePolicy)({ scope: historical })
      expect(policy).toEqual({ scope: current })
      expect(Schema.encodeSync(CachePolicy)(policy)).toEqual({ scope: current })
    }
  })

  it("refuses a scope the engine cannot honor", () => {
    expect(decode({ scope: "unknown" })._tag).toBe("Failure")
  })

  it("refuses a time-to-live that is not a positive whole millisecond count", () => {
    expect(decode({ ttlMs: 0 })._tag).toBe("Failure")
    expect(decode({ ttlMs: -1 })._tag).toBe("Failure")
    expect(decode({ ttlMs: 1.5 })._tag).toBe("Failure")
    expect(decode({ ttlMs: 1 })._tag).toBe("Success")
  })
})

describe("cachePolicyOf", () => {
  it("reads the policy an action annotated", () => {
    const annotations = Context.add(Context.empty(), CachePolicyAnnotation, { ttlMs: 1000, scope: "run" })
    expect(cachePolicyOf(annotations)).toEqual({ ttlMs: 1000, scope: "run" })
  })

  it("reports no policy when the bag carries none", () => {
    expect(cachePolicyOf(Context.empty())).toBeUndefined()
  })
})

describe("withCache", () => {
  const compile = Action.make({
    name: "CachePolicy/compile",
    success: Schema.String,
    tier: "sealed",
    execute: Effect.succeed("dist/server.js")
  })

  it("declares the policy the engine reads at dispatch", () => {
    const declared = withCache(compile, { ttlMs: 1000, scope: "run" })
    expect(cachePolicyOf(declared.annotations)).toEqual({ ttlMs: 1000, scope: "run" })
  })

  it("leaves the action it was given alone", () => {
    const _declaration = withCache(compile, { ttlMs: 1000 })
    expect(cachePolicyOf(compile.annotations)).toBeUndefined()
  })

  it("keeps everything else the declaration carries", () => {
    const declared = withCache(compile, { scope: "shared" })
    expect(declared.name).toBe("CachePolicy/compile")
    expect(declared.tier).toBe("sealed")
  })
})
