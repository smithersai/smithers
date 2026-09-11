import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as KeyMaterial from "../src/KeyMaterial.ts"
import * as StepKey from "../src/StepKey.ts"
import { withCrypto, withCryptoFailure } from "./Crypto.ts"

const material = (overrides: Partial<KeyMaterial.KeyMaterial> = {}): KeyMaterial.KeyMaterial => ({
  version: KeyMaterial.version,
  kind: "sealed",
  body: { action: "render" },
  inputs: [],
  layers: [],
  capabilities: [],
  ...overrides
})

const expectKeyMaterialError = (
  failure: unknown,
  code: StepKey.KeyMaterialError["code"],
  message: string
): void => {
  expect(failure).toBeInstanceOf(StepKey.KeyMaterialError)
  const error = failure as StepKey.KeyMaterialError
  expect(error.code).toBe(code)
  expect(error.message).toBe(message)
}

describe("StepKey", () => {
  it.effect("binds normalized environment fingerprints without changing existing content identity", () =>
    Effect.gen(function*() {
      const environment: StepKey.EnvironmentIdentity = {
        declared: true,
        layers: ["cafe\u0301", "second"],
        capabilities: { fs: ["b", "a", "a"], net: ["host"] }
      }
      const equivalent: StepKey.EnvironmentIdentity = {
        declared: true,
        layers: ["caf\u00e9", "second"],
        capabilities: { net: ["host"], fs: ["a", "b"] }
      }
      const fingerprint = yield* withCrypto(StepKey.environmentIdentity(environment))
      expect(fingerprint).toBe(yield* withCrypto(StepKey.environmentIdentity(equivalent)))
      const base = { body: 1, inputs: {}, layers: [], capabilities: {} }
      expect(yield* withCrypto(StepKey.content({ ...base, environment })))
        .toBe(yield* withCrypto(StepKey.content({ ...base, environment: equivalent })))
      expect(fingerprint).not.toBe(yield* withCrypto(StepKey.content({ ...base, environment })))
      const variants: Array<StepKey.EnvironmentIdentity | undefined> = [
        undefined,
        { declared: true, layers: [], capabilities: {} },
        { ...environment, layers: ["second", "caf\u00e9"] },
        { ...environment, layers: ["caf\u00e9", "second", "second"] },
        { ...environment, capabilities: { fs: ["a", "b", "c"], net: ["host"] } },
        { ...environment, declared: false, runScope: "run-a" },
        { ...environment, declared: false, runScope: "run-b" }
      ]
      const keys = yield* withCrypto(Effect.forEach(variants, (value) => StepKey.environmentIdentity(value)))
      expect(new Set([fingerprint, ...keys]).size).toBe(variants.length + 1)
      const decoded = Schema.decodeUnknownSync(StepKey.EnvironmentIdentity)(environment)
      expect(decoded).toEqual(environment)
      expect(decoded).not.toBe(environment)
      expect(decoded.layers).not.toBe(environment.layers)
      expect(decoded.capabilities.fs).not.toBe(environment.capabilities.fs)
    }))

  it.effect("rejects malformed environments through every identity constructor without defects", () =>
    Effect.gen(function*() {
      const base = { declared: true, layers: [], capabilities: {} }
      const values: Array<unknown> = [
        null,
        1,
        "env",
        [],
        {},
        { ...base, layers: "layer" },
        { ...base, layers: [1] },
        { ...base, capabilities: null },
        { ...base, capabilities: { fs: "path" } },
        { ...base, capabilities: { fs: [false] } },
        { ...base, extra: "not-keyed" },
        {
          ...base,
          get layers() {
            throw new Error("private getter detail")
          }
        }
      ]
      for (const value of values) {
        const environment = value as StepKey.EnvironmentIdentity
        const effects = [
          StepKey.environmentIdentity(environment),
          StepKey.content({ body: 1, inputs: {}, layers: [], capabilities: {}, environment }),
          StepKey.dispatchIdentity({
            material: material(),
            results: {},
            environment,
            hermetic: { readSet: [], writeSet: [], boundaryMode: "hard" }
          })
        ]
        for (const effect of effects) {
          const error = yield* withCryptoFailure(effect)
          expect(error).toMatchObject({ code: "invalid_environment" })
          expect(JSON.stringify(error)).not.toContain("private getter detail")
        }
      }
    }))

  it.effect("produces a key1_ digest and is stable under set reordering", () =>
    Effect.gen(function*() {
      const left = yield* withCrypto(
        StepKey.content({ body: 1, inputs: {}, layers: ["b", "a"], capabilities: { fs: ["w", "r", "r"] } })
      )
      const right = yield* withCrypto(
        StepKey.content({ body: 1, inputs: {}, layers: ["a", "b"], capabilities: { fs: ["r", "w"] } })
      )
      expect(left).toMatch(/^key1_[0-9a-f]{64}$/)
      expect(left).toBe(right)
    }))

  it.effect("hashes a branded digest input differently from a literal of the same shape", () =>
    Effect.gen(function*() {
      const branded = yield* withCrypto(
        StepKey.content({ body: 1, inputs: { a: StepKey.digestInput("abc") }, layers: [], capabilities: {} })
      )
      const literal = yield* withCrypto(
        StepKey.content({ body: 1, inputs: { a: { digest: "abc" } }, layers: [], capabilities: {} })
      )
      expect(StepKey.isDigestInput(StepKey.digestInput("abc"))).toBe(true)
      expect(StepKey.isDigestInput({ digest: "abc" })).toBe(false)
      expect(StepKey.isDigestInput(null)).toBe(false)
      expect(branded).not.toBe(literal)
    }))

  it.effect("keeps the environment namespace non-aliasing and order-sensitive", () =>
    Effect.gen(function*() {
      const separate = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: ["a"],
        capabilities: {},
        environment: { declared: true, layers: ["b"], capabilities: { fs: ["r"] } }
      }))
      const merged = yield* withCrypto(
        StepKey.content({ body: 1, inputs: {}, layers: ["a", "b"], capabilities: { fs: ["r"] } })
      )
      const undeclared = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: ["a"],
        capabilities: {},
        environment: { declared: false, layers: ["b"], capabilities: { fs: ["r"] }, runScope: "run-1" }
      }))
      const reordered = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: ["a"],
        capabilities: {},
        environment: { declared: true, layers: ["b", "c"], capabilities: {} }
      }))
      const swapped = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: ["a"],
        capabilities: {},
        environment: { declared: true, layers: ["c", "b"], capabilities: {} }
      }))
      expect(separate).not.toBe(merged)
      expect(separate).not.toBe(undeclared)
      expect(reordered).not.toBe(swapped)
    }))

  it.effect("normalizes and dedupes the hermetic declaration", () =>
    Effect.gen(function*() {
      const left = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: [],
        capabilities: {},
        hermetic: {
          readSet: [{ path: "b", digest: "2" }, { path: "a", digest: "1" }, { path: "a", digest: "1" }, {
            path: "a",
            digest: "0"
          }],
          writeSet: ["out", "out"],
          boundaryMode: "hard"
        }
      }))
      const right = yield* withCrypto(StepKey.content({
        body: 1,
        inputs: {},
        layers: [],
        capabilities: {},
        hermetic: {
          readSet: [{ path: "a", digest: "0" }, { path: "a", digest: "1" }, { path: "b", digest: "2" }],
          writeSet: ["out"],
          boundaryMode: "hard"
        }
      }))
      expect(left).toBe(right)
    }))

  it.effect("normalizes tree, glob, and removal declarations", () =>
    Effect.gen(function*() {
      const identity = (
        writeSet: NonNullable<StepKey.ContentIdentity["hermetic"]>["writeSet"],
        removes: ReadonlyArray<string>
      ) =>
        StepKey.content({
          body: 1,
          inputs: {},
          layers: [],
          capabilities: {},
          hermetic: { readSet: [], writeSet, removes, boundaryMode: "hard" }
        })
      const left = yield* withCrypto(identity([
        { _tag: "Glob", include: ["src/**/*.ts", "src/**/*.ts"], exclude: ["src/z.ts", "src/a.ts"] },
        { _tag: "Glob", include: ["assets/**"] },
        { _tag: "TreeArtifact", path: "dist" },
        "out"
      ], ["stale/z", "stale/a", "stale/a"]))
      const right = yield* withCrypto(identity([
        "out",
        { _tag: "Glob", include: ["assets/**"] },
        { _tag: "TreeArtifact", path: "dist" },
        { _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/a.ts", "src/z.ts"] }
      ], ["stale/a", "stale/z"]))
      expect(left).toBe(right)
    }))

  it.effect("canonicalizes write entry property order and sorts by code unit", () =>
    Effect.gen(function*() {
      const identity = (writeSet: NonNullable<StepKey.ContentIdentity["hermetic"]>["writeSet"]) =>
        StepKey.content({
          body: 1,
          inputs: {},
          layers: [],
          capabilities: {},
          hermetic: { readSet: [], writeSet, boundaryMode: "hard" }
        })
      const ordinary = { _tag: "TreeArtifact" as const, path: "än/out.js" }
      const reordered = { path: "än/out.js", _tag: "TreeArtifact" as const }
      const left = yield* withCrypto(identity([ordinary, reordered, "z/out.js"]))
      const right = yield* withCrypto(identity(["z/out.js", reordered]))

      expect(left).toBe(right)
    }))

  it.effect("makes an ordinal key run-local", () =>
    Effect.gen(function*() {
      const first = yield* withCrypto(StepKey.ordinal({ runId: "run-1", ordinal: 1, tier: "unsealed" }))
      const second = yield* withCrypto(StepKey.ordinal({ runId: "run-2", ordinal: 1, tier: "unsealed" }))
      expect(first).not.toBe(second)
    }))

  it.effect("substitutes dependency digests and tags every reference variant", () =>
    Effect.gen(function*() {
      const digests = { upstream: "key1_upstream" }
      const pending = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Pending", from: "upstream" }] }), digests)
      )
      const plain = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: [] }] }), digests)
      )
      const projected = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: ["a"] }] }), digests)
      )
      const literal = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Literal", value: 1 }] }), digests)
      )
      expect(new Set([pending, plain, projected, literal]).size).toBe(4)
    }))

  it.effect("keeps a literal that spells a digest reference distinct from the reference (D7)", () =>
    Effect.gen(function*() {
      // `fromKeyMaterial` now builds `DigestInput` values and lets
      // `normalizeInputs` be the single normalizer, instead of hand-building
      // `{kind: "ref", digest}` objects that were then wrapped a second time as
      // `{kind: "literal", value: <that object>}`. The double wrap was what made
      // this collision impossible before; the nominal `DigestInputTypeId` brand
      // is what makes it impossible now. A literal value can spell the digest
      // reference's normalized form exactly and still cannot be mistaken for it.
      const digests = { upstream: "key1_upstream" }
      const reference = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: [] }] }), digests)
      )
      const impostor = yield* withCrypto(
        StepKey.fromKeyMaterial(
          material({
            inputs: [{ _tag: "Literal", value: { kind: "digest", digest: "key1_upstream", reference: "ref" } }]
          }),
          digests
        )
      )
      const projectedImpostor = yield* withCrypto(
        StepKey.fromKeyMaterial(
          material({
            inputs: [{
              _tag: "Literal",
              value: { kind: "digest", digest: "key1_upstream", reference: "ref-projected", path: ["a"] }
            }]
          }),
          digests
        )
      )
      const projected = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "upstream", path: ["a"] }] }), digests)
      )

      expect(new Set([reference, impostor, projected, projectedImpostor]).size).toBe(4)
    }))

  it.effect("keeps an untagged digest input distinct from a graph reference (D7)", () =>
    Effect.gen(function*() {
      // A caller-supplied `digestInput(d)` carries no `reference`, so it must not
      // collide with the `ref` variant `fromKeyMaterial` produces for the same
      // digest. This is the corner the new discriminator opens.
      const untagged = yield* withCrypto(
        StepKey.content({
          body: { version: 1, declaration: "step" },
          inputs: { "0": StepKey.digestInput("key1_upstream") },
          layers: [],
          capabilities: { declared: [] }
        })
      )
      const tagged = yield* withCrypto(
        StepKey.content({
          body: { version: 1, declaration: "step" },
          inputs: { "0": StepKey.digestInput("key1_upstream", { reference: "ref" }) },
          layers: [],
          capabilities: { declared: [] }
        })
      )

      expect(untagged).not.toBe(tagged)
    }))

  it.effect("folds effects, placement, and the material version into the body", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(StepKey.fromKeyMaterial(material(), {}))
      const withEffects = yield* withCrypto(StepKey.fromKeyMaterial(material({ effects: { net: true } }), {}))
      const withPlacement = yield* withCrypto(StepKey.fromKeyMaterial(material({ placement: "edge" }), {}))
      expect(new Set([base, withEffects, withPlacement]).size).toBe(3)
    }))

  it.effect("folds declared nondeterminism without moving the absent plan key", () =>
    Effect.gen(function*() {
      const deterministic = yield* withCrypto(StepKey.fromKeyMaterial(material(), {}))
      const nondeterministic = yield* withCrypto(
        StepKey.fromKeyMaterial(material({ nondeterministic: true }), {})
      )
      expect(deterministic).toBe("key1_70a7f80ee5c3eb79693e5e98802145e7d928f6c67a57bec1338da6ee4f5ca0e9")
      expect(nondeterministic).not.toBe(deterministic)
    }))

  it.effect("refuses material with no digest for a declared dependency", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(
        StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: "missing", path: [] }] }), {})
      )
      expectKeyMaterialError(failure, "missing_dependency", "Missing digest for graph dependency missing")
    }))

  it.effect.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"] as const)(
    "rejects a prototype-named dependency %s against a plain digest record",
    (dependency) =>
      Effect.gen(function*() {
        const failure = yield* withCryptoFailure(
          StepKey.fromKeyMaterial(material({ inputs: [{ _tag: "Ref", from: dependency, path: [] }] }), {})
        )
        expectKeyMaterialError(
          failure,
          "missing_dependency",
          `Missing digest for graph dependency ${dependency}`
        )
      })
  )

  it.effect("rejects an own dependency digest that is not a string", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(
        StepKey.fromKeyMaterial(
          material({ inputs: [{ _tag: "Ref", from: "upstream", path: [] }] }),
          { upstream: 123 } as unknown as Readonly<Record<string, string>>
        )
      )
      expectKeyMaterialError(
        failure,
        "missing_dependency",
        "Digest for graph dependency upstream must be a string"
      )
    }))

  it.effect("rejects an own dependency digest accessor without invoking it", () =>
    Effect.gen(function*() {
      let calls = 0
      const digests = Object.defineProperty({}, "upstream", {
        enumerable: true,
        get: () => {
          calls++
          return "key1_upstream"
        }
      }) as Readonly<Record<string, string>>
      const failure = yield* withCryptoFailure(
        StepKey.fromKeyMaterial(
          material({ inputs: [{ _tag: "Ref", from: "upstream", path: [] }] }),
          digests
        )
      )

      expectKeyMaterialError(
        failure,
        "missing_dependency",
        "Digest for graph dependency upstream must be a data property"
      )
      expect(calls).toBe(0)
    }))

  it.effect("refuses non-content material", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(StepKey.fromKeyMaterial(material({ kind: "irreversible" }), {}))
      expect(failure).toMatchObject({ code: "non_content_material" })
    }))

  it.effect("surfaces a canonicalization failure as a typed schema error", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(
        Effect.asVoid(StepKey.content({ body: 1n, inputs: {}, layers: [], capabilities: {} }))
      )
      expect(failure).toBeDefined()
    }))
})

describe("StepKey.project", () => {
  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"] as const)(
    "does not resolve inherited property %s",
    (property) => {
      expect(StepKey.project({}, [property])).toBeUndefined()
    }
  )

  it("resolves own data properties and array indices", () => {
    expect(StepKey.project({ value: { nested: 1 } }, ["value", "nested"])).toBe(1)
    expect(StepKey.project(["first"], ["0"])).toBe("first")
  })

  it("does not invoke an accessor", () => {
    let reads = 0
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        reads++
        return "revealed"
      }
    })
    expect(StepKey.project(value, ["secret"])).toBeUndefined()
    expect(reads).toBe(0)
  })
})

describe("StepKey.dispatchIdentity", () => {
  const hermetic: NonNullable<StepKey.ContentIdentity["hermetic"]> = {
    readSet: [{ path: "src/a.ts", digest: "sha256:a" }],
    writeSet: ["out/a.js"],
    boundaryMode: "hard"
  }

  const dispatch = (
    overrides: Partial<KeyMaterial.KeyMaterial>,
    results: Readonly<Record<string, unknown>>,
    boundary: typeof hermetic = hermetic
  ) => StepKey.dispatchIdentity({ material: material(overrides), results, hermetic: boundary })

  it.effect("memoizes a projected value digest across concurrent key computations", () =>
    Effect.gen(function*() {
      let digestCalls = 0
      const countingCrypto = Layer.effect(
        Crypto.Crypto,
        Effect.map(Crypto.Crypto, (crypto) =>
          Crypto.Crypto.of({
            ...crypto,
            digest: (algorithm, data) =>
              Effect.sync(() => {
                digestCalls = digestCalls + 1
              }).pipe(Effect.andThen(crypto.digest(algorithm, data)))
          }))
      ).pipe(Layer.provide(NodeCrypto.layer))
      const inputs = [{ _tag: "Ref", from: "upstream", path: ["value"] }] as const
      const options = {
        material: material({ inputs }),
        results: { upstream: { value: { nested: true } } },
        hermetic
      }
      const digestMemo = StepKey.makeDigestMemo()
      const memoized = yield* (
        Effect.all([
          StepKey.dispatchIdentity({ ...options, digestMemo }),
          StepKey.dispatchIdentity({ ...options, digestMemo })
        ], { concurrency: "unbounded" }).pipe(Effect.provide(countingCrypto))
      )
      const unmemoized = yield* withCrypto(StepKey.dispatchIdentity(options))
      // One projected-value digest plus one final key digest per call.
      expect(digestCalls).toBe(3)
      expect(memoized).toEqual([unmemoized, unmemoized])
    }))

  it.effect("evicts an interrupted projected-value computation", () =>
    Effect.gen(function*() {
      const memo = StepKey.makeDigestMemo()
      const started = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<void>()
      const first = yield* Effect.forkChild(
        memo.digest(
          "upstream",
          ["value"],
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(blocked)),
            Effect.as("key1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as StepKey.StepKey)
          )
        )
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(first)

      const recovered = yield* memo.digest(
        "upstream",
        ["value"],
        Effect.succeed("key1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as StepKey.StepKey)
      )
      expect(recovered).toBe("key1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    }).pipe(Effect.provide(NodeCrypto.layer)))

  it.effect("lets a parked waiter replace an interrupted digest leader", () =>
    Effect.gen(function*() {
      const memo = StepKey.makeDigestMemo()
      const leaderStarted = yield* Deferred.make<void>()
      const leaderGate = yield* Deferred.make<void>()
      const waiterAttempted = yield* Deferred.make<void>()
      const leaderKey = "key1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as StepKey.StepKey
      const waiterKey = "key1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as StepKey.StepKey
      const leader = yield* Effect.forkChild(
        memo.digest(
          "upstream",
          ["value"],
          Deferred.succeed(leaderStarted, undefined).pipe(
            Effect.andThen(Deferred.await(leaderGate)),
            Effect.as(leaderKey)
          )
        )
      )
      yield* Deferred.await(leaderStarted)
      const waiter = yield* Effect.forkChild(
        Deferred.succeed(waiterAttempted, undefined).pipe(
          Effect.andThen(memo.digest("upstream", ["value"], Effect.succeed(waiterKey)))
        )
      )
      yield* Deferred.await(waiterAttempted)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(leader)

      expect(yield* Fiber.join(waiter)).toBe(waiterKey)
    }).pipe(Effect.provide(NodeCrypto.layer)))

  it.effect("propagates a leader's typed SchemaError to every parked waiter", () =>
    Effect.gen(function*() {
      const memo = StepKey.makeDigestMemo()
      const schemaError = yield* Effect.flip(Schema.decodeUnknownEffect(Schema.String)(123))
      const leaderStarted = yield* Deferred.make<void>()
      const leaderGate = yield* Deferred.make<void>()
      const leader = yield* Effect.forkChild(
        memo.digest(
          "upstream",
          ["value"],
          Deferred.succeed(leaderStarted, undefined).pipe(
            Effect.andThen(Deferred.await(leaderGate)),
            Effect.andThen(Effect.fail(schemaError))
          )
        )
      )
      yield* Deferred.await(leaderStarted)
      const waiter = yield* Effect.forkChild(
        memo.digest(
          "upstream",
          ["value"],
          Effect.succeed("key1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as StepKey.StepKey)
        )
      )
      yield* Effect.yieldNow
      yield* Deferred.succeed(leaderGate, undefined)

      expect(yield* Effect.flip(Fiber.join(leader))).toBe(schemaError)
      expect(yield* Effect.flip(Fiber.join(waiter))).toBe(schemaError)
    }).pipe(Effect.provide(NodeCrypto.layer)))

  it.effect("separates memo entries by upstream id and projection path", () =>
    Effect.gen(function*() {
      const digestMemo = StepKey.makeDigestMemo()
      const results = {
        alpha: { "a.b": 1, a: { b: 2 } },
        beta: { "a.b": 3, a: { b: 4 } }
      }
      const addresses = [
        { from: "alpha", path: ["a.b"] },
        { from: "alpha", path: ["a", "b"] },
        { from: "alpha", path: [] },
        { from: "beta", path: ["a.b"] },
        { from: "beta", path: ["a", "b"] },
        { from: "beta", path: [] }
      ] as const
      const derive = (address: (typeof addresses)[number], memo?: StepKey.DigestMemo) =>
        StepKey.dispatchIdentity({
          material: material({ inputs: [{ _tag: "Ref", ...address }] }),
          results,
          hermetic,
          ...(memo === undefined ? {} : { digestMemo: memo })
        })
      const memoized = yield* withCrypto(Effect.all(
        addresses.map((address) => derive(address, digestMemo)),
        { concurrency: "unbounded" }
      ))
      // Every concurrent distinct-address request matches an unmemoized derivation.
      for (const [index, address] of addresses.entries()) {
        expect(memoized[index]).toBe(yield* withCrypto(derive(address)))
      }
      expect(new Set(memoized).size).toBe(addresses.length)
      // A repeat request for a settled address shares its memo entry.
      expect(yield* withCrypto(derive(addresses[0]!, digestMemo))).toBe(memoized[0])
    }))

  it.effect("does not reuse a failed memo entry when the address is retried", () =>
    Effect.gen(function*() {
      const memo = StepKey.makeDigestMemo()
      const schemaError = yield* Effect.flip(Schema.decodeUnknownEffect(Schema.String)(123))
      const failure = yield* Effect.flip(memo.digest("upstream", ["value"], Effect.fail(schemaError)))
      expect(failure).toBe(schemaError)

      const recoveredKey = "key1_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as StepKey.StepKey
      let attempts = 0
      const recovered = yield* memo.digest(
        "upstream",
        ["value"],
        Effect.sync(() => {
          attempts = attempts + 1
          return recoveredKey
        })
      )
      expect(recovered).toBe(recoveredKey)
      expect(attempts).toBe(1)

      // A failure at one address leaves other addresses untouched.
      const otherKey = "key1_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as StepKey.StepKey
      expect(yield* memo.digest("upstream", ["other"], Effect.succeed(otherKey))).toBe(otherKey)
    }).pipe(Effect.provide(NodeCrypto.layer)))

  it.effect("folds an engine-resolved environment without moving the absent identity", () =>
    Effect.gen(function*() {
      const absent = yield* withCrypto(dispatch({}, {}))
      const environment: StepKey.EnvironmentIdentity = {
        declared: false,
        layers: ["node-crypto", "workspace"],
        capabilities: { fs: ["read", "write"] },
        runScope: "run-0"
      }
      const present = yield* withCrypto(StepKey.dispatchIdentity({
        material: material(),
        results: {},
        hermetic,
        environment
      }))
      const scoped = yield* withCrypto(StepKey.dispatchIdentity({
        material: material(),
        results: {},
        hermetic,
        environment: { ...environment, runScope: "run-1" }
      }))
      expect(absent).toBe("key1_7ce64818cbad9a440c9e8302693ab565de6b602ee548708d2773a690f8ea610e")
      expect(present).not.toBe(absent)
      expect(scoped).not.toBe(present)
    }))

  it.effect("rejects an undeclared environment without a run scope", () =>
    Effect.gen(function*() {
      const environment = {
        declared: false,
        layers: [],
        capabilities: {}
      } as unknown as StepKey.EnvironmentIdentity
      const failure = yield* withCryptoFailure(StepKey.dispatchIdentity({
        material: material(),
        results: {},
        hermetic,
        environment
      }))
      expectKeyMaterialError(
        failure,
        "invalid_environment",
        "Undeclared environment identity requires a non-empty runScope"
      )
    }))

  it.effect("rejects empty scopes and malformed environments through content", () =>
    Effect.gen(function*() {
      const base = { body: 1, inputs: {}, layers: [], capabilities: {} }
      const empty = yield* withCryptoFailure(StepKey.content({
        ...base,
        environment: {
          declared: false,
          layers: [],
          capabilities: {},
          runScope: ""
        }
      }))
      expectKeyMaterialError(
        empty,
        "invalid_environment",
        "Undeclared environment identity requires a non-empty runScope"
      )

      const malformed = yield* withCryptoFailure(StepKey.content({
        ...base,
        environment: {
          declared: "sometimes",
          layers: [],
          capabilities: {}
        } as unknown as StepKey.EnvironmentIdentity
      }))
      expectKeyMaterialError(
        malformed,
        "invalid_environment",
        "Environment identity requires a boolean declared field"
      )
    }))

  it.effect("rejects a declared environment carrying a run scope", () =>
    Effect.gen(function*() {
      const environment = {
        declared: true,
        layers: [],
        capabilities: {},
        runScope: "run-9"
      } as unknown as StepKey.EnvironmentIdentity
      const failure = yield* withCryptoFailure(StepKey.dispatchIdentity({
        material: material(),
        results: {},
        hermetic,
        environment
      }))
      expectKeyMaterialError(
        failure,
        "invalid_environment",
        "Declared environment identity must not include runScope"
      )
    }))

  it.effect("keys undeclared environments by run scope and accepts a declared environment", () =>
    Effect.gen(function*() {
      const dispatchWith = (environment: StepKey.EnvironmentIdentity) =>
        StepKey.dispatchIdentity({ material: material(), results: {}, hermetic, environment })
      const run1 = yield* withCrypto(dispatchWith({
        declared: false,
        layers: [],
        capabilities: {},
        runScope: "run-1"
      }))
      const run2 = yield* withCrypto(dispatchWith({
        declared: false,
        layers: [],
        capabilities: {},
        runScope: "run-2"
      }))
      const declared = yield* withCrypto(dispatchWith({ declared: true, layers: [], capabilities: {} }))
      expect(run1).not.toBe(run2)
      expect(declared).toMatch(/^key1_[0-9a-f]{64}$/)
    }))

  it.effect("folds declared nondeterminism without moving the absent dispatch key", () =>
    Effect.gen(function*() {
      const deterministic = yield* withCrypto(dispatch({}, {}))
      const nondeterministic = yield* withCrypto(dispatch({ nondeterministic: true }, {}))
      expect(deterministic).toBe("key1_7ce64818cbad9a440c9e8302693ab565de6b602ee548708d2773a690f8ea610e")
      expect(nondeterministic).not.toBe(deterministic)
    }))

  it.effect("folds the settled output value of a `Ref`, never the upstream's identity", () =>
    Effect.gen(function*() {
      // The early cutoff: the derivation is handed the upstream's VALUE and
      // nothing else, so there is no channel through which an upstream body
      // edit that left the output byte-identical could reach this key.
      const inputs = [{ _tag: "Ref", from: "upstream", path: [] }] as const
      const first = yield* withCrypto(dispatch({ inputs }, { upstream: { count: 1 } }))
      const again = yield* withCrypto(dispatch({ inputs }, { upstream: { count: 1 } }))
      const changed = yield* withCrypto(dispatch({ inputs }, { upstream: { count: 2 } }))
      expect(first).toBe(again)
      expect(first).not.toBe(changed)
    }))

  it.effect("projects a `Ref` path, so a sibling field of the upstream result cannot re-key it", () =>
    Effect.gen(function*() {
      const inputs = [{ _tag: "Ref", from: "upstream", path: ["taken"] }] as const
      const base = yield* withCrypto(dispatch({ inputs }, { upstream: { taken: "x", ignored: 1 } }))
      const sibling = yield* withCrypto(dispatch({ inputs }, { upstream: { taken: "x", ignored: 2 } }))
      const projected = yield* withCrypto(dispatch({ inputs }, { upstream: { taken: "y", ignored: 1 } }))
      expect(base).toBe(sibling)
      expect(base).not.toBe(projected)
    }))

  it.effect("digests a projection that walks off the end as a stable, distinct value", () =>
    Effect.gen(function*() {
      const deep = [{ _tag: "Ref", from: "upstream", path: ["a", "b"] }] as const
      const offScalar = yield* withCrypto(dispatch({ inputs: deep }, { upstream: { a: "scalar" } }))
      const offNull = yield* withCrypto(dispatch({ inputs: deep }, { upstream: { a: null } }))
      const offMissing = yield* withCrypto(dispatch({ inputs: deep }, { upstream: {} }))
      const present = yield* withCrypto(dispatch({ inputs: deep }, { upstream: { a: { b: null } } }))
      // Every way of missing is the same absence; an explicit `null` is not it.
      expect(new Set([offScalar, offNull, offMissing]).size).toBe(1)
      expect(present).not.toBe(offScalar)
    }))

  it.effect("keeps a projected reference distinct from the unprojected one", () =>
    Effect.gen(function*() {
      const flat = yield* withCrypto(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: { a: 1 } }))
      const nested = yield* withCrypto(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: ["a"] }] }, { u: { a: 1 } }))
      const bare = yield* withCrypto(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: 1 }))
      expect(nested).not.toBe(bare)
      expect(flat).not.toBe(nested)
    }))

  it.effect("folds nothing but a tag for `Pending`: ordering does not change what a node consumes", () =>
    Effect.gen(function*() {
      const inputs = [{ _tag: "Pending", from: "before" }] as const
      const one = yield* withCrypto(dispatch({ inputs }, { before: { anything: 1 } }))
      const other = yield* withCrypto(dispatch({ inputs }, { before: "completely different" }))
      expect(one).toBe(other)
    }))

  it.effect("keeps a literal that spells a resolved reference distinct from the reference", () =>
    Effect.gen(function*() {
      const reference = yield* withCrypto(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: 1 }))
      const digest = yield* withCrypto(StepKey.content({ body: 0, inputs: { "0": 1 }, layers: [], capabilities: {} }))
      const impostor = yield* withCrypto(
        dispatch({ inputs: [{ _tag: "Literal", value: { kind: "digest", digest, reference: "ref" } }] }, { u: 1 })
      )
      expect(reference).not.toBe(impostor)
    }))

  it.effect("folds the node's own declaration and the measured boundary", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(dispatch({}, {}))
      const body = yield* withCrypto(dispatch({ body: { action: "compile" } }, {}))
      const effects = yield* withCrypto(dispatch({ effects: { net: true } }, {}))
      const placement = yield* withCrypto(dispatch({ placement: "edge" }, {}))
      const layers = yield* withCrypto(dispatch({ layers: ["fs"] }, {}))
      const capabilities = yield* withCrypto(dispatch({ capabilities: ["fs:read"] }, {}))
      const measured = yield* withCrypto(
        dispatch({}, {}, { ...hermetic, readSet: [{ path: "src/a.ts", digest: "sha256:b" }] })
      )
      expect(new Set([base, body, effects, placement, layers, capabilities, measured]).size).toBe(7)
    }))

  it.effect("folds declared removals into the dispatch identity", () =>
    Effect.gen(function*() {
      const base = yield* withCrypto(dispatch({}, {}))
      const removing = yield* withCrypto(dispatch({}, {}, { ...hermetic, removes: ["out/stale.js"] }))
      expect(removing).not.toBe(base)
    }))

  it.effect("refuses material naming a dependency that has not settled", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(dispatch({ inputs: [{ _tag: "Ref", from: "missing", path: [] }] }, {}))
      expectKeyMaterialError(failure, "missing_dependency", "Missing settled result for graph dependency missing")
    }))

  it.effect("refuses an own settled-result accessor without invoking it", () =>
    Effect.gen(function*() {
      let calls = 0
      const results = Object.defineProperty({}, "upstream", {
        enumerable: true,
        get: () => {
          calls++
          return { value: 1 }
        }
      }) as Readonly<Record<string, unknown>>
      const failure = yield* withCryptoFailure(
        dispatch({ inputs: [{ _tag: "Ref", from: "upstream", path: [] }] }, results)
      )

      expectKeyMaterialError(
        failure,
        "missing_dependency",
        "Settled result for graph dependency upstream must be a data property"
      )
      expect(calls).toBe(0)
    }))

  it.effect("refuses non-content material", () =>
    Effect.gen(function*() {
      expect(yield* withCryptoFailure(dispatch({ kind: "irreversible" }, {}))).toMatchObject({
        code: "non_content_material"
      })
    }))

  it.effect("surfaces a canonicalization failure as a typed schema error", () =>
    Effect.gen(function*() {
      const failure = yield* withCryptoFailure(
        Effect.asVoid(dispatch({ inputs: [{ _tag: "Ref", from: "u", path: [] }] }, { u: 1n }))
      )
      expect(failure).toBeDefined()
    }))
})

describe("KeyMaterial.dependencies", () => {
  it("lists graph references once, in declaration order, skipping literals", () => {
    expect(KeyMaterial.dependencies(material({
      inputs: [
        { _tag: "Literal", value: 1 },
        { _tag: "Ref", from: "b", path: [] },
        { _tag: "Pending", from: "a" },
        { _tag: "Ref", from: "b", path: ["x"] }
      ]
    }))).toEqual(["b", "a"])
  })

  it("decodes persisted material without a nondeterminism declaration", () => {
    const decoded = Schema.decodeUnknownResult(KeyMaterial.KeyMaterial)(material())
    expect(decoded._tag).toBe("Success")
    if (decoded._tag === "Success") {
      expect(decoded.success.nondeterministic).toBeUndefined()
    }
  })
})
