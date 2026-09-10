import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { FastCheck } from "effect/testing"
import * as KeyMaterial from "../src/KeyMaterial.ts"
import * as StepKey from "../src/StepKey.ts"
import { withCrypto } from "./Crypto.ts"
import { params as sharedParams } from "./FastCheckParams.ts"

const params = sharedParams(100)

/** Path segments biased toward prototype-chain keys and serialization hazards. */
const hostileSegment = FastCheck.oneof(
  FastCheck.constantFrom(
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "length",
    "0",
    "1",
    ""
  ),
  FastCheck.string({ unit: "binary", maxLength: 6 })
)

const hostilePath = FastCheck.array(hostileSegment, { maxLength: 5 })

/** Arbitrary values including non-JSON shapes (undefined, sparse objects). */
const anyValue = FastCheck.oneof(FastCheck.jsonValue({ stringUnit: "binary" }), FastCheck.anything())

/** JSON restricted to well-formed strings, so canonicalization always succeeds. */
const cleanJson = FastCheck.jsonValue({ stringUnit: "grapheme" })

const cleanString = FastCheck.string({ unit: "grapheme", maxLength: 6 })

/** A content identity whose inputs are all literals, so it survives structuredClone. */
const literalIdentity = FastCheck.record({
  body: cleanJson,
  inputs: FastCheck.dictionary(cleanString, cleanJson, { maxKeys: 3 }),
  layers: FastCheck.array(cleanString, { maxLength: 4 }),
  capabilities: FastCheck.dictionary(cleanString, FastCheck.array(cleanString, { maxLength: 3 }), { maxKeys: 3 })
})

const sealed = (overrides: Partial<KeyMaterial.KeyMaterial> = {}): KeyMaterial.KeyMaterial => ({
  version: KeyMaterial.version,
  kind: "sealed",
  body: { action: "render" },
  inputs: [],
  layers: [],
  capabilities: [],
  ...overrides
})

describe("StepKey.project properties", () => {
  // Pinned counterexample corpus; runs before random inputs, forever.
  const projectCorpus: Array<[unknown, Array<string>, unknown]> = [
    [{}, ["__proto__", "constructor"], undefined],
    [Object.create(null), ["toString"], undefined],
    [[0], ["0", "valueOf", "length"], undefined],
    [null, [""], undefined],
    ["text", ["length"], undefined],
    [{ a: undefined }, ["a", "b"], undefined],
    [{ own: { value: 1 } }, ["own", "value"], 1],
    [["first"], ["0"], "first"]
  ]

  it("pins adversarial paths to explicit values", () => {
    for (const [value, path, expected] of projectCorpus) {
      expect(StepKey.project(value, path)).toBe(expected)
    }
  })

  it("is total and stable: any value with any hostile path yields the same value or undefined, never a throw", () => {
    FastCheck.assert(
      FastCheck.property(anyValue, hostilePath, (value, path) => {
        const first = StepKey.project(value, path)
        const second = StepKey.project(value, path)
        expect(Object.is(first, second)).toBe(true)
      }),
      { ...params, examples: projectCorpus.map(([value, path]) => [value, path]) }
    )
  })

  it("projects the empty path as identity and concatenated paths compose", () => {
    FastCheck.assert(
      FastCheck.property(anyValue, hostilePath, hostilePath, (value, first, second) => {
        expect(Object.is(StepKey.project(value, []), value)).toBe(true)
        const direct = StepKey.project(value, [...first, ...second])
        const staged = StepKey.project(StepKey.project(value, first), second)
        expect(Object.is(direct, staged)).toBe(true)
      }),
      params
    )
  })
})

describe("StepKey.content properties", () => {
  it.effect.prop(
    "is total on hostile JSON: every outcome is a key or a typed SchemaError, never a defect",
    [FastCheck.jsonValue({ stringUnit: "binary" })],
    ([body]) =>
      Effect.gen(function*() {
        // A defect would fail the property; a lone surrogate must surface as
        // the typed canonicalization error.
        const outcome = yield* withCrypto(
          StepKey.content({ body, inputs: { hostile: body }, layers: [], capabilities: {} }).pipe(
            Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "key" })
          )
        )
        expect(outcome === "key" || outcome === "SchemaError").toBe(true)
      }),
    { fastCheck: { ...params, examples: [[{ "\uD800": "\uDFFF" }], ["\uD800"], [{ "": null }]] } }
  )

  it.effect.prop(
    "keys structure, not identity: rehashing and a structural clone are byte-identical",
    [literalIdentity],
    ([identity]) =>
      Effect.gen(function*() {
        const first = yield* withCrypto(StepKey.content(identity))
        const again = yield* withCrypto(StepKey.content(identity))
        const cloned = yield* withCrypto(StepKey.content(structuredClone(identity)))
        expect(first).toMatch(/^key1_[0-9a-f]{64}$/)
        expect(again).toBe(first)
        expect(cloned).toBe(first)
      }),
    { fastCheck: params }
  )

  it.effect.prop(
    "hashes layers and capability patterns as NFC-normalized sets: order, duplication, and composed form never re-key",
    [
      FastCheck.array(cleanString, { maxLength: 4 }),
      FastCheck.array(cleanString, { maxLength: 4 })
    ],
    ([layers, patterns]) =>
      Effect.gen(function*() {
        const canonical = yield* withCrypto(
          StepKey.content({ body: 0, inputs: {}, layers, capabilities: { fs: patterns } })
        )
        const scrambled = yield* withCrypto(
          StepKey.content({
            body: 0,
            inputs: {},
            layers: [...layers].reverse().concat(layers).map((layer) => layer.normalize("NFD")),
            capabilities: {
              fs: [...patterns].reverse().concat(patterns).map((pattern) => pattern.normalize("NFD"))
            }
          })
        )
        expect(scrambled).toBe(canonical)
      }),
    { fastCheck: { ...params, examples: [[["é", "é"], []]] } }
  )

  it.effect.prop(
    "never lets a literal spelling of any digest-reference shape collide with the branded input",
    [
      FastCheck.string({ unit: "grapheme", maxLength: 12 }),
      FastCheck.constantFrom("none", "ref", "pending", "ref-projected"),
      FastCheck.array(cleanString, { maxLength: 3 })
    ],
    ([value, kind, path]) =>
      Effect.gen(function*() {
        const reference = kind === "none"
          ? undefined
          : kind === "ref-projected"
          ? { reference: kind, path }
          : { reference: kind }
        const branded = yield* withCrypto(
          StepKey.content({
            body: 0,
            inputs: { input: StepKey.digestInput(value, reference) },
            layers: [],
            capabilities: {}
          })
        )
        const impostor = yield* withCrypto(
          StepKey.content({
            body: 0,
            inputs: {
              input: {
                kind: "digest",
                digest: value,
                ...(reference === undefined ? {} : { reference: reference.reference }),
                ...(kind === "ref-projected" ? { path } : {})
              }
            },
            layers: [],
            capabilities: {}
          })
        )
        expect(impostor).not.toBe(branded)
      }),
    { fastCheck: params }
  )

  it.effect.prop(
    "keys every reference variant of one digest distinctly",
    [
      FastCheck.string({ unit: "grapheme", maxLength: 12 }),
      FastCheck.array(cleanString, { maxLength: 3 })
    ],
    ([value, path]) =>
      Effect.gen(function*() {
        const keyOf = (input: unknown) =>
          withCrypto(StepKey.content({ body: 0, inputs: { input }, layers: [], capabilities: {} }))
        const keys = yield* Effect.all([
          keyOf(StepKey.digestInput(value)),
          keyOf(StepKey.digestInput(value, { reference: "ref" })),
          keyOf(StepKey.digestInput(value, { reference: "pending" })),
          keyOf(StepKey.digestInput(value, { reference: "ref-projected", path })),
          keyOf({ digest: value })
        ], { concurrency: "unbounded" })
        expect(new Set(keys).size).toBe(keys.length)
      }),
    { fastCheck: params }
  )
})

describe("StepKey.fromKeyMaterial properties", () => {
  const materialArb = Schema.toArbitrary(KeyMaterial.KeyMaterial)(FastCheck)

  it.effect.prop(
    "is deterministic over the whole material schema: equal material yields equal keys or equal typed errors",
    [materialArb],
    ([material]) =>
      Effect.gen(function*() {
        const digests = Object.fromEntries(
          KeyMaterial.dependencies(material).map((name) => [name, `key1_${name}`])
        )
        const observe = withCrypto(
          StepKey.fromKeyMaterial(material, digests).pipe(
            Effect.match({
              onFailure: (error) => (error instanceof StepKey.KeyMaterialError ? `error:${error.code}` : error._tag),
              onSuccess: (key) => `key:${key}`
            })
          )
        )
        expect(yield* observe).toBe(yield* observe)
      }),
    { fastCheck: params }
  )
})

describe("StepKey.dispatchIdentity properties", () => {
  const hermetic: NonNullable<StepKey.ContentIdentity["hermetic"]> = {
    readSet: [],
    writeSet: [],
    boundaryMode: "hard"
  }

  const dispatch = (path: ReadonlyArray<string>, results: Readonly<Record<string, unknown>>) =>
    StepKey.dispatchIdentity({
      material: sealed({ inputs: [{ _tag: "Ref", from: "up", path: [...path] }] }),
      results,
      hermetic
    })

  it.effect.prop(
    "keys on the projected settled value: a structural clone of the results is byte-identical",
    [FastCheck.array(cleanString, { maxLength: 3 }), cleanJson],
    ([path, settled]) =>
      Effect.gen(function*() {
        const results = { up: settled }
        const first = yield* withCrypto(dispatch(path, results))
        const cloned = yield* withCrypto(dispatch(path, structuredClone(results)))
        expect(first).toMatch(/^key1_[0-9a-f]{64}$/)
        expect(cloned).toBe(first)
      }),
    { fastCheck: params }
  )

  it.effect.prop(
    "keys distinct projected values distinctly",
    [FastCheck.tuple(FastCheck.integer(), FastCheck.integer()).filter(([left, right]) => left !== right)],
    ([[left, right]]) =>
      Effect.gen(function*() {
        const first = yield* withCrypto(dispatch([], { up: left }))
        const second = yield* withCrypto(dispatch([], { up: right }))
        expect(first).not.toBe(second)
      }),
    { fastCheck: params }
  )
})
