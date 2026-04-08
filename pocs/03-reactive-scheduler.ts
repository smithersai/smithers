/**
 * POC 3: Reactive scheduling with Effect.Queue
 *
 * Demonstrates the replacement for Smithers' synchronous
 * `while(true) { render → execute → Promise.race }` scheduler loop:
 * - Tasks complete and trigger re-scheduling immediately via a queue
 * - Multiple completions are batched (takeAll)
 * - External events (signals, approvals) also trigger re-scheduling
 * - No blocking on Promise.race — fully reactive
 *
 * Run: bun run pocs/03-reactive-scheduler.ts
 */

import { Effect, Queue, Fiber, Ref } from "effect"

// ─── Types ──────────────────────────────────────────────────────────────────

type Task = {
  id: string
  durationMs: number
  dependsOn: string[]
}

type ScheduleTrigger =
  | { reason: "initial" }
  | { reason: "task-completed"; taskId: string }
  | { reason: "external-event"; event: string }

// ─── Simulated task graph ───────────────────────────────────────────────────
// A → B → D
// A → C → D
// Independent tasks can run in parallel

const tasks: Task[] = [
  { id: "A", durationMs: 100, dependsOn: [] },
  { id: "B", durationMs: 150, dependsOn: ["A"] },
  { id: "C", durationMs: 200, dependsOn: ["A"] },
  { id: "D", durationMs: 50, dependsOn: ["B", "C"] },
]

// ─── Reactive scheduler ────────────────────────────────────────────────────

const program = Effect.gen(function* () {
  yield* Effect.log("━━━ POC 3: Reactive scheduling with Effect.Queue ━━━")
  yield* Effect.log("")
  yield* Effect.log("Task graph: A → B,C → D (B and C run in parallel)")
  yield* Effect.log("")

  const triggerQueue = yield* Queue.unbounded<ScheduleTrigger>()
  const completedTasks = yield* Ref.make<Set<string>>(new Set())
  const inflightTasks = yield* Ref.make<Set<string>>(new Set())
  const schedulingLog = yield* Ref.make<string[]>([])

  const log = (msg: string) =>
    Effect.flatMap(Ref.update(schedulingLog, (arr) => [...arr, msg]), () =>
      Effect.log(msg)
    )

  // Worker: executes a task and triggers re-scheduling when done
  const executeTask = (task: Task) =>
    Effect.gen(function* () {
      yield* log(`  ▶ Starting task ${task.id} (${task.durationMs}ms)`)
      yield* Ref.update(inflightTasks, (s) => new Set([...s, task.id]))
      yield* Effect.sleep(`${task.durationMs} millis`)
      yield* Ref.update(completedTasks, (s) => new Set([...s, task.id]))
      yield* Ref.update(inflightTasks, (s) => {
        const next = new Set(s)
        next.delete(task.id)
        return next
      })
      yield* log(`  ✓ Task ${task.id} completed`)
      // This is the key: completion triggers re-scheduling immediately
      yield* Queue.offer(triggerQueue, { reason: "task-completed", taskId: task.id })
    })

  // Determine which tasks are runnable
  const getRunnableTasks = Effect.gen(function* () {
    const completed = yield* Ref.get(completedTasks)
    const inflight = yield* Ref.get(inflightTasks)
    return tasks.filter(
      (t) =>
        !completed.has(t.id) &&
        !inflight.has(t.id) &&
        t.dependsOn.every((dep) => completed.has(dep))
    )
  })

  const isFinished = Effect.map(Ref.get(completedTasks), (s) =>
    tasks.every((t) => s.has(t.id))
  )

  // ─── Scheduler loop (reactive, not polling) ─────────────────────────────

  // Kick off with initial trigger
  yield* Queue.offer(triggerQueue, { reason: "initial" })

  const startTime = Date.now()

  let cycles = 0
  while (true) {
    // Wait for a trigger (non-blocking when triggers are queued)
    const trigger = yield* Queue.take(triggerQueue)
    // Drain any other pending triggers (batch simultaneous completions)
    const batch = yield* Queue.takeAll(triggerQueue)
    cycles++

    const triggerReasons = [trigger, ...batch]
      .map((t) => {
        if (t.reason === "task-completed") return `task-completed:${t.taskId}`
        return t.reason
      })
      .join(", ")

    yield* log(`\n📋 Schedule cycle ${cycles} [triggers: ${triggerReasons}]`)

    // Check if we're done
    if (yield* isFinished) {
      yield* log(`\n✅ All tasks complete!`)
      break
    }

    // Find runnable tasks and dispatch them
    const runnable = yield* getRunnableTasks
    if (runnable.length === 0) {
      yield* log(`  (no runnable tasks — waiting for inflight to complete)`)
      continue
    }

    yield* log(`  Runnable: [${runnable.map((t) => t.id).join(", ")}]`)

    // Fork all runnable tasks — they complete async and trigger re-scheduling
    for (const task of runnable) {
      yield* Effect.fork(executeTask(task))
    }
  }

  const elapsed = Date.now() - startTime
  yield* Effect.log(`\nTotal time: ~${elapsed}ms`)
  yield* Effect.log(`Schedule cycles: ${cycles}`)
  yield* Effect.log(``)
  yield* Effect.log(`Key observations:`)
  yield* Effect.log(`  - A started immediately (no deps)`)
  yield* Effect.log(`  - B and C started in parallel after A completed`)
  yield* Effect.log(`  - D started only after both B AND C completed`)
  yield* Effect.log(`  - No Promise.race — completions triggered re-scheduling via Queue`)
  yield* Effect.log(`  - Multiple triggers batched via Queue.takeAll`)
})

Effect.runPromise(program).catch(console.error)
