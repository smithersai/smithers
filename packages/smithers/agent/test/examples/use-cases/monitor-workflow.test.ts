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
import * as Kit from "../../../examples/use-cases/kit.ts"
import type { Condition, Health } from "../../../examples/use-cases/monitor-workflow.ts"
import { Check, Handle, layer, MonitorWorkflow, rules, settings } from "../../../examples/use-cases/monitor-workflow.ts"

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

const health = (
  condition: Condition,
  runStatus: string,
  targetNodeId?: string,
  ownerActive?: boolean
): typeof Health.Type => ({
  condition,
  runStatus,
  ...(ownerActive === undefined ? {} : { ownerActive }),
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

it("keeps the 0.x rule table: no rule for healthy, heal ownerless stalled and wedged runs, escalate the rest", () => {
  expect(rules.map((rule) => `${rule.condition}${rule.ownerless ? " (ownerless)" : ""}: ${rule.then._tag}`)).toEqual([
    "stalled (ownerless): handle",
    "stalled: escalate",
    "wedged-node (ownerless): handle",
    "wedged-node: escalate",
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
      health("stalled", "running", undefined, false),
      health("wedged-node", "running", "compile", false),
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
    const { answer, handled, samples } = script(["broken", health("stalled", "running", undefined, false)])
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
      health: health("stalled", "running", undefined, false),
      action: { action: "handled stalled", changed: false, summary: "acted on stalled evidence" }
    })
  }))

// A resume or retry against a live owner races it, and an unread owner may be live.
it.live(
  "asks a person instead of healing a stalled or wedged run whose owner is active or unreported",
  () =>
    Effect.gen(function*() {
      const { answer, handled, samples } = script([
        health("stalled", "running", undefined, true),
        health("wedged-node", "running", "compile")
      ])
      const questions: Array<string> = []
      const executionId = "monitor-owned"
      const decision = { action: "none", changed: false, summary: "owner is still working" }
      const last = yield* Kit.run(MonitorWorkflow, {
        watchRunId: "run-7",
        watchWorkflowPath: "/repo/flows/build.ts",
        intervalMs: 1,
        maxChecks: 2
      }, {
        filename: join(directory, "owned.sqlite"),
        executionId,
        script: answer,
        actions: Layer.mergeAll(layer, person(executionId, [decision, decision], questions))
      })

      expect(samples).toEqual(["stalled/running", "wedged-node/running"])
      expect(handled).toEqual([])
      expect(questions).toEqual([
        "Run run-7 looks \"stalled\" and the monitor is not allowed to fix it on its own.\n" +
        "Evidence: \"stalled evidence\"\n" +
        "Watched run status: running\n" +
        "Should this run be resumed?",
        "Run run-7 looks \"wedged-node\" and the monitor is not allowed to fix it on its own.\n" +
        "Evidence: \"wedged-node evidence\"\n" +
        "Watched run status: running\n" +
        "Implicated node: compile\n" +
        "Should this node be retried, or is the failure real?"
      ])
      expect(last).toEqual({ beats: 2, health: health("wedged-node", "running", "compile"), action: decision })
    }),
  { timeout: 60_000 }
)

it.live("fails at once when the watcher's seat has no model, instead of watching blind", () =>
  Effect.gen(function*() {
    const { answer, samples } = script([])
    const seats: Array<string> = []
    const error = yield* Effect.flip(Kit.run(MonitorWorkflow, { watchRunId: "run-7", intervalMs: 1 }, {
      filename: join(directory, "unresolved.sqlite"),
      executionId: "monitor-unresolved",
      script: answer,
      actions: Layer.mergeAll(Check.layer.pipe(Layer.provide(Kit.refusingSeats(seats))), Handle.layer)
    }))

    expect(seats).toContain("anthropic:claude-sonnet-5-5")
    expect(samples).toEqual([])
    expect(error._tag).toBe("@smthrs/agent/Seat/SeatUnresolved")
  }))

it.live("fails after maxMisses beats in a row with no sample", () =>
  Effect.gen(function*() {
    const { answer, handled, samples } = script(["broken", "broken", "broken"])
    const error = yield* Effect.flip(Kit.run(MonitorWorkflow, { watchRunId: "run-7", intervalMs: 1 }, {
      filename: join(directory, "blind.sqlite"),
      executionId: "monitor-blind",
      script: answer,
      actions: layer
    }))

    expect(settings.maxMisses).toBe(3)
    expect(samples).toEqual(["broken", "broken", "broken"])
    expect(handled).toEqual([])
    expect(error).toMatchObject({
      _tag: "examples/MonitorWorkflow/SamplesMissed",
      watchRunId: "run-7",
      misses: 3,
      message: "The monitor had no sample of run run-7 for 3 beats in a row."
    })
  }))

it.live("counts only misses in a row: a sample between them resets the count", () =>
  Effect.gen(function*() {
    const { answer, samples } = script([
      "broken",
      "broken",
      health("healthy", "running"),
      "broken",
      "broken",
      health("healthy", "finished")
    ])
    const last = yield* Kit.run(MonitorWorkflow, { watchRunId: "run-7", intervalMs: 1 }, {
      filename: join(directory, "reset.sqlite"),
      executionId: "monitor-reset",
      script: answer,
      actions: layer
    })

    expect(samples).toEqual(["broken", "broken", "healthy/running", "broken", "broken", "healthy/finished"])
    expect(last).toEqual({ beats: 6, health: health("healthy", "finished"), action: null })
  }))

it.live("settles at the bound when the last beat had no sample but the misses stay under maxMisses", () =>
  Effect.gen(function*() {
    const { answer, samples } = script([health("healthy", "running"), "broken"])
    const last = yield* Kit.run(MonitorWorkflow, { watchRunId: "run-7", intervalMs: 1, maxChecks: 2 }, {
      filename: join(directory, "bound-miss.sqlite"),
      executionId: "monitor-bound-miss",
      script: answer,
      actions: layer
    })

    expect(samples).toEqual(["healthy/running", "broken"])
    expect(last).toEqual({ beats: 2, health: null, action: null })
  }))
