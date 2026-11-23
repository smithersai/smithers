/**
 * A monitor attached to a scope, and the line each of its beats prints as.
 *
 * `Monitor.attach` is the long-lived form of `Monitor.run`: it beats from a
 * background fiber until the watched run settles or the caller's scope
 * closes. The cases run over the real durable control plane, and they drive
 * the watched run from `onBeat`, so every terminal transition lands between
 * two known beats instead of racing a clock.
 */
import { Deferred, Effect, Exit, Scope } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { InvalidInput } from "../src/ControlError.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { RunStatus } from "../src/ControlSchema.ts"
import * as Monitor from "../src/Monitor.ts"
import { durable, type DurableStack } from "./DurableStack.ts"
import { park } from "./Park.ts"

const run = <A, E>(body: Effect.Effect<A, E, DurableStack | Scope.Scope>): Promise<A> =>
  Effect.runPromise(body.pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie))

/** Plans, approves, and starts one control-owned run. */
const start = (suffix: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const runtime = yield* ControlRuntime
    const card = yield* control.plan({ flowId: "system/test", input: { suite: suffix } })
    yield* control.approve({ ...card.approval, idempotencyKey: `approve:${suffix}` })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${suffix}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a started run")
    yield* runtime.resume(receipt.runId)
    return receipt.runId
  })

/** Parks a run on the reason a sweep leaves behind, so it can stall. */
const parkReleased = (runId: string) =>
  Effect.gen(function*() {
    yield* park(yield* ControlRuntime, runId)
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE flows_runs SET waiting_reason = 'released' WHERE run_id = ${runId}`.pipe(Effect.orDie)
  })

/** Settles a run to `status` the way its owner would. */
const settle = (runId: string, status: RunStatus) =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime
    const fence = yield* runtime.claimFence(runId)
    yield* runtime.writeStatus(runId, fence, status)
  })

describe("Monitor.attach", () => {
  const terminalCases: ReadonlyArray<[RunStatus, Monitor.Health]> = [
    ["completed", "healthy"],
    ["failed", "failing"],
    ["cancelled", "healthy"]
  ]

  for (const [status, health] of terminalCases) {
    it(`stops on its own once the watched run is ${status}`, async () => {
      const observed = await run(Effect.gen(function*() {
        const runId = yield* start(`attach-${status}`)
        const context = yield* Effect.context<DurableStack>()
        const seen: Array<Monitor.Beat> = []
        const attached = yield* Monitor.attach(runId, {
          intervalMs: 0,
          onBeat: (beat) =>
            Effect.sync(() => seen.push(beat)).pipe(
              Effect.andThen(beat.beat === 0 ? settle(runId, status).pipe(Effect.orDie) : Effect.void),
              Effect.provideContext(context)
            )
        })
        return { runId, report: yield* attached.await, seen }
      }))

      expect(observed.report.runId).toBe(observed.runId)
      expect(observed.report.beats.map((beat) => beat.beat)).toEqual([0, 1])
      expect(observed.report.health).toBe(health)
      expect(observed.seen).toEqual(observed.report.beats)
    })
  }

  it("keeps beating a settled run when told not to stop", async () => {
    const report = await run(Effect.gen(function*() {
      const runId = yield* start("attach-keep-going")
      yield* settle(runId, "completed")
      const attached = yield* Monitor.attach(runId, { intervalMs: 0, maxChecks: 3, stopOnTerminal: false })
      return yield* attached.await
    }))

    expect(report.beats.map((beat) => beat.health)).toEqual(["healthy", "healthy", "healthy"])
  })

  it("retains only the newest beats a caller asks for", async () => {
    const report = await run(Effect.gen(function*() {
      const runId = yield* start("attach-retain")
      const attached = yield* Monitor.attach(runId, { intervalMs: 0, maxChecks: 4, retainBeats: 2 })
      return yield* attached.await
    }))

    expect(report.beats.map((beat) => beat.beat)).toEqual([2, 3])
  })

  const teardownCases: ReadonlyArray<[string, Monitor.Health, boolean]> = [
    ["healthy", "healthy", false],
    ["stalled", "stalled", true]
  ]

  for (const [label, health, stall] of teardownCases) {
    it(`is interrupted when its scope closes while the run is ${label}`, async () => {
      const observed = await run(Effect.gen(function*() {
        const runId = yield* start(`attach-close-${label}`)
        if (stall) yield* parkReleased(runId)
        const reached = yield* Deferred.make<Monitor.Beat>()
        const scope = yield* Scope.make()
        const attached = yield* Monitor.attach(runId, {
          intervalMs: 5,
          stallBeats: 1,
          onBeat: (beat) => beat.health === health ? Deferred.succeed(reached, beat).pipe(Effect.asVoid) : Effect.void
        }).pipe(Effect.provideService(Scope.Scope, scope))
        const beat = yield* Deferred.await(reached)
        const before = attached.fiber.pollUnsafe()
        yield* Scope.close(scope, Exit.void)
        return { beat, before, after: attached.fiber.pollUnsafe() }
      }))

      expect(observed.beat.health).toBe(health)
      expect(observed.before).toBeUndefined()
      expect(observed.after !== undefined && Exit.hasInterrupts(observed.after)).toBe(true)
    })
  }

  it("delivers healed beats when it auto-heals a stall", async () => {
    const observed = await run(Effect.gen(function*() {
      const runId = yield* start("attach-heal")
      yield* parkReleased(runId)
      const seen: Array<Monitor.Beat> = []
      const attached = yield* Monitor.attach(runId, {
        intervalMs: 0,
        maxChecks: 3,
        stallBeats: 1,
        autoHeal: ["stalled"],
        onBeat: (beat) => Effect.sync(() => seen.push(beat))
      })
      return { report: yield* attached.await, seen }
    }))

    const healed = observed.seen.find((beat) => beat.healed !== undefined)
    expect(healed).toMatchObject({ health: "stalled", remedy: "resume", healed: "resume" })
    expect(healed?.receipt?._tag).toBe("Accepted")
    expect(observed.seen).toEqual(observed.report.beats)
  })

  it("refuses options it cannot beat under before forking anything", async () => {
    const failure = await run(Effect.gen(function*() {
      const runId = yield* start("attach-invalid")
      return yield* Effect.flip(Monitor.attach(runId, { stallBeats: 0 }))
    }))

    expect(failure).toBeInstanceOf(InvalidInput)
    expect((failure as InvalidInput).issue).toBe("Monitor.run: stallBeats must be a positive integer")
  })
})

describe("Monitor.formatBeat", () => {
  const table: ReadonlyArray<[Monitor.Beat, string]> = [
    [
      { beat: 0, health: "healthy", sequence: 4, runId: "run-1", beatsWithoutProgress: 0 },
      "run=run-1 beat=0 health=healthy beatsWithoutProgress=0"
    ],
    [
      {
        beat: 3,
        health: "stalled",
        sequence: 4,
        runId: "run-1",
        beatsWithoutProgress: 3,
        remedy: "resume",
        healed: "resume",
        receipt: { _tag: "Accepted", receiptId: "r", runId: "run-1" }
      },
      "run=run-1 beat=3 health=stalled beatsWithoutProgress=3 remedy=resume healed=resume receipt=Accepted"
    ],
    [
      {
        beat: 2,
        health: "wedged-node",
        sequence: 4,
        runId: "run-1",
        beatsWithoutProgress: 5,
        remedy: "resume",
        receipt: { _tag: "Conflict", message: "the key names another mutation" }
      },
      "run=run-1 beat=2 health=wedged-node beatsWithoutProgress=5 remedy=resume receipt=Conflict"
    ],
    [
      { beat: 1, health: "failing", sequence: 9, runId: "run-1", beatsWithoutProgress: 0, remedy: "cancel" },
      "run=run-1 beat=1 health=failing beatsWithoutProgress=0 remedy=cancel"
    ],
    [
      { beat: 1, health: "runaway-loop", sequence: 9, runId: "run-1", beatsWithoutProgress: 0 },
      "run=run-1 beat=1 health=runaway-loop beatsWithoutProgress=0"
    ],
    [
      { beat: 1, health: "awaiting-human", sequence: 9, runId: "run-1", beatsWithoutProgress: 7 },
      "run=run-1 beat=1 health=awaiting-human beatsWithoutProgress=7"
    ],
    [{ beat: 0, health: "unknown", sequence: -1 }, "beat=0 health=unknown"],
    [
      { beat: 0, health: "healthy", sequence: 1, runId: "run 1\nforged=1" },
      "run=\"run 1\\nforged=1\" beat=0 health=healthy"
    ]
  ]

  it.each(table)("renders %o on one line", (beat, line) => {
    expect(Monitor.formatBeat(beat)).toBe(line)
    expect(Monitor.formatBeat(beat)).not.toContain("\n")
  })

  it("covers every health the vocabulary names", () => {
    const rendered = new Set(table.map(([beat]) => beat.health))
    expect([...rendered].sort()).toEqual([...Monitor.Health.literals].sort())
  })
})
