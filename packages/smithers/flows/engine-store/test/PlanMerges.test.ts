import { describe, expect, it } from "@effect/vitest"
import { KeyMaterial, Plan } from "@smthrs/plan"
import { Effect } from "effect"
import * as Merges from "../src/internal/PlanMerges.vibe"
import type * as MergeStore from "../src/PlanMergeStore.vibe"
import { withCrypto } from "./Sha256.ts"

const fixture = Effect.gen(function*() {
  const base = yield* Plan.compile({
    planId: "recovery-plan",
    flow: "test/Recovery",
    nodes: ["a", "b"].map((id) => ({
      id,
      material: { version: KeyMaterial.version, kind: "sealed", body: id, inputs: [], layers: [], capabilities: [] },
      effects: { reads: [], writes: ["shared"], boundaryMode: "hard" },
      ...(id === "b" ? { conflictStrategy: "lane" as const, runtimeStrategy: "stop-merge" as const } : {})
    }))
  })
  const node = base.nodes.find((node) => node.id === "b")!
  const intent: MergeStore.Intent = {
    version: 1,
    nodeId: node.id,
    nodeKey: node.key,
    dispatchKey: "dispatch",
    attempts: 1,
    rebases: 0,
    peers: ["a"]
  }
  const grown = yield* Plan.append(base, [Merges.draft(node, "b+merge", ["a"])])
  const completion: MergeStore.Completion = {
    version: 1,
    generation: 1,
    parentDigest: base.digest,
    planDigest: grown.digest,
    mergeId: "b+merge",
    mergeKey: Plan.generationNodes(grown)[0]!.key,
    winners: ["a"]
  }
  return { base, node, intent, grown, completion }
})

describe("durable merge reconstruction", () => {
  it.effect("reconstructs the identical graph from the approved base or loaded extension", () =>
    withCrypto(Effect.gen(function*() {
      const { base, intent, grown, completion } = yield* fixture
      expect(yield* Merges.recover(base, [])).toBe(base)
      expect(yield* Merges.recover(base, [{ intent }])).toBe(base)
      for (const candidate of [base, grown]) {
        const recovered = yield* Merges.recover(candidate, [{ intent, completion }])
        expect(recovered).toEqual(grown)
        expect(yield* Plan.verify(recovered)).toEqual(grown)
      }
    })))

  it.effect("preserves approved intervening generations without inventing missing work", () =>
    withCrypto(Effect.gen(function*() {
      const { base, node, intent } = yield* fixture
      const intervening = yield* Plan.append(base, [{
        id: "approved-extra",
        material: {
          version: KeyMaterial.version,
          kind: "sealed",
          body: "extra",
          inputs: [],
          layers: [],
          capabilities: []
        },
        effects: { reads: [], writes: ["other"], boundaryMode: "hard" },
        priority: 7
      }])
      const grown = yield* Plan.append(intervening, [Merges.draft(node, "b+merge", ["a"])])
      const completion: MergeStore.Completion = {
        version: 1,
        generation: 2,
        parentDigest: intervening.digest,
        planDigest: grown.digest,
        mergeId: "b+merge",
        mergeKey: Plan.generationNodes(grown)[0]!.key,
        winners: ["a"]
      }
      expect(yield* Merges.recover(intervening, [{ intent, completion }])).toEqual(grown)
      expect(yield* Merges.recover(grown, [{ intent, completion }])).toEqual(grown)
      expect(yield* Effect.flip(Merges.recover(base, [{ intent, completion }]))).toMatchObject({
        code: "corrupt_state",
        message: "merge recovery requires the approved intervening plan generations"
      })
    })))

  it.effect("refuses incompatible parent, generated identity and supplied plan digests", () =>
    withCrypto(Effect.gen(function*() {
      const { base, intent, grown, completion } = yield* fixture
      for (
        const changed of [{ ...completion, parentDigest: "wrong" }, { ...completion, planDigest: "wrong" }, {
          ...completion,
          mergeKey: "wrong"
        }, { ...completion, mergeId: "a" }]
      ) {
        expect(yield* Effect.flip(Merges.recover(base, [{ intent, completion: changed }]))).toMatchObject({
          code: "corrupt_state"
        })
      }
      const changed = { ...grown, digest: base.digest }
      expect(yield* Effect.flip(Merges.recover(changed, [{ intent, completion }]))).toMatchObject({
        code: "corrupt_state",
        message: "merge decisions disagree with the supplied plan"
      })
    })))

  it.effect("refuses corrupt approved bases and generation bounds before elaboration", () =>
    withCrypto(Effect.gen(function*() {
      const { base, intent, completion } = yield* fixture
      expect(
        yield* Effect.flip(Merges.recover({ ...base, baseDigest: completion.planDigest as Plan.Plan["baseDigest"] }, [
          { intent, completion }
        ]))
      ).toMatchObject({ code: "corrupt_state", message: "merge recovery has an invalid approved base" })
      expect(
        yield* Effect.flip(Merges.recover(base, [{
          intent,
          completion: {
            ...completion,
            generation: Plan.maximumPlanNodes + 1
          }
        }]))
      ).toMatchObject({ code: "corrupt_state", message: "merge generation exceeds the plan limit" })
    })))

  it.effect("refuses intents that change node identity, tier, strategy or conflict cohort", () =>
    withCrypto(Effect.gen(function*() {
      const { base, intent, node } = yield* fixture
      for (
        const changed of [{ ...intent, nodeId: "missing" }, { ...intent, nodeKey: "wrong" }, {
          ...intent,
          peers: ["outsider"]
        }]
      ) {
        expect(yield* Effect.flip(Merges.recover(base, [{ intent: changed }]))).toMatchObject({ code: "corrupt_state" })
      }
      for (
        const changed of [
          { ...node, material: { ...node.material, kind: "irreversible" as const } },
          { ...node, runtime: "delay-rebase" as const, conflicts: [] }
        ]
      ) {
        expect(
          yield* Effect.flip(Merges.validateIntent({
            ...base,
            nodes: base.nodes.map((item) => item.id === node.id ? changed : item)
          }, intent))
        )
          .toMatchObject({ code: "corrupt_state" })
      }
      // A peer's stop-merge conflict can authorize the strategy even when the
      // node's own default runtime policy is delay-rebase.
      const peerStrategy = {
        ...node,
        runtime: "delay-rebase" as const,
        conflicts: node.conflicts.map((item) => ({ ...item, runtime: "stop-merge" as const }))
      }
      expect(yield* Merges.validateIntent({ ...base, nodes: [peerStrategy] }, { ...intent, peers: [] })).toEqual(
        peerStrategy
      )
    })))

  it.effect("allocates deterministic free IDs through multiple user-name collisions", () =>
    withCrypto(Effect.gen(function*() {
      const { base, node } = yield* fixture
      expect(Merges.allocateId(base, "b")).toBe("b+merge")
      const occupied = {
        ...base,
        nodes: [...base.nodes, ...["b+merge", "b+merge#1", "b+merge#2"].map((id) => ({ ...node, id }))]
      }
      expect(Merges.allocateId(occupied, "b")).toBe("b+merge#3")
    })))
})
