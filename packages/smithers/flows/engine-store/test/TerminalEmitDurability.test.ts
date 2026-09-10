/**
 * Issue #109: the terminal lifecycle records — `attemptFinished`,
 * `hardViolation`, `expectedSetDeviation` — must never be permanently absent
 * for an attempt row that is durably terminal, or the journal diverges from
 * the attempt table forever.
 *
 * The crash window that used to create that divergence is now closed at the
 * source: `attempts.finish` and its terminal records commit in ONE
 * transaction (see `WalAtomicity.test.ts`), so a crash between them rolls
 * both back. What remains is the *repair* path, and it still matters for the
 * holes atomicity cannot prevent — a database written before the invariant
 * landed, and a time-travel fork that copies attempt rows and journal rows
 * separately.
 *
 * These tests therefore create the hole directly — a durably terminal attempt
 * row with no terminal record — and pin that a replay fills it, idempotently:
 * the per-attempt producer identity `(sourceId, sourceSeq 0)` collapses the
 * re-emission into a `Duplicate` on every ordinary replay.
 */
import { describe, expect, it } from "@effect/vitest"
import type { Action } from "@smthrs/flow"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "terminal-emit-host", pid: 61, nonce: "terminal-emit-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "terminal-emit-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const dispatch = (
  runId: string,
  key: string,
  execute: () => Effect.Effect<unknown, unknown>,
  options: { readonly tier?: Action.Tier; readonly metadata?: ActionPersistence.BoundaryMetadata } = {}
) =>
  ActionPersistence.make({ runId, owner, sourceId: `terminal-emit-${runId}`, execute })({
    action: {},
    attempt: 1,
    key,
    tier: options.tier ?? "sealed",
    ...(options.metadata === undefined ? {} : { metadata: options.metadata })
  })

/**
 * Writes a durably terminal attempt row WITHOUT its terminal journal records
 * — the divergence a pre-atomicity crash used to leave behind, and the shape
 * a time-travel fork's row copy still produces.
 */
const terminalRowWithoutRecords = (
  runId: string,
  key: string,
  row: {
    readonly state: "succeeded" | "failed"
    readonly outcome?: AttemptStore.JsonValue
    readonly error?: AttemptStore.JsonValue
    readonly meta: AttemptStore.JsonValue
  }
) =>
  Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    const id = { runId, stepKeyDigest: sha256(key), attempt: 1 }
    const admitted = yield* attempts.put({ ...id, state: "running", startedAtMs: 0, meta: row.meta }, owner)
    if (admitted._tag !== "Inserted") return yield* Effect.die(new Error(`admission lost: ${admitted._tag}`))
    const finished = yield* attempts.finish({ ...id, ...row, finishedAtMs: 1 }, owner)
    if (finished._tag !== "Finished") return yield* Effect.die(new Error(`finish lost: ${finished._tag}`))
  })

const eventsOf = (runId: string, eventType: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 100 })
    return page.entries.filter((entry) => entry.eventType === eventType)
  })

const boundary = StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) })

const evidence = {
  declaredOutputs: [],
  diffIdentity: "terminal-emit-diff"
}

describe("replay re-emission validates a foreign-lineage terminal record (issue #109)", () => {
  it.effect("surfaces the conflict when the foreign record has no validated fork ancestry", () =>
    Effect.gen(function*() {
      // A time-travel fork copies the parent's journal rows: the copied
      // terminal record carries the same producer identity but names the
      // parent run in its payload, so the re-emission raises
      // idempotency_conflict rather than collapsing to a Duplicate. Replay
      // tolerates that ONLY for a record a retained fork demonstrably
      // copied (`ReplayConflictValidation.test.ts`). This record names a
      // parent this run never forked from, so the journal's conflict stands
      // and the body is not re-executed.
      const runId = "terminal-foreign-lineage"
      const key = "terminal-emit/foreign"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* activate(runId)
          yield* terminalRowWithoutRecords(runId, key, {
            state: "succeeded",
            outcome: "done",
            meta: { tier: "sealed", boundary: evidence, readSetVerified: true }
          })
          // The copied record: same producer identity, foreign payload.
          yield* journal.emitDurable({
            runId: runId as never,
            sourceId: `terminal-emit-${runId}:attempt:${sha256(key)}:1:finished` as never,
            sourceSeq: 0 as never,
            eventType: "flows.engine.attempt-finished",
            payload: { runId: "the-fork-parent", state: "succeeded" }
          } as never, owner)
          const replayed = yield* dispatch(runId, key, () => Effect.die("must not re-execute"), {
            metadata: declared
          }).pipe(Effect.provide(boundary), Effect.exit)
          return { replayed }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.replayed._tag).toBe("Failure")
      if (Exit.isFailure(outcome.replayed)) {
        const reason = outcome.replayed.cause.reasons[0]
        expect(reason?._tag).toBe("Fail")
        expect((reason as { readonly error?: unknown }).error).toMatchObject({
          _tag: "@smthrs/journal/JournalError",
          code: "idempotency_conflict"
        })
      }
    }))

  it.effect("still surfaces journal failures that are not idempotency conflicts", () =>
    Effect.gen(function*() {
      const runId = "terminal-journal-broken"
      const key = "terminal-emit/broken"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* activate(runId)
          yield* terminalRowWithoutRecords(runId, key, {
            state: "succeeded",
            outcome: "done",
            meta: { tier: "sealed", boundary: evidence, readSetVerified: true }
          })
          // The replaying process's journal is genuinely broken: the
          // convergence emit must not swallow that.
          const broken: typeof journal = {
            ...journal,
            emitDurable: (input, journalOwner) =>
              input.eventType === "flows.engine.attempt-finished"
                ? Effect.fail(
                  new Journal.JournalError({ code: "queue_overflow", message: "journal saturated" })
                )
                : journal.emitDurable(input, journalOwner)
          }
          const replayed = yield* dispatch(runId, key, () => Effect.die("must not re-execute"), {
            metadata: declared
          }).pipe(
            Effect.provideService(Journal.Journal, broken),
            Effect.provide(boundary),
            Effect.exit
          )
          return { replayed }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // The strong form (issue #128): not just any failure — the surfaced
      // cause carries the journal's own error, so the convergence emit
      // demonstrably propagated the queue_overflow instead of swallowing it
      // into some other failure.
      expect(outcome.replayed._tag).toBe("Failure")
      if (Exit.isFailure(outcome.replayed)) {
        const reason = outcome.replayed.cause.reasons[0]
        expect(reason?._tag).toBe("Fail")
        expect((reason as { readonly error?: unknown }).error).toMatchObject({
          _tag: "@smthrs/journal/JournalError",
          code: "queue_overflow"
        })
      }
    }))
})

describe("replay converges a terminal record the journal is missing (issue #109)", () => {
  it.effect("re-emits attemptFinished on the succeeded replay branch", () =>
    Effect.gen(function*() {
      const runId = "terminal-converge-succeeded"
      const key = "terminal-emit/succeeded"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate(runId)
          yield* terminalRowWithoutRecords(runId, key, {
            state: "succeeded",
            outcome: "done",
            meta: { tier: "sealed", boundary: evidence, readSetVerified: true }
          })
          const missing = yield* eventsOf(runId, "flows.engine.attempt-finished")
          // The re-drive replays the succeeded row — and must fill the hole.
          const replayed = yield* dispatch(runId, key, () => Effect.die("must not re-execute"), {
            metadata: declared
          }).pipe(Effect.provide(boundary))
          const events = yield* eventsOf(runId, "flows.engine.attempt-finished")
          // A second ordinary replay collapses to a Duplicate, not a new row.
          yield* dispatch(runId, key, () => Effect.die("must not re-execute"), { metadata: declared }).pipe(
            Effect.provide(boundary)
          )
          const after = yield* eventsOf(runId, "flows.engine.attempt-finished")
          return { missing, replayed, events, after }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.missing).toHaveLength(0)
      expect(outcome.replayed).toBe("done")
      expect(outcome.events).toHaveLength(1)
      expect((outcome.events[0]!.payload as { state?: string }).state).toBe("succeeded")
      expect(outcome.after).toHaveLength(1)
    }))

  it.effect("re-emits hardViolation and attemptFinished on the failed replay branch", () =>
    Effect.gen(function*() {
      const runId = "terminal-converge-violation"
      const key = "terminal-emit/violation"
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate(runId)
          yield* terminalRowWithoutRecords(runId, key, {
            state: "failed",
            error: { reasons: [{ _tag: "Fail", error: { _tag: "BoundaryViolation" } }] },
            meta: { tier: "sealed", hardViolation: true }
          })
          const missing = yield* eventsOf(runId, "flows.engine.hard-violation")
          // The re-drive replays the durably failed attempt by rethrowing —
          // and must fill both journal holes first.
          const replayed = yield* dispatch(runId, key, () => Effect.die("must not re-execute"), {
            metadata: declared
          }).pipe(Effect.provide(boundary), Effect.exit)
          const violations = yield* eventsOf(runId, "flows.engine.hard-violation")
          const finished = yield* eventsOf(runId, "flows.engine.attempt-finished")
          return { missing, replayed, violations, finished }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.missing).toHaveLength(0)
      expect(outcome.replayed._tag).toBe("Failure")
      expect(outcome.violations).toHaveLength(1)
      expect(outcome.finished).toHaveLength(1)
      expect((outcome.finished[0]!.payload as { state?: string }).state).toBe("failed")
    }))

  it.effect("re-emits expectedSetDeviation alongside the finish on succeeded replays", () =>
    Effect.gen(function*() {
      const runId = "terminal-converge-deviation"
      const key = "terminal-emit/deviation"
      const expectedMode = { ...declared, boundaryMode: "expected" as const }
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate(runId)
          yield* terminalRowWithoutRecords(runId, key, {
            state: "succeeded",
            outcome: "deviated",
            meta: {
              tier: "sealed",
              boundary: {
                ...evidence,
                deviation: {
                  _tag: "ExpectedSetDeviation",
                  paths: ["surprise.txt"],
                  diffIdentity: "terminal-emit-diff"
                }
              }
            }
          })
          const replayed = yield* dispatch(runId, key, () => Effect.die("must not re-execute"), {
            metadata: expectedMode
          }).pipe(Effect.provide(boundary))
          const deviations = yield* eventsOf(runId, "flows.engine.expected-set-deviation")
          const finished = yield* eventsOf(runId, "flows.engine.attempt-finished")
          return { replayed, deviations, finished }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.replayed).toBe("deviated")
      expect(outcome.deviations).toHaveLength(1)
      expect(outcome.finished).toHaveLength(1)
    }))
})

describe("the crash window itself is closed", () => {
  it.effect("a crash at the terminal emit leaves neither the terminal row nor its record", () =>
    Effect.gen(function*() {
      // The complement of the repairs above: with the pair atomic, the crash
      // that used to create the hole now leaves the attempt mid-flight, which
      // the ordinary adoption path re-executes. Journal and state still agree.
      const runId = "terminal-crash-window"
      const key = "terminal-emit/window"
      const crashOnce = (journal: Journal.Journal["Service"]): Journal.Journal["Service"] => {
        let crashed = false
        return {
          ...journal,
          emitDurable: (input: JournalEvent.Input, journalOwner: Ownership.OwnerId) =>
            Effect.suspend(() => {
              if (!crashed && input.eventType === "flows.engine.attempt-finished") {
                crashed = true
                return Effect.die(new Error("simulated crash at the terminal emit"))
              }
              return journal.emitDurable(input, journalOwner)
            })
        }
      }
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const attempts = yield* AttemptStore.AttemptStore
          yield* activate(runId)
          const crashed = yield* dispatch(runId, key, () => Effect.succeed("done"), { metadata: declared }).pipe(
            Effect.provideService(Journal.Journal, crashOnce(journal)),
            Effect.provide(boundary),
            Effect.exit
          )
          const row = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
          const finished = yield* eventsOf(runId, "flows.engine.attempt-finished")
          return { crashed, row, finished }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.crashed._tag).toBe("Failure")
      // The row never reached its terminal state, so no terminal record exists.
      expect(outcome.row._tag === "Some" && outcome.row.value.state).toBe("running")
      expect(outcome.finished).toHaveLength(0)
    }))
})
