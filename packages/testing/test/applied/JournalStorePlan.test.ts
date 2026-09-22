import { Action, Flow } from "@smthrs/flow"
import * as Graph from "@smthrs/flow/Graph"
import * as JournalPackage from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as Node from "@smthrs/plan/Node"
import * as Placement from "@smthrs/plan/Placement"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import type { JournalEntryLike } from "../../src/EngineSubject.ts"
import { expectJournal } from "../../src/JournalAssertions.ts"
import * as Plan from "../../src/Plan.ts"
import { expectPlan } from "../../src/PlanAssertions.ts"

interface StoredStepEvent {
  readonly stepKey: string
  readonly kind: string
  readonly outcome: JournalEntryLike["outcome"]
  readonly value?: unknown
}

const asStoredStepEvent = (payload: unknown): StoredStepEvent => payload as StoredStepEvent

const stepKeyPattern = /^key1_[0-9a-f]{64}$/

const reader = Action.make("recorded:reader", {
  payload: Schema.Struct({}),
  success: Schema.String,
  tier: "sealed"
})
  .annotate(Flow.EffectsDeclaration, { reads: ["workspace/pr.json"], writes: [], boundaryMode: "hard" })
  .annotate(Placement.Annotation, Placement.local())

const reviewerAction = (name: string) =>
  Action.make(name, { payload: Schema.Struct({}), success: Schema.String, tier: "sealed" })
    .annotate(Flow.EffectsDeclaration, { reads: [], writes: ["workspace/review.json"], boundaryMode: "hard" })
    .annotate(Placement.Annotation, Placement.remote({ profile: "reviewer" }))

const buildGraph = (reviewerName: string): Graph.Graph =>
  Graph.build(Node.all({ read: reader.call({}), review: reviewerAction(reviewerName).call({}) }))

describe("journal store plan assertions", () => {
  it("asserts a plan against entries committed by the production TestJournal store", async () => {
    const journalEntries = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* JournalPackage.Journal.Journal
        // The durable channel is fenced since 28309cc84. This test seeds
        // entries to assert a plan against them; no engine owns the run, so
        // the ownerless channel is the honest one.
        const runId = "journal-store-plan" as JournalPackage.JournalEvent.RunId
        const sourceId = "journal-store-plan" as JournalPackage.JournalEvent.SourceId
        yield* journal.emitDurableUnfenced({
          runId,
          sourceId,
          eventType: "step.completed",
          payload: {
            stepKey: "read-pr",
            kind: "step",
            outcome: "completed",
            value: { idempotencyKey: "read-pr:1" }
          }
        })
        yield* journal.emitDurableUnfenced({
          runId,
          sourceId,
          eventType: "effect.completed",
          payload: {
            stepKey: "model:reviewer",
            kind: "effect",
            outcome: "completed",
            value: { idempotencyKey: "model:reviewer:1" }
          }
        })
        yield* journal.flush
        const page = yield* journal.entries({ runId, limit: 10 })
        return page.entries.map((entry): JournalEntryLike => {
          const payload = asStoredStepEvent(entry.payload)
          return {
            index: entry.seq,
            stepKey: payload.stepKey,
            kind: payload.kind,
            outcome: payload.outcome,
            ...(payload.value === undefined ? {} : { value: payload.value })
          }
        })
      }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = expectJournal(journalEntries)
        yield* journal.executedInOrder(["read-pr", "model:reviewer"])
        yield* journal.terminal("completed")
        yield* journal.effect("model:reviewer").atLeastOnce()
        yield* journal.effect("model:reviewer").journaledAtMostOnce()
        yield* journal.effect("model:reviewer").idempotencyKey("model:reviewer:1")
      })
    )

    const envelope = {
      reads: ["workspace/pr.json"],
      writes: ["workspace/review.json"],
      mode: "hermetic",
      onConflict: "serialize",
      tier: "sealed"
    }
    const graph = buildGraph("recorded:reviewer")
    // Real key material: keys are derived from each node's draft material
    // through @smthrs/plan's step-key compiler — no caller-supplied resolver,
    // no hardcoded fake keys.
    const keys = Plan.keys(graph)
    const plan = Plan.fromGraph(graph, {
      envelope: { ...envelope },
      digest: "plan:journal-store"
    })

    // Every derived key is a real key1_ content digest and unique per node.
    for (const key of Object.values(keys)) expect(key).toMatch(stepKeyPattern)
    expect(new Set(Object.values(keys)).size).toBe(Object.keys(keys).length)

    // Deterministic: rebuilding the same declaration yields byte-identical
    // keys; changing identity-bearing material (the action called) changes the
    // key.
    expect(Plan.keys(buildGraph("recorded:reviewer"))).toEqual(keys)
    const changed = Plan.keys(buildGraph("recorded:reviewer-v2"))
    expect(changed["root.all.review"]).not.toBe(keys["root.all.review"])
    expect(changed["root.all.read"]).toBe(keys["root.all.read"])

    await Effect.runPromise(
      Effect.gen(function*() {
        const assertions = expectPlan(plan)
        yield* assertions.nodeCount(3)
        yield* assertions.edges([
          ["root.all.read", "root"],
          ["root.all.review", "root"]
        ], { exact: true })
        yield* assertions.keys(keys)
        yield* assertions.placement("root.all.read", "flows/core/Placement/Local")
        yield* assertions.placement("root.all.review", {
          tag: "flows/core/Placement/Remote",
          options: { profile: "reviewer" }
        })
        yield* assertions.node("root.all.read").mode("hard")
        yield* assertions.node("root.all.read").tier("sealed")
        yield* assertions.node("root.all.review").mode("hard")
        yield* assertions.node("root.all.review").tier("sealed")
        yield* assertions.declaresEffects("root.all.read", ["read:workspace/pr.json"])
        yield* assertions.declaresEffects("root.all.review", ["write:workspace/review.json"])
        yield* assertions.envelope({ ...envelope })
        yield* assertions.matchesSnapshot(Plan.render(plan))
      })
    )

    expect(journalEntries).toHaveLength(2)
    expect(Graph.nodes(graph)).toHaveLength(3)
  })
})
