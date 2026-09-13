import { DurableWriter } from "@smthrs/database"
import * as BunDatabase from "@smthrs/database/bun/BunDatabase"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import { Effect, Layer, ManagedRuntime } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

/** Local observations use the same durable journal as workspace observations. */
export const openLocalHealthJournal = async (stateDir?: string) => {
  if (stateDir !== undefined) await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const database = Layer.provideMerge(
    DurableWriter.layer(),
    BunDatabase.layer({ filename: stateDir === undefined ? ":memory:" : join(stateDir, "local-health.sqlite") })
  )
  const runtime = ManagedRuntime.make(SqlJournal.layer({
    capacity: 128,
    overflow: "reject",
    maxEntryBytes: 8_192
  }).pipe(Layer.provide(Layer.provideMerge(Migrations.layer, database))))
  try {
    const journal = await runtime.runPromise(Journal.Journal)
    return {
      append: (subjectId: string, sourceId: string, eventType: string, payload: Record<string, unknown>) =>
        runtime.runPromise(journal.emitDurableUnfenced(new JournalEvent.Input({
          runId: JournalEvent.RunId.make(subjectId),
          sourceId: JournalEvent.SourceId.make(sourceId),
          eventType,
          payload
        }))).then((receipt) => receipt.seq as number),
      entries: (subjectId: string, afterSequence?: number) => runtime.runPromise(journal.entries({
        runId: JournalEvent.RunId.make(subjectId),
        limit: 128,
        ...(afterSequence === undefined ? {} : { after: JournalEvent.Seq.make(afterSequence) })
      })),
      /** Tests and host adapters may run journal effects without inventing another store. */
      run: <A, E>(effect: Effect.Effect<A, E, Journal.Journal>) => runtime.runPromise(effect),
      close: () => runtime.dispose()
    }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

export type LocalHealthJournal = Awaited<ReturnType<typeof openLocalHealthJournal>>
