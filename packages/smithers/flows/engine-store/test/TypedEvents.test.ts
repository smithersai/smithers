import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Flow } from "@smthrs/flow"
import { EngineEvent, Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as AttemptLifecycle from "../src/internal/AttemptLifecycle.ts"
import * as ResultEnvelope from "../src/internal/ResultEnvelope.ts"
import * as TypedEvents from "../src/internal/TypedEvents.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const owner = { hostId: "a2", pid: 1, nonce: "typed" }
const scope: EngineEvent.Consumer = {
  runId: JournalEvent.RunId.make("typed-run"),
  lineageId: JournalEvent.LineageId.make("typed-lineage"),
  rootRunId: JournalEvent.RunId.make("typed-run"),
  round: 0,
  parentRunId: null,
  sources: [JournalEvent.SourceId.make("typed-source")],
  unknown: "ignore"
}
const entry = (seq: number, lifecycle: unknown, key = "dispatch") =>
  new JournalEvent.Entry({
    runId: scope.runId,
    seq: JournalEvent.Seq.make(seq),
    sourceId: scope.sources[0]!,
    sourceSeq: JournalEvent.SourceSeq.make(seq),
    eventId: `typed-${seq}`,
    emittedAtMs: 0,
    eventType: TypedEvents.attemptEventType,
    meta: null,
    payload: {
      version: 2,
      executionId: scope.runId,
      stepKeyDigest: key,
      attempt: 1,
      lifecycle,
      lineage: {
        kind: "root",
        runId: scope.runId,
        lineageId: scope.lineageId,
        rootRunId: scope.runId,
        round: 0,
        parentRunId: null
      }
    }
  })

describe("additive typed engine contracts", () => {
  it.effect("decodes current records captured from the real production attempt writer", () =>
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const runId = JournalEvent.RunId.make("current-record")
      yield* runs.create(runId, "{}")
      const pending = yield* runs.get(runId)
      const snapshot = { status: pending.status, owner: pending.owner, heartbeatAtMs: pending.heartbeatAtMs }
      const claim = yield* runs.claim(runId, snapshot, owner, 1)
      if (claim._tag !== "Claimed") return yield* Effect.die("fixture claim failed")
      yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
      yield* ActionPersistence.make({
        runId,
        owner,
        sourceId: "current-source",
        execute: () => Effect.succeed({ answer: 7 })
      })({
        action: {},
        attempt: 1,
        key: "current-key",
        tier: "sealed",
        metadata: { readSet: [], writeSet: ["out.json"], boundaryMode: "hard" }
      })
      const journal = yield* Journal.Journal
      const page = yield* journal.entries({ runId, limit: 20 })
      const markers = page.entries.filter((entry) =>
        ["flows.engine.attempt-started", "flows.engine.attempt-finished"].includes(entry.eventType)
      )
      expect(markers).toHaveLength(2)
      const decoded = yield* Effect.forEach(markers, (entry) =>
        TypedEvents.decodeCurrentAttempt(entry, {
          ...scope,
          runId,
          lineageId: JournalEvent.LineageId.make(FlowEngine.Lineage.root(runId)),
          sources: markers.map((entry) => entry.sourceId)
        }))
      const stepKeyDigest = createHash("sha256").update("current-key").digest("hex")
      expect(decoded.map(({ marker }) => marker.payload)).toEqual([
        { runId: "current-record", stepKeyDigest, attempt: 1, tier: "sealed" },
        { runId: "current-record", stepKeyDigest, attempt: 1, state: "succeeded" }
      ])
      expect(markers.every((entry) => !("version" in (entry.payload as object)))).toBe(true)
    }).pipe(
      Effect.provide(Layer.mergeAll(
        TestStores.layer(),
        StepBoundary.layerTest(),
        Layer.succeed(
          Jj.Jj,
          Jj.make({
            snapshot: () => Effect.succeed({ commitId: "snapshot" as never, changeId: "snapshot" as never }),
            restore: () => Effect.void,
            diff: () => Effect.succeed(""),
            workspaceAdd: () => Effect.void,
            workspaceForget: () => Effect.void,
            status: () => Effect.succeed("")
          })
        )
      )),
      Effect.scoped,
      withCrypto
    ))

  it.effect("enforces legal attempt transitions without losing suspensions or failed results", () =>
    Effect.gen(function*() {
      const fold = AttemptLifecycle.projection(scope)
      const start = { state: "running", startedAtMs: 1 }
      const suspended = { state: "suspended", startedAtMs: 1, checkpoint: { offset: 4 } }
      const succeeded = { state: "succeeded", startedAtMs: 1, finishedAtMs: 2, result: { _tag: "Success", value: 3 } }
      const failed = {
        state: "failed",
        startedAtMs: 1,
        finishedAtMs: 2,
        result: { _tag: "Failure", reason: "error", detail: "refused" }
      }
      expect(yield* AttemptLifecycle.decode(suspended)).toEqual(suspended)
      const first = yield* fold.reduce(fold.initial, entry(0, start))
      const paused = yield* fold.reduce(first, entry(1, suspended))
      const resumed = yield* fold.reduce(paused, entry(2, start))
      const terminal = yield* fold.reduce(resumed, entry(3, succeeded))
      expect(terminal).toEqual([{
        executionId: "typed-run",
        stepKeyDigest: "dispatch",
        attempt: 1,
        seq: 3,
        lifecycle: succeeded
      }])
      const failedState = yield* fold.reduce(first, entry(1, failed))
      expect(failedState[0]!.lifecycle).toEqual(failed)
      for (
        const [state, record] of [
          [fold.initial, entry(1, succeeded)],
          [first, entry(0, succeeded)],
          [terminal, entry(4, start)],
          [failedState, entry(4, start)],
          [first, entry(1, { ...start, startedAtMs: 2 })]
        ] as const
      ) {
        const error = yield* Effect.flip(fold.reduce(state, record))
        expect(error.code).toBe("transition")
        expect(error.cause).toBeDefined()
      }
      const unrelated = new JournalEvent.Entry({ ...entry(5, start), eventType: "vendor.custom" })
      expect(yield* fold.reduce(first, unrelated)).toBe(first)
      const other = yield* fold.reduce(first, entry(1, start, "other"))
      expect(other).toHaveLength(2)
      expect((yield* Effect.exit(AttemptLifecycle.decode({ ...succeeded, result: failed.result })))._tag).toBe(
        "Failure"
      )
      expect(yield* AttemptLifecycle.decode(start)).toEqual(start)
      const cause = new Error("attempt accessor")
      const rejected = yield* Effect.flip(AttemptLifecycle.decode({
        get state() {
          throw cause
        }
      }))
      expect(rejected.code).toBe("malformed")
      expect(rejected.cause).toBe(cause)
    }))

  it.effect("validates retained snapshots before trusting their cursor or state", () =>
    Effect.gen(function*() {
      const fold = AttemptLifecycle.projection(scope)
      const record = entry(0, { state: "running", startedAtMs: 1 })
      const rows = yield* fold.reduce([], record)
      const lineage = yield* TypedEvents.decodeEntry(record, scope)
      expect(lineage._tag).toBe("Attempt")
      if (lineage._tag !== "Attempt") return yield* Effect.die("fixture decode failed")
      const snapshot = { version: 2, lineage: lineage.payload.lineage, seq: 0, rows }
      expect(yield* AttemptLifecycle.restore(snapshot, scope)).toEqual(snapshot)
      for (
        const invalid of [
          { ...snapshot, version: 1 },
          { ...snapshot, rows: [...rows, ...rows] },
          { ...snapshot, rows: [{ ...rows[0], seq: 1 }] },
          { ...snapshot, rows: [{ ...rows[0], executionId: "foreign" }] }
        ]
      ) expect((yield* Effect.flip(AttemptLifecycle.restore(invalid, scope))).code).toBe("malformed")
      for (
        const expected of [
          { ...scope, runId: JournalEvent.RunId.make("foreign") },
          { ...scope, lineageId: JournalEvent.LineageId.make("foreign") },
          { ...scope, rootRunId: JournalEvent.RunId.make("foreign") },
          { ...scope, round: 1 },
          { ...scope, parentRunId: JournalEvent.RunId.make("foreign") }
        ]
      ) expect((yield* Effect.flip(AttemptLifecycle.restore(snapshot, expected))).code).toBe("foreign")
      const cause = new Error("snapshot getter")
      const error = yield* Effect.flip(AttemptLifecycle.restore({
        get version() {
          throw cause
        }
      }, scope))
      expect(error.cause).toBe(cause)
    }))

  it.effect("encodes terminal failures through the established fallback while preserving normal bytes", () =>
    Effect.gen(function*() {
      const flow = Flow.make("typed/result", {
        payload: {},
        success: Schema.Unknown,
        error: Schema.Unknown,
        body: () => Node.succeed(null)
      })
      const normal = yield* ResultEnvelope.encode(flow, new Flow.Complete({ exit: Exit.succeed({ answer: 42 }) }))
      expect(normal).toEqual({
        _tag: "Encoded",
        value: { _tag: "Complete", exit: { _tag: "Success", value: { answer: 42 } } }
      })
      const failed = yield* ResultEnvelope.encode(
        flow,
        new Flow.Complete({ exit: Exit.fail(new Error("class failure")) })
      )
      expect(failed._tag).toBe("EncodingFailure")
      expect(failed.value).toMatchObject({
        _tag: "Complete",
        exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: { _tag: "flows/engine-store/UnencodableResult" } }] }
      })
      expect(Schema.decodeUnknownSync(ResultEnvelope.Settlement)(JSON.parse(JSON.stringify(failed)))).toEqual(failed)
      const success = { _tag: "Success", value: { answer: 42 } }
      const failure = { _tag: "Failure", reason: "error", detail: { code: "refused" } }
      expect(yield* ResultEnvelope.decode(success)).toEqual(success)
      expect(yield* ResultEnvelope.decode(failure)).toEqual(failure)
      const cause = new Error("result accessor")
      const rejected = yield* Effect.flip(ResultEnvelope.decode({
        get _tag() {
          throw cause
        }
      }))
      expect(rejected.code).toBe("malformed")
      expect(rejected.cause).toBe(cause)
      expect((yield* Effect.exit(ResultEnvelope.decode({ _tag: "Success", value: new Error("not encoded") })))._tag)
        .toBe("Failure")
      for (
        const invalid of [new Error("class"), {
          get value() {
            throw new Error("getter")
          }
        }, undefined]
      ) {
        const settlement = yield* ResultEnvelope.fromEncoded(invalid)
        expect(settlement).toEqual({
          _tag: "EncodingFailure",
          note: "the encoded settlement was not JSON",
          value: {
            _tag: "Complete",
            exit: {
              _tag: "Failure",
              cause: [{
                _tag: "Die",
                defect: {
                  _tag: "flows/engine-store/UnencodableResult",
                  result: "Complete",
                  note: "the encoded settlement was not JSON",
                  reasons: [],
                  value: null
                }
              }]
            }
          }
        })
      }
    }))
})
