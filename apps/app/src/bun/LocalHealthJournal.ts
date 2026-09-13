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
  let service: Journal.Service | undefined
  const pending = new Set<Promise<unknown>>()
  let closing = false
  const runtime = ManagedRuntime.make(SqlJournal.layer({
    capacity: 128,
    overflow: "reject",
    maxEntryBytes: 8_192,
    // Sessions can live for weeks. Retain the current observation as a
    // checkpoint instead of growing one heartbeat history without a bound.
    compaction: {
      entryThreshold: 256,
      capture: (runId, upTo) => Effect.suspend(() => service!.entries({
        runId, limit: 1,
        ...(upTo > 0 ? { after: JournalEvent.Seq.make(upTo - 1) } : {})
      })).pipe(Effect.map((page) => ({ observation: page.entries[0]?.payload, sequence: upTo })))
    }
  }).pipe(Layer.provide(Layer.provideMerge(Migrations.layer, database))))
  try {
    const journal = await runtime.runPromise(Journal.Journal)
    service = journal
    return {
      append: (subjectId: string, sourceId: string, eventType: string, payload: Record<string, unknown>) => {
        if (closing) return Promise.reject(new Error("Health journal is closing"))
        const operation = runtime.runPromise(journal.emitDurableUnfenced(new JournalEvent.Input({
          runId: JournalEvent.RunId.make(subjectId),
          sourceId: JournalEvent.SourceId.make(sourceId),
          eventType,
          payload
        }))).then((receipt) => receipt.seq as number)
        pending.add(operation)
        void operation.finally(() => pending.delete(operation)).catch(() => {})
        return operation
      },
      entries: (subjectId: string, afterSequence?: number) => runtime.runPromise(journal.entries({
        runId: JournalEvent.RunId.make(subjectId),
        limit: 128,
        ...(afterSequence === undefined ? {} : { after: JournalEvent.Seq.make(afterSequence) })
      })),
      /** Tests and host adapters may run journal effects without inventing another store. */
      run: <A, E>(effect: Effect.Effect<A, E, Journal.Journal>) => runtime.runPromise(effect),
      checkpoint: (subjectId: string) => runtime.runPromise(journal.latestCheckpoint(JournalEvent.RunId.make(subjectId))),
      close: async () => {
        closing = true
        // An interrupted host fiber may have already submitted a durable
        // write. Drain those admitted writes before disposing their driver.
        await Promise.allSettled([...pending])
        await runtime.dispose()
      }
    }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

export type LocalHealthJournal = Awaited<ReturnType<typeof openLocalHealthJournal>>
