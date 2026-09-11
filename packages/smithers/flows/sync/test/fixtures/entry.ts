/**
 * The one journal entry builder the sync suites share, so a change to
 * `JournalEvent.Entry`'s fields lands here instead of in every suite.
 *
 * @since 0.1.0
 */
import * as JournalEvent from "@smthrs/journal/JournalEvent"

/** Entry fields a suite may pin in place of the defaults. */
export type EntryFields = ConstructorParameters<typeof JournalEvent.Entry>[0]

/**
 * An entry at `seq` in `runId`, written by source `"source"` at `seq`, with
 * `eventId` `${runId}-${seq}`, `emittedAtMs` and `payload` both `seq`, and
 * `eventType` `"event"`. `overrides` replaces any of those fields.
 */
export const entry = (runId: string, seq: number, overrides: Partial<EntryFields> = {}): JournalEvent.Entry =>
  new JournalEvent.Entry({
    runId: runId as JournalEvent.RunId,
    seq: seq as JournalEvent.Seq,
    eventId: `${runId}-${seq}`,
    sourceId: "source" as JournalEvent.SourceId,
    sourceSeq: seq as JournalEvent.SourceSeq,
    emittedAtMs: seq,
    eventType: "event",
    payload: seq,
    meta: null,
    ...overrides
  })
