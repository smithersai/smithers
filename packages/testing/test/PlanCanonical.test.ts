/**
 * The total canonical rendering behind plan snapshots, and the projection of
 * `@smthrs/flow`'s graph nodes it renders.
 *
 * Key material and diagnostic envelopes can carry values JSON does not name.
 * These cases pin the explicit tags, cycle handling, and small formatting
 * helpers so snapshots stay deterministic instead of throwing or collapsing
 * distinct inputs.
 */
import { Action, Flow } from "@smthrs/flow"
import * as Graph from "@smthrs/flow/Graph"
import * as Node from "@smthrs/plan/Node"
import * as Placement from "@smthrs/plan/Placement"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Plan from "../src/Plan.ts"
import { expectPlan } from "../src/PlanAssertions.ts"
import type { PlanLike } from "../src/PlanLike.ts"

const emptyPlan = (envelope: Record<string, unknown>): PlanLike => ({
  nodes: [],
  edges: [],
  envelope
})

const action = (name: string, tier: "sealed" | "compensable") =>
  Action.make(name, { payload: Schema.Struct({}), success: Schema.String, tier })

describe("Plan canonical rendering", () => {
  it("tags exotic values and terminates cycles", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    // `absent` carries `undefined`: an object property with no value is
    // dropped, while `undefined` inside an array keeps its position as `null`.
    const rendered = Plan.render(emptyPlan({
      absent: undefined,
      bigint: 7n,
      cycle,
      function: () => "not invoked",
      list: [undefined],
      namedSymbol: Symbol("lane"),
      unnamedSymbol: Symbol()
    }))

    expect(rendered).toBe(
      "envelope {\"bigint\":{\"_tag\":\"BigInt\",\"value\":\"7\"},\"cycle\":{\"self\":{\"_tag\":\"Circular\"}},\"function\":{\"_tag\":\"Function\"},\"list\":[null],\"namedSymbol\":{\"_tag\":\"Symbol\",\"value\":\"lane\"},\"unnamedSymbol\":{\"_tag\":\"Symbol\",\"value\":null}}"
    )
  })

  it("renders an edge directly", () => {
    expect(Plan.edge({ from: "prepare", to: "publish" })).toBe("prepare -> publish")
  })

  it("projects a placement without retaining undefined options", () => {
    const graph = Graph.build(
      action("place/remote", "sealed")
        .annotate(Placement.Annotation, Placement.remote({ profile: "reviewer", target: "control-plane" }))
        .call({})
    )
    const projected = Plan.fromGraph(graph, { key: () => "synthetic-key" })
    expect(projected.nodes[0]).toMatchObject({
      key: "synthetic-key",
      placement: {
        tag: "flows/core/Placement/Remote",
        options: { profile: "reviewer", target: "control-plane" }
      }
    })
  })

  it("derives an ordinal key and projects the tier a node is keyed under", () => {
    const graph = Graph.build(action("keyed/compensable", "compensable").call({}))
    const projected = Plan.fromGraph(graph, { runId: "canonical-test" })
    expect(projected.nodes[0]).toMatchObject({
      sealed: false,
      tier: "compensable"
    })
    const anotherRun = Plan.fromGraph(graph, { runId: "another-run" })
    expect(projected.nodes[0]!.key).not.toBe(anotherRun.nodes[0]!.key)
  })

  it("projects no boundary mode for a node whose declaration is the enclosing envelope", () => {
    // The envelope is the caller's ceiling, not the node's own declaration:
    // `Graph.build` checks a declaration against it and records nothing on a
    // node that declared none, so the projection carries no mode and no
    // declared effects for that node.
    const envelope = {
      reads: ["workspace/input"],
      writes: ["workspace/output"],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "compensable"
    } as const
    const inner = action("envelope/inner", "sealed")
    const flow = Flow.make("envelope/flow", {
      payload: Schema.Struct({}),
      success: Schema.String,
      effects: envelope,
      body: () => inner.call({})
    })
    const graph = Graph.build(flow, {})
    const projected = Plan.fromGraph(graph, { key: () => "synthetic-key" })
    const leaf = projected.nodes.find((node) => node.kind === "ActionCall")!
    expect(leaf.effects).toEqual([])
    expect(leaf).not.toHaveProperty("mode")
    Effect.runSync(Effect.gen(function*() {
      const assertions = expectPlan(projected).node(leaf.id)
      yield* assertions.mode(undefined)
      yield* assertions.declaresEffects([])
    }))
  })

  it("refuses a declaration the enclosing envelope does not cover", () => {
    // The other half of the same rule: an envelope that governs nothing would
    // be a ceiling nobody is held to. A declaration outside it is a build
    // refusal, which is where the envelope now lives.
    const outside = action("envelope/outside", "sealed").annotate(Flow.EffectEnvelope, {
      reads: ["workspace/elsewhere"],
      writes: [],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    })
    const flow = Flow.make("envelope/narrow", {
      payload: Schema.Struct({}),
      success: Schema.String,
      effects: { reads: ["workspace/input"], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
      body: () => outside.call({})
    })
    const graph = Graph.build(flow, {})
    expect(Graph.diagnostics(graph).map((diagnostic) => diagnostic.code)).toContain("effect_outside_envelope")
  })

  it("accepts the guide's effect assertion for declared paths", () => {
    const graph = Graph.build(
      action("effects/declared", "sealed")
        .annotate(Flow.EffectsDeclaration, {
          reads: ["workspace/input"],
          writes: ["workspace/output"],
          boundaryMode: "expected"
        })
        .call({})
    )
    const projected = Plan.fromGraph(graph, { key: () => "synthetic-key" })
    const guide = readFileSync(new URL("../docs/guides/assert-a-plan.md", import.meta.url), "utf8")
    const sample = guide.match(/planned\.declaresEffects\("test", (\[[^\]]*\])/)
    expect(sample).not.toBeNull()
    const effects = JSON.parse(sample![1]!) as Array<string>
    Effect.runSync(expectPlan(projected).node(projected.nodes[0]!.id).declaresEffects(effects))
  })

  it("projects a removal beside the writes it behaves like", () => {
    const graph = Graph.build(
      action("effects/removes", "sealed")
        .annotate(Flow.EffectsDeclaration, {
          reads: [],
          writes: ["workspace/output"],
          removes: ["workspace/stale"],
          boundaryMode: "hard"
        })
        .call({})
    )
    const projected = Plan.fromGraph(graph, { key: () => "synthetic-key" })
    expect(projected.nodes[0]).toMatchObject({
      mode: "hard",
      effects: ["remove:workspace/stale", "write:workspace/output"]
    })
  })

  it("renders a declared glob as its canonical form rather than dropping it", () => {
    const graph = Graph.build(
      action("effects/glob", "sealed")
        .annotate(Flow.EffectsDeclaration, {
          reads: [{ _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/**/*.test.ts"] }],
          writes: [],
          boundaryMode: "expected"
        })
        .call({})
    )
    const projected = Plan.fromGraph(graph, { key: () => "synthetic-key" })
    expect(projected.nodes[0]!.effects).toEqual([
      "read:{\"_tag\":\"Glob\",\"exclude\":[\"src/**/*.test.ts\"],\"include\":[\"src/**/*.ts\"]}"
    ])
  })

  it("renders every node with the tier it is keyed under", () => {
    const graph = Graph.build(
      Node.all({
        sealed: action("render/sealed", "sealed").call({}),
        loose: action("render/loose", "compensable").call({})
      })
    )
    const rendered = Plan.render(Plan.fromGraph(graph, { key: () => "synthetic-key" }))
    expect(rendered).toContain("tier=sealed")
    expect(rendered).toContain("tier=compensable")
  })
})
