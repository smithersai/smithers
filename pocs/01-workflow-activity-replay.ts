/**
 * POC 1: Workflow + Activity with replay memoization
 *
 * Demonstrates the core mechanism that replaces Smithers' `executeTask()`:
 * - Define a Workflow with a name, payload schema, and idempotency key
 * - Define Activities (side-effectful tasks) that run inside the workflow
 * - On replay (re-execution after suspend/resume), activities return cached
 *   results without re-executing
 *
 * This is the single most important POC — it proves that the Effect workflow
 * engine handles memoization and replay automatically.
 *
 * Run: bun run pocs/01-workflow-activity-replay.ts
 */

import * as Activity from "@effect/workflow/Activity"
import * as Workflow from "@effect/workflow/Workflow"
import * as WorkflowEngine from "@effect/workflow/WorkflowEngine"
import { Effect, Layer, Schema } from "effect"

// ─── Activity definitions ───────────────────────────────────────────────────

let activityCallCount = { analyze: 0, transform: 0, summarize: 0 }

const analyzeActivity = Activity.make({
  name: "analyze",
  success: Schema.Struct({
    topics: Schema.Array(Schema.String),
    sentiment: Schema.String,
  }),
  execute: Effect.gen(function* () {
    activityCallCount.analyze++
    yield* Effect.log(`[analyze] Executing (call #${activityCallCount.analyze})`)
    yield* Effect.sleep("100 millis")
    return {
      topics: ["architecture", "effect-ts", "durable-execution"],
      sentiment: "positive",
    }
  }),
})

const transformActivity = Activity.make({
  name: "transform",
  success: Schema.Struct({
    transformed: Schema.Boolean,
    itemCount: Schema.Number,
  }),
  execute: Effect.gen(function* () {
    activityCallCount.transform++
    yield* Effect.log(`[transform] Executing (call #${activityCallCount.transform})`)
    yield* Effect.sleep("100 millis")
    return { transformed: true, itemCount: 3 }
  }),
})

const summarizeActivity = Activity.make({
  name: "summarize",
  success: Schema.Struct({ summary: Schema.String }),
  execute: Effect.gen(function* () {
    activityCallCount.summarize++
    yield* Effect.log(`[summarize] Executing (call #${activityCallCount.summarize})`)
    yield* Effect.sleep("100 millis")
    return { summary: "Analysis complete: 3 topics found, positive sentiment" }
  }),
})

// ─── Workflow definition and implementation ─────────────────────────────────

const MyWorkflow = Workflow.make({
  name: "AnalysisPipeline",
  payload: {
    documentId: Schema.String,
  },
  success: Schema.Struct({ summary: Schema.String }),
  idempotencyKey: ({ documentId }) => documentId,
})

const MyWorkflowLayer = MyWorkflow.toLayer(
  (payload, executionId) =>
    Effect.gen(function* () {
      yield* Effect.log(`=== Workflow starting (executionId: ${executionId}) ===`)

      const analysis = yield* analyzeActivity
      yield* Effect.log(`Analysis: ${JSON.stringify(analysis)}`)

      const transformed = yield* transformActivity
      yield* Effect.log(`Transform: ${JSON.stringify(transformed)}`)

      const summary = yield* summarizeActivity
      yield* Effect.log(`Summary: ${JSON.stringify(summary)}`)

      yield* Effect.log("=== Workflow complete ===")
      return summary
    })
)

// ─── Run it ─────────────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
  yield* Effect.log("━━━ POC 1: Workflow + Activity replay ━━━\n")

  const result = yield* MyWorkflow.execute({ documentId: "doc-001" })
  yield* Effect.log(`\nFinal result: ${JSON.stringify(result)}`)
  yield* Effect.log(`Call counts: analyze=${activityCallCount.analyze} transform=${activityCallCount.transform} summarize=${activityCallCount.summarize}`)

  yield* Effect.log("\n━━━ Re-executing with same idempotency key ━━━")
  const result2 = yield* MyWorkflow.execute({ documentId: "doc-001" })
  yield* Effect.log(`Result: ${JSON.stringify(result2)}`)
  yield* Effect.log(`Counts (should be same — memoized!): analyze=${activityCallCount.analyze} transform=${activityCallCount.transform} summarize=${activityCallCount.summarize}`)

  yield* Effect.log("\n━━━ Executing with different key ━━━")
  const result3 = yield* MyWorkflow.execute({ documentId: "doc-002" })
  yield* Effect.log(`Result: ${JSON.stringify(result3)}`)
  yield* Effect.log(`Counts (should increment): analyze=${activityCallCount.analyze} transform=${activityCallCount.transform} summarize=${activityCallCount.summarize}`)
})

const MainLayer = MyWorkflowLayer.pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory),
)

Effect.runPromise(
  program.pipe(Effect.provide(MainLayer))
).catch(console.error)
