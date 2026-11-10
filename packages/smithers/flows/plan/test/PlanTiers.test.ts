import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as KeyMaterial from "../src/KeyMaterial.vibe"
import * as Plan from "../src/Plan.vibe"
import * as StepKey from "../src/StepKey.vibe"
import { withCrypto } from "./Crypto.ts"

const draft = (
  id: string,
  kind: KeyMaterial.KeyMaterial["kind"],
  inputs: ReadonlyArray<KeyMaterial.InputRef> = []
): Plan.NodeDraft => ({
  id,
  material: { version: KeyMaterial.version, kind, body: { operation: "write" }, inputs, layers: [], capabilities: [] },
  effects: { reads: [], writes: ["shared.txt"], boundaryMode: "hard" }
})
const compile = (nodes: ReadonlyArray<Plan.NodeDraft>) => Plan.compile({ planId: "tiers", flow: "tiers", nodes })

describe("plan identity is independent of cache eligibility", () => {
  for (const tier of ["sealed", "compensable", "irreversible"] as const) {
    it.effect(`compiles and verifies ${tier} without weakening effect ordering`, () =>
      Effect.gen(function*() {
        const plan = yield* compile([draft("a", tier), draft("b", tier)])
        expect(plan.nodes[1]!.dependsOn).toEqual(["a"])
        expect(plan.nodes.map((node) => node.material.kind)).toEqual([tier, tier])
        expect(yield* Plan.verify(JSON.parse(JSON.stringify(plan)))).toEqual(plan)
        const grown = yield* Plan.append(plan, [draft("c", tier, [{ _tag: "Pending", from: "b" }])])
        expect(grown.nodes.slice(0, 2)).toEqual(plan.nodes)
        expect(yield* Plan.verify(JSON.parse(JSON.stringify(grown)))).toEqual(grown)
      }).pipe(withCrypto))

    it.effect(`${tier} fingerprints preserve input tags and canonical set normalization`, () =>
      Effect.gen(function*() {
        const material = draft("node", tier).material
        const a = yield* StepKey.planIdentity({
          ...material,
          layers: ["b", "a", "a"],
          capabilities: ["net", "fs", "net"]
        }, {})
        const b = yield* StepKey.planIdentity({ ...material, layers: ["a", "b"], capabilities: ["fs", "net"] }, {})
        expect(a).toBe(b)
        const inputs: ReadonlyArray<KeyMaterial.InputRef> = [
          { _tag: "Literal", value: { digest: "dependency" } },
          { _tag: "Pending", from: "upstream" },
          { _tag: "Ref", from: "upstream", path: [] },
          { _tag: "Ref", from: "upstream", path: ["field"] }
        ]
        const keys = yield* Effect.forEach(inputs, (input) =>
          StepKey.planIdentity({ ...material, inputs: [input] }, { upstream: "dependency" }))
        expect(new Set(keys).size).toBe(inputs.length)
      }).pipe(withCrypto))

    it.effect(`${tier} rejects unsafe dependency maps without invoking getters`, () =>
      Effect.gen(function*() {
        const material = draft("node", tier, [{ _tag: "Ref", from: "upstream", path: [] }]).material
        let reads = 0
        const accessor = Object.defineProperty({}, "upstream", {
          get: () => {
            reads++
            return "dependency"
          }
        })
        for (const dependencies of [{}, Object.create({ upstream: "dependency" }), accessor, { upstream: 42 }]) {
          expect(yield* Effect.flip(StepKey.planIdentity(material, dependencies))).toMatchObject({
            code: "missing_dependency"
          })
        }
        expect(reads).toBe(0)
      }).pipe(withCrypto))
  }

  it.effect("keeps sealed keys unchanged and distinguishes all tier fingerprints", () =>
    Effect.gen(function*() {
      const keys: Array<string> = []
      for (const tier of ["sealed", "compensable", "irreversible"] as const) {
        const plan = yield* compile([draft("node", tier)])
        const node = plan.nodes[0]!
        keys.push(node.key)
        if (tier === "sealed") {
          expect(node.key).toBe(yield* StepKey.fromKeyMaterial(node.material, {}))
        } else {
          const error = yield* Effect.flip(StepKey.fromKeyMaterial(node.material, {}))
          expect(error).toMatchObject({ code: "non_content_material" })
        }
      }
      expect(new Set(keys).size).toBe(3)
    }).pipe(withCrypto))

  it.effect("rekeys a mixed-tier downstream declaration when an upstream declaration changes", () =>
    Effect.gen(function*() {
      const first = draft("first", "irreversible")
      const second = draft("second", "sealed", [{ _tag: "Ref", from: "first", path: ["id"] }])
      const original = yield* compile([first, second])
      const changed = yield* compile([
        { ...first, material: { ...first.material, body: { operation: "write-v2" } } },
        second
      ])
      expect(changed.nodes[0]!.key).not.toBe(original.nodes[0]!.key)
      expect(changed.nodes[1]!.key).not.toBe(original.nodes[1]!.key)
    }).pipe(withCrypto))
})
