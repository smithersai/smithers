import { describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { expect } from "vitest"
import * as Plan from "../src/Plan.ts"
import { expectKeyGoldens, expectPlan, expectPlans, expectPure } from "../src/PlanAssertions.ts"
import type { PlanLike } from "../src/PlanLike.ts"

// Structural unit fixture; the applied suite covers Plan.fromGraph over
// @smthrs/flow's graph.
const plan: PlanLike = {
  digest: "plan:review:small-pr",
  envelope: {
    deny: ["proc:spawn"],
    may: ["fs:read ./", "net:get api.github.com"]
  },
  nodes: [
    {
      id: "read-pr",
      key: "key:read-pr",
      kind: "ActionCall",
      placement: { tag: "local", options: {} },
      effects: ["fs:read", "net:get"],
      mode: "hard",
      tier: "sealed",
      sealed: true
    },
    {
      id: "lint",
      key: "key:lint",
      kind: "ActionCall",
      placement: { tag: "sandbox", options: { profile: "lane-3" } },
      effects: ["proc:spawn"],
      mode: "expected",
      tier: "compensable",
      sealed: false
    },
    {
      id: "test",
      key: "key:test",
      kind: "ActionCall",
      placement: { tag: "sandbox", options: { profile: "lane-3" } },
      effects: ["proc:spawn", "fs:read"],
      tier: "irreversible",
      sealed: false
    },
    {
      id: "review",
      key: "key:review",
      kind: "FlowCall",
      placement: { tag: "remote", options: { profile: "reviewer" } },
      effects: ["model:reviewer"],
      mode: "hard",
      tier: "sealed",
      sealed: true
    }
  ],
  edges: [
    { from: "read-pr", to: "test" },
    { from: "read-pr", to: "lint" },
    { from: "lint", to: "review" },
    { from: "test", to: "review" }
  ]
}

const assertFailure = (assertion: Effect.Effect<void, { readonly code: string }>, code: string) =>
  assertion.pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => expect(error.code).toBe(code))),
    Effect.asVoid
  )

describe("PlanAssertions", () => {
  it.effect("reports cyclic envelope mismatches through the typed channel", () =>
    Effect.gen(function*() {
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      const assertion = expectPlan(plan).envelope(cyclic)
      const error = yield* assertion.pipe(Effect.flip)
      expect(error.code).toBe("envelope_mismatch")
      expect(error.expected).toBe(cyclic)
      expect(error.message).toContain("Circular")
    }))

  it.effect("renders throwing getters without invoking them", () =>
    Effect.gen(function*() {
      let reads = 0
      const payload = {
        get profile() {
          reads++
          throw new Error("must not read")
        }
      }
      const error = yield* expectPlan(plan).envelope(payload).pipe(Effect.flip)
      expect(error.code).toBe("envelope_mismatch")
      expect(error.message).toContain("Accessor")
      const placement = yield* expectPlan(plan).node("review").placement({ tag: "remote", options: payload })
        .pipe(Effect.flip)
      expect(placement.code).toBe("placement_mismatch")
      expect(placement.message).toContain("Accessor")
      expect(reads).toBe(0)
    }))

  it.effect("defers comparison and bounds deeply nested diagnostics", () =>
    Effect.gen(function*() {
      let inspections = 0
      const payload = new Proxy({}, {
        ownKeys() {
          inspections++
          return []
        }
      })
      const assertion = expectPlan(plan).envelope(payload)
      expect(inspections).toBe(0)
      yield* assertFailure(assertion, "envelope_mismatch")
      expect(inspections).toBeGreaterThan(0)
      let deep: Record<string, unknown> = {}
      for (let index = 0; index < 1000; index++) deep = { child: deep }
      const error = yield* expectPlan(plan).envelope(deep).pipe(Effect.flip)
      expect(error.code).toBe("envelope_mismatch")
      expect(error.message).toContain("TooDeep")
      expect(error.message.length).toBeLessThan(5000)
    }))

  it.effect("asserts node counts and node membership", () =>
    Effect.gen(function*() {
      yield* expectPlan(plan).nodeCount(4)
      yield* expectPlan(plan).contains("review")
      yield* assertFailure(expectPlan(plan).nodeCount(3), "node_count_mismatch")
      yield* assertFailure(expectPlan(plan).contains("missing"), "missing_node")
    }))

  it.effect("asserts required and exact graph edges", () =>
    Effect.gen(function*() {
      yield* expectPlan(plan).edges([{ from: "read-pr", to: "lint" }])
      yield* expectPlan(plan).edges([
        ["read-pr", "lint"],
        ["read-pr", "test"],
        ["lint", "review"],
        ["test", "review"]
      ], { exact: true })
      yield* assertFailure(expectPlan(plan).edges([["review", "publish"]]), "missing_edge")
      yield* assertFailure(expectPlan(plan).edges([["read-pr", "lint"]], { exact: true }), "unexpected_edge")
    }))

  it.effect("asserts keys, placements, declared effects, and envelopes", () =>
    Effect.gen(function*() {
      yield* expectPlan(plan).keys({ "read-pr": "key:read-pr", review: "key:review" })
      yield* expectPlan(plan).placement("review", "remote")
      yield* expectPlan(plan).placement("review", { tag: "remote", options: { profile: "reviewer" } })
      yield* expectPlan(plan).declaresEffects("test", ["fs:read", "proc:spawn"])
      yield* expectPlan(plan).envelope({
        deny: ["proc:spawn"],
        may: ["fs:read ./", "net:get api.github.com"]
      })
      yield* assertFailure(expectPlan(plan).keys({ review: "key:wrong" }), "key_mismatch")
      yield* assertFailure(expectPlan(plan).placement("review", "local"), "placement_mismatch")
      yield* assertFailure(
        expectPlan(plan).placement("review", { tag: "remote", options: { profile: "other" } }),
        "placement_mismatch"
      )
      yield* assertFailure(expectPlan(plan).declaresEffects("test", ["fs:read"]), "declared_effect_mismatch")
      yield* assertFailure(expectPlan(plan).envelope({ deny: [] }), "envelope_mismatch")
    }))

  it.effect("scopes assertions to an individual node", () =>
    Effect.gen(function*() {
      const review = expectPlan(plan).node("review")
      yield* review.key("key:review")
      yield* review.placement("remote")
      yield* review.placement({ tag: "remote", options: { profile: "reviewer" } })
      yield* review.placement({ tag: "remote" })
      yield* review.mode("hard")
      yield* review.tier("sealed")
      yield* review.declaresEffects(["model:reviewer"])
      yield* assertFailure(review.key("key:other"), "key_mismatch")
      yield* assertFailure(review.placement("local"), "placement_mismatch")
      yield* assertFailure(review.mode("expected"), "declared_effect_mismatch")
      yield* assertFailure(review.tier("irreversible"), "declared_effect_mismatch")
      yield* assertFailure(review.declaresEffects([]), "declared_effect_mismatch")
      yield* assertFailure(expectPlan(plan).node("missing").key("key:none"), "missing_node")
      const lint = expectPlan(plan).node("lint")
      yield* lint.mode("expected")
      yield* lint.tier("compensable")
      yield* expectPlan(plan).node("test").mode(undefined)
      yield* expectPlan(plan).node("test").tier("irreversible")

      const absentMode = yield* expectPlan(plan).node("test").mode("expected").pipe(Effect.flip)
      expect(absentMode.code).toBe("declared_effect_mismatch")
      expect(absentMode.actual).toBeUndefined()
      expect(absentMode.message).toContain("actual undefined")
    }))

  it.effect("renders a stable snapshot and fails with a readable diff", () =>
    Effect.gen(function*() {
      const snapshot = Plan.render(plan)
      yield* expectPlan(plan).matchesSnapshot(snapshot)
      // Deterministic: node/edge order in the input must not matter.
      const shuffled: PlanLike = {
        ...plan,
        nodes: [...plan.nodes].reverse(),
        edges: [...plan.edges].reverse()
      }
      expect(Plan.render(shuffled)).toBe(snapshot)
      const error = yield* expectPlan(shuffled).matchesSnapshot(snapshot.replace("key:review", "key:changed")).pipe(
        Effect.flip
      )
      expect(error.code).toBe("snapshot_mismatch")
      expect(error.message).toContain("- ")
      expect(error.message).toContain("+ ")
      expect(error.message).toContain("key:changed")

      const missingActualLine = yield* expectPlan(plan).matchesSnapshot(`${snapshot}\nextra expected line`).pipe(
        Effect.flip
      )
      expect(missingActualLine.message).toContain("- extra expected line")

      const missingExpectedLine = yield* expectPlan(plan).matchesSnapshot(snapshot.split("\n").slice(0, -1).join("\n"))
        .pipe(
          Effect.flip
        )
      expect(missingExpectedLine.message).toContain("+ edge test -> review")
    }))

  it.effect("pluralizes empty-plan edge and coverage diagnostics", () =>
    Effect.gen(function*() {
      const empty: PlanLike = { nodes: [], edges: [] }
      const missingEdges = yield* expectPlan(empty).edges([
        ["prepare", "test"],
        ["test", "publish"]
      ]).pipe(Effect.flip)
      expect(missingEdges.code).toBe("missing_edge")
      expect(missingEdges.message).toContain("Missing edges")
      expect(missingEdges.message).toContain("Actual edges: (none)")

      const unexpectedEdges = yield* expectPlan(plan).edges([], { exact: true }).pipe(Effect.flip)
      expect(unexpectedEdges.code).toBe("unexpected_edge")
      expect(unexpectedEdges.message).toContain("Unexpected edges")
      expect(unexpectedEdges.message).toContain("Expected edges: (none)")

      const uncovered = yield* expectPlans([]).covers(["prepare", "publish"]).pipe(Effect.flip)
      expect(uncovered.code).toBe("coverage_mismatch")
      expect(uncovered.message).toContain("Unreached nodes")
      expect(uncovered.message).toContain("Reached nodes: (none)")

      const missingNode = yield* expectPlan(empty).contains("missing").pipe(Effect.flip)
      expect(missingNode.code).toBe("missing_node")
      expect(missingNode.message).toContain("Available nodes: (none)")

      const oneEdge: PlanLike = { nodes: [], edges: [{ from: "prepare", to: "publish" }] }
      const oneUnexpected = yield* expectPlan(oneEdge).edges([], { exact: true }).pipe(Effect.flip)
      expect(oneUnexpected.message).toContain("Unexpected edge: prepare -> publish")
    }))

  it.effect("checks key goldens and reports drift as a cache-identity break", () =>
    Effect.gen(function*() {
      yield* expectKeyGoldens({ a: "key1_aa", b: "key1_bb" }, { a: "key1_aa" })
      const error = yield* expectKeyGoldens({ a: "sk1_aa" }, { a: "sk1_other" }).pipe(Effect.flip)
      expect(error.code).toBe("key_golden_mismatch")
    }))

  it.effect("surfaces impure plan computations as purity violations", () =>
    Effect.gen(function*() {
      const pure = yield* expectPure(Effect.succeed(plan))
      expect(pure).toBe(plan)
      const error = yield* expectPure(Effect.fail("touched the filesystem")).pipe(Effect.flip)
      expect(error.code).toBe("purity_violation")
    }))

  it.effect("checks static coverage over a suite of plans", () =>
    Effect.gen(function*() {
      const alternate: PlanLike = { ...plan, nodes: plan.nodes.filter((node) => node.id !== "review") }
      yield* expectPlans([alternate, plan]).covers(["read-pr", "review"])
      yield* expectPlans([alternate]).covers(["review"], { allowUnreached: ["review"] })
      yield* assertFailure(expectPlans([alternate]).covers(["review"]), "coverage_mismatch")
    }))
})
