/**
 * Cancellation attribution over the durable stack: who asked, why, and whether
 * the run was asked at all rather than swept up in an ancestor's cascade.
 *
 * The evidence lives in three places — the control plane's journal entry, the
 * run store's request column, and the engine's interruption record — so every
 * case here writes the real thing. The cascade writes `RunStore.requestCancel`
 * on the descendants because that is exactly what the engine's own cascade
 * writes (`RunDriver.requestCancelDescendants`), and the engine case writes
 * the `flows.engine.interrupted` record the driver emits inside the same
 * transaction as the `cancelled` transition.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { Clock, Effect, type Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Cancellation from "../src/Cancellation.ts"
import { Control } from "../src/Control.vibe"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { Cancellation as Attribution, ListResponse, RunSummary } from "../src/ControlSchema.ts"
import { durable, type DurableStack } from "./DurableStack.ts"

const run = <A, E>(
  body: Effect.Effect<A, E, DurableStack>,
  stack: Layer.Layer<DurableStack> = durable()
): Promise<A> => Effect.runPromise(body.pipe(Effect.provide(stack), Effect.scoped, Effect.orDie))

/** Plans, approves, and starts one control-owned run. */
const start = (suffix: string) =>
  Effect.gen(function*() {
    const control = yield* Control
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
    return receipt.runId
  })

/** A run the engine created, with whichever ancestry column applies. */
const engineRun = (runId: string, parentRunId?: string) =>
  Effect.flatMap(RunStore.RunStore, (store) =>
    store.create(
      runId,
      JSON.stringify({ version: 1, flowName: "Reviewer", payload: {} }),
      parentRunId === undefined ? {} : { parentRunId }
    ).pipe(Effect.orDie))

/** The cascade the engine performs on the descendants of a cancelled run. */
const cascadeTo = (runIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    const at = yield* Clock.currentTimeMillis
    yield* Effect.forEach(runIds, (runId) => store.requestCancel(runId, at).pipe(Effect.orDie), { discard: true })
  })

/** The record the engine's driver journals when an interruption cancels a run. */
const engineInterrupted = (runId: string, interruptedAtMs: number) =>
  Effect.flatMap(Journal.Journal, (journal) =>
    journal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        sourceId: JournalEvent.SourceId.make("engine-store"),
        eventType: Cancellation.interruptedEventType,
        payload: { outcome: "cancelled", interruptedAtMs }
      })
    ).pipe(Effect.orDie))

const summaries = (listed: ListResponse): ReadonlyArray<RunSummary> => listed._tag === "runs" ? listed.items : []

const attributionOf = (listed: ListResponse, runId: string): Attribution | undefined =>
  summaries(listed).find((item) => item.runId === runId)?.cancellation

const listAll = Effect.flatMap(Control, (control) => control.list({ _tag: "runs" }))

describe("cancellation attribution", () => {
  it("names the principal and the reason an operator cancelled for", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runId = yield* start("attributed")
      yield* control.cancel({ runId, reason: "budget", idempotencyKey: `cancel:${runId}` })
      return { runId, listed: yield* listAll }
    }))

    expect(attributionOf(observed.listed, observed.runId)).toMatchObject({
      source: "control",
      reason: "budget",
      principal: { kind: "operator", id: "local" }
    })
  })

  it("carries no reason when the operator gave none", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runId = yield* start("unreasoned")
      yield* control.cancel({ runId, idempotencyKey: `cancel:${runId}` })
      return attributionOf(yield* listAll, runId)
    }))

    expect(observed?.source).toBe("control")
    expect(observed?.reason).toBeUndefined()
    // A cancel still has an actor even when it has no stated reason.
    expect(observed?.principal).toBeDefined()
  })

  it("attributes a cascaded child to the ancestor whose cancel started it", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const parent = yield* start("cascade-parent")
      yield* engineRun("cascade-child-a", parent)
      yield* engineRun("cascade-child-b", parent)
      // A grandchild, so the walk has to pass THROUGH a cascaded run to reach
      // the request that started everything.
      yield* engineRun("cascade-grandchild", "cascade-child-a")
      yield* control.cancel({ runId: parent, reason: "budget", idempotencyKey: `cancel:${parent}` })
      yield* cascadeTo(["cascade-child-a", "cascade-child-b", "cascade-grandchild"])
      const runtime = yield* ControlRuntime
      return {
        parent,
        listed: yield* listAll,
        // The single-run read folds a DIFFERENT scope: the run and its
        // ancestor chain, not the whole database. Two levels up is where a
        // chain that stopped at the first ancestor would give a different
        // answer from the listing.
        grandchildAlone: yield* runtime.getRun("cascade-grandchild"),
        childAlone: yield* runtime.getRun("cascade-child-a")
      }
    }))

    for (const childId of ["cascade-child-a", "cascade-child-b", "cascade-grandchild"]) {
      expect([childId, attributionOf(observed.listed, childId)?.source]).toEqual([childId, "cascade"])
      // The reason and the actor travel down the cascade: "who cancelled this
      // child" is answered by the operator who cancelled its ancestor.
      expect(attributionOf(observed.listed, childId)).toMatchObject({ reason: "budget" })
    }
    expect(attributionOf(observed.listed, "cascade-child-a")?.cascadedFrom).toBe(observed.parent)
    expect(attributionOf(observed.listed, "cascade-grandchild")?.cascadedFrom).toBe("cascade-child-a")
    // Same answers through the scoped path, including the reason that walked
    // two rounds up through a run that was itself only cascaded.
    expect(observed.grandchildAlone.cancellation).toEqual(
      attributionOf(observed.listed, "cascade-grandchild")
    )
    expect(observed.grandchildAlone.cancellation).toMatchObject({
      source: "cascade",
      reason: "budget",
      cascadedFrom: "cascade-child-a"
    })
    expect(observed.childAlone.cancellation).toEqual(attributionOf(observed.listed, "cascade-child-a"))
  })

  it("reports an engine-decided cancellation with no principal at all", async () => {
    const observed = await run(Effect.gen(function*() {
      yield* engineRun("engine-cancelled")
      yield* engineInterrupted("engine-cancelled", 4_242)
      return attributionOf(yield* listAll, "engine-cancelled")
    }))

    expect(observed).toEqual({ source: "engine", requestedAt: 4_242 })
  })

  it("leaves a live run unattributed", async () => {
    const observed = await run(Effect.gen(function*() {
      const runId = yield* start("live")
      return attributionOf(yield* listAll, runId)
    }))

    expect(observed).toBeUndefined()
  })

  it("delivers the attributed request to a watcher", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runId = yield* start("watched")
      yield* control.cancel({ runId, reason: "budget", idempotencyKey: `cancel:${runId}` })
      const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
      return events.find((event) => event.kind === Cancellation.requestedEventType)
    }))

    expect(observed?.payload).toMatchObject({
      source: "control",
      reason: "budget",
      principal: { kind: "operator", id: "local" }
    })
  })
})
