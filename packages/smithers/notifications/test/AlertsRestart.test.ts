/**
 * What an alerter still knows after the process that paged died.
 *
 * `Alerts.test.ts` runs every durability case over one in-memory journal and
 * one `AlertRuntime`, which cannot separate "the delivery record works" from
 * "the runtime remembered". An in-memory database dies with the runtime that
 * opened it, so the two are never apart. These cases run over a real file,
 * close the first stack completely, and build a SECOND runtime over the same
 * rows.
 *
 * The clock is the real one on purpose. A restart is exactly the situation
 * where the wall clock has moved between the page and the tick that follows
 * it, and an alert whose content varied with the reading time would be refused
 * by the queue as an idempotency conflict on the second process's first tick.
 */
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Migrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Alerts from "../src/Alerts.ts"
import * as NotificationQueue from "../src/NotificationQueue.vibe"

const directory = mkdtempSync(join(tmpdir(), "flows-alerts-restart-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const runId = "restart-run"

/**
 * Zero delay, because the delay is not what these cases are about and the real
 * clock is. `firedAt` is `since` plus this, so it stays the journal instant the
 * park was recorded at however long the process that reads it lived.
 */
const policy: Alerts.Policy = {
  defaults: { owner: "oncall" },
  rules: { "waiting-approval": { afterMs: 0, severity: "critical" } }
}

/** A sink that records what it was handed, so each process has its own tally. */
const countingSink = () => {
  const sent: Array<Alerts.Alert> = []
  return {
    sent,
    layer: Layer.succeed(Alerts.Sink)({
      deliver: (alert) =>
        Effect.sync(() => {
          sent.push(alert)
        })
    })
  }
}

/** A whole alerting stack over the SQLite file at `filename`. */
const over = (filename: string, sink: Layer.Layer<Alerts.Sink>) =>
  Alerts.layer(policy).pipe(
    Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, sink)),
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
  sink: Layer.Layer<Alerts.Sink>,
  body: Effect.Effect<A, E, Alerts.AlertRuntime | Journal.Journal | NotificationQueue.NotificationQueue>
): Promise<A> => Effect.runPromise(body.pipe(Effect.provide(over(filename, sink)), Effect.scoped, Effect.orDie))

/** The entry a control plane writes when a run parks for approval. */
const parkForApproval = Effect.flatMap(Journal.Journal, (journal) =>
  journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId: JournalEvent.RunId.make(runId),
      sourceId: JournalEvent.SourceId.make("/control"),
      eventType: "control.run.parked",
      payload: { runId, status: "waiting-approval" }
    })
  ))

const deliveredIds = Effect.flatMap(
  Journal.Journal,
  (journal) =>
    journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 }).pipe(
      Effect.map((page) =>
        page.entries
          .filter((entry) => entry.eventType === Alerts.deliveredEventType)
          .map((entry) => (entry.payload as Record<string, unknown>)["alertId"])
      )
    )
)

describe("an alert runtime rebuilt over the rows it left on disk", () => {
  it("pages once, and the replacement process suppresses the same alert", async () => {
    const filename = join(directory, "delivered.sqlite")
    const paging = countingSink()
    const first = await run(
      filename,
      paging.layer,
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        return { tick: yield* alerts.tick(runId), delivered: yield* deliveredIds }
      })
    )

    const replacement = countingSink()
    const second = await run(
      filename,
      replacement.layer,
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        const queue = yield* NotificationQueue.NotificationQueue
        return {
          tick: yield* alerts.tick(runId),
          delivered: yield* deliveredIds,
          pending: yield* queue.pending(runId)
        }
      })
    )

    expect(first.tick.delivered).toHaveLength(1)
    expect(paging.sent).toHaveLength(1)
    // The replacement process re-derives the identical alert from the journal
    // and finds its delivery record, so nobody is paged twice.
    expect(second.tick.suppressed).toEqual(first.tick.delivered)
    expect(second.tick.delivered).toEqual([])
    expect(replacement.sent).toEqual([])
    expect(second.delivered).toEqual(first.delivered)
    expect(second.delivered).toHaveLength(1)
    expect(second.pending).toHaveLength(1)
  })

  it("retries a page the dead process never got out, on the same alert id", async () => {
    const filename = join(directory, "refused.sqlite")
    const refusing = Layer.succeed(Alerts.Sink)({
      deliver: () => Effect.fail(new Alerts.AlertError({ message: "pager refused" }))
    })
    const first = await run(
      filename,
      refusing,
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        yield* parkForApproval
        return { tick: yield* alerts.tick(runId), delivered: yield* deliveredIds }
      })
    )

    const replacement = countingSink()
    const second = await run(
      filename,
      replacement.layer,
      Effect.gen(function*() {
        const alerts = yield* Alerts.AlertRuntime
        return { tick: yield* alerts.tick(runId), delivered: yield* deliveredIds }
      })
    )

    expect(first.tick.failed).toHaveLength(1)
    expect(first.delivered).toEqual([])
    // Wall-clock time has passed between the two ticks. The re-admission
    // carries the byte-identical alert, so the queue takes it as the duplicate
    // it is instead of refusing a reused id with different content.
    expect(second.tick.delivered).toEqual(first.tick.failed)
    expect(replacement.sent.map((alert) => Alerts.alertId(alert))).toEqual(second.delivered)
    expect(second.delivered).toHaveLength(1)
  })
})
