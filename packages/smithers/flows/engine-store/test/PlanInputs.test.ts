import { describe, expect, it } from "@effect/vitest"
import { FileSet, KeyMaterial, Plan } from "@smthrs/plan"
import { Effect } from "effect"
import * as PlanInputs from "../src/internal/PlanInputs.vibe"
import type * as PlanInputStore from "../src/PlanInputStore.vibe"
import { withCrypto } from "./Sha256.ts"

const compile = (reads: Plan.NodeEffects["reads"]) =>
  Plan.compile({
    planId: "input-validation",
    flow: "example/InputValidation",
    nodes: [{
      id: "reader",
      material: { version: KeyMaterial.version, kind: "sealed", body: null, inputs: [], layers: [], capabilities: [] },
      effects: { reads, writes: [], boundaryMode: "hard" }
    }]
  })
const snapshot = (plan: Plan.Plan): PlanInputStore.Snapshot => ({
  version: 1,
  generation: 0,
  nodes: plan.nodes.map((node) => ({
    id: node.id,
    key: node.key,
    reads: FileSet.expandReads(node.effects.reads).map((entry) => ({ entry, sourcePaths: ["config"] }))
  })),
  pins: [{ path: "config", digest: "first" }]
})

describe("plan input validation", () => {
  it.effect("keeps prior pins and validates new exact and glob source membership without mutation", () =>
    withCrypto(Effect.gen(function*() {
      const plan = yield* compile(["config", { _tag: "Glob", include: ["**"] }])
      const old = new Map([["prior", "prior-digest"]])
      const next = yield* PlanInputs.validate(snapshot(plan), plan.nodes, old, () => ["unrelated"])
      expect(next).toEqual(new Map([["prior", "prior-digest"], ["config", "first"]]))
      expect(old).toEqual(new Map([["prior", "prior-digest"]]))
      const reused = yield* PlanInputs.validate({ ...snapshot(plan), pins: [] }, plan.nodes, next, () => [])
      expect(reused).toEqual(next)
    })))

  it.effect("accepts produced reads without source pins and nodes without reads", () =>
    withCrypto(Effect.gen(function*() {
      const plan = yield* compile(["config"])
      const observed = snapshot(plan)
      const produced = {
        ...observed,
        pins: [],
        nodes: [{ ...observed.nodes[0]!, reads: [{ entry: "config", sourcePaths: [] }] }]
      }
      expect(yield* PlanInputs.validate(produced, plan.nodes, new Map(), () => ["config"])).toEqual(new Map())
      const empty = yield* compile([])
      expect(yield* PlanInputs.validate({ ...snapshot(empty), pins: [] }, empty.nodes, new Map(), () => [])).toEqual(
        new Map()
      )
    })))

  it.effect("rejects mismatched plans, missing pins, version changes and unused or replaced pins", () =>
    withCrypto(Effect.gen(function*() {
      const plan = yield* compile(["config"])
      const base = snapshot(plan)
      const node = base.nodes[0]!
      const invalid: Array<PlanInputStore.Snapshot> = [
        { ...base, nodes: [] },
        { ...base, nodes: [{ ...node, id: "other" }] },
        { ...base, nodes: [{ ...node, key: "other" }] },
        { ...base, nodes: [{ ...node, reads: [] }] },
        { ...base, nodes: [{ ...node, reads: [{ entry: "other", sourcePaths: [] }] }] },
        { ...base, nodes: [{ ...node, reads: [{ entry: "config", sourcePaths: [] }] }] },
        { ...base, pins: [] },
        { ...base, pins: [...base.pins, { path: "unreferenced", digest: "extra" }] }
      ]
      for (const observed of invalid) {
        expect(yield* Effect.flip(PlanInputs.validate(observed, plan.nodes, new Map(), () => []))).toMatchObject({
          code: "corrupt_state"
        })
      }
      expect(yield* Effect.flip(PlanInputs.validate(base, plan.nodes, new Map([["config", "old"]]), () => [])))
        .toMatchObject({ code: "corrupt_state" })
      expect(yield* Effect.flip(PlanInputs.validate(base, plan.nodes, new Map(), () => ["config"]))).toMatchObject({
        code: "corrupt_state"
      })
      const glob = yield* compile([{ _tag: "Glob", include: ["**"] }])
      expect(yield* Effect.flip(PlanInputs.validate(snapshot(glob), glob.nodes, new Map(), () => ["config"])))
        .toMatchObject({ code: "corrupt_state" })
    })))
})
