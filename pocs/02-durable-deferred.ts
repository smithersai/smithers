/**
 * POC 2: DurableDeferred — suspend/resume via external signals
 *
 * Demonstrates the replacement for Smithers' _smithers_approvals table:
 * - Workflow suspends when it encounters a DurableDeferred that hasn't resolved
 * - External code resolves the deferred using a token
 * - Workflow resumes from where it left off
 *
 * This is how human approvals, webhooks, and signals will work.
 *
 * Run: bun run pocs/02-durable-deferred.ts
 */

import * as Activity from "@effect/workflow/Activity"
import * as DurableDeferred from "@effect/workflow/DurableDeferred"
import * as Workflow from "@effect/workflow/Workflow"
import * as WorkflowEngine from "@effect/workflow/WorkflowEngine"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"

// ─── Define a deferred for human approval ───────────────────────────────────

const HumanApproval = DurableDeferred.make("human-approval", {
  success: Schema.Struct({
    approved: Schema.Boolean,
    reviewer: Schema.String,
  }),
})

// ─── Activities ─────────────────────────────────────────────────────────────

const prepareForReview = Activity.make({
  name: "prepare-for-review",
  success: Schema.Struct({ prUrl: Schema.String }),
  execute: Effect.gen(function* () {
    yield* Effect.log("[prepare] Creating PR for review...")
    yield* Effect.sleep("50 millis")
    return { prUrl: "https://github.com/example/repo/pull/42" }
  }),
})

const deployAfterApproval = Activity.make({
  name: "deploy",
  success: Schema.Struct({ deployed: Schema.Boolean }),
  execute: Effect.gen(function* () {
    yield* Effect.log("[deploy] Deploying to production...")
    yield* Effect.sleep("50 millis")
    return { deployed: true }
  }),
})

// ─── Workflow: prepare → wait for approval → deploy ─────────────────────────

const DeployWorkflow = Workflow.make({
  name: "DeployPipeline",
  payload: { prId: Schema.String },
  success: Schema.Struct({ deployed: Schema.Boolean }),
  idempotencyKey: ({ prId }) => prId,
})

const DeployWorkflowLayer = DeployWorkflow.toLayer(
  (payload, executionId) =>
    Effect.gen(function* () {
      yield* Effect.log("=== Deploy workflow starting ===")

      const pr = yield* prepareForReview
      yield* Effect.log(`PR created: ${pr.prUrl}`)

      yield* Effect.log("⏸  Waiting for human approval...")
      const approval = yield* DurableDeferred.await(HumanApproval)
      yield* Effect.log(`✅ Approved by ${approval.reviewer}!`)

      const result = yield* deployAfterApproval
      yield* Effect.log(`Deployed: ${result.deployed}`)

      return result
    })
)

// ─── Run ────────────────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
  yield* Effect.log("━━━ POC 2: DurableDeferred (human approval) ━━━\n")

  // Start workflow — it will suspend at DurableDeferred.await
  yield* Effect.log("Starting workflow (will suspend at approval step)...")
  const fiber = yield* Effect.fork(
    DeployWorkflow.execute({ prId: "pr-42" })
  )

  // Give workflow time to reach suspend point
  yield* Effect.sleep("300 millis")

  // Simulate external approval
  yield* Effect.log("\nSimulating human approval...")
  const executionId = yield* DeployWorkflow.executionId({ prId: "pr-42" })
  const token = DurableDeferred.tokenFromExecutionId(HumanApproval, {
    workflow: DeployWorkflow,
    executionId,
  })

  yield* DurableDeferred.succeed(HumanApproval, {
    token,
    value: { approved: true, reviewer: "alice" },
  })

  // Wait for workflow to complete
  const result = yield* Fiber.join(fiber)
  yield* Effect.log(`\nFinal result: ${JSON.stringify(result)}`)
})

const MainLayer = DeployWorkflowLayer.pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory),
)

Effect.runPromise(
  program.pipe(Effect.provide(MainLayer))
).catch(console.error)
