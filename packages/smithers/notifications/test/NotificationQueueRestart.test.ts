/**
 * What the queue still knows after the process that admitted died.
 *
 * `NotificationQueue.test.ts` runs every case over one in-memory journal and
 * one queue, which cannot separate "the journal records this" from "the layer
 * remembered it". These cases run over a real SQLite file, close the first
 * stack completely, and build a SECOND queue over the same rows, which is the
 * only way to prove that the drain identity, the pending fold, and a refusal
 * are properties of what was written rather than of a live process.
 */
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal } from "@smthrs/journal"
import * as Migrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Notification } from "../src/Notification.vibe"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-queue-restart-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const runId = "restart-run"

const item = (id: string, targetLineageId: string): Notification => ({
  _tag: "human-steer",
  id,
  delivery: "steer",
  targetLineageId,
  provenance: {
    sourceRunId: "operator",
    sourceLineageId: "operator/root",
    sourceTurn: 0,
    sourceActor: "human:will"
  },
  payload: { body: id }
})

const event = (id: string, targetLineageId: string, coalescingKey: string): Notification => ({
  _tag: "system-event",
  id,
  delivery: "queue",
  targetLineageId,
  coalescingKey,
  provenance: {
    sourceRunId: "supervisor",
    sourceLineageId: "supervisor/root",
    sourceTurn: 0,
    sourceActor: "system"
  },
  payload: { body: id }
})

/** A queue over the SQLite file at `filename`, at the capacity a case chooses. */
const over = (filename: string, capacity: number) =>
  NotificationQueue.layerWith({ capacity }).pipe(
    Layer.provideMerge(
      SqlJournal.layer({ capacity: 1024, overflow: "reject" }).pipe(
        Layer.provide(
          Layer.provideMerge(
            Migrations.layer,
            Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
          )
        )
      )
    )
  )

const run = <A, E>(
  filename: string,
  capacity: number,
  body: Effect.Effect<A, E, NotificationQueue.NotificationQueue | Journal.Journal>
): Promise<A> => Effect.runPromise(body.pipe(Effect.provide(over(filename, capacity)), Effect.scoped, Effect.orDie))

describe("a notification queue rebuilt over the rows it left on disk", () => {
  it("lets the replacement process drain the other lineage at the same boundary", async () => {
    const filename = join(directory, "lineages.sqlite")
    const first = await run(
      filename,
      128,
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit(runId, item("root-steer", "run/root"))
        yield* queue.admit(runId, item("child-steer", "run/root/child"))
        return yield* queue.drain({
          runId,
          targetLineageId: "run/root",
          boundary: "turn-1",
          wouldIdle: false
        })
      })
    )

    const second = await run(
      filename,
      128,
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        // A drain identity keyed on the boundary alone would read the record
        // the dead process wrote as this lineage's own delivery.
        const child = yield* queue.drain({
          runId,
          targetLineageId: "run/root/child",
          boundary: "turn-1",
          wouldIdle: false
        })
        const repeated = yield* queue.drain({
          runId,
          targetLineageId: "run/root",
          boundary: "turn-1",
          wouldIdle: false
        })
        return { child, repeated, pending: yield* queue.pending(runId) }
      })
    )

    expect(first.notifications.map(({ id }) => id)).toEqual(["root-steer"])
    expect(second.child.notifications.map(({ id }) => id)).toEqual(["child-steer"])
    expect(second.child.duplicate).toBe(false)
    // The record the first process committed is what the repeat reports, so
    // two processes never disagree about what a boundary delivered.
    expect(second.repeated.duplicate).toBe(true)
    expect(second.repeated.notifications.map(({ id }) => id)).toEqual(["root-steer"])
    expect(second.pending).toEqual([])
  })

  it("keeps each lineage's event under a shared coalescing key across a restart", async () => {
    const filename = join(directory, "coalescing-lineages.sqlite")
    const first = await run(
      filename,
      128,
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const root = yield* queue.admit(runId, event("root-event", "run/root", "progress"))
        const child = yield* queue.admit(runId, event("child-event", "run/root/child", "progress"))
        const laterRoot = yield* queue.admit(runId, event("root-event-2", "run/root", "progress"))
        return { root, child, laterRoot }
      })
    )

    const second = await run(
      filename,
      128,
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        // The replacement process folds the journal from nothing, so a
        // key-only match here would drop one branch's event a second time.
        const root = yield* queue.drain({ runId, targetLineageId: "run/root", boundary: "turn-1", wouldIdle: true })
        const child = yield* queue.drain({
          runId,
          targetLineageId: "run/root/child",
          boundary: "turn-1",
          wouldIdle: true
        })
        return { root, child, pending: yield* queue.pending(runId) }
      })
    )

    expect([first.root.decision, first.child.decision, first.laterRoot.decision]).toEqual([
      "admitted",
      "admitted",
      "coalesced"
    ])
    expect(second.root.notifications.map(({ id }) => id)).toEqual(["root-event-2"])
    expect(second.child.notifications.map(({ id }) => id)).toEqual(["child-event"])
    expect(second.pending).toEqual([])
  })

  it("leaves a refused notification admissible to the process that finds room", async () => {
    const filename = join(directory, "refused.sqlite")
    const first = await run(
      filename,
      1,
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.admit(runId, item("held", "run/root"))
        return yield* queue.admit(runId, item("refused", "run/root"))
      })
    )

    const second = await run(
      filename,
      1,
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* queue.drain({ runId, targetLineageId: "run/root", boundary: "turn-1", wouldIdle: false })
        return { retried: yield* queue.admit(runId, item("refused", "run/root")) }
      })
    )

    expect(first.decision).toBe("rejected-full")
    expect(first.seq).toBeUndefined()
    // Nothing durable records the refusal, so the id is not burned: the next
    // process admits it for real once the boundary has drained.
    expect(second.retried).toMatchObject({ decision: "admitted", duplicate: false })
  })
})
