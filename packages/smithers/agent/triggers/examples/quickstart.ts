/**
 * The quickstart in `docs/quickstart.md`, as a program a test runs.
 *
 * One trigger goes from a declaration to a launched run. The store is the
 * production SQLite one on an in-memory database and the scheduler is the
 * production one. The `Runner` records launches instead of reaching a control
 * plane, and the Effect `Clock` is a test clock, so a nightly schedule crosses
 * two boundaries in milliseconds.
 *
 * @since 1.0.0-rc.7
 */

import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import { TestClock } from "effect/testing"

/**
 * What the quickstart observed: every launch the runner recorded, and the
 * stored trigger row after the second tick.
 *
 * @since 1.0.0-rc.7
 */
export interface QuickstartResult {
  readonly launched: ReadonlyArray<Scheduler.StartInput>
  readonly registered: Option.Option<TriggerStore.Registered>
}

/**
 * Registers a nightly trigger, runs one tick on first sight and one tick a day
 * later, and answers with the launches and the stored row.
 *
 * @returns The recorded launches and the trigger as the store holds it.
 * @since 1.0.0-rc.7
 */
export const runQuickstart = (): Promise<QuickstartResult> => {
  const launched: Array<Scheduler.StartInput> = []

  const database = Layer.provideMerge(
    DurableWriter.layer(),
    NodeDatabase.layer({ filename: ":memory:" })
  )

  // The launcher seam: record the launch and answer with a run id.
  const runner = Scheduler.layerNoopRunner({
    start: (input) =>
      Effect.sync(() => {
        launched.push(input)
        return input.idempotencyKey
      })
  })

  const layer = Layer.mergeAll(
    SqlTriggerStore.layer.pipe(Layer.provide(database)),
    runner,
    TestClock.layer()
  )

  const program = Effect.scoped(Effect.gen(function*() {
    const triggers = yield* TriggerStore.TriggerStore
    // Registration happens at the first tick's instant. The trigger owes the
    // boundaries that pass after it is registered, and none before.
    yield* TestClock.setTime(Date.parse("2026-03-01T03:00:00.000Z"))
    yield* triggers.register({
      id: "nightly-report",
      flowId: "reports/nightly",
      input: { channel: "#ops" },
      cron: "0 3 * * *",
      timezone: "UTC",
      overlap: "skip",
      catchUp: "one",
      maxCatchUp: 1,
      enabled: true
    })

    const scheduler = yield* Scheduler.make()

    // First sight of this trigger: no boundary has passed since it was
    // registered, so the tick records a watermark and fires nothing.
    yield* scheduler.runOnce

    // A boundary has passed since that watermark, so this tick launches it.
    yield* TestClock.setTime(Date.parse("2026-03-02T03:00:00.000Z"))
    yield* scheduler.runOnce
    yield* Effect.yieldNow

    return yield* triggers.get("nightly-report")
  }))

  return Effect.runPromise(program.pipe(Effect.provide(layer))).then((registered) => ({ launched, registered }))
}
