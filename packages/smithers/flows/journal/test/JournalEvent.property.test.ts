import { Schema } from "effect"
import { TestSchema } from "effect/testing"
import * as FastCheck from "fast-check"
import { describe, expect, it } from "vitest"
import {
  Entry,
  Input,
  makeEventId,
  maxIdentifierLength,
  RunId,
  type RunId as RunIdType,
  Seq,
  SourceId,
  type SourceId as SourceIdType,
  SourceSeq,
  type SourceSeq as SourceSeqType
} from "../src/JournalEvent.ts"

const params = {
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  interruptAfterTimeLimit: 20_000,
  markInterruptAsFailure: true
} satisfies FastCheck.Parameters<unknown>

/** Written through `String.fromCharCode` so no source file carries a raw NUL. */
const nul = String.fromCharCode(0)

const runId = (value: string): RunIdType => value as RunIdType
const sourceId = (value: string): SourceIdType => value as SourceIdType
const sourceSeq = (value: number): SourceSeqType => value as SourceSeqType

describe("JournalEvent properties", () => {
  it("Entry survives encode-then-decode for arbitrary envelopes", async () => {
    const asserts = new TestSchema.Asserts(Entry)
    await asserts.verifyLosslessTransformation({ runs: params.numRuns, seed: params.seed })
  })

  it("Input survives encode-then-decode for arbitrary submissions", async () => {
    const asserts = new TestSchema.Asserts(Input)
    await asserts.verifyLosslessTransformation({ runs: params.numRuns, seed: params.seed })
  })

  it.each([
    [
      "RunId",
      () => Schema.decodeUnknownSync(RunId)("r".repeat(maxIdentifierLength)),
      () => Schema.decodeUnknownSync(RunId)("r".repeat(maxIdentifierLength + 1))
    ],
    [
      "SourceId",
      () => Schema.decodeUnknownSync(SourceId)("s".repeat(maxIdentifierLength)),
      () => Schema.decodeUnknownSync(SourceId)("s".repeat(maxIdentifierLength + 1))
    ],
    [
      "Input.eventType",
      () =>
        Schema.decodeUnknownSync(Input)({
          runId: "run",
          sourceId: "source",
          eventType: "e".repeat(maxIdentifierLength),
          payload: null
        }),
      () =>
        Schema.decodeUnknownSync(Input)({
          runId: "run",
          sourceId: "source",
          eventType: "e".repeat(maxIdentifierLength + 1),
          payload: null
        })
    ],
    [
      "Seq",
      () => Schema.decodeUnknownSync(Seq)(Number.MAX_SAFE_INTEGER - 1),
      () => Schema.decodeUnknownSync(Seq)(Number.MAX_SAFE_INTEGER)
    ],
    [
      "SourceSeq",
      () => Schema.decodeUnknownSync(SourceSeq)(Number.MAX_SAFE_INTEGER - 1),
      () => Schema.decodeUnknownSync(SourceSeq)(Number.MAX_SAFE_INTEGER)
    ]
  ])("%s accepts its supported upper boundary and refuses the next value", (_name, accepted, refused) => {
    expect(accepted).not.toThrow()
    expect(refused).toThrow()
  })

  // SQLite's `length()` stops at the first NUL and every identifier column
  // carries `CHECK (length(...) > 0)`, so a NUL-bearing identifier used to
  // decode cleanly and then fail the write as `sink_failed` with a constraint
  // cause: the caller was told the database was down about an identifier it had
  // just supplied.
  it.each([
    ["leading", `${nul}run`],
    ["trailing", `run${nul}`],
    ["embedded", `ru${nul}n`]
  ])("refuses a %s NUL in every identifier", (_position, value) => {
    expect(() => Schema.decodeUnknownSync(RunId)(value)).toThrow()
    expect(() => Schema.decodeUnknownSync(SourceId)(value)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Input)({
        runId: "run",
        sourceId: "source",
        eventType: value,
        payload: null
      })
    ).toThrow()
  })

  // `Entry.eventType` was a bare `Schema.String` while `Input.eventType` was the
  // bounded identifier, so a consumer decoding a committed row accepted event
  // types no emit could ever have produced.
  it.each([
    ["empty", ""],
    ["over-long", "e".repeat(maxIdentifierLength + 1)],
    ["lone-surrogate", "\uD800"],
    ["NUL-bearing", `e${nul}t`]
  ])("Entry refuses an %s eventType", (_name, eventType) => {
    expect(() =>
      Schema.decodeUnknownSync(Entry)({
        runId: "run",
        seq: 0,
        eventId: "flows:event:3:run6:source0",
        sourceId: "source",
        sourceSeq: 0,
        emittedAtMs: 0,
        eventType,
        payload: null,
        meta: null
      })
    ).toThrow()
  })

  it("Entry accepts the same event types Input accepts", () => {
    for (const eventType of ["e", "e".repeat(maxIdentifierLength), "step.\u{1F600}.done"]) {
      expect(() =>
        Schema.decodeUnknownSync(Entry)({
          runId: "run",
          seq: 0,
          eventId: "flows:event:3:run6:source0",
          sourceId: "source",
          sourceSeq: 0,
          emittedAtMs: 0,
          eventType,
          payload: null,
          meta: null
        })
      ).not.toThrow()
    }
  })

  it("makeEventId keeps distinct (runId, sourceId, sourceSeq) tuples distinct", () => {
    // The id concatenates the tuple, so identifiers containing the separator
    // or digits are exactly where a naive scheme collides ("b"+"12" versus
    // "b1"+"2"). The length prefixes must keep every boundary recoverable.
    const identifier = FastCheck.oneof(
      FastCheck.string({ unit: "binary" }),
      FastCheck.array(FastCheck.constantFrom("0", "1", "9", ":", "flows", "event", ""), { maxLength: 6 })
        .map((parts) => parts.join(""))
    )
    const seq = FastCheck.nat({ max: 1_000_000 })
    FastCheck.assert(
      FastCheck.property(identifier, identifier, seq, identifier, identifier, seq, (
        runA,
        sourceA,
        seqA,
        runB,
        sourceB,
        seqB
      ) => {
        const left = makeEventId(runId(runA), sourceId(sourceA), sourceSeq(seqA))
        const right = makeEventId(runId(runB), sourceId(sourceB), sourceSeq(seqB))
        if (runA === runB && sourceA === sourceB && seqA === seqB) {
          // Determinism: a producer retry regenerates the same durable id.
          expect(left).toBe(right)
        } else {
          expect(left).not.toBe(right)
        }
      }),
      {
        ...params,
        examples: [
          ["a", "b", 12, "a", "b1", 2],
          ["a", "1:b", 0, "a:1", "b", 0],
          ["ab", "c", 0, "a", "bc", 0],
          ["1", "", 10, "", "1", 10],
          ["flows:event:1:", "", 0, "", "flows:event:1:", 0],
          ["a", "b", 1, "a", "b", 1]
        ]
      }
    )
  })

  it("pins makeEventId's persisted wire format", () => {
    // `event_id` is written to `flows_journal_events` under a UNIQUE
    // constraint and is looked up verbatim by `selectExisting`, and
    // `@smthrs/time-travel` synthesizes forked rows as
    // `'fork:' || run_id || ':' || event_id`. Changing the prefix, the
    // separator, or the length prefixes orphans every persisted row, and the
    // injectivity property above would stay green while it happened. These
    // literals are a persisted wire format: they cannot change without a
    // migration.
    expect(makeEventId(runId("run"), sourceId("source"), sourceSeq(3))).toBe("flows:event:3:run6:source3")
    expect(makeEventId(runId("a:1"), sourceId("b:2"), sourceSeq(10))).toBe("flows:event:3:a:13:b:210")
    expect(makeEventId(runId(""), sourceId(""), sourceSeq(0))).toBe("flows:event:0:0:0")
  })
})
