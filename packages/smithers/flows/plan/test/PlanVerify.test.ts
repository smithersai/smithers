/**
 * `Plan.verify` and the three accessors a store reads it through.
 *
 * These cases used to live beside the store, in `PlanVerification.test.ts`,
 * because the store is what calls them. They need no database at all: verify
 * is a pure function of the plan value, and leaving it covered only from
 * `@smthrs/plan-store` made this package's own public surface depend on
 * another package's suite.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Plan from "../src/Plan.ts"
import { compile, draft } from "../src/test/PlanFixtures.ts"
import { withCrypto } from "./Crypto.ts"

const serialized = (plan: Plan.Plan): Plan.Plan => JSON.parse(JSON.stringify(plan))
const key = `key1_${"0".repeat(64)}`

describe("plan integrity", () => {
  it.effect("verifies ordinary, empty, and multi-generation plans without changing identities", () =>
    withCrypto(
      Effect.gen(function*() {
        const empty = yield* compile([])
        const base = yield* compile([draft("one", { writes: ["out"] }), draft("two", { writes: ["out"] })])
        const first = yield* Plan.append(base, [draft("three", { reads: ["out"] })])
        const second = yield* Plan.append(first, [
          draft("four", { inputs: [{ _tag: "Ref", from: "three", path: [] }] })
        ])
        const fromEmpty = yield* Plan.append(empty, [draft("first", { writes: ["out"] })])
        for (const plan of [empty, base, first, second, fromEmpty]) {
          expect(yield* Plan.verify(plan)).toBe(plan)
          const copy = serialized(plan)
          const checked = yield* Plan.verify(copy)
          expect(checked).toEqual(plan)
          expect(Object.isFrozen(checked)).toBe(true)
          if (copy.nodes.length > 0) {
            Object.assign(copy.nodes[0]!.material, { body: "changed after verification" })
            expect(checked.nodes[0]!.material.body).toEqual(plan.nodes[0]!.material.body)
          }
        }
      })
    ))

  it.effect("rejects forged keys, digests, topology, effects, material and generations", () =>
    withCrypto(
      Effect.gen(function*() {
        const base = yield* compile([draft("a"), draft("b", { inputs: [{ _tag: "Ref", from: "a", path: [] }] })])
        const node = base.nodes[0]!
        const cases: ReadonlyArray<unknown> = [
          undefined,
          null,
          {},
          { nodes: [] },
          { ...base, digest: key, baseDigest: key },
          { ...base, nodes: [{ ...node, key }, base.nodes[1]!] },
          { ...base, nodes: [{ ...node, material: { ...node.material, body: "forged" } }, base.nodes[1]!] },
          {
            ...base,
            nodes: [
              { ...node, material: { ...node.material, effects: { ...node.effects, writes: ["hidden"] } } },
              base.nodes[1]!
            ]
          },
          { ...base, nodes: [{ ...node, dependsOn: ["b"] }, base.nodes[1]!] },
          { ...base, nodes: [{ ...node, effects: { ...node.effects, writes: ["new"] } }, base.nodes[1]!] },
          { ...base, nodes: [{ ...node, priority: 10 }, base.nodes[1]!] },
          { ...base, nodes: [node, node] },
          ...[-1, 1.5, 3, Number.MAX_SAFE_INTEGER + 1].map((generation) => ({ ...base, generation })),
          { ...base, generation: 1 },
          { ...base, nodes: [{ ...node, generation: -1 }] },
          { ...base, generation: 2, nodes: [{ ...node, generation: 2 }, base.nodes[1]!] },
          { ...base, generation: 1, nodes: [{ ...node, generation: 1 }, base.nodes[1]!] },
          {
            ...base,
            generation: 1,
            nodes: [{ ...node, material: { ...node.material, inputs: [{ _tag: "Ref", from: "b", path: [] }] } }, {
              ...base.nodes[1]!,
              generation: 1
            }]
          },
          {
            ...base,
            nodes: [{ ...node, material: { ...node.material, inputs: [{ _tag: "Ref", from: "missing", path: [] }] } }]
          },
          {
            ...base,
            nodes: [
              { ...node, material: { ...node.material, inputs: [{ _tag: "Ref", from: "b", path: [] }] } },
              base.nodes[1]!
            ]
          },
          { nodes: Array.from({ length: Plan.maximumPlanNodes + 1 }, () => node) }
        ]
        for (const candidate of cases) {
          const result = yield* Effect.exit(Plan.verify(candidate))
          expect(result._tag).toBe("Failure")
        }
      })
    ))

  it.effect("names the newest generation's nodes, and only those", () =>
    withCrypto(
      Effect.gen(function*() {
        const base = yield* compile([draft("one"), draft("two")])
        expect(Plan.generationNodes(base).map((node) => node.id)).toEqual(["one", "two"])
        const grown = yield* Plan.append(base, [draft("three")])
        expect(Plan.generationNodes(grown).map((node) => node.id)).toEqual(["three"])
      })
    ))

  it.effect("recognises a compiler-owned snapshot and nothing else", () =>
    withCrypto(
      Effect.gen(function*() {
        const plan = yield* compile([draft("one")])
        expect(Plan.isVerified(plan)).toBe(true)
        expect(Plan.isVerified(serialized(plan))).toBe(false)
        for (const candidate of [undefined, null, 0, "plan", {}]) {
          expect(Plan.isVerified(candidate), String(candidate)).toBe(false)
        }
      })
    ))

  it.effect("derives the prefix digest a stored envelope is matched against", () =>
    withCrypto(
      Effect.gen(function*() {
        const base = yield* compile([draft("one")])
        const grown = yield* Plan.append(base, [draft("two")])
        // The prefix of generation 1 is generation 0, so its digest is the
        // digest the plan carried before the append: what a compare-and-swap
        // matches the stored row against.
        expect(yield* Plan.prefixDigest(grown)).toEqual(base.digest)
        // Generation 0 has no prefix, so the digest is the empty plan's.
        const empty = yield* compile([], base.planId)
        expect(yield* Plan.prefixDigest(base)).toEqual(empty.digest)
      })
    ))
})
