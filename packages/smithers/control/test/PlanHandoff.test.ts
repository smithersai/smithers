/**
 * The core graph is compiled by the persisted plan package before it reaches
 * the control card. The card carries that exact value plus cache verdicts.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Core from "@smthrs/core"
import * as PersistedPlan from "@smthrs/plan/Plan"
import { Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { InvalidInput } from "../src/ControlError.ts"
import type { MemoryFlow } from "../src/ControlRuntime.ts"
import { PlanCard, PlanGraph, type PlanNodeStatus } from "../src/ControlSchema.ts"
import * as TestControl from "../src/test/TestControl.ts"

const declaration = (writes: ReadonlyArray<string> = []) =>
  Core.Effects.make({
    reads: [],
    writes,
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  })

const graph = (reviewWrites: ReadonlyArray<string> = ["review.json"]): Core.Graph.Graph =>
  Core.Graph.build(Core.Node.all({
    read: Core.Node.dynamic({ model: "recorded:reader", effects: declaration() }),
    review: Core.Node.dynamic({ model: "recorded:reviewer", effects: declaration(reviewWrites) })
  }))

const compile = (
  value: Core.Graph.Graph,
  planId: string
) => {
  const nodes = new Map(Core.Graph.nodes(value).map((node) => [node.id, node]))
  const material = Result.getOrThrow(Core.Graph.keyMaterial(value))
  return PersistedPlan.compile({
    planId,
    flow: "review/pull-request",
    nodes: material.map((entry): PersistedPlan.NodeDraft => {
      const effects = nodes.get(entry.nodeId)?.declaredEffects ?? nodes.get(entry.nodeId)?.effectiveEffects
      return {
        id: entry.nodeId,
        material: entry.material,
        effects: {
          reads: effects?.reads ?? [],
          writes: effects?.writes ?? [],
          boundaryMode: effects?.mode === "expected" ? "expected" : "hard"
        },
        kind: entry.material.body !== null && typeof entry.material.body === "object" &&
            (entry.material.body as { readonly _tag?: unknown })._tag === "Dynamic"
          ? "agent"
          : "step"
      }
    })
  }).pipe(
    Effect.mapError((cause) => new InvalidInput({ issue: String(cause) })),
    Effect.provide(NodeCrypto.layer)
  )
}

const flow = (
  value: Core.Graph.Graph,
  statuses: Readonly<Record<string, PlanNodeStatus>> = {}
): MemoryFlow => ({
  flowId: "review/pull-request",
  description: "Review a pull request.",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} },
  plan: (_input, planId) => compile(value, planId).pipe(Effect.map((plan) => ({ plan, statuses })))
})

const planned = (
  value: Core.Graph.Graph,
  statuses?: Readonly<Record<string, PlanNodeStatus>>
) =>
  Effect.gen(function*() {
    const control = yield* Control
    return yield* control.plan({ flowId: "review/pull-request", input: { pr: 4821 } })
  }).pipe(
    Effect.provide(TestControl.layer({ flows: [flow(value, statuses)] })),
    Effect.scoped,
    Effect.runPromise
  )

describe("the persisted plan handoff", () => {
  it("carries the exact compiled plan and reports each node's cache outcome", async () => {
    const card = await planned(graph(), {
      "root.all.read": "cached",
      "root.all.review": "run"
    })

    expect(card.plan).toBeDefined()
    expect(card.plan?.planId).toBe(card.planId)
    expect(card.nodes.map((node) => node.key)).toEqual(card.plan?.nodes.map((node) => node.key))
    expect(card.nodes.find((node) => node.id === "root.all.read")?.status).toBe("cached")
    expect(card.nodes.find((node) => node.id === "root.all.review")?.status).toBe("run")
  })

  it("binds approval to the persisted plan digest", async () => {
    const original = await planned(graph(["review.json"]))
    const changed = await planned(graph(["review.json", "audit.json"]))

    expect(changed.plan?.digest).not.toBe(original.plan?.digest)
    expect(changed.digest).not.toBe(original.digest)
    expect(changed.approval.target.digest).toBe(changed.digest)
  })

  it("keeps graph structure that does not enter a step key on the approval surface", async () => {
    const card = await planned(graph())
    const review = card.nodes.find((node) => node.id === "root.all.review")

    expect(review).toMatchObject({
      effects: { writes: ["review.json"] },
      strategy: "serialize",
      runtime: "delay-rebase",
      generation: 0
    })
    expect(review).toHaveProperty("dependsOn")
    expect(review).toHaveProperty("conflicts")
  })

  it("represents hosts without a graph without fabricating a persisted plan", async () => {
    const noGraph: MemoryFlow = {
      flowId: "review/pull-request",
      description: "Review a pull request.",
      deployClass: false,
      envelope: { capabilities: [], flows: [], budget: {} }
    }
    const card = await Effect.gen(function*() {
      const control = yield* Control
      return yield* control.plan({ flowId: noGraph.flowId, input: { pr: 4821 } })
    }).pipe(
      Effect.provide(TestControl.layer({ flows: [noGraph] })),
      Effect.scoped,
      Effect.runPromise
    )

    expect(card.plan).toBeUndefined()
    expect(card.nodes).toEqual([])
    expect(card.digest).toMatch(/^[0-9a-f]{64}$/)
  })
})

/*
 * D-037: the typed edges `Graph.build` already knows travel beside the plan,
 * outside the digest an approval binds to. A host that gains them re-plans to
 * the digest it planned to before, so every parked approval still validates.
 */
const withGraph = (value: Core.Graph.Graph): MemoryFlow => ({
  ...flow(value),
  plan: (_input, planId) =>
    compile(value, planId).pipe(Effect.map((plan) => ({
      plan,
      graph: { edges: Core.Graph.edges(value) }
    })))
})

const plannedBy = (memoryFlow: MemoryFlow) =>
  Effect.gen(function*() {
    const control = yield* Control
    return yield* control.plan({ flowId: "review/pull-request", input: { pr: 4821 } })
  }).pipe(
    Effect.provide(TestControl.layer({ flows: [memoryFlow] })),
    Effect.scoped,
    Effect.runPromise
  )

describe("the typed edges beside the plan", () => {
  it("reports each edge's reason from the built graph", async () => {
    const card = await plannedBy(withGraph(graph()))

    expect(card.graph?.edges).toEqual(Core.Graph.edges(graph()))
    expect(new Set(card.graph?.edges.map((edge) => edge.reason))).toEqual(new Set(["value"]))
    expect(card.graph?.edges.map((edge) => edge.to)).toEqual(
      card.graph?.edges.map((edge) => edge.to).filter((id) => card.nodes.some((node) => node.id === id))
    )
  })

  it("leaves the approval digest exactly where it was without the edges", async () => {
    const withEdges = await plannedBy(withGraph(graph()))
    const without = await plannedBy(flow(graph()))

    expect(withEdges.digest).toBe(without.digest)
    expect(withEdges.approval.target.digest).toBe(without.approval.target.digest)
  })

  it("decodes a card stored before the field existed", () => {
    const stored = {
      planId: "plan-1",
      flowId: "review/pull-request",
      digest: "a".repeat(64),
      inputSummary: "{}",
      envelope: { capabilities: [], flows: [], budget: {} },
      deployClass: false,
      nodes: [],
      approval: {
        target: {
          _tag: "Plan",
          planId: "plan-1",
          digest: "a".repeat(64),
          envelope: { capabilities: [], flows: [], budget: {} }
        },
        scope: "run",
        idempotencyKey: "approve:plan-1"
      }
    }

    expect(Schema.decodeUnknownSync(PlanCard)(stored).graph).toBeUndefined()
    expect(
      Schema.decodeUnknownSync(PlanCard)({
        ...stored,
        graph: { edges: [{ from: "a", to: "b", reason: "continuation" }] }
      }).graph?.edges
    )
      .toEqual([{ from: "a", to: "b", reason: "continuation" }])
  })
})

/*
 * D-054: the declaration sites the graph builder already knows travel beside
 * the plan, in the same place and under the same rule as the edges. A reader
 * of a plan card can open the node's code; an approval still binds to the
 * digest it bound to before.
 */
const declaredAt = { path: "flows/review/pull-request.ts", line: 12 } as const

const withDeclarations = (value: Core.Graph.Graph): MemoryFlow => ({
  ...flow(value),
  plan: (_input, planId) =>
    compile(value, planId).pipe(Effect.map((plan) => ({
      plan,
      graph: {
        edges: Core.Graph.edges(value),
        nodes: Core.Graph.nodes(value).map((node) => ({ id: node.id, declaredAt }))
      }
    })))
})

describe("the declaration sites beside the plan", () => {
  it("names where each node of the plan was declared", async () => {
    const card = await plannedBy(withDeclarations(graph()))

    /* The join a drawer makes: every keyed node the card reports has a site. */
    const sites = new Map((card.graph?.nodes ?? []).map((node) => [node.id, node.declaredAt]))
    expect(card.nodes.length).toBeGreaterThan(0)
    expect(card.nodes.every((node) => sites.get(node.id)?.path === declaredAt.path)).toBe(true)
    expect(card.nodes.every((node) => sites.get(node.id)?.line === declaredAt.line)).toBe(true)
  })

  it("leaves the approval digest exactly where it was without them", async () => {
    const withSites = await plannedBy(withDeclarations(graph()))
    const without = await plannedBy(withGraph(graph()))

    expect(withSites.digest).toBe(without.digest)
    expect(withSites.approval.target.digest).toBe(without.approval.target.digest)
  })

  it("refuses an absolute path, so an operator's home directory never reaches a card", () => {
    const absolute = {
      edges: [],
      nodes: [{ id: "root.all.read", declaredAt: { path: "/Users/operator/project/flow.ts", line: 12 } }]
    }

    expect(() => Schema.decodeUnknownSync(PlanGraph)(absolute)).toThrow()
    expect(
      Schema.decodeUnknownSync(PlanGraph)({ edges: [], nodes: [{ id: "root.all.read", declaredAt }] }).nodes?.[0]
        ?.declaredAt
    )
      .toEqual(declaredAt)
  })

  it("reads a graph recorded before the field existed", () => {
    expect(Schema.decodeUnknownSync(PlanGraph)({ edges: [{ from: "a", to: "b", reason: "value" }] }).nodes)
      .toBeUndefined()
  })
})

/*
 * D-068: the declaration sites above say WHERE a node was declared and never
 * which bytes were there. The revision the host read its flows out of travels
 * beside them, in the same place and under the same rule: outside the digest
 * an approval binds to, because it describes the source a reader opens and
 * not what the plan will do.
 */
const REVISION = "9".repeat(40)

const withRevision = (value: Core.Graph.Graph): MemoryFlow => ({
  ...flow(value),
  plan: (_input, planId) =>
    compile(value, planId).pipe(Effect.map((plan) => ({
      plan,
      graph: {
        edges: Core.Graph.edges(value),
        nodes: Core.Graph.nodes(value).map((node) => ({ id: node.id, declaredAt })),
        sourceRevision: REVISION
      }
    })))
})

describe("the source revision beside the plan", () => {
  it("names the revision the host read those declaration sites out of", async () => {
    const card = await plannedBy(withRevision(graph()))

    /*
     * Through the schema, which is how a client receives it: a field the card
     * shape does not declare is dropped on the way out, so reading it off the
     * in-process value alone would prove nothing about what a reader gets.
     */
    const served = Schema.decodeUnknownSync(PlanCard)(Schema.encodeUnknownSync(PlanCard)(card))
    expect(served.graph?.sourceRevision).toBe(REVISION)
    expect(served.graph?.nodes?.length).toBe(card.graph?.nodes?.length)
  })

  it("leaves the approval digest exactly where it was without it", async () => {
    const withIt = await plannedBy(withRevision(graph()))
    const without = await plannedBy(withDeclarations(graph()))

    expect(withIt.digest).toBe(without.digest)
    expect(withIt.approval.target.digest).toBe(without.approval.target.digest)
  })

  it("reads a graph recorded before the field existed, and takes only an object id", () => {
    expect(Schema.decodeUnknownSync(PlanGraph)({ edges: [] }).sourceRevision).toBeUndefined()
    expect(Schema.decodeUnknownSync(PlanGraph)({ edges: [], sourceRevision: REVISION }).sourceRevision).toBe(REVISION)
    /*
     * The app puts this value straight into a contents route's `?ref=`, and a
     * route that honours it spawns jj or git from it. The only producer emits
     * forty lowercase hex digits (`SourceRevision.objectId`), so a branch
     * name, an abbreviation, an upper-case id, a leading `-` git would read as
     * an option and the empty string are refused at the boundary.
     */
    for (
      const invalid of [
        "",
        "main",
        "9".repeat(39),
        "9".repeat(41),
        "A".repeat(40),
        `-${"9".repeat(39)}`,
        `${REVISION}\n`
      ]
    ) {
      expect(() => Schema.decodeUnknownSync(PlanGraph)({ edges: [], sourceRevision: invalid })).toThrow()
    }
  })
})
