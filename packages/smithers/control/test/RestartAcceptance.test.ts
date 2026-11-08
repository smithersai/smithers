/**
 * What the control plane still knows after the process that learned it died.
 *
 * Every other durable suite here opens one in-memory database and keeps one
 * runtime for the whole case, which proves the projections read rows and
 * nothing about their surviving a restart: an in-memory database dies with the
 * runtime that opened it, so the two are never separable. These cases run over
 * a real file, close the first stack completely, and build a SECOND runtime
 * over the same rows — new owner nonce, new journal writer, new projection
 * caches, no in-process state carried across.
 *
 * The assertions are equality against what the first runtime reported, not a
 * hand-written expectation, because the claim under test is that a restart
 * changes nothing about the answer.
 */
import { NotificationQueue } from "@smthrs/notifications"
import { Effect, type Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Control } from "../src/Control.vibe"
import { ControlRuntime } from "../src/ControlRuntime.vibe"
import type { Cancellation, Principal, RunSummary, SteerMessage } from "../src/ControlSchema.vibe"
import { durable, type DurableStack, fileBundle } from "./DurableStack.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-control-restart-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const principal: Principal = { id: "operator", kind: "test", stampedAt: 1 }

/** A fresh runtime over the rows at `filename`. */
const over = (filename: string): Layer.Layer<DurableStack> => durable({ database: fileBundle(filename) })

const run = <A, E>(stack: Layer.Layer<DurableStack>, body: Effect.Effect<A, E, DurableStack>): Promise<A> =>
  Effect.runPromise(body.pipe(Effect.provide(stack), Effect.scoped, Effect.orDie))

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

describe("a control plane rebuilt over the rows it left on disk", () => {
  it("attributes a cancellation the same way after the process that recorded it died", async () => {
    const filename = join(directory, "attribution.sqlite")
    const first = await run(
      over(filename),
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const runId = yield* start("restart-cancel")
        yield* control.cancel({ runId, reason: "budget", idempotencyKey: `cancel:${runId}` })
        const summary = yield* runtime.getRun(runId)
        return { runId, cancellation: summary.cancellation, status: summary.status }
      })
    )

    const second = await run(
      over(filename),
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const summary = yield* runtime.getRun(first.runId)
        return { cancellation: summary.cancellation, status: summary.status }
      })
    )

    expect(first.cancellation).toMatchObject({
      source: "control",
      reason: "budget",
      principal: { kind: "operator", id: "local" }
    })
    // The attribution is journal evidence, so a runtime that never saw the
    // cancel reports what the one that made it reported.
    expect(second.cancellation).toEqual(first.cancellation as Cancellation)
    expect(second.status).toBe(first.status)
  })

  it("keeps the steer ids and the delivery record a dead process wrote", async () => {
    const filename = join(directory, "steering.sqlite")
    const first = await run(
      over(filename),
      Effect.gen(function*() {
        const control = yield* Control
        const queue = yield* NotificationQueue.NotificationQueue
        const runId = yield* start("restart-steer")
        for (const messageId of ["steer-1", "steer-2"]) {
          const message = { messageId, body: messageId, runId, principal, createdAt: 1 } as SteerMessage
          yield* control.steer({ runId, message, idempotencyKey: `steer:${messageId}` })
        }
        const drained = yield* queue.drain({
          runId,
          targetLineageId: runId,
          boundary: `${runId}/turn-1`,
          wouldIdle: false
        })
        return { runId, drained: drained.notifications.map((item) => item.id) }
      })
    )

    const second = await run(
      over(filename),
      Effect.gen(function*() {
        const control = yield* Control
        const queue = yield* NotificationQueue.NotificationQueue
        const listed = yield* control.list({ _tag: "runs", filters: { runId: first.runId } })
        return {
          pending: yield* queue.pending(first.runId),
          summary: listed._tag === "runs" ? listed.items[0] : undefined
        }
      })
    )

    expect(first.drained).toEqual(["steer-1", "steer-2"])
    // Delivered before the restart stays delivered after it: the queue's
    // evidence is journal rows, not the drained process's memory.
    expect(second.pending).toEqual([])
    expect((second.summary as RunSummary).steering).toEqual({ pending: 0 })
    expect((second.summary as RunSummary).runId).toBe(first.runId)
  })
})
