import * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * Issue #75: a sealed action's cache key omitted the two pieces of key
 * material the Step Keys spec calls mandatory — the resolved layers and the
 * capability set — by hard-coding `layers: []` and `capabilities: {}` for the
 * string form and passing the object form through verbatim.
 *
 * Sealed + `boundaryMode: "hard"` actions are cross-run cacheable, so a
 * digest blind to the environment served a result computed under Model=sonnet
 * to a run wired to Model=opus, or one computed with broad capabilities to a
 * run that attenuated them. The boundary descriptor (read set, write set,
 * boundary mode) is filesystem material and changes for neither swap.
 *
 * The environment is engine-resolved material, so — like the boundary
 * descriptor of issue #57 — it is folded into BOTH key forms and a caller
 * cannot opt out of it.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const flow = Flow.make("CacheEnvironmentKeys/flow", {
  payload: { id: Schema.String },
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

const hermeticMetadata = {
  readSet: [{ path: "src/input.ts", digest: "d1" }],
  writeSet: ["out/artifact"],
  boundaryMode: "hard"
} as const

const sealed = (idempotencyKey: Action.IdempotencyKey) =>
  Action.make({
    name: "CacheEnvironmentKeys/summarize",
    success: Schema.Void,
    idempotencyKey,
    metadata: hermeticMetadata,
    execute: Effect.void
  })

/** Dispatches `action` under `environment` and returns the step key. */
const keyUnder = (
  action: Action.Action,
  environment?: Action.CacheEnvironment,
  executionId = "content-environment-run"
): Effect.Effect<string, never, (EffectDigest.Digest | SecureRandom.SecureRandom)> => {
  let captured: string | undefined
  const engine = scriptedEngine({
    actionExecute: (input) =>
      Effect.sync(() => {
        captured = input.key
        return new Flow.Complete({ exit: Exit.void })
      })
  })
  return Effect.gen(function*() {
    const service = yield* FlowRuntime.FlowRuntime
    yield* service.actionExecute(action, 1)
    return captured!
  }).pipe(
    (self) =>
      environment === undefined
        ? self
        : Effect.provideService(self, Action.CurrentCacheEnvironment, environment),
    Effect.provideService(
      FlowRuntime.FlowInstance,
      FlowEngine.makeInstance(flow, executionId)
    ),
    Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
  )
}

const sonnet: Action.CacheEnvironment = {
  layers: ["Model=sonnet"],
  capabilities: { net: ["api.anthropic.com"] }
}

describe("sealed cache keys fold the resolved environment (issue #75)", () => {
  effect("pins compact declaration and boundary digests in sealed key bytes", () =>
    Effect.gen(function*() {
      // Encodings 1 and 2, written before keys named their encoding, never
      // change: recorded runs and cache rows are found under them.
      for (const encoding of [1, 2] as const) {
        const older = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(effect, FlowEngine.ActionKeyEncoding, encoding)
        expect(yield* older(keyUnder(sealed("order-123"), sonnet))).toBe(
          "key1_473bad0add0fa0b2995bbabffafdeaa8dc0df4e0be0c72e861da2e5d951c5db7"
        )
        expect(yield* older(keyUnder(sealed({ operation: "stable" }), sonnet))).toBe(
          "key1_1ff577a43eb9d96de10e62a98d4a65b45d6743e192f3660e45b28b058d4b5db4"
        )
      }
      // Encoding 3 names itself, and never changes either.
      const third = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, FlowEngine.ActionKeyEncoding, 3)
      expect(yield* third(keyUnder(sealed("order-123"), sonnet))).toBe(
        "key1_9d63d4f9dc261788d17d59ab85664b2567cd79eb83c8f4697cec3b7b4cde35a5"
      )
      expect(yield* third(keyUnder(sealed({ operation: "stable" }), sonnet))).toBe(
        "key1_a043263d97aae8aee91d61f4a740d980b53968bcd5fb41356289f499a127c431"
      )
      // New records are written under encoding 4, which names itself too.
      expect(yield* keyUnder(sealed("order-123"), sonnet)).toBe(
        "key1_c056171f759cc46e67d2445ee4fb30317d9032f5b767d7067eaa74ba2fcfd851"
      )
      expect(yield* keyUnder(sealed({ operation: "stable" }), sonnet)).toBe(
        "key1_1c0f6d314bc62133da3f308228d364de4f9916d8d60fae9d12c03ee28a1ed521"
      )
    }))

  effect("hashes an unchanged boundary document only once", () =>
    Effect.gen(function*() {
      const crypto = yield* EffectDigest.Digest
      const documents: Array<string> = []
      const action = Action.make({
        name: "CacheEnvironmentKeys/memoized-boundary",
        idempotencyKey: "row",
        metadata: { ...hermeticMetadata },
        execute: Effect.void
      })
      const observed = {
        ...crypto,
        digest: (...args: Parameters<typeof crypto.digest>) => {
          documents.push(new TextDecoder().decode(args[1]))
          return crypto.digest(...args)
        }
      }
      yield* Effect.gen(function*() {
        yield* keyUnder(action, sonnet)
        expect(documents.filter((document) => document.includes("src/input.ts"))).toHaveLength(1)
        yield* keyUnder(action, sonnet)
        expect(documents.filter((document) => document.includes("src/input.ts"))).toHaveLength(1)
      }).pipe(Effect.provideService(EffectDigest.Digest, observed))
    }))

  effect("rechecks mutable boundary metadata before reusing its digest", () =>
    Effect.gen(function*() {
      const metadata = {
        readSet: [{ path: "src/input.ts", digest: "d1" }],
        writeSet: ["out/artifact"],
        boundaryMode: "hard"
      }
      const action = Action.make({
        name: "CacheEnvironmentKeys/mutable-boundary",
        success: Schema.Void,
        idempotencyKey: "row",
        metadata,
        execute: Effect.void
      })
      const first = yield* keyUnder(action, sonnet)
      expect(yield* keyUnder(action, sonnet)).toBe(first)
      metadata.readSet[0]!.digest = "d2"
      expect(yield* keyUnder(action, sonnet)).not.toBe(first)
      metadata.readSet[0]!.digest = "d1"
      expect(yield* keyUnder(action, sonnet)).toBe(first)
      metadata.boundaryMode = "invalid"
      expect(yield* keyUnder(action, sonnet)).not.toBe(first)
    }))

  it("validates complete cache environments", () => {
    expect(Schema.decodeUnknownSync(Action.CacheEnvironment)(sonnet)).toEqual(sonnet)
    expect(() =>
      Schema.decodeUnknownSync(Action.CacheEnvironment)({
        layers: [],
        capabilities: { "": ["read"] }
      })
    ).toThrow("Capability names must not be empty")
  })

  effect("a swapped layer changes the digest of a string-form key", () => {
    return Effect.gen(function*() {
      const action = sealed("order-123")
      const underSonnet = yield* keyUnder(action, sonnet)
      const underOpus = yield* keyUnder(action, { ...sonnet, layers: ["Model=opus"] })
      expect(underSonnet).not.toBe(underOpus)
      // Same environment, same digest: the key stays reusable across runs.
      expect(yield* keyUnder(action, { layers: ["Model=sonnet"], capabilities: { net: ["api.anthropic.com"] } }))
        .toBe(underSonnet)
    })
  })

  effect("reordering environment layers changes the digest", () => {
    return Effect.gen(function*() {
      const action = sealed("order-123")
      const modelThenHost = yield* keyUnder(action, {
        layers: ["Model=sonnet", "Host=node"],
        capabilities: {}
      })
      const hostThenModel = yield* keyUnder(action, {
        layers: ["Host=node", "Model=sonnet"],
        capabilities: {}
      })
      expect(modelThenHost).not.toBe(hostThenModel)
    })
  })

  effect("attenuating capabilities changes the digest of a string-form key", () => {
    return Effect.gen(function*() {
      const action = sealed("order-123")
      const broad = yield* keyUnder(action, sonnet)
      const attenuated = yield* keyUnder(action, { ...sonnet, capabilities: { net: [] } })
      expect(broad).not.toBe(attenuated)
    })
  })

  effect("a caller-supplied cache key input cannot opt out of the environment", () => {
    return Effect.gen(function*() {
      const identity = { operation: "CacheEnvironmentKeys/rename-stable" }
      const action = sealed(identity)
      const underSonnet = yield* keyUnder(action, sonnet)
      const underOpus = yield* keyUnder(action, { ...sonnet, layers: ["Model=opus"] })
      expect(underSonnet).not.toBe(underOpus)
      // The caller's own declared material still counts.
      const richer = sealed({ ...identity, input: "changed" })
      expect(yield* keyUnder(richer, sonnet)).not.toBe(underSonnet)
    })
  })

  effect("an undeclared environment is scoped to the current execution", () => {
    return Effect.gen(function*() {
      const action = sealed("order-123")
      expect(yield* keyUnder(action)).not.toBe(
        yield* keyUnder(action, { layers: [], capabilities: {} })
      )
      expect(yield* keyUnder(action, undefined, "other-run")).not.toBe(
        yield* keyUnder(action, undefined, "first-run")
      )
    })
  })

  effect("caller and environment capability identities cannot alias through concatenation", () => {
    return Effect.gen(function*() {
      const identity = (patterns: ReadonlyArray<string>): Schema.JsonObject => ({
        operation: "CacheEnvironmentKeys/union",
        authority: patterns
      })
      const environment: Action.CacheEnvironment = {
        layers: [],
        capabilities: { fs: ["/workspace"] }
      }
      const readsA = yield* keyUnder(sealed(identity(["/data/a"])), environment)
      const readsB = yield* keyUnder(sealed(identity(["/data/b"])), environment)
      expect(readsA).not.toBe(readsB)
      // Caller-owned and engine-resolved authority occupy distinct namespaces:
      // moving one pattern across that boundary must re-key.
      expect(yield* keyUnder(sealed(identity(["/workspace", "/data/a"])), { layers: [], capabilities: {} }))
        .not.toBe(readsA)
    })
  })

  effect("layerCacheEnvironment declares the environment for a composition", () => {
    // Issue #88: the declaration must be wireable as a layer so shipped
    // compositions (the plugin kernel, hand-wired stacks) provide it.
    return Effect.gen(function*() {
      const environment = yield* Action.CurrentCacheEnvironment.pipe(
        Effect.provide(Action.layerCacheEnvironment(sonnet))
      )
      expect(environment).toEqual(sonnet)
    })
  })

  effect("the environment does not enter invocation keys", () => {
    return Effect.gen(function*() {
      // Invocation keys are run-local and never reused across runs, so the
      // environment is not key input for them.
      const ordinalAction = Action.make({
        name: "CacheEnvironmentKeys/ordinal",
        tier: "irreversible",
        success: Schema.Void,
        execute: Effect.void
      })
      expect(yield* keyUnder(ordinalAction, sonnet)).toBe(
        yield* keyUnder(ordinalAction, { ...sonnet, layers: ["Model=opus"] })
      )
    })
  })
})

describe("older key encodings reach a driver's replay lookup", () => {
  /** Dispatches `action` through a driver whose replay lookup answers what `choose` picks from the offered keys. */
  const offered = (
    action: Action.Action,
    choose: (current: string, legacy: ReadonlyArray<string>) => string
  ) =>
    Effect.gen(function*() {
      let captured: string | undefined
      const seen: { current?: string; legacy?: ReadonlyArray<string>; runScoped?: ReadonlyArray<string> } = {}
      const engine = scriptedEngine({
        actionExecute: (input) =>
          Effect.sync(() => {
            captured = input.key
            return new Flow.Complete({ exit: Exit.void })
          }),
        actionReplayKey: (derive, legacy) =>
          Effect.gen(function*() {
            const instance = yield* FlowRuntime.FlowInstance
            seen.current = yield* derive(instance.executionId, false)
            seen.legacy = yield* legacy(instance.executionId, false)
            seen.runScoped = yield* legacy(instance.executionId, true)
            return choose(seen.current, seen.legacy)
          })
      })
      yield* Effect.flatMap(FlowRuntime.FlowRuntime, (service) => service.actionExecute(action, 1)).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "legacy-run")),
        Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
      )
      return { captured: captured!, ...seen }
    })

  effect(
    "a keyed sealed action is offered each older key once, and runs under the key the driver picks",
    () =>
      Effect.gen(function*() {
        const under = (encoding: FlowEngine.KeyEncoding) =>
          Effect.provideService(
            keyUnder(sealed("order-123"), undefined, "legacy-run"),
            FlowEngine.ActionKeyEncoding,
            encoding
          )
        // Encoding 3 names itself. Encodings 2 and 1 derive one key for a
        // declaration with no brand; the driver is offered it once.
        const named = yield* under(3)
        const original = yield* under(2)
        expect(yield* under(1)).toBe(original)
        const picked = yield* offered(sealed("order-123"), (_current, legacy) => legacy[1]!)
        expect(picked.legacy).toEqual([named, original])
        // Without a cache environment the run-scoped key is the same key.
        expect(picked.runScoped).toEqual([named, original])
        expect(picked.current).not.toBe(original)
        expect(picked.captured).toBe(original)
      })
  )

  effect("an action whose key no encoding changes is offered nothing older", () =>
    Effect.gen(function*() {
      const plain = Action.make({ name: "CacheEnvironmentKeys/plain", success: Schema.Void, execute: Effect.void })
      const picked = yield* offered(plain, (current) => current)
      expect(picked.legacy).toEqual([])
      expect(picked.captured).toBe(picked.current)
    }))
})
