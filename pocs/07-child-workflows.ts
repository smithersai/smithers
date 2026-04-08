/**
 * POC 7: Child workflows — replacing Smithers' executeChildWorkflow
 *
 * Demonstrates how @effect/workflow handles nested/child workflows:
 * - Parent workflow spawns child workflows
 * - Children run in parallel and are independently replayable
 * - This is how <Sandbox> becomes a child workflow dispatched to a worker
 *
 * Run: bun run pocs/07-child-workflows.ts
 */

import * as Activity from "@effect/workflow/Activity"
import * as Workflow from "@effect/workflow/Workflow"
import * as WorkflowEngine from "@effect/workflow/WorkflowEngine"
import { Effect, Layer, Schema } from "effect"

// ─── Child workflow ─────────────────────────────────────────────────────────

const SandboxWorkflow = Workflow.make({
  name: "SandboxWork",
  payload: {
    taskId: Schema.String,
    workDescription: Schema.String,
  },
  success: Schema.Struct({
    taskId: Schema.String,
    result: Schema.String,
    filesChanged: Schema.Number,
  }),
  idempotencyKey: ({ taskId }) => taskId,
})

const sandboxAnalyze = Activity.make({
  name: "sandbox-analyze",
  success: Schema.Struct({ issues: Schema.Number }),
  execute: Effect.gen(function* () {
    yield* Effect.log("    [sandbox] Analyzing code...")
    yield* Effect.sleep("50 millis")
    return { issues: 3 }
  }),
})

const sandboxFix = Activity.make({
  name: "sandbox-fix",
  success: Schema.Struct({ fixed: Schema.Number }),
  execute: Effect.gen(function* () {
    yield* Effect.log("    [sandbox] Fixing issues...")
    yield* Effect.sleep("50 millis")
    return { fixed: 3 }
  }),
})

const SandboxWorkflowLayer = SandboxWorkflow.toLayer(
  (payload, _executionId) =>
    Effect.gen(function* () {
      yield* Effect.log(`  [sandbox] Starting: "${payload.workDescription}"`)
      const analysis = yield* sandboxAnalyze
      yield* Effect.log(`  [sandbox] Found ${analysis.issues} issues`)
      const fix = yield* sandboxFix
      yield* Effect.log(`  [sandbox] Fixed ${fix.fixed} issues`)
      return {
        taskId: payload.taskId,
        result: `Completed: ${payload.workDescription}`,
        filesChanged: fix.fixed,
      }
    })
)

// ─── Parent workflow ────────────────────────────────────────────────────────

const OrchestratorWorkflow = Workflow.make({
  name: "Orchestrator",
  payload: { projectId: Schema.String },
  success: Schema.Struct({
    totalFilesChanged: Schema.Number,
    childResults: Schema.Array(Schema.String),
  }),
  idempotencyKey: ({ projectId }) => projectId,
})

const planActivity = Activity.make({
  name: "plan",
  success: Schema.Struct({
    tasks: Schema.Array(Schema.Struct({
      id: Schema.String,
      description: Schema.String,
    })),
  }),
  execute: Effect.gen(function* () {
    yield* Effect.log("[orchestrator] Planning work...")
    yield* Effect.sleep("50 millis")
    return {
      tasks: [
        { id: "sandbox-1", description: "Refactor auth module" },
        { id: "sandbox-2", description: "Add database migrations" },
        { id: "sandbox-3", description: "Update API endpoints" },
      ],
    }
  }),
})

const OrchestratorLayer = OrchestratorWorkflow.toLayer(
  (_payload, _executionId) =>
    Effect.gen(function* () {
      yield* Effect.log("[orchestrator] Starting orchestration")

      const plan = yield* planActivity
      yield* Effect.log(`[orchestrator] Plan: ${plan.tasks.length} tasks`)

      yield* Effect.log("[orchestrator] Dispatching child workflows...")
      const childResults = yield* Effect.all(
        plan.tasks.map((task) =>
          SandboxWorkflow.execute({
            taskId: task.id,
            workDescription: task.description,
          })
        ),
        { concurrency: "unbounded" }
      )

      yield* Effect.log("[orchestrator] All children completed!")
      return {
        totalFilesChanged: childResults.reduce((s, r) => s + r.filesChanged, 0),
        childResults: childResults.map((r) => r.result),
      }
    })
)

// ─── Run it ─────────────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
  yield* Effect.log("━━━ POC 7: Child workflows (sandbox dispatch) ━━━\n")

  const result = yield* OrchestratorWorkflow.execute({ projectId: "proj-001" })

  yield* Effect.log(`\nTotal files changed: ${result.totalFilesChanged}`)
  yield* Effect.log(`Child results:`)
  for (const r of result.childResults) {
    yield* Effect.log(`  - ${r}`)
  }

  yield* Effect.log("\nKey observations:")
  yield* Effect.log("  - Parent orchestrates, children execute independently")
  yield* Effect.log("  - Children run in parallel")
  yield* Effect.log("  - Each child is independently replayable")
  yield* Effect.log("  - With ClusterWorkflowEngine, children dispatch to remote entities")
})

const MainLayer = OrchestratorLayer.pipe(
  Layer.provideMerge(SandboxWorkflowLayer),
  Layer.provideMerge(WorkflowEngine.layerMemory),
)

Effect.runPromise(
  program.pipe(Effect.provide(MainLayer))
).catch(console.error)
