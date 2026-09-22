/**
 * `WithCache` on `@smthrs/flow` declarations.
 *
 * Every assertion is the one it was: which envelopes the decorator refuses,
 * what the wrapper is named, which fields reach the policy annotation, and
 * which declarations share key material. A wrapper's name is `flow._tag`, its
 * envelope is the `Flow.EffectEnvelope` annotation, and its key material is
 * the canonical digest of the per-node `draft.material` `@smthrs/flow`'s graph
 * publishes.
 */
import { describe, expectTypeOf, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import * as Effects from "@smthrs/plan/Effects"
import * as Node from "@smthrs/plan/Node"
import * as Placement from "@smthrs/plan/Placement"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Decorate from "../src/internal/Decorate.ts"
import * as Pattern from "../src/Pattern.ts"
import { PatternError } from "../src/PatternError.ts"
import * as WithCache from "../src/WithCache.ts"
import * as WithRetry from "../src/WithRetry.ts"

/** The one step a cached flow wraps: an action, which is opaque work. */
const read = Action.make("withCache/read", {
  payload: { path: Schema.String },
  success: Schema.String,
  error: Schema.Never
})

const flowOf = (
  tag: string,
  options?: {
    readonly effects?: Effects.Declaration | undefined
    readonly pure?: boolean | undefined
    readonly description?: string | undefined
  }
): Flow.Any =>
  Flow.make(tag, {
    ...(options?.description === undefined ? {} : { description: options.description }),
    payload: { path: Schema.String },
    success: Schema.String,
    error: Schema.Never,
    ...(options?.effects === undefined ? {} : { effects: options.effects }),
    body: Node.capture(
      { tag, pure: options?.pure === true },
      ({ path }: { readonly path: string }) => options?.pure === true ? Node.succeed(path) : read.call({ path })
    )
  }) as unknown as Flow.Any

const hermetic = Effects.make({
  reads: ["workspace/**"],
  writes: [],
  mode: "hermetic",
  onConflict: "serialize"
})

const sealedRead = (): Flow.Any => flowOf("read", { effects: hermetic })

/** Everything a built graph keys on, which is what `/keys` hashes. */
const keyMaterial = (flow: Flow.Any): ReadonlyArray<unknown> =>
  Graph.nodes(Graph.build(flow, { path: "file" })).map((node) => node.draft.material)

/** The annotation bag a built flow carries; `Flow.Any` states the field. */
const annotationsOf = (flow: Flow.Any): Context.Context<never> => flow.annotations

describe("WithCache", () => {
  it("rejects an unsealed inner flow", () => {
    try {
      WithCache.withCache(flowOf("unsealed"))
      throw new Error("expected withCache to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(PatternError)
      expect(error).toMatchObject({
        code: "invalid_decorator",
        message: "withCache requires an explicitly hermetic, sealed flow"
      })
    }
  })

  it("marks the wrapper sealed without emitting an unconsumed marker", () => {
    const cached = WithCache.withCache(sealedRead())
    const graph = Graph.build(cached, { path: "file" })

    expect(cached._tag).toBe("withCache(read)")
    expect(Decorate.envelopeOf(cached)).toMatchObject({ mode: "hermetic", tier: "sealed" })
    expect(Graph.nodes(graph).some((node) => JSON.stringify(node.draft.material).includes("StepKeyCache"))).toBe(false)
    expect(Graph.nodes(graph).filter((node) => node.kind === "ActionCall")).toHaveLength(1)
  })

  it("accepts a declared policy alongside the inner flow", () => {
    expectTypeOf(WithCache.withCache).parameters.toEqualTypeOf<
      [inner: Flow.Any, options?: WithCache.Options | undefined]
    >()
  })
})

describe("WithCache policy", () => {
  it("names every declared field in the wrapper", () => {
    const cached = WithCache.withCache(sealedRead(), { ttlMs: 1000, scope: "run", version: "v2" })
    expect(cached._tag).toBe("withCache(read, ttlMs=1000, scope=run, version=v2)")
  })

  it("names only the fields the caller declared", () => {
    expect(WithCache.withCache(sealedRead(), { scope: "flow" })._tag).toBe("withCache(read, scope=flow)")
  })

  it("carries the wrapped flow's description, and states none when it has none", () => {
    const described = WithCache.withCache(flowOf("read", { effects: hermetic, description: "Read one file." }))

    expect(described.description).toBe("Read one file.")
    expect(WithCache.withCache(sealedRead()).description).toBeUndefined()
  })

  it("leaves an undeclared policy at the pre-policy declaration", () => {
    const inner = sealedRead()
    const cached = WithCache.withCache(inner)
    const emptyPolicy = WithCache.withCache(inner, {})

    expect(cached._tag).toBe("withCache(read)")
    expect(keyMaterial(cached)).toEqual(keyMaterial(emptyPolicy))
  })

  it("folds the policy into declaration key material", () => {
    const inner = sealedRead()
    const oneSecond = WithCache.withCache(inner, { ttlMs: 1000 })
    const oneSecondAgain = WithCache.withCache(inner, { ttlMs: 1000 })
    const twoSeconds = WithCache.withCache(inner, { ttlMs: 2000 })
    const runScoped = WithCache.withCache(inner, { ttlMs: 1000, scope: "run" })
    const versioned = WithCache.withCache(inner, { ttlMs: 1000, version: "v2" })

    expect(keyMaterial(oneSecond)).toEqual(keyMaterial(oneSecondAgain))
    expect(keyMaterial(oneSecond)).not.toEqual(keyMaterial(twoSeconds))
    expect(keyMaterial(oneSecond)).not.toEqual(keyMaterial(runScoped))
    expect(keyMaterial(oneSecond)).not.toEqual(keyMaterial(versioned))
  })

  it("refuses a time to live no clock reading satisfies", () => {
    for (const ttlMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => WithCache.withCache(sealedRead(), { ttlMs })).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: `withCache ttlMs must be a positive safe integer, received ${ttlMs}`
        })
      )
    }
  })

  it("validates a factory's options synchronously on application", () => {
    const decorator = WithCache.make({ ttlMs: 0 })
    expect(() => Pattern.decorate(sealedRead(), decorator)).toThrow(
      expect.objectContaining({ code: "invalid_decorator" })
    )
  })

  it("accepts the TTL boundaries on an explicitly hermetic pure flow", () => {
    const echo = flowOf("echo", {
      pure: true,
      effects: Effects.make({ reads: [], writes: [], mode: "hermetic", onConflict: "serialize" })
    })
    for (const ttlMs of [1, Number.MAX_SAFE_INTEGER]) {
      const cached = WithCache.withCache(echo, { ttlMs, version: "v1" })
      expect(CacheEnvironment.cachePolicyOf(annotationsOf(cached))).toEqual({ ttlMs })
      expect(Graph.diagnostics(Graph.build(cached, { path: "hello" }))).toEqual([])
    }
  })

  it("refuses a blank version", () => {
    expect(() => WithCache.withCache(sealedRead(), { version: " " })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "withCache version must name a revision, not blank text"
      })
    )
  })

  it("refuses every non-cacheable effect envelope with its exact code", () => {
    const inner = (mode: "expected" | "hermetic", tier: "sealed" | "compensable") =>
      flowOf(`${mode}-${tier}`, {
        pure: true,
        effects: Effects.make({ reads: [], writes: [], mode, onConflict: "serialize", tier })
      })

    for (const flow of [inner("expected", "sealed"), inner("hermetic", "compensable")]) {
      expect(() => WithCache.withCache(flow)).toThrow(
        expect.objectContaining({
          code: "invalid_decorator",
          message: "withCache requires an explicitly hermetic, sealed flow"
        })
      )
    }
  })
})

describe("WithCache policy annotation", () => {
  it("preserves the policy through Pattern.decorate", () => {
    const cached = Pattern.decorate(sealedRead(), WithCache.make({ ttlMs: 1000, scope: "run" }))
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(cached))).toEqual({ ttlMs: 1000, scope: "run" })
  })

  it("preserves an inner policy through an outer retry", () => {
    const cached = WithCache.withCache(sealedRead(), { ttlMs: 1000, scope: "run" })
    const retried = WithRetry.withRetry(cached, { attempts: 3 })
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(retried))).toEqual({ ttlMs: 1000, scope: "run" })
  })

  it("preserves the policy through Pattern.decorateAll", () => {
    const decorated = Pattern.decorateAll(sealedRead(), [
      WithCache.make({ ttlMs: 1000, scope: "run" }),
      WithRetry.make({ attempts: 3 })
    ])
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(decorated))).toEqual({ ttlMs: 1000, scope: "run" })
  })

  it("lets the outer cache policy replace the inner policy", () => {
    const decorated = Pattern.decorateAll(sealedRead(), [
      WithCache.make({ ttlMs: 1000, scope: "run" }),
      WithCache.make({ ttlMs: 2000 })
    ])
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(decorated))).toEqual({ ttlMs: 2000 })
  })

  it("preserves placement and custom metadata from both sides of the seam", () => {
    const Metadata = Context.Service<string>("test/WithCache/Metadata")
    const inner = Decorate.annotate(
      Decorate.annotate(sealedRead(), Flow.Placement, Placement.local()),
      Metadata,
      "inner"
    )
    const cached = Pattern.decorate(inner, WithCache.make({ ttlMs: 1000 }))
    expect(Option.getOrUndefined(Context.getOption(annotationsOf(cached), Flow.Placement))).toEqual(
      Placement.local()
    )
    expect(Option.getOrUndefined(Context.getOption(annotationsOf(cached), Metadata))).toBe("inner")
    const outer = Pattern.decorate(
      cached,
      () =>
        Decorate.annotate(
          Decorate.annotate(sealedRead(), Flow.Placement, Placement.remote()),
          Metadata,
          "outer"
        )
    )
    expect(Option.getOrUndefined(Context.getOption(annotationsOf(outer), Flow.Placement))).toEqual(
      Placement.remote()
    )
    expect(Option.getOrUndefined(Context.getOption(annotationsOf(outer), Metadata))).toBe("outer")
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(outer))).toEqual({ ttlMs: 1000 })
  })

  it("annotates the wrapper with the policy the engine reads at dispatch", () => {
    const cached = WithCache.withCache(sealedRead(), { ttlMs: 1000, scope: "run", version: "v2" })
    // Read back through @smthrs/flow's reader, not this module's: the two keys
    // are declared separately and only their identifier makes them one, so a
    // drift in either identifier fails here rather than silently making every
    // declared policy inert at dispatch.
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(cached))).toEqual({ ttlMs: 1000, scope: "run" })
    expect(WithCache.policyOf(annotationsOf(cached))).toEqual({ ttlMs: 1000, scope: "run" })
  })

  it("carries only the durable fields, because version is identity and not an instruction", () => {
    const versionOnly = WithCache.withCache(sealedRead(), { version: "v2" })
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(versionOnly))).toBeUndefined()
    const ttlOnly = WithCache.withCache(sealedRead(), { ttlMs: 250 })
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(ttlOnly))).toEqual({ ttlMs: 250 })
  })

  it("annotates nothing when the caller declares no policy", () => {
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(WithCache.withCache(sealedRead())))).toBeUndefined()
  })

  it("keeps the annotation through the seal the combinator applies", () => {
    const decorated = WithCache.make({ scope: "flow" })(sealedRead())
    const sealed = WithCache.withCache(sealedRead(), { scope: "flow" })
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(decorated))).toEqual({ scope: "flow" })
    expect(CacheEnvironment.cachePolicyOf(annotationsOf(sealed))).toEqual({ scope: "flow" })
  })

  it("gives two declarations differing only in version different key material", () => {
    const inner = sealedRead()
    const first = keyMaterial(WithCache.withCache(inner, { version: "v1" }))
    const firstAgain = keyMaterial(WithCache.withCache(inner, { version: "v1" }))
    const second = keyMaterial(WithCache.withCache(inner, { version: "v2" }))

    // The material is what `/keys` hashes, so a step key derived from it moves
    // with the version and a row recorded under v1 is unreachable at v2.
    expect(first).toEqual(firstAgain)
    expect(first).not.toEqual(second)
  })

  it("seals a flow that declared no envelope at all", () => {
    // `Decorate.seal` has two arms: a declared envelope is narrowed, and a flow
    // with none gets the closed one. `withCache` refuses the second case, so it
    // is exercised here directly.
    const sealed = Decorate.seal(flowOf("unsealed", { pure: true }))

    expect(Decorate.envelopeOf(sealed)).toEqual(
      Effects.make({ reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" })
    )
  })
})
