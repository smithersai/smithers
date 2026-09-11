/**
 * Boundary delivery behavior of the sync client.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Effect, Stream } from "effect"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as SyncClient from "../src/SyncClient.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"

const runId = (value: string) => value as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (sequence: number) =>
  new JournalEvent.Entry({
    runId: runId("boundary"),
    seq: seq(sequence),
    eventId: `boundary-${sequence}`,
    sourceId: "source" as JournalEvent.SourceId,
    sourceSeq: sourceSeq(sequence),
    emittedAtMs: sequence,
    eventType: "event",
    payload: sequence,
    meta: null
  })

describe("SyncClient covered-frame boundaries", () => {
  it.effect("filters an entry exactly at the cursor while admitting the later entry in the same frame", () =>
    Effect.gen(function*() {
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
          "Sync.Subscribe": () =>
            Stream.succeed<SyncProtocol.Frame>({
              generation: 0,
              _tag: "Entries",
              runId: runId("boundary"),
              fromSeq: seq(2),
              toSeq: seq(3),
              entries: [entry(2), entry(3)]
            })
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })

      const entries = yield* (
        client.subscribe({
          scope: { _tag: "Run", runId: runId("boundary") },
          cursors: [{ generation: 0, runId: runId("boundary"), afterSeq: seq(2) }]
        }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([3])
      expect((yield* client.progress).delivered).toEqual([{ generation: 0, runId: "boundary", afterSeq: 3 }])
    }))

  it.effect("forwards a share capability when the durable bootstrap enters live follow", () =>
    Effect.gen(function*() {
      const capability = new BranchProtocol.ShareCapability({
        claims: new BranchProtocol.ShareClaims({
          kid: "primary",
          branchId: "boundary" as BranchProtocol.BranchId,
          capabilityId: "cap-boundary",
          access: "read",
          issuedAtMs: 0,
          expiresAtMs: 1
        }),
        signature: "signed"
      })
      let received: BranchProtocol.ShareCapability | undefined
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
          "Sync.Subscribe": (request: { readonly capability?: BranchProtocol.ShareCapability }) => {
            received = request.capability
            return Stream.succeed<SyncProtocol.Frame>({
              generation: 0,
              _tag: "Entries",
              runId: runId("boundary"),
              fromSeq: seq(0),
              toSeq: seq(0),
              entries: [entry(0)]
            })
          }
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })

      const entries = yield* (
        client.subscribe({
          scope: { _tag: "Run", runId: runId("boundary") },
          cursors: [],
          capability
        }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([0])
      expect(received).toBe(capability)
    }))
})
