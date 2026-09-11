import { expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Cause, Context, Effect, Exit, Schema, Stream } from "effect"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError } from "../src/SyncError.ts"

for (const path of ["bootstrap", "live", "snapshot"] as const) {
  it.effect(`preserves unrelated defects and annotations when translating a ${path} RPC schema failure`, () =>
    Effect.gen(function*() {
      const malformed = yield* Schema.decodeUnknownEffect(Schema.String)(0).pipe(Effect.flip)
      const unrelated = new Error("unrelated host defect")
      const metadata = Context.makeUnsafe(new Map<string, unknown>([["trace", "original"]]))
      const original = Cause.fromReasons([
        Cause.makeDieReason(malformed).annotate(metadata),
        Cause.makeDieReason(unrelated)
      ])
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": () =>
            path === "bootstrap"
              ? Effect.failCause(original)
              : Effect.succeed({ entries: [], cursors: [], done: true }),
          "Sync.Subscribe": () => Stream.failCause(original),
          "Sync.Snapshot": () => Effect.failCause(original)
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      const runId = "cause-integrity" as JournalEvent.RunId
      const result = yield* Effect.exit(
        path === "snapshot"
          ? client.snapshot({
            protocolVersion: 1,
            runId,
            lineageId: "one",
            projection: "count",
            projectionVersion: 1,
            atLeastSeq: 0 as JournalEvent.Seq
          })
          : client.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(Stream.runDrain)
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toHaveLength(2)
        const failure = result.cause.reasons.find(Cause.isFailReason)!
        expect(failure.error).toMatchObject({ code: "decode_failed", cause: "SchemaError" })
        expect(failure.annotations.get("trace")).toBe("original")
        expect(result.cause.reasons.find(Cause.isDieReason)!.defect).toBe(unrelated)
      }
      expect((yield* client.progress).applied).toEqual([])
      expect((yield* client.progress).delivered).toEqual([])
    }))
}

for (const path of ["bootstrap", "live", "snapshot"] as const) {
  for (const kind of ["defect", "interruption"] as const) {
    it.effect(`retains a ${path} RPC ${kind} without translating it or acknowledging data`, () =>
      Effect.gen(function*() {
        const defect = new Error("original defect")
        const original = kind === "defect" ? Cause.die(defect) : Cause.interrupt(123)
        const client = yield* SyncClient.make({
          client: {
            "Sync.Read": () =>
              path === "bootstrap"
                ? Effect.failCause(original)
                : Effect.succeed({ entries: [], cursors: [], done: true }),
            "Sync.Subscribe": () => Stream.failCause(original),
            "Sync.Snapshot": () => Effect.failCause(original)
          } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
        })
        const runId = "original-cause" as JournalEvent.RunId
        const result = yield* (path === "snapshot"
          ? client.snapshot({
            protocolVersion: 1,
            runId,
            lineageId: "one",
            projection: "count",
            projectionVersion: 1,
            atLeastSeq: 0 as JournalEvent.Seq
          })
          : client.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(Stream.runDrain))
          .pipe(Effect.uninterruptible, Effect.exit)
        expect(result).toMatchObject({
          _tag: "Failure",
          cause: {
            reasons: kind === "defect"
              ? [{ _tag: "Die", defect }] :
              [{ _tag: "Interrupt", fiberId: 123 }]
          }
        })
        expect((yield* client.progress).delivered).toEqual([])
        expect((yield* client.progress).applied).toEqual([])
      }))
  }
}

it.effect("does not retry a disconnect accompanied by an unrelated defect", () =>
  Effect.gen(function*() {
    const failure = new SyncError({ code: "transport_failed", message: "disconnect" })
    const defect = new Error("unrelated defect")
    const original = Cause.combine(Cause.fail(failure), Cause.die(defect))
    let calls = 0
    const client = yield* SyncClient.make({
      client: {
        "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
        "Sync.Subscribe": () => {
          calls++
          return Stream.failCause(original)
        }
      } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
    })
    const result = yield* client.subscribe({ scope: { _tag: "Workspace" }, cursors: [] }).pipe(
      Stream.runDrain,
      Effect.exit
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      cause: {
        reasons: [
          { _tag: "Fail", error: failure },
          { _tag: "Die", defect }
        ]
      }
    })
    expect(calls).toBe(1)
    expect((yield* client.progress).delivered).toEqual([])
  }))
