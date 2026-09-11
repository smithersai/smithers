/**
 * Property tests for the sync client's frame and cursor invariants.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Effect, Exit, Stream } from "effect"
import { FastCheck } from "effect/testing"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError, SyncGapError } from "../src/SyncError.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"
import * as TestEntry from "./fixtures/entry.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  seed: Number(process.env.FC_SEED ?? 20260814),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

const runId = "property-run" as JournalEvent.RunId
const foreignRunId = "foreign-run" as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq

const entry = (sequence: number, entryRunId: JournalEvent.RunId = runId) => TestEntry.entry(entryRunId, sequence)

const stubClient = (frames: ReadonlyArray<SyncProtocol.Frame>) =>
  SyncClient.make({
    client: {
      "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
      "Sync.Subscribe": () => Stream.fromIterable(frames)
    } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
  })

const closed: SyncProtocol.Frame = { _tag: "Closed", reason: "end of generated frames" }

/** Runs a subscription to its terminal Closed frame, capturing deliveries. */
const collect = (
  client: SyncClient.Service,
  cursors: SyncProtocol.WorkspaceCursor
) =>
  Effect.gen(function*() {
    const delivered: Array<number> = []
    const exit = yield* Effect.exit(
      client.subscribe({ scope: { _tag: "Run", runId }, cursors }).pipe(
        Stream.tap((admitted) => Effect.sync(() => delivered.push(admitted.seq))),
        Stream.runDrain
      )
    )
    const failure = Exit.isFailure(exit)
      ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      : undefined
    const acknowledged = (yield* client.progress).delivered
    return { delivered, failure, acknowledged }
  })

describe("SyncClient properties", () => {
  it.effect.prop(
    "admits each sequence exactly once, in order, across arbitrary overlapping consistent frames",
    [
      FastCheck.integer({ min: 1, max: 16 }),
      FastCheck.array(
        FastCheck.tuple(FastCheck.nat({ max: 3 }), FastCheck.integer({ min: 1, max: 4 })),
        { maxLength: 5 }
      ),
      FastCheck.integer({ min: -1, max: 14 })
    ],
    ([total, overlaps, rawCursor]) =>
      Effect.gen(function*() {
        // Initial cursor strictly below the last sequence so at least one
        // entry is always admitted.
        const initialCursor = Math.min(rawCursor, total - 2)
        const frames: Array<SyncProtocol.Frame> = []
        let covered = -1
        const push = (from: number, to: number) => {
          frames.push({
            generation: 0,
            _tag: "Entries",
            runId,
            fromSeq: seq(from),
            toSeq: seq(to),
            entries: Array.from({ length: to - from + 1 }, (_, offset) => entry(from + offset))
          })
          covered = Math.max(covered, to)
        }
        for (const [overlap, advance] of overlaps) {
          push(Math.max(0, covered - overlap), Math.min(total - 1, Math.max(covered, 0) + advance))
        }
        if (covered < total - 1) push(covered + 1, total - 1)
        frames.push(closed)

        const client = yield* stubClient(frames)
        const { acknowledged, delivered, failure } = yield* collect(
          client,
          initialCursor < 0 ? [] : [{ generation: 0, runId, afterSeq: seq(initialCursor) }]
        )

        // The subscription ends at the Closed frame with a typed error.
        expect(SyncError.is(failure) && failure.code === "closed").toBe(true)
        // Contiguous coverage means every sequence past the cursor arrives
        // exactly once and in order, however the frames overlap.
        expect(delivered).toEqual(
          Array.from({ length: total - 1 - initialCursor }, (_, offset) => initialCursor + 1 + offset)
        )
        expect(acknowledged).toEqual([{ generation: 0, runId, afterSeq: total - 1 }])
      }),
    { fastCheck: params }
  )

  it.effect.prop(
    "fails with a typed gap error and an unmoved cursor for any frame beyond the covered cursor",
    [FastCheck.integer({ min: -1, max: 5 }), FastCheck.integer({ min: 1, max: 10 })],
    ([initialCursor, gap]) =>
      Effect.gen(function*() {
        const from = initialCursor + 1 + gap
        const client = yield* stubClient([
          { generation: 0, _tag: "Entries", runId, fromSeq: seq(from), toSeq: seq(from), entries: [entry(from)] },
          closed
        ])
        const { acknowledged, delivered, failure } = yield* collect(
          client,
          initialCursor < 0 ? [] : [{ generation: 0, runId, afterSeq: seq(initialCursor) }]
        )

        expect(failure).toBeInstanceOf(SyncGapError)
        expect(failure).toMatchObject({ runId, expectedFrom: initialCursor + 1, receivedFrom: from })
        expect(delivered).toEqual([])
        expect(acknowledged).toEqual([])
      }),
    { fastCheck: params }
  )

  // A schema-valid Entries frame can still contradict itself. Every mutation
  // below is an internal run/range/sequence inconsistency the client must
  // refuse as a protocol violation without moving the acknowledged cursor.
  // Corroborates the pinned cases in ClientProtocolValidation.test.ts.
  it.effect.prop(
    "rejects arbitrary inconsistent frames with protocol_violation and never moves the cursor",
    [
      FastCheck.constantFrom(
        "duplicate-seq",
        "descending-seq",
        "foreign-run-entry",
        "toSeq-below-entry"
      ),
      FastCheck.integer({ min: 2, max: 9 }),
      FastCheck.nat({ max: 8 })
    ],
    ([mutation, total, rawIndex]) =>
      Effect.gen(function*() {
        const index = rawIndex % total
        const base = Array.from({ length: total }, (_, sequence) => entry(sequence))
        const mutated = mutation === "duplicate-seq"
          ? [...base.slice(0, index + 1), base[index]!, ...base.slice(index + 1)]
          : mutation === "descending-seq"
          ? [...base].reverse()
          : mutation === "foreign-run-entry"
          ? base.map((value, position) => position === index ? entry(position, foreignRunId) : value)
          : base
        const frame: SyncProtocol.Frame = {
          generation: 0,
          _tag: "Entries",
          runId,
          fromSeq: seq(0),
          toSeq: seq(mutation === "toSeq-below-entry" ? total - 2 : total - 1),
          entries: mutated
        }

        const client = yield* stubClient([frame, closed])
        const { acknowledged, delivered, failure } = yield* collect(client, [])

        // The contract: an internally inconsistent frame is a protocol
        // violation, delivers nothing, and must not advance the cursor.
        expect(SyncError.is(failure) && failure.code === "protocol_violation").toBe(true)
        expect(delivered).toEqual([])
        expect(acknowledged).toEqual([])
      }),
    { fastCheck: params }
  )
})
