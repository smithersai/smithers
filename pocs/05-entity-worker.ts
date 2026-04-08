/**
 * POC 5: Entity + TestRunner — local worker dispatch via cluster
 *
 * Demonstrates typed RPC dispatch to a worker entity running in-process:
 * - Entity.make defines a typed protocol (execute, heartbeat)
 * - TestRunner runs everything in-memory (no SQL, no network)
 * - Same Entity/client API works with HttpRunner for remote workers
 * - Sharding handles routing automatically
 *
 * Run: bun run pocs/05-entity-worker.ts
 */

import { Entity, TestRunner } from "@effect/cluster"
import * as Rpc from "@effect/rpc/Rpc"
import { Effect, Layer, Schema } from "effect"

// ─── Define the Worker Entity ───────────────────────────────────────────────

const TaskWorker = Entity.make("TaskWorker", [
  Rpc.make("execute", {
    payload: Schema.Struct({
      taskId: Schema.String,
      prompt: Schema.String,
      agentId: Schema.String,
    }),
    success: Schema.Struct({
      taskId: Schema.String,
      outputJson: Schema.String,
      durationMs: Schema.Number,
    }),
  }),
  Rpc.make("heartbeat", {
    success: Schema.Struct({ alive: Schema.Boolean, activeTaskCount: Schema.Number }),
  }),
])

// ─── Worker implementation ──────────────────────────────────────────────────

let activeTasks = 0

const TaskWorkerHandlers = Effect.succeed({
    execute: (request: any) =>
      Effect.gen(function* () {
        activeTasks++
        yield* Effect.log(`  🔧 Worker: ${request.payload.taskId} with ${request.payload.agentId}`)
        yield* Effect.sleep("100 millis")
        activeTasks--
        return {
          taskId: request.payload.taskId,
          outputJson: JSON.stringify({
            answer: `Done: "${request.payload.prompt}"`,
            model: request.payload.agentId,
          }),
          durationMs: 100,
        }
      }),
    heartbeat: (_: any) =>
      Effect.succeed({ alive: true, activeTaskCount: activeTasks }),
  })


// ─── Orchestrator ───────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
  yield* Effect.log("━━━ POC 5: Entity + TestRunner (local worker) ━━━\n")

  const makeClient = yield* TaskWorker.client
  const worker = makeClient("worker-1")

  yield* Effect.log("Dispatching 3 tasks...\n")

  const results = yield* Effect.all([
    worker.execute({
      taskId: "task-001",
      prompt: "Refactor the auth module",
      agentId: "gpt-4",
    }),
    worker.execute({
      taskId: "task-002",
      prompt: "Add unit tests for db.ts",
      agentId: "claude-3",
    }),
    worker.execute({
      taskId: "task-003",
      prompt: "Update API documentation",
      agentId: "gpt-4",
    }),
  ], { concurrency: "unbounded" })

  yield* Effect.log("\nAll tasks completed!")
  for (const result of results) {
    yield* Effect.log(`  ${result.taskId}: ${result.outputJson}`)
  }

  const health = yield* worker.heartbeat()
  yield* Effect.log(`\nWorker health: alive=${health.alive}, active=${health.activeTaskCount}`)

  yield* Effect.log("\nKey observations:")
  yield* Effect.log("  - Typed RPC dispatch (schema-validated at both ends)")
  yield* Effect.log("  - TestRunner = all in-memory, zero overhead")
  yield* Effect.log("  - SingleRunner uses SQLite for persistence")
  yield* Effect.log("  - HttpRunner/SocketRunner for remote workers — same API")
}).pipe(Effect.scoped)

const MainLayer = TaskWorker.toLayer(TaskWorkerHandlers).pipe(
  Layer.provideMerge(TestRunner.layer),
)

Effect.runPromise(
  program.pipe(Effect.provide(MainLayer))
).catch(console.error)
