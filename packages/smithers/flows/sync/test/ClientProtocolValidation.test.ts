import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Effect, Exit, Stream } from "effect"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError } from "../src/SyncError.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"

const runId = "validated-run" as JournalEvent.RunId
const foreignRunId = "foreign-run" as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq

const entry = (sequence: number, entryRunId: JournalEvent.RunId = runId) =>
  new JournalEvent.Entry({
    runId: entryRunId,
    seq: seq(sequence),
    eventId: `${entryRunId}-${sequence}`,
    sourceId: "source" as JournalEvent.SourceId,
    sourceSeq: sequence as JournalEvent.SourceSeq,
    emittedAtMs: sequence,
    eventType: "event",
    payload: sequence,
    meta: null
  })

interface Case {
  readonly name: string
  readonly frame: SyncProtocol.EntriesFrame
  readonly cursors?: SyncProtocol.WorkspaceCursor
}

const cases: ReadonlyArray<Case> = [
  {
    name: "rejects an entry for a different run",
    frame: { generation: 0, _tag: "Entries", runId, fromSeq: seq(0), toSeq: seq(0), entries: [entry(0, foreignRunId)] }
  },
  {
    name: "rejects descending entry sequences",
    frame: { generation: 0, _tag: "Entries", runId, fromSeq: seq(0), toSeq: seq(1), entries: [entry(1), entry(0)] }
  },
  {
    name: "rejects duplicate entry sequences",
    frame: { generation: 0, _tag: "Entries", runId, fromSeq: seq(0), toSeq: seq(0), entries: [entry(0), entry(0)] }
  },
  {
    name: "rejects entries outside the declared covered interval",
    frame: { generation: 0, _tag: "Entries", runId, fromSeq: seq(1), toSeq: seq(2), entries: [entry(0), entry(1)] },
    cursors: [{ generation: 0, runId, afterSeq: seq(0) }]
  },
  {
    name: "rejects a toSeq below an included entry",
    frame: { generation: 0, _tag: "Entries", runId, fromSeq: seq(0), toSeq: seq(0), entries: [entry(1)] }
  }
]

describe("SyncClient protocol consistency validation", () => {
  // A schema-valid Entries frame can still contradict itself. Each case is an
  // internal run/range/sequence inconsistency the client must refuse as a
  // protocol violation without moving any cursor.
  for (const { cursors = [], frame, name } of cases) {
    it.effect(`${name} and leaves cursors intact`, () =>
      Effect.gen(function*() {
        const client = yield* SyncClient.make({
          client: {
            "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
            "Sync.Subscribe": () => Stream.succeed<SyncProtocol.Frame>(frame)
          } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
        })

        const exit = yield* Effect.exit(
          client.subscribe({ scope: { _tag: "Run", runId }, cursors }).pipe(
            Stream.take(1),
            Stream.runCollect
          )
        )
        const failure = Exit.isFailure(exit)
          ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
          : undefined

        expect(failure).toBeInstanceOf(SyncError)
        expect(failure).toMatchObject({ code: "protocol_violation" })
        expect((yield* client.progress).delivered).toEqual([])
      }))
  }
})
