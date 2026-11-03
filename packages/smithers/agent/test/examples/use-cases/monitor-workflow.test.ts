import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { DurableDeferred, HumanTask } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schedule from "effect/Schedule"
import type * as Schema from "effect/Schema"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import type { Condition, Health } from "../../../examples/use-cases/monitor-workflow.vibe"
import { layer, MonitorWorkflow, rules } from "../../../examples/use-cases/monitor-workflow.vibe"

const directory = mkdtempSync(join(tmpdir(), "monitor-workflow-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A person who answers each question the run tree parks on with the next of
 * `answers`, recording each question. It runs beside the run on the same
 * engine and reads the whole tree, because a later beat parks in a later
 * trampoline round.
 */
const person = (executionId: string, answers: ReadonlyArray<typeof Schema.Json.Type>, questions: Array<string>) =>
  Layer.effectDiscard(Effect.forkScoped(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const answered = new Set<string>()
      for (const value of answers) {
        const open = (rows: ReadonlyArray<DurableEngineState.WaitingRow>) =>
          rows.find((row) => row.reason === "approval" && row.token !== null && !answered.has(row.token))
        const rows = yield* state.waitingTree(executionId).pipe(
          Effect.repeat({ until: (rows) => open(rows) !== undefined, schedule: Schedule.spaced(10) })
        )
        const row = open(rows)!
        answered.add(row.token!)
        const request = typeof row.request === "string" ? JSON.parse(row.request) : row.request
        questions.push(request.prompt)
        yield* HumanTask.answer({ token: DurableDeferred.Token.make(row.token!), value })
      }
    }).pipe(Effect.orDie)
  ))

const health = (condition: Condition, runStatus: string, targetNodeId?: string): typeof Health.Type => ({
  condition,
  runStatus,
  ...(targetNodeId === undefined ? {} : { targetNodeId }),
  evidence: `${condition} evidence`,
  summary: `${condition} summary`
})

/**
 * A watcher that answers its `n`-th sample with `beats[n - 1]` ("broken"
 * answers off-schema, and so does every correction re-ask of it), and handlers
 * that report the condition and the evidence they were handed. Samples and
 * handler instructions are recorded in order.
 */
const script = (beats: ReadonlyArray<typeof Health.Type | "broken">) => {
  const samples: Array<string> = []
  const handled: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const handler = /The heartbeat classified run run-7 as "(.+)"\.\n\nHealth sample:\n(.+)\n\n(.+)/.exec(asked)
    if (handler !== null) {
      const [, condition, sample, instruction] = handler
      handled.push(`${condition}: ${instruction}`)
      return {
        action: `handled ${condition}`,
        changed: false,
        summary: `acted on ${JSON.parse(sample!).evidence}`
      }
    }
    if (asked.includes("You are the heartbeat health check for run `run-7`")) {
      if (asked.includes("\"unexpected\"")) return { unexpected: true }
      const beat = beats[samples.length]
      if (beat === undefined) return undefined
      samples.push(beat === "broken" ? "broken" : `${beat.condition}/${beat.runStatus}`)
      return beat === "broken" ? { unexpected: true } : beat
    }
    return undefined
  }
  return { answer, handled, samples }
}

it("keeps the 0.x rule table: no rule for healthy, heal stalled and wedged nodes, escalate the rest", () => {
  expect(rules.map((rule) => `${rule.condition}: ${rule.then._tag}`)).toEqual([
    "stalled: handle",
    "wedged-node: handle",
    "runaway-loop: escalate",
    "awaiting-human: handle",
    "failing: handle",
    "unknown: escalate"
  ])
})

// `it.live` throughout: a beat after the first sleeps on a durable timer and
// the engine re-drives the parked round on a schedule, and a test clock nobody
// advances would leave both asleep forever.
it.live("heals what the table routes, keeps watching a healthy run, and stops when it finishes", () =>
  Effect.gen(function*() {
    const { answer, handled, samples } = script([
      health("stalled", "running"),
      health("wedged-node", "running", "compile"),
      health("healthy", "running"),
      health("healthy", "finished")
    ])
    const last = yield* Kit.run(MonitorWorkflow, {
      watchRunId: "run-7",
      watchWorkflowPath: "/repo/flows/build.ts",
      intervalMs: 1
    }, {
      filename: join(directory, "heal.sqlite"),
      executionId: "monitor-heal",
      script: answer,
      actions: layer
    })

    // One sample per beat until the watched run finished.
    expect(samples).toEqual(["stalled/running", "wedged-node/running", "healthy/running", "healthy/finished"])
    // Each unhealthy beat reached its own handler with the command its sample allows.
    expect(handled).toHaveLength(2)
    expect(handled[0]).toContain(
      "stalled: First confirm that the health sample explicitly reports `ownerActive: false`"
    )
    expect(handled[0]).toContain("`bunx smthrs up '/repo/flows/build.ts' --resume --run-id 'run-7'`")
    expect(handled[1]).toContain(
      "`bunx smthrs retry-task '/repo/flows/build.ts' --run-id 'run-7' --node-id 'compile'`"
    )
    expect(last).toEqual({ beats: 4, health: health("healthy", "finished"), action: null })
  }))

// The person polls the engine's waiting rows on a schedule as well.
it.live(
  "asks a person about a condition it may not heal and settles with their answer at the bound",
  () =>
    Effect.gen(function*() {
      const { answer, handled, samples } = script([
        health("healthy", "running"),
        health("runaway-loop", "running", "retry-loop")
      ])
      const questions: Array<string> = []
      const executionId = "monitor-escalate"
      const decision = { action: "raised the loop's bound", changed: true, summary: "operator intervened" }
      const last = yield* Kit.run(MonitorWorkflow, { watchRunId: "run-7", intervalMs: 1, maxChecks: 2 }, {
        filename: join(directory, "escalate.sqlite"),
        executionId,
        script: answer,
        actions: Layer.mergeAll(layer, person(executionId, [decision], questions))
      })

      expect(samples).toEqual(["healthy/running", "runaway-loop/running"])
      // No agent acted on the runaway loop; the person was asked, with the second beat's evidence.
      expect(handled).toEqual([])
      expect(questions).toEqual([
        "Run run-7 looks \"runaway-loop\" and the monitor is not allowed to fix it on its own.\n" +
        "Evidence: \"runaway-loop evidence\"\n" +
        "Watched run status: running\n" +
        "Implicated node: retry-loop\n" +
        "The loop is iterating without converging. Cancel the run, let it keep going, or change its exit condition?"
      ])
      expect(last).toEqual({ beats: 2, health: health("runaway-loop", "running", "retry-loop"), action: decision })
    }),
  { timeout: 60_000 }
)

it.live("survives a failed sample and refuses to resume without a workflow path", () =>
  Effect.gen(function*() {
    const { answer, handled, samples } = script(["broken", health("stalled", "running")])
    const last = yield* Kit.run(MonitorWorkflow, { watchRunId: "run-7", intervalMs: 1, maxChecks: 2 }, {
      filename: join(directory, "broken.sqlite"),
      executionId: "monitor-broken",
      script: answer,
      actions: layer
    })

    // The failed sample routed nowhere, and the next beat sampled again.
    expect(samples).toEqual(["broken", "stalled/running"])
    expect(handled).toEqual([
      "stalled: Do not resume: watchWorkflowPath was not supplied. Report that the monitor cannot build a safe resume command."
    ])
    expect(last).toEqual({
      beats: 2,
      health: health("stalled", "running"),
      action: { action: "handled stalled", changed: false, summary: "acted on stalled evidence" }
    })
  }))
