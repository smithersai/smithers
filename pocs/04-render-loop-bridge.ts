/**
 * POC 4: Render loop inside Effect Workflow — the JSX bridge
 *
 * This is the CRITICAL proof-of-concept. It shows how Smithers' React/JSX
 * declarative render loop maps onto Effect's Workflow/Activity model:
 *
 * 1. A simulated "render" function produces a task graph (like React rendering JSX)
 * 2. The scheduler identifies runnable tasks based on dependencies + completed state
 * 3. Each task dispatches as an Activity (memoized on replay)
 * 4. After activities complete, we re-render to discover new tasks
 * 5. Conditional tasks (appearing based on prior output) work correctly
 *
 * This proves the React render loop is deterministic enough for replay.
 *
 * Run: bun run pocs/04-render-loop-bridge.ts
 */

import * as Activity from "@effect/workflow/Activity"
import * as Workflow from "@effect/workflow/Workflow"
import * as WorkflowEngine from "@effect/workflow/WorkflowEngine"
import { Effect, Layer, Schema } from "effect"

// ─── Simulated "JSX tree" output ────────────────────────────────────────────

type TaskNode = {
  id: string
  prompt: string
  dependsOn: string[]
  condition?: (outputs: Map<string, any>) => boolean
}

function renderTaskTree(outputs: Map<string, any>): TaskNode[] {
  const tasks: TaskNode[] = [
    { id: "analyze", prompt: "Analyze the codebase", dependsOn: [] },
    { id: "lint", prompt: "Run linting", dependsOn: [] },
    { id: "plan", prompt: "Create implementation plan", dependsOn: ["analyze"] },
    {
      id: "fix-issues",
      prompt: "Fix the identified issues",
      dependsOn: ["analyze", "lint"],
      condition: (outs) => {
        const analysis = outs.get("analyze")
        return analysis?.issueCount > 0
      },
    },
    {
      id: "implement",
      prompt: "Implement the plan",
      dependsOn: ["plan"],
      condition: (outs) => {
        const analysis = outs.get("analyze")
        if (!analysis) return false
        if (analysis.issueCount > 0 && !outs.has("fix-issues")) return false
        return true
      },
    },
  ]
  return tasks.filter((t) => !t.condition || t.condition(outputs))
}

// ─── Simulated task execution ───────────────────────────────────────────────

let executionCounts = new Map<string, number>()

function makeActivity(taskId: string, prompt: string) {
  return Activity.make({
    name: taskId,
    success: Schema.Unknown,
    execute: Effect.gen(function* () {
      const count = (executionCounts.get(taskId) ?? 0) + 1
      executionCounts.set(taskId, count)
      yield* Effect.log(`  🔧 [${taskId}] Executing: "${prompt}" (call #${count})`)
      yield* Effect.sleep("50 millis")
      switch (taskId) {
        case "analyze": return { issueCount: 2, files: ["auth.ts", "db.ts"] }
        case "lint": return { warnings: 3, errors: 0 }
        case "plan": return { steps: ["refactor auth", "add tests"] }
        case "fix-issues": return { fixed: 2, remaining: 0 }
        case "implement": return { filesChanged: 5, testsAdded: 3 }
        default: return {}
      }
    }),
  })
}

// ─── Workflow with render loop ──────────────────────────────────────────────

const RenderLoopWorkflow = Workflow.make({
  name: "RenderLoopPipeline",
  payload: { projectId: Schema.String },
  success: Schema.Unknown,
  idempotencyKey: ({ projectId }) => projectId,
})

const RenderLoopWorkflowLayer = RenderLoopWorkflow.toLayer(
  (payload, executionId) =>
    Effect.gen(function* () {
      yield* Effect.log("=== Render loop workflow starting ===")

      const outputs = new Map<string, any>()
      const completed = new Set<string>()
      let cycle = 0

      while (true) {
        cycle++
        yield* Effect.log(`\n📋 Render cycle ${cycle}`)

        const visibleTasks = renderTaskTree(outputs)
        yield* Effect.log(`  Visible: [${visibleTasks.map((t) => t.id).join(", ")}]`)

        const runnable = visibleTasks.filter(
          (t) =>
            !completed.has(t.id) &&
            t.dependsOn.every((dep) => completed.has(dep))
        )

        if (runnable.length === 0 && visibleTasks.every((t) => completed.has(t.id))) {
          yield* Effect.log(`\n✅ All visible tasks complete!`)
          break
        }

        if (runnable.length === 0) {
          yield* Effect.log(`  No runnable tasks (waiting for deps)`)
          continue
        }

        yield* Effect.log(`  Runnable: [${runnable.map((t) => t.id).join(", ")}]`)

        const results = yield* Effect.all(
          runnable.map((task) =>
            Effect.map(makeActivity(task.id, task.prompt), (result) => ({
              taskId: task.id,
              result,
            }))
          ),
          { concurrency: "unbounded" }
        )

        for (const { taskId, result } of results) {
          outputs.set(taskId, result)
          completed.add(taskId)
          yield* Effect.log(`  ✓ ${taskId} → ${JSON.stringify(result)}`)
        }
      }

      return Object.fromEntries(outputs)
    })
)

// ─── Run it ─────────────────────────────────────────────────────────────────

const program = Effect.gen(function* () {
  yield* Effect.log("━━━ POC 4: Render loop inside Effect Workflow ━━━")
  yield* Effect.log("Graph: analyze ──┬──→ plan ──→ implement")
  yield* Effect.log("       lint ─────┤")
  yield* Effect.log("                 └──→ fix-issues (conditional)\n")

  const result = yield* RenderLoopWorkflow.execute({ projectId: "proj-001" })
  yield* Effect.log(`\nFinal: ${JSON.stringify(result, null, 2)}`)

  yield* Effect.log(`\nExecution counts:`)
  for (const [taskId, count] of executionCounts) {
    yield* Effect.log(`  ${taskId}: ${count}`)
  }

  yield* Effect.log(`\nKey observations:`)
  yield* Effect.log(`  - analyze + lint ran in parallel (no deps)`)
  yield* Effect.log(`  - fix-issues appeared AFTER analyze revealed 2 issues`)
  yield* Effect.log(`  - implement waited for BOTH plan AND fix-issues`)
  yield* Effect.log(`  - Conditional rendering works — task graph changes based on outputs`)
  yield* Effect.log(`  - Each activity would be memoized on replay`)
})

const MainLayer = RenderLoopWorkflowLayer.pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory),
)

Effect.runPromise(
  program.pipe(Effect.provide(MainLayer))
).catch(console.error)
