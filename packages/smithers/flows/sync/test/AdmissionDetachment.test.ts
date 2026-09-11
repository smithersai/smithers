import { expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Effect, Stream } from "effect"
import * as SyncClient from "../src/SyncClient.ts"

for (const live of [false, true]) {
  it.effect(`detaches admitted ${live ? "live" : "bootstrap"} entries before application can mutate the producer's batch`, () =>
    Effect.gen(function*() {
      const runId = "detached-admission" as JournalEvent.RunId
      const entries = [0, 1].map((position) =>
        new JournalEvent.Entry({
          runId,
          seq: position as JournalEvent.Seq,
          eventId: `e-${position}`,
          sourceId: "s" as JournalEvent.SourceId,
          sourceSeq: position as JournalEvent.SourceSeq,
          eventType: "increment",
          payload: { amount: position + 1 },
          emittedAtMs: 0,
          meta: null
        })
      )
      const remote = yield* SyncClient.make({
        client: {
          "Sync.Read": () =>
            Effect.succeed({
              entries: live ? [] : entries,
              cursors: live ? [] : [{ generation: 0, runId, afterSeq: 1 as JournalEvent.Seq }],
              done: true
            }),
          "Sync.Subscribe": () =>
            Stream.succeed({ generation: 0, _tag: "Entries", runId, fromSeq: 0, toSeq: 1, entries })
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      const applied: Array<{ seq: number; amount: number }> = []
      yield* remote.subscribe({
        scope: { _tag: "Run", runId },
        cursors: [],
        apply: (entry) =>
          Effect.sync(() => {
            applied.push({ seq: entry.seq, amount: (entry.payload as { amount: number }).amount })
            if (entry.seq === 0) {
              Object.assign(entries[1]!, { seq: 100 })
              Object.assign(entries[1]!.payload as object, { amount: 1000 })
            }
          })
      }).pipe(Stream.take(2), Stream.runDrain)
      expect(applied).toEqual([{ seq: 0, amount: 1 }, { seq: 1, amount: 2 }])
      expect((yield* remote.progress).applied).toEqual([{ generation: 0, runId, afterSeq: 1 }])
    }))
}
