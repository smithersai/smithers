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
import * as Schema from "effect/Schema"
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

  it.effect("rejects malformed plan shapes with schema errors", () =>
    withCrypto(Effect.gen(function*() {
      const base = yield* compile([draft("a")])
      for (
        const candidate of [
          undefined,
          null,
          {},
          { nodes: [] },
          ...[1.5, Number.MAX_SAFE_INTEGER + 1].map((generation) => ({ ...base, generation }))
        ]
      ) {
        const error = yield* Effect.flip(Plan.verify(candidate))
        expect(error).toBeInstanceOf(Schema.SchemaError)
      }
    })))

  it.effect("rejects each forged field with its specific typed integrity error", () =>
    withCrypto(Effect.gen(function*() {
      const base = yield* compile([draft("a"), draft("b", { inputs: [{ _tag: "Ref", from: "a", path: [] }] })])
      const grown = yield* Plan.append(base, [draft("c")])
      const node = base.nodes[0]!
      const replaceFirst = (changed: Plan.PlanNode): Plan.Plan => ({
        ...base,
        nodes: [changed, base.nodes[1]!]
      })
      const digestMessage = "Plan approval digest does not match its compiled content"
      const nodesMessage = "Plan nodes do not match their compiled keys, effects, ordering, or generations"
      const cases: ReadonlyArray<{
        readonly field: string
        readonly candidate: unknown
        readonly code: Plan.PlanError["code"]
        readonly message: string
      }> = [
        { field: "digest", candidate: { ...base, digest: key }, code: "invalid_plan", message: digestMessage },
        { field: "baseDigest", candidate: { ...base, baseDigest: key }, code: "invalid_plan", message: digestMessage },
        {
          field: "node key",
          candidate: replaceFirst({ ...node, key: key as typeof node.key }),
          code: "invalid_plan",
          message: nodesMessage
        },
        {
          field: "material body",
          candidate: replaceFirst({ ...node, material: { ...node.material, body: "forged" } }),
          code: "invalid_plan",
          message: digestMessage
        },
        {
          field: "material effects",
          candidate: replaceFirst({
            ...node,
            material: { ...node.material, effects: { ...node.effects, writes: ["hidden"] } }
          }),
          code: "invalid_plan",
          message: nodesMessage
        },
        {
          field: "dependsOn",
          candidate: replaceFirst({ ...node, dependsOn: ["b"] }),
          code: "invalid_plan",
          message: nodesMessage
        },
        {
          field: "effects",
          candidate: replaceFirst({ ...node, effects: { ...node.effects, writes: ["new"] } }),
          code: "invalid_plan",
          message: digestMessage
        },
        {
          field: "priority",
          candidate: replaceFirst({ ...node, priority: 10 }),
          code: "invalid_plan",
          message: digestMessage
        },
        {
          field: "duplicate id",
          candidate: { ...base, nodes: [node, { ...base.nodes[1]!, id: "a" }] },
          code: "duplicate_node",
          message: "Node a is already in the plan"
        },
        ...[-1, 3].map((generation) => ({
          field: `plan generation ${generation}`,
          candidate: { ...base, generation },
          code: "invalid_plan" as const,
          message: "Plan generation must be a non-negative safe integer with a nonempty appended generation"
        })),
        {
          field: "newest generation",
          candidate: { ...base, generation: 1 },
          code: "invalid_plan",
          message: "Plan generation does not match its newest nodes"
        },
        ...[-1, 2].map((generation) => ({
          field: `node generation ${generation}`,
          candidate: replaceFirst({ ...node, generation }),
          code: "invalid_plan" as const,
          message: "Node a has an invalid or out-of-order generation"
        })),
        {
          field: "future generation reference",
          candidate: {
            ...grown,
            nodes: [
              { ...node, material: { ...node.material, inputs: [{ _tag: "Ref", from: "c", path: [] }] } },
              ...grown.nodes.slice(1)
            ]
          },
          code: "invalid_plan",
          message: "Node a refers to a future generation"
        },
        {
          field: "unknown material reference",
          candidate: replaceFirst({
            ...node,
            material: { ...node.material, inputs: [{ _tag: "Ref", from: "missing", path: [] }] }
          }),
          code: "unknown_dependency",
          message: "Node a depends on unknown node missing"
        },
        {
          field: "cyclic material reference",
          candidate: replaceFirst({
            ...node,
            material: { ...node.material, inputs: [{ _tag: "Ref", from: "b", path: [] }] }
          }),
          code: "cycle",
          message: "Plan cycle through node a"
        },
        {
          field: "node count",
          candidate: { ...base, nodes: Array.from({ length: Plan.maximumPlanNodes + 1 }, () => node) },
          code: "graph_too_large",
          message: `A plan may contain at most ${Plan.maximumPlanNodes} nodes, received ${Plan.maximumPlanNodes + 1}`
        }
      ]
      // Every starting plan is valid. Each specimen alters one field and
      // preserves all unrelated rows, so its diagnostic identifies that check.
      expect(yield* Plan.verify(serialized(base))).toEqual(base)
      expect(yield* Plan.verify(serialized(grown))).toEqual(grown)
      for (const { field, candidate, code, message } of cases) {
        const error = yield* Effect.flip(Plan.verify(candidate))
        expect(error, field).toBeInstanceOf(Plan.PlanError)
        expect(error, field).toMatchObject({ code, message })
      }
    })))

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
