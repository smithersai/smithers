import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { EventTypes } from "@smthrs/engine-store/EventTypes"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import * as Jj from "@smthrs/jj"
import { jjError } from "@smthrs/jj"
import * as EngineEvent from "@smthrs/journal/EngineEvent"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import {
  Arbitrary,
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Option,
  Result,
  Schema
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import {
  CompensationHandlers,
  EffectBoundary,
  forkWorkspaceName,
  Frame,
  MemoryTimeTravelStore,
  Migrations,
  type Options as TimeTravelOptions,
  ReadOnlyTimeTravel,
  SqlTimeTravelStore,
  TimeTravel,
  TimeTravelError,
  TimeTravelStore
} from "../src/index.ts"
import * as Compensation from "../src/internal/Compensation.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as ForkOperation from "../src/internal/Fork.ts"
import * as HistoryLimit from "../src/internal/HistoryLimit.ts"
import * as JournalPages from "../src/internal/JournalPages.ts"
import * as Lease from "../src/internal/Lease.ts"
import * as LineageTree from "../src/internal/LineageTree.ts"
import * as Recovery from "../src/internal/Recovery.ts"
import * as Replay from "../src/internal/Replay.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as RunRow from "../src/internal/RunRow.ts"
import * as SnapshotProjector from "../src/internal/SnapshotProjector.ts"
import * as StepHook from "../src/internal/StepHook.ts"
import { journalOf, makeRuns, row as makeRow } from "./MemoryHarness.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "400" : "100"))
const fastExecutions = Math.max(20, baseExecutions)
const medExecutions = Math.max(15, Math.floor(baseExecutions * 0.4))
const sqlExecutions = Math.max(10, Math.floor(baseExecutions * 0.25))
const simExecutions = Math.max(12, Math.floor(baseExecutions * 0.25))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const quietLayer = Logger.layer([])

const runFuzz = async <A>(
  arb: Parameters<typeof Fuzz.run<A, any, never>>[0],
  prop: (input: A) => Effect.Effect<boolean, any, never>,
  options: { readonly seedOffset: number; readonly executions: number; readonly simulation?: boolean }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, prop, {
      seed: seed + options.seedOffset,
      executions: options.executions,
      ...(options.simulation ? { execution: FuzzSimulation.execution() } : {})
    }).pipe(Effect.provide(quietLayer))
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const idArb = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,20}$/)))
const lineageKindArb = Schema.Literals(["child", "fork", "continuation"])

const makeOwner = (suffix: string, pid = 100): OwnerId => ({
  hostId: `host-${suffix}`,
  pid,
  nonce: `nonce-${suffix}`
})

const deadEvidence = (owner: OwnerId, nowMs: number): LivenessEvidence => ({
  kind: "same-host-pid-dead",
  expectedOwner: owner,
  checkedAtMs: nowMs
})

const makeBoundaryRecord = (
  runId: string,
  lineageId: string,
  seq: number,
  effect: Omit<EffectBoundary.EffectRecord, "seq">
): MemoryTimeTravelStore.JournalRecord => ({
  runId,
  seq,
  eventId: `${runId}-ev-${seq}`,
  lineageId,
  eventType: EffectBoundary.eventType,
  payload: {
    eventType: EffectBoundary.eventType,
    payload: { version: 1, effect },
    meta: { lineageId }
  }
})

const makePlainRecord = (
  runId: string,
  lineageId: string,
  seq: number,
  eventType = "baseline",
  payload: unknown = {},
  extraMeta: Record<string, unknown> = {}
): MemoryTimeTravelStore.JournalRecord => ({
  runId,
  seq,
  eventId: `${runId}-ev-${seq}`,
  lineageId,
  eventType,
  payload: {
    eventType,
    payload,
    meta: { lineageId, ...extraMeta }
  }
})

const makeMemoryJj = (options: {
  readonly currentChangeId?: string
  readonly currentOperationId?: string | undefined
  readonly omitOperationId?: boolean
  readonly failOn?: "snapshot" | "restore" | "opRestore" | "workspaceAdd" | "workspaceForget"
} = {}) => {
  let changeId = options.currentChangeId ?? "cur-change"
  let opId = options.currentOperationId ?? "cur-op"
  const workspaces = new Map<string, string>()
  const forgotten: Array<string> = []
  const restored: Array<string> = []
  const opRestored: Array<string> = []

  const service = Jj.makeNoop({
    snapshot: () =>
      options.failOn === "snapshot"
        ? Effect.fail(jjError({ code: "not_installed", method: "snapshot" }))
        : Effect.sync(() => ({
          commitId: changeId,
          changeId,
          ...(options.omitOperationId ? {} : { operationId: opId })
        })),
    restore: (target) =>
      options.failOn === "restore"
        ? Effect.fail(jjError({ code: "conflict", method: "restore" }))
        : Effect.sync(() => {
          restored.push(target)
          changeId = target
        }),
    opRestore: (target) =>
      options.failOn === "opRestore"
        ? Effect.fail(jjError({ code: "conflict", method: "opRestore" }))
        : Effect.sync(() => {
          opRestored.push(target)
          opId = target
        }),
    workspaceAdd: (name, path, rev) =>
      options.failOn === "workspaceAdd"
        ? Effect.fail(jjError({ code: "conflict", method: "workspaceAdd" }))
        : Effect.sync(() => {
          workspaces.set(name, `${path}@${rev ?? "head"}`)
        }),
    workspaceForget: (name) =>
      options.failOn === "workspaceForget"
        ? Effect.fail(jjError({ code: "conflict", method: "workspaceForget" }))
        : Effect.sync(() => {
          forgotten.push(name)
          workspaces.delete(name)
        })
  })
  return {
    service,
    getChangeId: () => changeId,
    getOpId: () => opId,
    workspaces,
    forgotten,
    restored,
    opRestored
  }
}

describe("@smthrs/time-travel fuzz suite", () => {
  // ---------------------------------------------------------------------------
  // 1. Schemas, Errors, Store Facade, LineageTree, HistoryLimit, JournalPages, StepHook, RunRow
  // ---------------------------------------------------------------------------
  describe("core primitives & pure helpers", () => {
    it("Frame schemas, forkWorkspaceName, TimeTravelError & TimeTravelStore facade invariants", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          lineageId: idArb,
          seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
          forkRunId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(40))),
          code: TimeTravelError.TimeTravelErrorCode,
          msg: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
          causeKind: Schema.Literals(["none", "tt", "error", "string"]),
          badKey: Schema.Literals(["id", "runId", "frame", "extra"])
        })
      )
      await runFuzz(
        arb,
        ({ lineageId, seq, forkRunId, code, msg, causeKind, badKey }) =>
          Effect.gen(function*() {
            const decoded = Schema.decodeUnknownSync(Frame.Frame)({ lineageId, seq })
            if (decoded.lineageId !== lineageId || decoded.seq !== seq) return false

            const ws1 = forkWorkspaceName(forkRunId)
            const ws2 = forkWorkspaceName(forkRunId)
            if (ws1 !== ws2 || ws1.length === 0) return false
            if (ws1.includes("..") || ws1.includes("/") || ws1.includes("\\")) return false

            const err = causeKind === "none"
              ? TimeTravelError.error(code, msg)
              : TimeTravelError.error(code, msg, "detail")
            if (err.code !== code || err.message !== msg) return false
            if (causeKind === "none" && "cause" in err && err.cause !== undefined) return false

            const fromCauseInput = causeKind === "tt"
              ? Cause.fail(err)
              : causeKind === "error"
              ? Cause.fail(new Error(msg))
              : Cause.fail(msg)
            const mapped = TimeTravelError.fromCause(fromCauseInput)
            if (causeKind === "tt" && mapped !== err) return false
            if (causeKind !== "tt" && mapped.code !== "unknown") return false

            // TimeTravelStore.validateAuditPatch & messages
            const okPatch = yield* TimeTravelStore.validateAuditPatch({ status: "completed", detail: { ok: true } })
            if (okPatch.status !== "completed") return false

            const badObj = yield* Effect.flip(TimeTravelStore.validateAuditPatch(null as any))
            if (badObj.code !== "invalid") return false
            const badArr = yield* Effect.flip(TimeTravelStore.validateAuditPatch([] as any))
            if (badArr.code !== "invalid") return false
            const badKeyErr = yield* Effect.flip(TimeTravelStore.validateAuditPatch({ [badKey]: "x" } as any))
            if (badKeyErr.code !== "invalid") return false
            const badStatus = yield* Effect.flip(TimeTravelStore.validateAuditPatch({ status: "bogus" as any }))
            if (badStatus.code !== "invalid") return false

            if (!TimeTravelStore.forkFrameMessage("r", decoded).includes(lineageId)) return false
            if (!TimeTravelStore.forkChildTakenMessage(forkRunId).includes(forkRunId)) return false

            // TimeTravelStore.makeNoop / layerNoop fail every unoverridden method with "unknown"
            const noop = yield* TimeTravelStore.TimeTravelStore.pipe(Effect.provide(TimeTravelStore.layerNoop()))
            const methods: ReadonlyArray<Effect.Effect<unknown, TimeTravelError.TimeTravelError>> = [
              noop.snapshotAt("r", decoded),
              noop.recordSnapshot({ runId: "r", frame: decoded, changeId: "c" }),
              noop.recordSnapshots([]),
              noop.latestSnapshots("r"),
              noop.stateAt("r", decoded),
              noop.attemptsAt("r", decoded),
              noop.descendants("r", decoded),
              noop.writeAudit({ id: "a", runId: "r", frame: decoded, status: "in_progress" }),
              noop.updateAudit("a", {}),
              noop.pendingAudits(),
              noop.archiveAndTruncate("r", decoded, [], makeOwner("o")),
              noop.archivedAt("r", 0),
              noop.nextForkId("r", decoded),
              noop.renewForkIntent("c"),
              noop.abandonForkIntents(0),
              noop.forgetForkIntent("c", 0),
              noop.createFork("r", decoded),
              noop.recordReceipt({ id: "rc", auditId: "a", effectId: "e", receipt: {} })
            ]
            for (const m of methods) {
              const fail = yield* Effect.flip(m)
              if (fail.code !== "unknown") return false
            }

            // StepHook & RunRow
            yield* StepHook.run("rewind", undefined, "claim-run")
            yield* StepHook.run("rewind", () => Effect.void, "claim-run")
            const hookFail = yield* Effect.flip(
              StepHook.run("rewind", () => Effect.fail("boom"), "write-audit")
            )
            if (hookFail.code !== "unknown" || !hookFail.message.includes("write-audit")) return false

            const rrNotFound = RunRow.failure(
              "read",
              new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "missing", cause: "x" })
            )
            const rrOther = RunRow.failure(
              "read",
              new RunStore.RunStoreError({ code: "invalid_run", method: "get", message: "bad", cause: "x" })
            )
            if (rrNotFound.code !== "not_found" || rrOther.code !== "unknown") return false

            return true
          }),
        { seedOffset: 1, executions: fastExecutions }
      )
    })

    it("LineageTree.descendants handles arbitrary DAGs, cycles, self-loops, duplicates, and seq thresholds", async () => {
      const nodeArb = Schema.Literals(["r0", "r1", "r2", "r3", "r4", "r5"])
      const arb = Arbitrary.schema(
        Schema.Struct({
          cutoff: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
          edges: Schema.Array(
            Schema.Struct({
              parentRunId: nodeArb,
              parentSeq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
              childRunId: nodeArb,
              kind: lineageKindArb,
              attached: Schema.Boolean
            })
          ).pipe(Schema.check(Schema.isMaxLength(24)))
        })
      )
      await runFuzz(
        arb,
        ({ cutoff, edges }) =>
          Effect.sync(() => {
            const res = LineageTree.descendants(edges, "r0", { lineageId: "r0/root", seq: cutoff })
            if (res.attachedRunIds.has("r0")) return false
            if (res.attached.some((e) => e.childRunId === "r0") || res.detached.some((e) => e.childRunId === "r0")) {
              return false
            }
            const attIds = new Set(res.attached.map((e) => e.childRunId))
            const detIds = new Set(res.detached.map((e) => e.childRunId))
            if (attIds.size !== res.attached.length || detIds.size !== res.detached.length) return false
            if (attIds.size !== res.attachedRunIds.size) return false
            for (const e of [...res.attached, ...res.detached]) {
              if (e.parentRunId === "r0" && e.parentSeq <= cutoff) return false
            }
            for (const e of edges) {
              if (res.attachedRunIds.has(e.parentRunId) && e.childRunId !== "r0") {
                if (e.attached && !res.attachedRunIds.has(e.childRunId)) return false
                if (!e.attached && !detIds.has(e.childRunId)) return false
              }
            }
            return true
          }),
        { seedOffset: 2, executions: fastExecutions }
      )
    })

    it("HistoryLimit & JournalPages enforce bounds, paging invariance, and fail-closed anomalies", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          count: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 30 }))),
          pageSize: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
          stopAt: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 35 }))),
          limit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -3, maximum: 10 }))),
          anomaly: Schema.Literals(["none", "empty_has_more", "non_advancing", "journal_error"])
        })
      )
      await runFuzz(
        arb,
        ({ count, pageSize, stopAt, limit, anomaly }) =>
          Effect.gen(function*() {
            const defaultVal = yield* HistoryLimit.resolve(undefined, 42)
            if (defaultVal !== 42) return false
            const resolved = yield* Effect.result(HistoryLimit.resolve(limit, 42))
            if (limit >= 1 && (!Result.isSuccess(resolved) || resolved.success !== limit)) return false
            if (limit < 1 && (!Result.isFailure(resolved) || resolved.failure.code !== "invalid")) return false
            const nonInt = yield* Effect.flip(HistoryLimit.resolve(1.5, 42))
            if (nonInt.code !== "invalid") return false
            const exc = HistoryLimit.exceeded("replay", "r1", 5)
            if (exc.code !== "limit_exceeded") return false

            const entries: Array<JournalEvent.Entry> = Array.from({ length: count }, (_, i) => ({
              runId: "r1" as JournalEvent.RunId,
              seq: i as JournalEvent.Seq,
              eventId: `e-${i}`,
              sourceId: "src" as JournalEvent.SourceId,
              sourceSeq: i as JournalEvent.SourceSeq,
              emittedAtMs: i,
              eventType: "t",
              payload: {},
              meta: {}
            }))

            if (anomaly === "none") {
              const seen: Array<number> = []
              yield* JournalPages.forEachPage(
                journalOf(entries),
                { runId: "r1", pageSize, label: "test", readFailure: "read failed" },
                (page) =>
                  Effect.sync(() => {
                    for (const e of page) {
                      if (e.seq >= stopAt) return JournalPages.Stop
                      seen.push(e.seq)
                    }
                  })
              )
              const expectedCount = Math.min(count, stopAt)
              if (seen.length !== expectedCount) return false
              for (let i = 0; i < expectedCount; i++) {
                if (seen[i] !== i) return false
              }
              return true
            }

            const badJournal = Journal.makeNoop({
              entries: () => {
                if (anomaly === "journal_error") {
                  return Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "io error" }))
                }
                if (anomaly === "empty_has_more") {
                  return Effect.succeed({ entries: [], hasMore: true })
                }
                return Effect.succeed({
                  entries: [
                    {
                      runId: "r1" as JournalEvent.RunId,
                      seq: 0 as JournalEvent.Seq,
                      eventId: "e-0",
                      sourceId: "src" as JournalEvent.SourceId,
                      sourceSeq: 0 as JournalEvent.SourceSeq,
                      emittedAtMs: 0,
                      eventType: "t",
                      payload: {},
                      meta: {}
                    }
                  ],
                  hasMore: true
                })
              }
            })
            const err = yield* Effect.flip(
              JournalPages.forEachPage(
                badJournal,
                {
                  runId: "r1",
                  after: anomaly === "non_advancing" ? 0 : undefined,
                  pageSize,
                  label: "test",
                  readFailure: "read failed"
                },
                () => Effect.void
              )
            )
            return err.code === (anomaly === "journal_error" ? "unknown" : "invalid")
          }),
        { seedOffset: 3, executions: fastExecutions }
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 2. EffectBoundary (guard, decodeEntry, fromRecords, fromEntries)
  // ---------------------------------------------------------------------------
  describe("EffectBoundary guard & record folding", () => {
    it("EffectBoundary.guard enforces validation, deduplication, and crash-safe settlement across all tiers & faults", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          tier: EffectBoundary.EffectTier,
          outcome: Schema.Literals(["succeed", "fail", "defect", "interrupt"]),
          fault: Schema.Literals([
            "none",
            "duplicate_intended",
            "intended_sink_fail",
            "intended_fence_lost",
            "succeeded_sink_fail_unknown_ok",
            "succeeded_sink_fail_unknown_fail",
            "succeeded_conflict_confirm_ok",
            "succeeded_conflict_confirm_fail",
            "unknown_fail_on_action_err"
          ]),
          metaKind: Schema.Literals(["none", "record", "primitive"]),
          hasKey: Schema.Boolean,
          reservedKind: Schema.Boolean,
          maxSeq: Schema.Boolean,
          durableBoundary: Schema.Boolean,
          providerStream: Schema.Boolean
        })
      )
      await runFuzz(
        arb,
        ({ tier, outcome, fault, metaKind, hasKey, reservedKind, maxSeq, durableBoundary, providerStream }) =>
          Effect.gen(function*() {
            const owner = makeOwner("eb")
            const emitted: Array<{ status: string; sourceSeq: number | undefined; meta: unknown }> = []
            let succeedAttempts = 0

            const journal = Journal.makeNoop({
              emitDurable: (input) => {
                const payload = input.payload as { readonly effect: { readonly status: string } }
                const status = payload.effect.status
                const srcSeq = (input.sourceSeq ?? 0) as JournalEvent.SourceSeq
                if (status === "intended") {
                  if (fault === "duplicate_intended") {
                    return Effect.succeed({
                      _tag: "Duplicate" as const,
                      seq: 0 as JournalEvent.Seq,
                      sourceSeq: srcSeq,
                      status: "committed" as const
                    })
                  }
                  if (fault === "intended_sink_fail") {
                    return Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "disk full" }))
                  }
                  if (fault === "intended_fence_lost") {
                    return Effect.fail(new Journal.JournalError({ code: "fence_lost", message: "stolen" }))
                  }
                }
                if (status === "succeeded") {
                  succeedAttempts += 1
                  if (fault === "succeeded_sink_fail_unknown_ok" || fault === "succeeded_sink_fail_unknown_fail") {
                    return Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "write failed" }))
                  }
                  if (fault === "succeeded_conflict_confirm_ok" && succeedAttempts === 1) {
                    return Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "ack lost" }))
                  }
                  if (fault === "succeeded_conflict_confirm_fail") {
                    return Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "ack lost 2" }))
                  }
                }
                if (status === "unknown") {
                  if (fault === "succeeded_sink_fail_unknown_fail" || fault === "unknown_fail_on_action_err") {
                    return Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "unknown failed" }))
                  }
                  if (fault === "succeeded_conflict_confirm_ok" || fault === "succeeded_conflict_confirm_fail") {
                    return Effect.fail(
                      new Journal.JournalError({ code: "idempotency_conflict", message: "already written" })
                    )
                  }
                }
                emitted.push({ status, sourceSeq: input.sourceSeq, meta: input.meta })
                return Effect.succeed({
                  _tag: "Accepted" as const,
                  seq: emitted.length as JournalEvent.Seq,
                  sourceSeq: srcSeq
                })
              }
            })

            const desc: EffectBoundary.Description = {
              id: "eff-1",
              kind: reservedKind ? EventTypes.childSpawnKind : "mail.send",
              tier,
              runId: "run-1",
              lineageId: "run-1/root",
              owner,
              sourceId: "src-1",
              sourceSeq: maxSeq ? Number.MAX_SAFE_INTEGER - 1 : 0,
              ...(hasKey
                ? { idempotencyKey: "idem-1", cacheKey: "ck-1", changeId: "ch-1", compensation: "comp-1" }
                : {}),
              durableBoundary,
              providerStream,
              attempt: 1,
              nonce: "n1",
              residue: "res",
              input: { x: 1 },
              ...(metaKind === "record"
                ? { metadata: { trace: "abc" } }
                : metaKind === "primitive"
                ? { metadata: "tag-value" }
                : {})
            }

            let actionRan = false
            const action: Effect.Effect<string, string> = Effect.suspend(() => {
              actionRan = true
              if (outcome === "succeed") return Effect.succeed("ok-val")
              if (outcome === "fail") return Effect.fail("typed-err")
              if (outcome === "defect") return Effect.die(new Error("boom"))
              return Effect.interrupt
            })

            const exit = yield* Effect.exit(
              EffectBoundary.guard(desc, action).pipe(Effect.provideService(Journal.Journal, journal))
            )

            if (reservedKind || maxSeq || (tier === "irreversible" && !hasKey)) {
              if (actionRan) return false
              if (!Exit.isFailure(exit)) return false
              return TimeTravelError.fromCause(exit.cause).code === "invalid"
            }
            if (fault === "duplicate_intended") {
              if (actionRan) return false
              if (!Exit.isFailure(exit)) return false
              return TimeTravelError.fromCause(exit.cause).code === "already_crossed"
            }
            if (fault === "intended_sink_fail" || fault === "intended_fence_lost") {
              if (actionRan) return false
              if (!Exit.isFailure(exit)) return false
              return TimeTravelError.fromCause(exit.cause).code === "unknown"
            }

            if (!actionRan) return false
            if (outcome === "succeed") {
              if (
                fault === "none" || fault === "unknown_fail_on_action_err" || fault === "succeeded_conflict_confirm_ok"
              ) {
                return Exit.isSuccess(exit) && exit.value === "ok-val" && emitted.some((e) => e.status === "succeeded")
              }
              if (!Exit.isFailure(exit)) return false
              return TimeTravelError.fromCause(exit.cause).code === "unknown"
            }
            if (!Exit.isFailure(exit)) return false
            if (
              fault !== "unknown_fail_on_action_err" &&
              fault !== "succeeded_sink_fail_unknown_fail" &&
              fault !== "succeeded_conflict_confirm_ok" &&
              fault !== "succeeded_conflict_confirm_fail"
            ) {
              if (!emitted.some((e) => e.status === "unknown")) return false
            }
            return true
          }),
        { seedOffset: 4, executions: fastExecutions }
      )
    })

    it("EffectBoundary.decodeEntry, fromRecords & fromEntries fold valid histories and reject every conflict shape", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "valid_intended_only",
            "valid_intended_succeeded",
            "valid_intended_unknown",
            "valid_exact_duplicate",
            "conflict_identity",
            "conflict_same_seq_status",
            "conflict_same_seq_payload",
            "conflict_post_terminal",
            "conflict_double_intended",
            "corrupt_payload",
            "other_event_type"
          ]),
          seqBase: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50 }))),
          tier: EffectBoundary.EffectTier
        })
      )
      await runFuzz(
        arb,
        ({ mode, seqBase, tier }) =>
          Effect.gen(function*() {
            const baseRecord = (
              seq: number,
              status: EffectBoundary.EffectStatus,
              overrides: Partial<EffectBoundary.EffectRecord> = {}
            ): EffectBoundary.EffectRecord => ({
              id: "e1",
              kind: "k1",
              tier,
              status,
              runId: "r1",
              lineageId: "r1/root",
              seq,
              durableBoundary: true,
              providerStream: false,
              ...overrides
            })

            const toEntry = (
              rec: EffectBoundary.EffectRecord,
              eventType = EffectBoundary.eventType
            ): JournalEvent.Entry => ({
              runId: "r1" as JournalEvent.RunId,
              seq: rec.seq as JournalEvent.Seq,
              eventId: `ev-${rec.seq}`,
              sourceId: "src" as JournalEvent.SourceId,
              sourceSeq: rec.seq as JournalEvent.SourceSeq,
              emittedAtMs: rec.seq,
              eventType,
              payload: { version: 1, effect: rec },
              meta: { lineageId: rec.lineageId }
            })

            if (mode === "other_event_type") {
              const dec = yield* EffectBoundary.decodeEntry(toEntry(baseRecord(seqBase, "intended"), "other.event"))
              return dec === undefined
            }
            if (mode === "corrupt_payload") {
              const badEntry: JournalEvent.Entry = {
                ...toEntry(baseRecord(seqBase, "intended")),
                payload: { version: 99, bogus: true }
              }
              const err = yield* Effect.flip(EffectBoundary.fromEntries([badEntry]))
              return err.code === "invalid"
            }

            if (mode === "valid_intended_only") {
              const out = yield* EffectBoundary.fromEntries([toEntry(baseRecord(seqBase, "intended"))])
              return out.length === 1 && out[0]!.status === "intended"
            }
            if (mode === "valid_intended_succeeded") {
              const out = yield* EffectBoundary.fromEntries([
                toEntry(baseRecord(seqBase + 1, "succeeded", { output: 42 })),
                toEntry(baseRecord(seqBase, "intended"))
              ])
              return out.length === 1 && out[0]!.status === "succeeded" && out[0]!.output === 42
            }
            if (mode === "valid_intended_unknown") {
              const out = yield* EffectBoundary.fromRecords([
                baseRecord(seqBase, "intended"),
                baseRecord(seqBase + 2, "unknown")
              ])
              return out.length === 1 && out[0]!.status === "unknown"
            }
            if (mode === "valid_exact_duplicate") {
              const r = baseRecord(seqBase, "intended")
              const out = yield* EffectBoundary.fromRecords([r, { ...r }])
              return out.length === 1 && out[0]!.seq === seqBase
            }

            const conflictingRecords: ReadonlyArray<EffectBoundary.EffectRecord> = mode === "conflict_identity"
              ? [baseRecord(seqBase, "intended"), baseRecord(seqBase + 1, "succeeded", { kind: "different-kind" })]
              : mode === "conflict_same_seq_status"
              ? [baseRecord(seqBase, "intended"), baseRecord(seqBase, "succeeded")]
              : mode === "conflict_same_seq_payload"
              ? [baseRecord(seqBase, "succeeded", { output: 1 }), baseRecord(seqBase, "succeeded", { output: 2 })]
              : mode === "conflict_post_terminal"
              ? [baseRecord(seqBase, "succeeded"), baseRecord(seqBase + 1, "unknown")]
              : [baseRecord(seqBase, "intended"), baseRecord(seqBase + 1, "intended")]

            const err = yield* Effect.flip(EffectBoundary.fromRecords(conflictingRecords))
            return err.code === "invalid"
          }),
        { seedOffset: 5, executions: fastExecutions }
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 3. EffectHandlerRegistry & Compensation
  // ---------------------------------------------------------------------------
  describe("EffectHandlerRegistry & Compensation", () => {
    it("EffectHandlerRegistry validates registrations and assesses/reverts/rolls back consistently", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          caseKind: Schema.Literals([
            "ok_default_assess",
            "ok_custom_assess",
            "malformed_custom_assess",
            "duplicate_kind",
            "missing_handler",
            "tier_mismatch",
            "descriptor_mismatch",
            "missing_key",
            "non_succeeded",
            "revert_fail",
            "rollback_fail",
            "rollback_tier_mismatch",
            "rollback_descriptor_mismatch",
            "invalid_empty_kind"
          ]),
          status: Schema.Literals(["intended", "unknown"])
        })
      )
      await runFuzz(
        arb,
        ({ caseKind, status }) =>
          Effect.gen(function*() {
            const baseHandler: CompensationHandlers.Handler = {
              kind: "billing.charge",
              tier: "irreversible",
              compensation: "billing.refund/v1",
              requiresIdempotencyKey: true,
              residue: (e) => `refunded ${e.id}`,
              revert: (e) => Effect.succeed({ refundFor: e.id }),
              rollback: () => Effect.void
            }

            if (caseKind === "invalid_empty_kind") {
              const err = yield* Effect.flip(EffectHandlerRegistry.make([{ ...baseHandler, kind: "" }]))
              return err.code === "invalid"
            }
            if (caseKind === "duplicate_kind") {
              const err = yield* Effect.flip(EffectHandlerRegistry.make([baseHandler, baseHandler]))
              return err.code === "unknown"
            }

            const eff: EffectBoundary.EffectRecord = {
              id: "eff-pay",
              kind: caseKind === "missing_handler" ? "unregistered.kind" : "billing.charge",
              tier: caseKind === "tier_mismatch" ? "compensable" : "irreversible",
              status: caseKind === "non_succeeded" ? status : "succeeded",
              runId: "r1",
              lineageId: "r1/root",
              seq: 3,
              compensation: caseKind === "descriptor_mismatch" ? "wrong.desc" : "billing.refund/v1",
              ...(caseKind === "missing_key" ? {} : { idempotencyKey: "pay-key-1" }),
              durableBoundary: true,
              providerStream: false
            }

            const handler: CompensationHandlers.Handler = {
              ...baseHandler,
              ...(caseKind === "ok_custom_assess"
                ? {
                  assess: () => Effect.succeed({ classification: "warning" as const, reason: "soft", residue: "none" })
                }
                : caseKind === "malformed_custom_assess"
                ? { assess: () => Effect.succeed({ classification: "bogus" } as any) }
                : {}),
              ...(caseKind === "revert_fail"
                ? { revert: () => Effect.fail(TimeTravelError.error("compensation_failed", "stripe down")) }
                : {}),
              ...(caseKind === "rollback_fail"
                ? { rollback: () => Effect.fail(TimeTravelError.error("compensation_failed", "undo failed")) }
                : {})
            }

            const reg = yield* EffectHandlerRegistry.make([handler])
            const assessed = yield* reg.assess(eff)

            if (caseKind === "ok_default_assess") {
              if (assessed.classification !== "revertible") return false
              const receipt = yield* reg.revert(eff)
              yield* reg.rollback(receipt)
              return receipt.id === `${eff.id}:rollback`
            }
            if (caseKind === "ok_custom_assess") {
              return assessed.classification === "warning"
            }
            if (
              caseKind === "malformed_custom_assess" ||
              caseKind === "missing_handler" ||
              caseKind === "tier_mismatch" ||
              caseKind === "descriptor_mismatch" ||
              caseKind === "missing_key" ||
              caseKind === "non_succeeded"
            ) {
              if (assessed.classification !== "blocking") return false
              if (caseKind !== "malformed_custom_assess" && caseKind !== "non_succeeded") {
                const revErr = yield* Effect.flip(reg.revert(eff))
                if (revErr.code !== "irreversible") return false
              }
              return true
            }
            if (caseKind === "revert_fail") {
              const revErr = yield* Effect.flip(reg.revert(eff))
              return revErr.code === "compensation_failed"
            }
            if (caseKind === "rollback_fail") {
              const receipt = yield* reg.revert(eff)
              const rbErr = yield* Effect.flip(reg.rollback(receipt))
              return rbErr.code === "compensation_failed"
            }
            if (caseKind === "rollback_tier_mismatch") {
              const rbErr = yield* Effect.flip(
                reg.rollback({ id: "r", effect: { ...eff, tier: "compensable" }, data: {} })
              )
              return rbErr.code === "compensation_failed"
            }
            if (caseKind === "rollback_descriptor_mismatch") {
              const rbErr = yield* Effect.flip(
                reg.rollback({ id: "r", effect: { ...eff, compensation: "other/v2" }, data: {} })
              )
              return rbErr.code === "compensation_failed"
            }
            return true
          }),
        { seedOffset: 6, executions: fastExecutions }
      )
    })

    it("Compensation.assess, compensate, prepareWorkspace, restorePreparedWorkspace & rollback uphold reverse-order & atomicity", async () => {
      const effectSpecArb = Schema.Struct({
        tier: EffectBoundary.EffectTier,
        hasKey: Schema.Boolean,
        cacheHit: Schema.Boolean,
        status: EffectBoundary.EffectStatus,
        durableBoundary: Schema.Boolean,
        providerStream: Schema.Boolean,
        revertFails: Schema.Boolean,
        rollbackFails: Schema.Boolean,
        leaksSecret: Schema.Boolean
      })
      const arb = Arbitrary.schema(
        Schema.Struct({
          specs: Schema.Array(effectSpecArb).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(6))),
          hasTargetChange: Schema.Boolean,
          wholeRepo: Schema.Boolean,
          hasTargetOp: Schema.Boolean,
          omitCurrentOp: Schema.Boolean,
          onReceiptsFails: Schema.Boolean,
          jjFail: Schema.Literals(["none", "snapshot", "restore", "opRestore"])
        })
      )
      await runFuzz(
        arb,
        ({ specs, hasTargetChange, wholeRepo, hasTargetOp, omitCurrentOp, onReceiptsFails, jjFail }) =>
          Effect.gen(function*() {
            const events: Array<string> = []
            const cacheMap = new Map<string, CacheStore.CacheEntry>()
            const handlers: Array<CompensationHandlers.Handler> = []
            const effects: Array<EffectBoundary.EffectRecord> = []

            specs.forEach((spec, idx) => {
              const seq = idx + 1
              const id = `eff-${seq}`
              const kind = `kind-${seq}`
              const cacheKey = spec.hasKey ? `ck-${seq}` : undefined
              if (cacheKey !== undefined && spec.cacheHit) {
                cacheMap.set(cacheKey, {
                  keyDigest: cacheKey,
                  result: { seq },
                  meta: {},
                  createdAtMs: 0,
                  recordedRunId: "r1",
                  recordedEventSeq: seq
                })
              }
              effects.push({
                id,
                kind,
                tier: spec.tier,
                status: spec.status,
                runId: "r1",
                lineageId: "r1/root",
                seq,
                ...(cacheKey !== undefined ? { cacheKey } : {}),
                ...(spec.tier === "compensable" ? { changeId: `ch-${seq}` } : {}),
                ...(spec.tier === "irreversible" && spec.hasKey ? { idempotencyKey: `ik-${seq}` } : {}),
                durableBoundary: spec.durableBoundary,
                providerStream: spec.providerStream
              })
              if (spec.tier === "irreversible") {
                handlers.push({
                  kind,
                  tier: "irreversible",
                  requiresIdempotencyKey: true,
                  residue: () => "none",
                  revert: () => {
                    events.push(`revert:${seq}`)
                    if (spec.revertFails) {
                      return Effect.fail(TimeTravelError.error("compensation_failed", `revert-boom-${seq}`))
                    }
                    if (spec.leaksSecret) return Effect.succeed({ token: "ghp_1234567890abcdef1234567890abcdef1234" })
                    return Effect.succeed({ seq })
                  },
                  rollback: () => {
                    events.push(`rollback:${seq}`)
                    if (spec.rollbackFails) {
                      return Effect.fail(TimeTravelError.error("compensation_failed", `rollback-boom-${seq}`))
                    }
                    return Effect.void
                  }
                })
              }
            })

            const cacheLayer = Layer.succeed(
              CacheStore.CacheStore,
              CacheStore.makeNoop({
                get: (key) => Effect.sync(() => Option.fromUndefinedOr(cacheMap.get(key)))
              })
            )
            const regLayer = EffectHandlerRegistry.layer(handlers)
            const jjMem = makeMemoryJj({
              currentChangeId: "head-ch",
              currentOperationId: "head-op",
              omitOperationId: omitCurrentOp,
              ...(jjFail === "none" ? {} : { failOn: jjFail })
            })
            const jjLayer = Layer.succeed(Jj.Jj, jjMem.service)
            const env = Layer.mergeAll(cacheLayer, regLayer, jjLayer)

            const plan = yield* Compensation.assess(
              effects,
              hasTargetChange ? "target-ch" : undefined,
              wholeRepo
                ? { wholeRepo: true, ...(hasTargetOp ? { targetOperationId: "target-op" } : {}) }
                : undefined
            ).pipe(Effect.provide(env))

            if (plan.assessments.length !== effects.length) return false
            const hasBlocking = plan.assessments.some((a) => a.classification === "blocking")

            const compExit = yield* Effect.exit(
              Compensation.compensate(
                plan,
                onReceiptsFails ? () => Effect.fail(TimeTravelError.error("unknown", "persist failed")) : undefined
              ).pipe(Effect.provide(env))
            )

            if (hasBlocking) {
              if (!Exit.isFailure(compExit)) return false
              return TimeTravelError.fromCause(compExit.cause).code === "irreversible"
            }

            if (Exit.isSuccess(compExit)) {
              const receipts = compExit.value
              const storeReceipts = Compensation.toStoreReceipts("audit-1", { handlerReceipts: receipts })
              if (storeReceipts.length !== receipts.length) return false

              const prepExit = yield* Effect.exit(
                Compensation.prepareWorkspace(plan, receipts).pipe(Effect.provide(env))
              )
              if (Exit.isSuccess(prepExit)) {
                const restExit = yield* Effect.exit(
                  Compensation.restorePreparedWorkspace(prepExit.value).pipe(Effect.provide(env))
                )
                if (Exit.isSuccess(restExit)) {
                  const rbExit = yield* Effect.exit(
                    Compensation.rollback(restExit.value).pipe(Effect.provide(env))
                  )
                  if (Exit.isFailure(rbExit)) {
                    const rbErr = TimeTravelError.fromCause(rbExit.cause)
                    if (rbErr.code !== "compensation_failed") return false
                  }
                }
              }
              return true
            } else {
              const err = TimeTravelError.fromCause(compExit.cause)
              const stillApplied = Compensation.applied(err)
              if (stillApplied !== undefined && !Array.isArray(stillApplied.handlerReceipts)) return false
              return err.code === "compensation_failed" || err.code === "unknown"
            }
          }),
        { seedOffset: 7, executions: medExecutions }
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 4. SnapshotProjector, Replay & ReadOnlyTimeTravel
  // ---------------------------------------------------------------------------
  describe("SnapshotProjector, Replay & ReadOnlyTimeTravel", () => {
    it("SnapshotProjector.project is idempotent across resume, pageSize, upTo, and multi-lineage interleaving", async () => {
      const eventArb = Schema.Struct({
        lineage: Schema.Literals(["lin-a", "lin-b"]),
        kind: Schema.Literals(["snapshot", "carried", "plan", "subgraph", "plan_no_digest", "other"]),
        tag: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
        withOp: Schema.Boolean
      })
      const arb = Arbitrary.schema(
        Schema.Struct({
          events: Schema.Array(eventArb).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20))),
          pageSize: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 6 }))),
          splitAt: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 })))
        })
      )
      await runFuzz(
        arb,
        ({ events, pageSize, splitAt }) =>
          Effect.gen(function*() {
            const entries: Array<JournalEvent.Entry> = events.map((ev, seq) => {
              const eventType = ev.kind === "snapshot" || ev.kind === "carried"
                ? EventTypes.snapshotIdentified
                : ev.kind === "plan" || ev.kind === "plan_no_digest"
                ? EventTypes.planRecorded
                : ev.kind === "subgraph"
                ? EventTypes.subgraphAppended
                : "other.event"
              const payload = ev.kind === "snapshot"
                ? {
                  version: 1,
                  snapshotId: `snap-${ev.tag}`,
                  ...(ev.withOp ? { operationId: `op-${ev.tag}` } : {})
                }
                : ev.kind === "carried"
                ? { version: 1, carried: true }
                : ev.kind === "plan" || ev.kind === "subgraph"
                ? { version: 1, digest: `dig-${ev.tag}` }
                : ev.kind === "plan_no_digest"
                ? { version: 1 }
                : { note: ev.tag }
              return {
                runId: "run-p" as JournalEvent.RunId,
                seq: seq as JournalEvent.Seq,
                eventId: `ev-${seq}`,
                sourceId: "src" as JournalEvent.SourceId,
                sourceSeq: seq as JournalEvent.SourceSeq,
                emittedAtMs: seq,
                eventType,
                payload,
                meta: { lineageId: ev.lineage }
              }
            })

            const storeFull = MemoryTimeTravelStore.make()
            const envFull = Layer.mergeAll(
              Layer.succeed(Journal.Journal, journalOf(entries)),
              Layer.succeed(TimeTravelStore.TimeTravelStore, storeFull)
            )
            const fullState = yield* SnapshotProjector.project("run-p", { pageSize }).pipe(Effect.provide(envFull))

            const storeInc = MemoryTimeTravelStore.make()
            const envInc = Layer.mergeAll(
              Layer.succeed(Journal.Journal, journalOf(entries)),
              Layer.succeed(TimeTravelStore.TimeTravelStore, storeInc)
            )
            yield* SnapshotProjector.project("run-p", { pageSize: 1, upTo: splitAt }).pipe(Effect.provide(envInc))
            yield* SnapshotProjector.project("run-p", { pageSize }).pipe(Effect.provide(envInc))
            const repeat = yield* SnapshotProjector.project("run-p", { pageSize }).pipe(Effect.provide(envInc))
            if (repeat.anchors !== 0) return false

            for (const lin of ["lin-a", "lin-b"]) {
              for (let s = 0; s < events.length; s++) {
                const a = yield* storeFull.snapshotAt("run-p", { lineageId: lin, seq: s })
                const b = yield* storeInc.snapshotAt("run-p", { lineageId: lin, seq: s })
                if (
                  (a === undefined) !== (b === undefined) ||
                  (a !== undefined && b !== undefined && (a.changeId !== b.changeId || a.planDigest !== b.planDigest))
                ) {
                  return false
                }
              }
            }

            if (events.length >= 2) {
              const storeLim = MemoryTimeTravelStore.make()
              const limErr = yield* Effect.flip(
                SnapshotProjector.project("run-p", { pageSize: 1, maxEntries: 1 }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      Layer.succeed(Journal.Journal, journalOf(entries)),
                      Layer.succeed(TimeTravelStore.TimeTravelStore, storeLim)
                    )
                  )
                )
              )
              if (limErr.code !== "limit_exceeded") return false
            }

            const storeDirect = MemoryTimeTravelStore.make()
            const proj = SnapshotProjector.projection(storeDirect)
            let directState = proj.initial
            for (const entry of entries) {
              directState = yield* proj.reduce(directState, entry)
            }
            return directState.anchors === fullState.anchors
          }),
        { seedOffset: 8, executions: fastExecutions }
      )
    })

    it("Replay.rederive & ReadOnlyTimeTravel are pageSize-invariant and fail closed on corrupt/out-of-range frames", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          entriesSpec: Schema.Array(
            Schema.Struct({
              lineage: Schema.Literals(["lin-a", "lin-b", "none"]),
              val: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
              cached: Schema.Boolean
            })
          ).pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(18))),
          pageSize: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 7 }))),
          targetIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 17 })))
        })
      )
      await runFuzz(
        arb,
        ({ entriesSpec, pageSize, targetIdx }) =>
          Effect.gen(function*() {
            const clampedTarget = Math.min(targetIdx, entriesSpec.length - 1)
            const cacheMap = new Map<string, CacheStore.CacheEntry>()
            const entries: Array<JournalEvent.Entry> = entriesSpec.map((spec, seq) => {
              const cacheKey = spec.cached ? `ck-${seq}` : undefined
              if (cacheKey !== undefined) {
                cacheMap.set(cacheKey, {
                  keyDigest: cacheKey,
                  result: spec.val * 10,
                  meta: {},
                  createdAtMs: 0,
                  recordedRunId: "run-r",
                  recordedEventSeq: seq
                })
              }
              return {
                runId: "run-r" as JournalEvent.RunId,
                seq: seq as JournalEvent.Seq,
                eventId: `ev-${seq}`,
                sourceId: "src" as JournalEvent.SourceId,
                sourceSeq: seq as JournalEvent.SourceSeq,
                emittedAtMs: seq,
                eventType: "step.done",
                payload: { val: spec.val },
                meta: {
                  ...(spec.lineage === "none" ? {} : { lineageId: spec.lineage }),
                  ...(cacheKey === undefined ? {} : { cacheKey })
                }
              }
            })

            const projection: Replay.Projection<Array<string>> = {
              initial: [],
              reduce: (acc, entry, sealed) => [
                ...acc,
                `${entry.seq}:${(entry.payload as { val: number }).val}:${sealed === undefined ? "u" : String(sealed)}`
              ]
            }

            const env = Layer.mergeAll(
              Layer.succeed(Journal.Journal, journalOf(entries)),
              Layer.succeed(
                CacheStore.CacheStore,
                CacheStore.makeNoop({
                  get: (key) => Effect.sync(() => Option.fromUndefinedOr(cacheMap.get(key)))
                })
              )
            )

            const hasLinA = entriesSpec.slice(0, clampedTarget + 1).some((s) => s.lineage === "lin-a")
            const frame = { lineageId: "lin-a", seq: clampedTarget }

            const r1 = yield* Effect.result(
              Replay.rederive(frame, projection, { runId: "run-r", pageSize: 1 }).pipe(Effect.provide(env))
            )
            const rk = yield* Effect.result(
              Replay.rederive(frame, projection, { runId: "run-r", pageSize }).pipe(Effect.provide(env))
            )

            if (!hasLinA) {
              if (!Result.isFailure(r1) || r1.failure.code !== "not_found") return false
              if (!Result.isFailure(rk) || rk.failure.code !== "not_found") return false
            } else {
              if (!Result.isSuccess(r1) || !Result.isSuccess(rk)) return false
              if (JSON.stringify(r1.success) !== JSON.stringify(rk.success)) return false

              const ro = yield* ReadOnlyTimeTravel.pipe(Effect.provide(TimeTravel.readOnly.pipe(Layer.provide(env))))
              const roReplay = yield* ro.replay({ runId: "run-r", frame }, projection, { pageSize })
              const roInspect = yield* ro.inspect({ runId: "run-r", frame }, projection)
              if (JSON.stringify(roReplay) !== JSON.stringify(r1.success)) return false
              if (JSON.stringify(roInspect) !== JSON.stringify(r1.success)) return false

              const pastTail = yield* Effect.flip(
                ro.replay({ runId: "run-r", frame: { lineageId: "lin-a", seq: entriesSpec.length + 5 } }, projection)
              )
              if (pastTail.code !== "not_found") return false

              const badLimit = yield* Effect.flip(
                ro.replay({ runId: "run-r", frame }, projection, { maxHistoryEntries: 0 })
              )
              if (badLimit.code !== "invalid") return false
              if (clampedTarget >= 1) {
                const capErr = yield* Effect.flip(
                  ro.replay({ runId: "run-r", frame }, projection, { maxHistoryEntries: 1 })
                )
                if (capErr.code !== "limit_exceeded") return false
              }
            }

            const cleanEntry0: JournalEvent.Entry = { ...entries[0]!, meta: { lineageId: "lin-a" } }
            const dupJournal = Journal.makeNoop({
              entries: () =>
                Effect.succeed({
                  entries: [cleanEntry0, { ...cleanEntry0, eventId: "conflicting-id" }],
                  hasMore: false
                })
            })
            const dupErr = yield* Effect.flip(
              Replay.rederive({ lineageId: "lin-a", seq: 0 }, projection, { runId: "run-r" }).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    Layer.succeed(Journal.Journal, dupJournal),
                    Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())
                  )
                )
              )
            )
            if (dupErr.code !== "invalid") return false

            const v2Journal = Journal.makeNoop({
              entries: () =>
                Effect.succeed({
                  entries: [{ ...entries[0]!, eventType: "flows.engine.v2.run-started" }],
                  hasMore: false
                })
            })
            const v2Err = yield* Effect.flip(
              Replay.rederive({ lineageId: "lin-a", seq: 0 }, projection, { runId: "run-r" }).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    Layer.succeed(Journal.Journal, v2Journal),
                    Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())
                  )
                )
              )
            )
            return v2Err.code === "invalid"
          }),
        { seedOffset: 9, executions: fastExecutions }
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 5. Differential Fuzzing: MemoryTimeTravelStore vs SqlTimeTravelStore (Real SQLite!)
  // ---------------------------------------------------------------------------
  describe("MemoryTimeTravelStore vs SqlTimeTravelStore differential conformance", () => {
    it("snapshots, stateAt, attemptsAt, descendants, audits, receipts, archives & fork intents agree across Memory and SQLite", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          snaps: Schema.Array(
            Schema.Struct({
              lineage: Schema.Literals(["run/root", "run/alt"]),
              seq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
              changeNum: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
              withOp: Schema.Boolean,
              withDigest: Schema.Boolean
            })
          ).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8))),
          querySeq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
          useStrangerOnArchive: Schema.Boolean,
          forkFrameSeq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
          reclaimIntent: Schema.Boolean
        })
      )
      await runFuzz(
        arb,
        ({ snaps, querySeq, useStrangerOnArchive, forkFrameSeq, reclaimIntent }) =>
          Effect.gen(function*() {
            const owner = makeOwner("diff")
            const stranger = makeOwner("stranger", 999)
            const lineage = "run/root"

            const memRecords: Array<MemoryTimeTravelStore.JournalRecord> = [
              {
                runId: "run",
                seq: 0,
                eventId: "run-0",
                lineageId: lineage,
                eventType: EventTypes.runDecision,
                payload: { state: { version: 1, flowName: "Demo", payload: { step: 0 } } }
              },
              {
                runId: "run",
                seq: 1,
                eventId: "run-1",
                lineageId: lineage,
                eventType: EventTypes.attemptStarted,
                payload: { stepKeyDigest: "step-a", attempt: 1 }
              },
              {
                runId: "run",
                seq: 2,
                eventId: "run-2",
                lineageId: lineage,
                eventType: EventTypes.attemptFinished,
                payload: { stepKeyDigest: "step-a", attempt: 1, outcome: "succeeded" }
              },
              {
                runId: "run",
                seq: 3,
                eventId: "run-3",
                lineageId: lineage,
                eventType: EventTypes.runDecision,
                payload: {
                  decision: "handed-off",
                  nextExecutionId: "det-1",
                  state: { version: 1, flowName: "Demo", payload: { step: 3 } }
                }
              },
              {
                runId: "att-1",
                seq: 0,
                eventId: "att-1-0",
                lineageId: "att-1/root",
                eventType: EventTypes.runDecision,
                payload: { state: { version: 1, flowName: "Child", payload: {} } }
              }
            ]
            const memEdges: Array<Frame.LineageEdge> = [
              { parentRunId: "run", parentSeq: 2, childRunId: "att-1", kind: "child", attached: true },
              { parentRunId: "run", parentSeq: 3, childRunId: "det-1", kind: "continuation", attached: false }
            ]
            const memStore = MemoryTimeTravelStore.make({
              records: memRecords,
              edges: memEdges,
              liveRuns: new Set(["run"]),
              runOwners: new Map([["run", owner]]),
              runStatuses: new Map([
                ["run", "running"],
                ["att-1", "completed"],
                ["det-1", "suspended"]
              ])
            })

            const sqlRes = yield* Effect.gen(function*() {
              yield* Migrations.run
              const sql = yield* SqlClient.SqlClient
              const sqlStore = yield* SqlTimeTravelStore.make

              yield* sql`
                INSERT INTO flows_runs
                  (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
                VALUES (
                  'run', 'running', 0,
                  ${JSON.stringify({ version: 1, flowName: "Demo", payload: { step: 3 } })},
                  ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0
                )
              `
              yield* sql`
                INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
                VALUES
                  ('att-1', 'completed', 0, ${JSON.stringify({ version: 1, flowName: "Child", payload: {} })}),
                  ('det-1', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})
              `
              for (const r of memRecords) {
                yield* sql`
                  INSERT INTO flows_journal_events
                    (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
                  VALUES (
                    ${r.runId}, ${r.seq}, ${r.eventId}, 'src', ${r.seq}, 0,
                    ${r.eventType ?? "event"}, ${JSON.stringify(r.payload)}, ${
                  JSON.stringify({ lineageId: r.lineageId })
                }
                  )
                `
              }
              yield* sql`
                INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
                VALUES
                  ('run', 2, 'att-1', 'child', 1),
                  ('run', 3, 'det-1', 'continuation', 0)
              `

              const runOps = (store: TimeTravelStore.Service) =>
                Effect.gen(function*() {
                  const batch = snaps.slice(0, -1).map((s) => ({
                    runId: "run",
                    frame: { lineageId: s.lineage, seq: s.seq },
                    changeId: `ch-${s.changeNum}`,
                    ...(s.withOp ? { operationId: `op-${s.changeNum}` } : {}),
                    ...(s.withDigest ? { planDigest: `dig-${s.changeNum}` } : {})
                  }))
                  yield* store.recordSnapshots(batch)
                  const lastSnap = snaps[snaps.length - 1]!
                  yield* store.recordSnapshot({
                    runId: "run",
                    frame: { lineageId: lastSnap.lineage, seq: lastSnap.seq },
                    changeId: `ch-${lastSnap.changeNum}`,
                    ...(lastSnap.withOp ? { operationId: `op-${lastSnap.changeNum}` } : {}),
                    ...(lastSnap.withDigest ? { planDigest: `dig-${lastSnap.changeNum}` } : {})
                  })
                  const snapAt = yield* store.snapshotAt("run", { lineageId: lineage, seq: querySeq })
                  const latest = yield* store.latestSnapshots("run")
                  const stateAt = yield* store.stateAt("run", { lineageId: lineage, seq: querySeq })
                  const attemptsAt = yield* store.attemptsAt("run", { lineageId: lineage, seq: querySeq })
                  const desc = yield* store.descendants("run", { lineageId: lineage, seq: Math.min(querySeq, 3) })

                  const auditId = "audit-diff-1"
                  yield* store.writeAudit({
                    id: auditId,
                    runId: "run",
                    frame: { lineageId: lineage, seq: 1 },
                    status: "in_progress",
                    detail: { step: 1 }
                  })
                  const pending1 = yield* store.pendingAudits()
                  yield* store.recordReceipt({
                    id: "rc-1",
                    auditId,
                    effectId: "eff-1",
                    receipt: { refunded: true }
                  })
                  yield* store.updateAudit(auditId, { status: "completed", detail: { step: 2 } })
                  const pending2 = yield* store.pendingAudits()

                  const minted1 = yield* store.nextForkId("run", { lineageId: lineage, seq: forkFrameSeq })
                  yield* store.renewForkIntent(minted1)
                  let reclaimedCount = 0
                  if (reclaimIntent) {
                    const nowMs = yield* Clock.currentTimeMillis
                    const abandoned = yield* store.abandonForkIntents(nowMs + 10_000)
                    reclaimedCount = abandoned.length
                    for (const intent of abandoned) {
                      yield* store.forgetForkIntent(intent.childRunId, intent.reclaimedAtMs!)
                    }
                  }
                  const forkRes = yield* Effect.result(
                    store.createFork("run", { lineageId: lineage, seq: forkFrameSeq }, minted1)
                  )

                  const archRes = yield* Effect.result(
                    store.archiveAndTruncate(
                      "run",
                      { lineageId: lineage, seq: 1 },
                      [{ id: "rc-2", auditId, effectId: "eff-2", receipt: { ok: true } }],
                      useStrangerOnArchive ? stranger : owner
                    )
                  )
                  const archivedSeq2 = yield* store.archivedAt("run", 2, 0)

                  return {
                    snapChange: snapAt?.changeId,
                    snapOp: snapAt?.operationId,
                    snapDigest: snapAt?.planDigest,
                    latestCount: latest.length,
                    stateFound: stateAt !== undefined,
                    attemptsCount: attemptsAt.length,
                    attachedIds: desc.attached.map((e) => e.childRunId).sort(),
                    detachedIds: desc.detached.map((e) => e.childRunId).sort(),
                    pending1Count: pending1.length,
                    pending2Count: pending2.length,
                    reclaimedCount,
                    forkCode: Result.isFailure(forkRes) ? forkRes.failure.code : "ok",
                    archCode: Result.isFailure(archRes) ? archRes.failure.code : `ok:${archRes.success.archived}`,
                    archivedSeq2
                  }
                })

              const sqlOut = yield* runOps(sqlStore)
              const memOut = yield* runOps(memStore)
              return { sqlOut, memOut }
            }).pipe(Effect.provide(TestDatabase.layer))

            const { sqlOut, memOut } = sqlRes
            if (sqlOut.snapChange !== memOut.snapChange) return false
            if (sqlOut.snapOp !== memOut.snapOp) return false
            if (sqlOut.snapDigest !== memOut.snapDigest) return false
            if (sqlOut.latestCount !== memOut.latestCount) return false
            if (sqlOut.stateFound !== memOut.stateFound) return false
            if (sqlOut.attemptsCount !== memOut.attemptsCount) return false
            if (JSON.stringify(sqlOut.attachedIds) !== JSON.stringify(memOut.attachedIds)) return false
            if (JSON.stringify(sqlOut.detachedIds) !== JSON.stringify(memOut.detachedIds)) return false
            if (sqlOut.pending1Count !== memOut.pending1Count || sqlOut.pending2Count !== memOut.pending2Count) {
              return false
            }
            if (sqlOut.reclaimedCount !== memOut.reclaimedCount) return false
            if (sqlOut.forkCode !== memOut.forkCode) return false
            if (sqlOut.archCode !== memOut.archCode) return false
            if (sqlOut.archivedSeq2 !== memOut.archivedSeq2) return false
            return true
          }),
        { seedOffset: 10, executions: sqlExecutions }
      )
    })

    it("SqlTimeTravelStore createFork exercises step overrides, rebinding, carriedChildren & inbound cutoffs", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          frameSeq: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
          withOverride: Schema.Boolean,
          overrideOnChild: Schema.Boolean,
          overrideMissing: Schema.Boolean,
          withRebinding: Schema.Boolean,
          unknownCarriedChild: Schema.Boolean,
          childHasInbound: Schema.Boolean
        })
      )
      await runFuzz(
        arb,
        (
          {
            frameSeq,
            withOverride,
            overrideOnChild,
            overrideMissing,
            withRebinding,
            unknownCarriedChild,
            childHasInbound
          }
        ) =>
          Effect.gen(function*() {
            const lineage = "parent/root"
            const childLin = "child-1/root"

            const parentRecords: Array<MemoryTimeTravelStore.JournalRecord> = [
              {
                runId: "parent",
                seq: 0,
                eventId: "p-0",
                lineageId: lineage,
                eventType: EventTypes.runDecision,
                payload: { state: { version: 1, flowName: "Parent", payload: { x: 1 } } }
              },
              {
                runId: "parent",
                seq: 1,
                eventId: "p-1",
                lineageId: lineage,
                eventType: EventTypes.attemptStarted,
                payload: { stepKeyDigest: "p-step", attempt: 1 }
              },
              {
                runId: "parent",
                seq: 2,
                eventId: "p-2",
                lineageId: lineage,
                eventType: EventTypes.attemptFinished,
                payload: { stepKeyDigest: "p-step", attempt: 1, outcome: "succeeded" }
              },
              {
                runId: "parent",
                seq: 3,
                eventId: "p-3",
                lineageId: lineage,
                eventType: EventTypes.runDecision,
                payload: { state: { version: 1, flowName: "Parent", payload: { x: 2 } } }
              }
            ]
            const childRecords: Array<MemoryTimeTravelStore.JournalRecord> = [
              {
                runId: "child-1",
                seq: 0,
                eventId: "c-0",
                lineageId: childLin,
                eventType: EventTypes.runDecision,
                payload: { state: { version: 1, flowName: "Child", payload: { y: 1 } } }
              },
              {
                runId: "child-1",
                seq: 1,
                eventId: "c-1",
                lineageId: childLin,
                eventType: EventTypes.attemptStarted,
                payload: { stepKeyDigest: "c-step", attempt: 1 }
              },
              {
                runId: "child-1",
                seq: 2,
                eventId: "c-2",
                lineageId: childLin,
                eventType: EventTypes.attemptFinished,
                payload: { stepKeyDigest: "c-step", attempt: 1, outcome: "succeeded" }
              },
              ...(childHasInbound
                ? [
                  {
                    runId: "child-1",
                    seq: 3,
                    eventId: "c-3",
                    lineageId: childLin,
                    eventType: EventTypes.deferredCompleted,
                    payload: { token: "t1", value: "done" }
                  }
                ]
                : [])
            ]

            const sqlOutcome = yield* Effect.gen(function*() {
              yield* Migrations.run
              const sql = yield* SqlClient.SqlClient
              const sqlStore = yield* SqlTimeTravelStore.make

              yield* sql`
                INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
                VALUES
                  ('parent', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Parent", payload: { x: 2 } })}),
                  ('child-1', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Child", payload: { y: 1 } })})
              `
              for (const r of [...parentRecords, ...childRecords]) {
                yield* sql`
                  INSERT INTO flows_journal_events
                    (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
                  VALUES (
                    ${r.runId}, ${r.seq}, ${r.eventId}, 'src', ${r.seq}, 0,
                    ${r.eventType ?? "event"}, ${JSON.stringify(r.payload)}, ${
                  JSON.stringify({ lineageId: r.lineageId })
                }
                  )
                `
              }
              yield* sql`
                INSERT INTO flows_attempts
                  (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms, heartbeat_at_ms, outcome_json, meta_json)
                VALUES
                  ('parent', 'p-step', 1, 'succeeded', 0, 1, 0, ${
                JSON.stringify({ _tag: "Success", value: { a: 1 } })
              }, '{}'),
                  ('child-1', 'c-step', 1, 'succeeded', 0, 1, 0, ${
                JSON.stringify({ _tag: "Success", value: { b: 2 } })
              }, '{}')
              `
              yield* sql`
                INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
                VALUES ('parent', 1, 'child-1', 'child', 1)
              `
              yield* sqlStore.recordSnapshot({
                runId: "parent",
                frame: { lineageId: lineage, seq: 0 },
                changeId: "p-ch-0"
              })

              const override: TimeTravelStore.StepOverride | undefined = withOverride
                ? {
                  stepKeyDigest: overrideMissing ? "no-such-step" : overrideOnChild ? "c-step" : "p-step",
                  ...(overrideOnChild && withRebinding ? { runId: "child-1" } : {}),
                  result: { overridden: true }
                }
                : undefined

              const rebinding: TimeTravelStore.Rebinding | undefined = withRebinding
                ? {
                  payload: { rebound: true },
                  children: [
                    {
                      from: unknownCarriedChild ? "ghost-child" : "child-1",
                      to: "forked-child-1",
                      payload: { reboundChild: true }
                    }
                  ]
                }
                : undefined

              const res = yield* Effect.result(
                sqlStore.createFork("parent", { lineageId: lineage, seq: frameSeq }, undefined, override, rebinding)
              )
              if (Result.isFailure(res)) {
                return { ok: false as const, code: res.failure.code }
              }
              return { ok: true as const, runId: res.success.runId }
            }).pipe(Effect.provide(TestDatabase.layer))

            if (withRebinding && unknownCarriedChild) {
              return !sqlOutcome.ok && sqlOutcome.code === "invalid"
            }
            if (withOverride) {
              if (overrideMissing) return !sqlOutcome.ok && sqlOutcome.code === "not_found"
              if (!overrideOnChild && frameSeq < 2) return !sqlOutcome.ok && sqlOutcome.code === "not_found"
              if (overrideOnChild && (!withRebinding || frameSeq < 1)) {
                return !sqlOutcome.ok && sqlOutcome.code === "not_found"
              }
            }
            return sqlOutcome.ok && sqlOutcome.runId.length > 0
          }),
        { seedOffset: 11, executions: sqlExecutions }
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 6. TimeTravel.fork (Fork.fork & TimeTravel.fork on Memory & SQLite)
  // ---------------------------------------------------------------------------
  describe("TimeTravel.fork end-to-end fuzzing", () => {
    it("TimeTravel.fork handles workspace provisioning, disclosures, overrides, rebind, and StepHook cleanup", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          hasSnapshot: Schema.Boolean,
          retainWorkspace: Schema.Boolean,
          hasEffectsAbove: Schema.Boolean,
          parentLive: Schema.Boolean,
          hookFailStep: Schema.Literals(["none", "provision-workspace", "commit-fork"]),
          jjFail: Schema.Literals(["none", "workspaceAdd"]),
          withOverride: Schema.Boolean,
          useSql: Schema.Boolean
        })
      )
      await runFuzz(
        arb,
        ({ hasSnapshot, retainWorkspace, hasEffectsAbove, parentLive, hookFailStep, jjFail, withOverride, useSql }) =>
          Effect.gen(function*() {
            const lineage = "run-f/root"
            const jjMem = makeMemoryJj(jjFail === "none" ? {} : { failOn: jjFail })
            const cacheLayer = Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())
            const jjLayer = Layer.succeed(Jj.Jj, jjMem.service)

            const runOnMemory = Effect.gen(function*() {
              const records: Array<MemoryTimeTravelStore.JournalRecord> = [
                makePlainRecord("run-f", lineage, 0, EventTypes.runDecision, {
                  state: { version: 1, flowName: "Demo", payload: {} }
                }),
                makePlainRecord("run-f", lineage, 1, EventTypes.attemptFinished, {
                  stepKeyDigest: "step-1",
                  attempt: 1,
                  outcome: "succeeded"
                }),
                ...(hasEffectsAbove
                  ? [
                    makeBoundaryRecord("run-f", lineage, 2, {
                      id: "eff-above",
                      kind: "mail.send",
                      tier: "irreversible",
                      status: "succeeded",
                      runId: "run-f",
                      lineageId: lineage,
                      idempotencyKey: "k1",
                      durableBoundary: true,
                      providerStream: false
                    })
                  ]
                  : [])
              ]
              const store = MemoryTimeTravelStore.make({
                records,
                snapshots: hasSnapshot
                  ? [{ runId: "run-f", frame: { lineageId: lineage, seq: 0 }, changeId: "snap-0" }]
                  : [],
                liveRuns: parentLive ? new Set(["run-f"]) : new Set(),
                runStatuses: new Map([["run-f", parentLive ? "running" : "suspended"]])
              })
              const runs = makeRuns([
                makeRow({
                  runId: "run-f",
                  status: parentLive ? "running" : "suspended",
                  owner: parentLive ? makeOwner("live") : null,
                  heartbeatAtMs: parentLive ? 0 : null
                })
              ])
              const env = Layer.mergeAll(
                Layer.succeed(Journal.Journal, journalOf(store)),
                Layer.succeed(RunStore.RunStore, runs),
                Layer.succeed(TimeTravelStore.TimeTravelStore, store),
                cacheLayer,
                jjLayer,
                EffectHandlerRegistry.layerNoop
              )
              return yield* Effect.scoped(
                Effect.exit(
                  ForkOperation.fork({
                    parentRunId: "run-f",
                    frame: { lineageId: lineage, seq: 1 },
                    workspaceRoot: "/tmp/fuzz-ws",
                    retainWorkspace,
                    hooks: hookFailStep === "none"
                      ? undefined
                      : {
                        beforeStep: (step) => step === hookFailStep ? Effect.fail("injected-fork-fail") : Effect.void
                      }
                  }).pipe(Effect.provide(env))
                )
              )
            })

            const runOnSql = Effect.gen(function*() {
              yield* Migrations.run
              const sql = yield* SqlClient.SqlClient
              if (parentLive) {
                yield* sql`
                  INSERT INTO flows_runs
                    (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
                  VALUES (
                    'run-f', 'running', 0,
                    ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
                    'h1', 1, 'n1', 0
                  )
                `
              } else {
                yield* sql`
                  INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
                  VALUES ('run-f', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })})
                `
              }
              yield* sql`
                INSERT INTO flows_journal_events
                  (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
                VALUES
                  ('run-f', 0, 'ev-0', 'src', 0, 0, ${EventTypes.runDecision},
                   ${JSON.stringify({ state: { version: 1, flowName: "Demo", payload: {} } })},
                   ${JSON.stringify({ lineageId: lineage })}),
                  ('run-f', 1, 'ev-1', 'src', 1, 0, ${EventTypes.attemptStarted},
                   ${JSON.stringify({ stepKeyDigest: "step-1", attempt: 1 })},
                   ${JSON.stringify({ lineageId: lineage })}),
                  ('run-f', 2, 'ev-2', 'src', 2, 0, ${EventTypes.attemptFinished},
                   ${JSON.stringify({ stepKeyDigest: "step-1", attempt: 1, outcome: "succeeded" })},
                   ${JSON.stringify({ lineageId: lineage })})
              `
              yield* sql`
                INSERT INTO flows_attempts
                  (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms, heartbeat_at_ms, outcome_json, meta_json)
                VALUES
                  ('run-f', 'step-1', 1, 'succeeded', 0, 1, 0, ${
                JSON.stringify({ _tag: "Success", value: "v1" })
              }, '{}')
              `
              if (hasEffectsAbove) {
                yield* sql`
                  INSERT INTO flows_journal_events
                    (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
                  VALUES (
                    'run-f', 3, 'ev-3', 'src', 3, 0, ${EffectBoundary.eventType},
                    ${
                  JSON.stringify({
                    version: 1,
                    effect: {
                      id: "eff-above",
                      kind: "mail.send",
                      tier: "irreversible",
                      status: "succeeded",
                      runId: "run-f",
                      lineageId: lineage,
                      idempotencyKey: "k1",
                      durableBoundary: true,
                      providerStream: false
                    }
                  })
                },
                    ${JSON.stringify({ lineageId: lineage })}
                  )
                `
              }
              const store = yield* SqlTimeTravelStore.make
              if (hasSnapshot) {
                yield* store.recordSnapshot({
                  runId: "run-f",
                  frame: { lineageId: lineage, seq: 0 },
                  changeId: "snap-0"
                })
              }
              const persistence = Layer.mergeAll(
                SqlJournal.layer({ capacity: 32, overflow: "reject" }),
                RunStore.layer.pipe(Layer.provide(SqlConsensus.layer)),
                CacheStore.layer,
                Layer.succeed(TimeTravelStore.TimeTravelStore, store),
                jjLayer
              )
              const ttLayer = TimeTravel.layerWith({
                maxHistoryEntries: 50
              }).pipe(Layer.provide(persistence))

              return yield* Effect.scoped(
                Effect.exit(
                  Effect.gen(function*() {
                    const tt = yield* TimeTravel
                    return yield* tt.fork(
                      { runId: "run-f", frame: { lineageId: lineage, seq: 2 } },
                      {
                        workspaceRoot: "/tmp/fuzz-ws",
                        retainWorkspace,
                        ...(withOverride ? { override: { stepKeyDigest: "step-1", result: "patched" } } : {})
                      }
                    )
                  }).pipe(Effect.provide(ttLayer))
                )
              )
            }).pipe(Effect.provide(TestDatabase.layer))

            const exit = yield* (useSql && hookFailStep === "none" ? runOnSql : runOnMemory)

            if (parentLive) {
              return Exit.isFailure(exit) && TimeTravelError.fromCause(exit.cause).code === "live_parent"
            }
            if (hookFailStep !== "none") {
              if (!Exit.isFailure(exit)) return false
              if (hookFailStep === "commit-fork" && jjFail === "none") {
                if (jjMem.forgotten.length === 0) return false
              }
              return TimeTravelError.fromCause(exit.cause).code === "unknown"
            }
            if (jjFail === "workspaceAdd") {
              return Exit.isFailure(exit) && TimeTravelError.fromCause(exit.cause).code === "unknown"
            }
            if (!Exit.isSuccess(exit)) return false
            const res = exit.value
            if (hasEffectsAbove && res.warnings.length === 0) return false
            return res.runId.length > 0
          }),
        { seedOffset: 12, executions: sqlExecutions }
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 7. TimeTravel.rewind (Rewind.validate, Rewind.rewind, TimeTravel.rewind)
  // ---------------------------------------------------------------------------
  describe("TimeTravel.rewind end-to-end fuzzing", () => {
    it("Rewind handles effects, workspaces, detached children, rate limits, and StepHook faults with rollback", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          effectKind: Schema.Literals([
            "none",
            "sealed_hit",
            "sealed_miss",
            "compensable",
            "irreversible_ok",
            "irreversible_fail",
            "irreversible_unregistered"
          ]),
          detachedChildState: Schema.Literals(["none", "completed", "suspended", "running_dead", "running_live"]),
          detachedPolicy: Schema.Literals(["block", "cancel"]),
          rateAllowed: Schema.Boolean,
          wholeRepo: Schema.Boolean,
          hookFailStep: Schema.Literals([
            "none",
            "claim-run",
            "rate-limit",
            "write-audit",
            "load-suffix",
            "assess-boundary",
            "compensate-effects",
            "restore-workspace",
            "archive-and-truncate"
          ])
        })
      )
      await runFuzz(
        arb,
        ({ effectKind, detachedChildState, detachedPolicy, rateAllowed, wholeRepo, hookFailStep }) =>
          Effect.gen(function*() {
            const lineage = "run-w/root"
            const owner = makeOwner("rw")
            const childOwner = makeOwner("child", 77)
            const frame = { lineageId: lineage, seq: 0 }

            const records: Array<MemoryTimeTravelStore.JournalRecord> = [
              makePlainRecord("run-w", lineage, 0, EventTypes.runDecision, {
                state: { version: 1, flowName: "Demo", payload: { s: 0 } }
              })
            ]
            const cacheMap = new Map<string, CacheStore.CacheEntry>()
            const handlers: Array<CompensationHandlers.Handler> = []
            let reverted = 0
            let rolledBack = 0

            if (effectKind === "sealed_hit" || effectKind === "sealed_miss") {
              records.push(
                makeBoundaryRecord("run-w", lineage, 1, {
                  id: "eff-seal",
                  kind: "read",
                  tier: "sealed",
                  status: "succeeded",
                  runId: "run-w",
                  lineageId: lineage,
                  cacheKey: "ck-seal",
                  durableBoundary: true,
                  providerStream: false
                })
              )
              if (effectKind === "sealed_hit") {
                cacheMap.set("ck-seal", {
                  keyDigest: "ck-seal",
                  result: "cached",
                  meta: {},
                  createdAtMs: 0,
                  recordedRunId: "run-w",
                  recordedEventSeq: 1
                })
              }
            } else if (effectKind === "compensable") {
              records.push(
                makeBoundaryRecord("run-w", lineage, 1, {
                  id: "eff-comp",
                  kind: "fs.write",
                  tier: "compensable",
                  status: "succeeded",
                  runId: "run-w",
                  lineageId: lineage,
                  changeId: "ch-1",
                  durableBoundary: true,
                  providerStream: false
                })
              )
            } else if (
              effectKind === "irreversible_ok" ||
              effectKind === "irreversible_fail" ||
              effectKind === "irreversible_unregistered"
            ) {
              records.push(
                makeBoundaryRecord("run-w", lineage, 1, {
                  id: "eff-irr",
                  kind: "mail.send",
                  tier: "irreversible",
                  status: "succeeded",
                  runId: "run-w",
                  lineageId: lineage,
                  idempotencyKey: "ik-1",
                  durableBoundary: true,
                  providerStream: false
                })
              )
              if (effectKind !== "irreversible_unregistered") {
                handlers.push({
                  kind: "mail.send",
                  tier: "irreversible",
                  requiresIdempotencyKey: true,
                  residue: () => "recalled",
                  revert: () => {
                    reverted += 1
                    if (effectKind === "irreversible_fail") {
                      return Effect.fail(TimeTravelError.error("compensation_failed", "smtp fail"))
                    }
                    return Effect.succeed({ recalled: true })
                  },
                  rollback: () => {
                    rolledBack += 1
                    return Effect.void
                  }
                })
              }
            } else {
              records.push(makePlainRecord("run-w", lineage, 1, "step.done", { x: 1 }))
            }

            const edges: Array<Frame.LineageEdge> = []
            const runRows: Array<RunStore.RunRow> = [
              makeRow({ runId: "run-w", status: "suspended", stateJson: "{\"s\":1}" })
            ]
            const runStatuses = new Map<string, RunStore.RunStatus>([["run-w", "suspended"]])
            if (detachedChildState !== "none") {
              edges.push({
                parentRunId: "run-w",
                parentSeq: 1,
                childRunId: "det-child",
                kind: "fork",
                attached: false
              })
              const cStatus: RunStore.RunStatus = detachedChildState === "completed"
                ? "completed"
                : detachedChildState === "suspended"
                ? "suspended"
                : "running"
              runStatuses.set("det-child", cStatus)
              runRows.push(
                makeRow({
                  runId: "det-child",
                  status: cStatus,
                  owner: cStatus === "running" ? childOwner : null,
                  heartbeatAtMs: cStatus === "running" ? 0 : null
                })
              )
            }

            const runs = makeRuns(runRows)
            const store = MemoryTimeTravelStore.make({
              records,
              edges,
              snapshots: [
                {
                  runId: "run-w",
                  frame,
                  changeId: "snap-0",
                  ...(wholeRepo ? { operationId: "op-0" } : {})
                }
              ],
              runs,
              runStatuses
            })
            const jjMem = makeMemoryJj({ currentChangeId: "head-ch", currentOperationId: "head-op" })
            const env = Layer.mergeAll(
              Layer.succeed(Journal.Journal, journalOf(store)),
              Layer.succeed(RunStore.RunStore, runs),
              Layer.succeed(TimeTravelStore.TimeTravelStore, store),
              Layer.succeed(
                CacheStore.CacheStore,
                CacheStore.makeNoop({
                  get: (k) => Effect.sync(() => Option.fromUndefinedOr(cacheMap.get(k)))
                })
              ),
              Layer.succeed(Jj.Jj, jjMem.service),
              EffectHandlerRegistry.layer(handlers)
            )

            const expectedTail = yield* Rewind.validate({ runId: "run-w", frame }).pipe(Effect.provide(env))

            const exit = yield* Effect.exit(
              Rewind.rewind({
                runId: "run-w",
                frame,
                owner,
                expectedTail,
                detachedChildPolicy: detachedPolicy,
                wholeRepo,
                rateLimit: () => Effect.succeed({ allowed: rateAllowed, detail: { remaining: rateAllowed ? 5 : 0 } }),
                childLivenessEvidence: (_cid, row, _claimant, nowMs) =>
                  Effect.succeed(
                    detachedChildState === "running_dead" && row.owner !== null
                      ? deadEvidence(row.owner, nowMs)
                      : undefined
                  ),
                hooks: hookFailStep === "none"
                  ? undefined
                  : {
                    beforeStep: (step) => step === hookFailStep ? Effect.fail(`hook-${step}`) : Effect.void
                  }
              }).pipe(Effect.provide(env))
            )

            const finalRow = runs.state("run-w")
            if (finalRow.status === "running") return false

            if (Exit.isSuccess(exit)) {
              if (exit.value.archive.archived < 1) return false
              if (
                (detachedChildState === "suspended" || detachedChildState === "running_dead") &&
                detachedPolicy === "cancel"
              ) {
                if (!exit.value.cancelledChildren.includes("det-child")) return false
              }
              return true
            } else {
              const err = TimeTravelError.fromCause(exit.cause)
              if (reverted > 0 && effectKind === "irreversible_ok" && hookFailStep !== "none") {
                if (rolledBack !== reverted) return false
              }
              return [
                "rate_limited",
                "irreversible",
                "live_child",
                "compensation_failed",
                "unknown",
                "busy",
                "fence_lost"
              ].includes(err.code)
            }
          }),
        { seedOffset: 13, executions: medExecutions }
      )
    })

    it("TimeTravel.layerWith full SQLite rewind & invalid option guards", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          suffixCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
          badDetachedPolicy: Schema.Boolean,
          rateLimited: Schema.Boolean
        })
      )
      await runFuzz(
        arb,
        ({ suffixCount, badDetachedPolicy, rateLimited }) =>
          Effect.gen(function*() {
            const lineage = "sql-rw/root"
            const jjMem = makeMemoryJj({ currentChangeId: "cur-ch", currentOperationId: "cur-op" })
            const result = yield* Effect.gen(function*() {
              yield* Migrations.run
              const sql = yield* SqlClient.SqlClient
              yield* sql`
                INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
                VALUES ('sql-rw', 'suspended', 0, ${
                JSON.stringify({ version: 1, flowName: "Demo", payload: { n: suffixCount } })
              })
              `
              for (let s = 0; s <= suffixCount; s++) {
                yield* sql`
                  INSERT INTO flows_journal_events
                    (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
                  VALUES (
                    'sql-rw', ${s}, ${`ev-${s}`}, 'src', ${s}, 0, ${EventTypes.runDecision},
                    ${JSON.stringify({ state: { version: 1, flowName: "Demo", payload: { n: s } } })},
                    ${JSON.stringify({ lineageId: lineage })}
                  )
                `
              }
              const persistence = Layer.mergeAll(
                SqlJournal.layer({ capacity: 64, overflow: "reject" }),
                RunStore.layer.pipe(Layer.provide(SqlConsensus.layer)),
                CacheStore.layer,
                SqlTimeTravelStore.layer,
                Layer.succeed(Jj.Jj, jjMem.service)
              )
              const ttLayer = TimeTravel.layerWith({
                maxHistoryEntries: 50,
                rateLimit: () => Effect.succeed({ allowed: !rateLimited }),
                compensationTimeout: Duration.seconds(10)
              }).pipe(Layer.provide(persistence))

              return yield* Effect.scoped(
                Effect.exit(
                  Effect.gen(function*() {
                    const tt = yield* TimeTravel
                    return yield* tt.rewind(
                      { runId: "sql-rw", frame: { lineageId: lineage, seq: 0 } },
                      { detachedChildren: (badDetachedPolicy ? "blcok" : "block") as any }
                    )
                  }).pipe(Effect.provide(ttLayer))
                )
              )
            }).pipe(Effect.provide(TestDatabase.layer))

            if (badDetachedPolicy) {
              return Exit.isFailure(result) && TimeTravelError.fromCause(result.cause).code === "invalid"
            }
            if (rateLimited) {
              return Exit.isFailure(result) && TimeTravelError.fromCause(result.cause).code === "rate_limited"
            }
            return Exit.isSuccess(result) && result.value.archive.archived === suffixCount
          }),
        { seedOffset: 14, executions: sqlExecutions }
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 8. Recovery (Recovery.recover across all phases, outcomes & fork intents)
  // ---------------------------------------------------------------------------
  describe("Recovery.recover & startup intent reclamation", () => {
    it("Recovery.recover resolves every audit phase, run status, liveness, compensation rollback & corrupt detail", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          phase: Schema.Literals([
            "audit_written",
            "preflight_complete",
            "compensated",
            "archive_committed",
            "corrupt_detail"
          ]),
          runState: Schema.Literals([
            "suspended",
            "pending",
            "running_dead",
            "running_live",
            "running_self",
            "completed",
            "claimed",
            "missing"
          ]),
          hasSuffix: Schema.Boolean,
          hasArchived: Schema.Boolean,
          withComp: Schema.Boolean,
          withWorkspace: Schema.Boolean,
          wholeRepoWs: Schema.Boolean,
          rollbackFails: Schema.Boolean,
          withPendingChild: Schema.Boolean
        })
      )
      await runFuzz(
        arb,
        (
          {
            phase,
            runState,
            hasSuffix,
            hasArchived,
            withComp,
            withWorkspace,
            wholeRepoWs,
            rollbackFails,
            withPendingChild
          }
        ) =>
          Effect.gen(function*() {
            const recoveryOwner = makeOwner("rec", 50)
            const foreignOwner: OwnerId = { hostId: recoveryOwner.hostId, pid: 51, nonce: "nonce-foreign" }
            const frame = { lineageId: "run/root", seq: 0 }

            const eff: EffectBoundary.EffectRecord = {
              id: "eff-rec",
              kind: "mail.send",
              tier: "irreversible",
              status: "succeeded",
              runId: "run",
              lineageId: "run/root",
              seq: 1,
              idempotencyKey: "ik-rec",
              durableBoundary: true,
              providerStream: false
            }

            const detail: unknown = phase === "corrupt_detail"
              ? { version: 99, bogus: true }
              : ({
                version: 1,
                phase,
                originalStatus: runState === "pending" ? "pending" : "suspended",
                suffixCount: 1,
                suffixTailSeq: 1,
                ...(withComp
                  ? {
                    compensation: {
                      handlerReceipts: [{ id: "eff-rec:rollback", effect: eff, data: { x: 1 } }],
                      ...(withWorkspace
                        ? {
                          workspace: wholeRepoWs
                            ? {
                              currentChangeId: "cur-ch",
                              targetChangeId: "tgt-ch",
                              currentOperationId: "cur-op",
                              targetOperationId: "tgt-op"
                            }
                            : { currentChangeId: "cur-ch", targetChangeId: "tgt-ch" }
                        }
                        : {})
                    }
                  }
                  : {}),
                warnings: [],
                cancelledChildren: [],
                ...(withPendingChild ? { pendingChildren: ["p-child"] } : {})
              } satisfies Rewind.AuditDetail)

            const baseStore = MemoryTimeTravelStore.make()
            const store: TimeTravelStore.Service = {
              ...baseStore,
              archivedAt: () => Effect.succeed(hasArchived)
            }
            yield* store.writeAudit({
              id: "audit-1",
              runId: "run",
              frame,
              status: "in_progress",
              detail
            })

            const runRows: Array<RunStore.RunRow> = []
            if (runState !== "missing") {
              runRows.push(
                makeRow({
                  runId: "run",
                  status: runState === "running_dead" || runState === "running_live" || runState === "running_self"
                    ? "running"
                    : runState === "completed"
                    ? "completed"
                    : runState === "pending"
                    ? "pending"
                    : "suspended",
                  owner: runState === "running_self"
                    ? recoveryOwner
                    : runState === "running_dead" || runState === "running_live"
                    ? foreignOwner
                    : null,
                  heartbeatAtMs:
                    runState === "running_self" || runState === "running_dead" || runState === "running_live"
                      ? 0
                      : null,
                  claim: runState === "claimed" ? foreignOwner : null,
                  claimedAtMs: runState === "claimed" ? 0 : null,
                  stateJson: "{\"cursor\":1}"
                })
              )
            }
            if (withPendingChild) {
              runRows.push(makeRow({ runId: "p-child", status: "suspended" }))
            }
            const runs = makeRuns(runRows)

            const journal = Journal.makeNoop({
              emitDurableUnfenced: () =>
                Effect.succeed({
                  _tag: "Accepted",
                  seq: 0 as JournalEvent.Seq,
                  sourceSeq: 0 as JournalEvent.SourceSeq
                }),
              entries: ({ runId }) =>
                Effect.succeed({
                  entries: runId === "run" && hasSuffix
                    ? [
                      {
                        runId: "run" as JournalEvent.RunId,
                        seq: 1 as JournalEvent.Seq,
                        eventId: "ev-1",
                        sourceId: "src" as JournalEvent.SourceId,
                        sourceSeq: 1 as JournalEvent.SourceSeq,
                        emittedAtMs: 1,
                        eventType: "suffix",
                        payload: {},
                        meta: { lineageId: "run/root" }
                      }
                    ]
                    : [],
                  hasMore: false
                })
            })

            const jjMem = makeMemoryJj({ currentChangeId: "tgt-ch", currentOperationId: "tgt-op" })
            const handlers: Array<CompensationHandlers.Handler> = [
              {
                kind: "mail.send",
                tier: "irreversible",
                requiresIdempotencyKey: true,
                residue: () => "none",
                revert: () => Effect.succeed({}),
                rollback: () =>
                  rollbackFails
                    ? Effect.fail(TimeTravelError.error("compensation_failed", "rb-boom"))
                    : Effect.void
              }
            ]

            const env = Layer.mergeAll(
              Layer.succeed(TimeTravelStore.TimeTravelStore, store),
              Layer.succeed(RunStore.RunStore, runs),
              Layer.succeed(Journal.Journal, journal),
              Layer.succeed(Jj.Jj, jjMem.service),
              EffectHandlerRegistry.layer(handlers)
            )

            const outcomes = yield* Recovery.recover({
              owner: recoveryOwner,
              livenessEvidence: (_audit, row, _claimant, nowMs) =>
                Effect.succeed(
                  runState === "running_dead" && row.owner !== null
                    ? deadEvidence(row.owner, nowMs)
                    : undefined
                )
            }).pipe(Effect.provide(env))

            if (outcomes.length !== 1) return false
            const out = outcomes[0]!

            if (phase === "corrupt_detail") return out._tag === "Failed"
            if (runState === "running_live" || runState === "claimed") return out._tag === "Busy"
            if (runState === "missing") return out._tag === "Failed"

            if (phase === "archive_committed") {
              if (hasSuffix && runState !== "completed") return out._tag === "Busy"
              return out._tag === "Completed"
            }

            if (!hasSuffix && hasArchived && phase === "compensated" && runState !== "completed") {
              return out._tag === "Completed"
            }
            if (withComp && rollbackFails) {
              return out._tag === "Failed"
            }
            return out._tag === "RolledBack" || out._tag === "Completed"
          }),
        { seedOffset: 15, executions: medExecutions }
      )
    })

    it("TimeTravel.layerWith reclaims stale fork intents on startup and forgets their jj workspaces", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          staleCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
          forgetFails: Schema.Boolean
        })
      )
      await runFuzz(
        arb,
        ({ staleCount, forgetFails }) =>
          Effect.gen(function*() {
            const store = MemoryTimeTravelStore.make({
              records: [makePlainRecord("r1", "r1/root", 0)]
            })
            const jjMem = makeMemoryJj(forgetFails ? { failOn: "workspaceForget" } : {})
            const runs = makeRuns([makeRow({ runId: "r1", status: "suspended" })])
            const deps = Layer.mergeAll(
              Layer.succeed(TimeTravelStore.TimeTravelStore, store),
              Layer.succeed(RunStore.RunStore, runs),
              Layer.succeed(Journal.Journal, journalOf(store)),
              Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop()),
              Layer.succeed(Jj.Jj, jjMem.service)
            )
            // Mint inside TestClock so reservedAtMs uses TestClock (0), then advance past intentStaleAfter
            const program = Effect.gen(function*() {
              for (let i = 0; i < staleCount; i++) {
                yield* store.nextForkId("r1", { lineageId: "r1/root", seq: 0 })
              }
              yield* TestClock.adjust(Duration.minutes(10))
              yield* Effect.scoped(
                TimeTravel.pipe(
                  Effect.provide(
                    TimeTravel.layerWith({
                      isAlive: () => Effect.succeed(false)
                    }).pipe(Layer.provide(deps))
                  )
                )
              )
            }).pipe(Effect.provide(TestClock.layer()))

            yield* program
            if (!forgetFails) {
              if (jjMem.forgotten.length !== staleCount) return false
            }
            return true
          }),
        { seedOffset: 16, executions: medExecutions }
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 9. Concurrency Fuzzing under FuzzSimulation.execution()
  // ---------------------------------------------------------------------------
  describe("FuzzSimulation concurrency invariants", () => {
    it("concurrent rewinds and forks on the same run preserve mutual exclusion and never corrupt history", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          racers: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 4 }))),
          includeForkRacer: Schema.Boolean,
          suffixLen: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 5 })))
        })
      )
      await runFuzz(
        arb,
        ({ racers, includeForkRacer, suffixLen }) =>
          Effect.gen(function*() {
            const lineage = "conc/root"
            const records: Array<MemoryTimeTravelStore.JournalRecord> = Array.from(
              { length: suffixLen + 1 },
              (_, seq) =>
                makePlainRecord("conc", lineage, seq, EventTypes.runDecision, {
                  state: { version: 1, flowName: "Conc", payload: { seq } }
                })
            )
            const runs = makeRuns([makeRow({ runId: "conc", status: "suspended", stateJson: "{\"seq\":5}" })])
            const store = MemoryTimeTravelStore.make({
              records,
              snapshots: [{ runId: "conc", frame: { lineageId: lineage, seq: 0 }, changeId: "ch-0" }],
              runs,
              runStatuses: new Map([["conc", "suspended"]])
            })
            const jjMem = makeMemoryJj({ currentChangeId: "cur-ch" })
            const env = Layer.mergeAll(
              Layer.succeed(Journal.Journal, journalOf(store)),
              Layer.succeed(RunStore.RunStore, runs),
              Layer.succeed(TimeTravelStore.TimeTravelStore, store),
              Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop()),
              Layer.succeed(Jj.Jj, jjMem.service),
              EffectHandlerRegistry.layerNoop
            )

            const rewindTasks = Array.from({ length: racers }, (_, i) =>
              Effect.exit(
                Rewind.rewind({
                  runId: "conc",
                  frame: { lineageId: lineage, seq: 0 },
                  owner: makeOwner(`racer-${i}`, 200 + i)
                }).pipe(Effect.provide(env))
              ))
            const forkTask = includeForkRacer
              ? [
                Effect.scoped(
                  Effect.exit(
                    ForkOperation.fork({
                      parentRunId: "conc",
                      frame: { lineageId: lineage, seq: 1 },
                      workspaceRoot: "/tmp/fuzz-conc"
                    }).pipe(Effect.provide(env))
                  )
                )
              ]
              : []

            const [rwResults, fkResults] = yield* Effect.all(rewindTasks, { concurrency: "unbounded" }).pipe(
              Effect.zip(Effect.all(forkTask, { concurrency: "unbounded" }), { concurrent: true })
            )
            const nonEmptyArchives = rwResults.filter((e) => Exit.isSuccess(e) && e.value.archive.archived > 0)
            if (nonEmptyArchives.length > 1) return false

            for (const ex of rwResults) {
              if (Exit.isFailure(ex)) {
                const err = TimeTravelError.fromCause(ex.cause)
                if (!["busy", "fence_lost", "not_found", "live_parent", "unknown"].includes(err.code)) return false
              }
            }
            for (const ex of fkResults) {
              if (Exit.isFailure(ex)) {
                const err = TimeTravelError.fromCause(ex.cause)
                if (!["busy", "fence_lost", "not_found", "live_parent", "unknown"].includes(err.code)) return false
              }
            }
            return runs.state("conc").status !== "running"
          }),
        { seedOffset: 17, executions: simExecutions, simulation: true }
      )
    })

    it("concurrent fork intent minting, renewal & reclamation never mint duplicate child ids under FuzzSimulation", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          callers: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 6 }))),
          reclaim: Schema.Boolean
        })
      )
      await runFuzz(
        arb,
        ({ callers, reclaim }) =>
          Effect.gen(function*() {
            const store = MemoryTimeTravelStore.make({
              records: [makePlainRecord("p", "p/root", 0)],
              runStatuses: new Map([["p", "suspended"]])
            })
            const ids = yield* Effect.forEach(
              Array.from({ length: callers }, (_, i) => i),
              () => store.nextForkId("p", { lineageId: "p/root", seq: 0 }),
              { concurrency: "unbounded" }
            )
            if (new Set(ids).size !== callers) return false

            if (reclaim) {
              const nowMs = yield* Clock.currentTimeMillis
              const reclaimed = yield* store.abandonForkIntents(nowMs + 1000)
              yield* Effect.forEach(
                reclaimed,
                (intent) => store.forgetForkIntent(intent.childRunId, intent.reclaimedAtMs!),
                { concurrency: "unbounded" }
              )
              const renewErr = yield* Effect.flip(store.renewForkIntent(ids[0]!))
              if (renewErr.code !== "fence_lost") return false
            } else {
              yield* Effect.forEach(ids, (id) => store.renewForkIntent(id), { concurrency: "unbounded" })
              const forks = yield* Effect.forEach(
                ids,
                (id) => store.createFork("p", { lineageId: "p/root", seq: 0 }, id),
                { concurrency: "unbounded" }
              )
              if (new Set(forks.map((f) => f.runId)).size !== callers) return false
            }
            return true
          }),
        { seedOffset: 18, executions: simExecutions, simulation: true }
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 10. Wave 2 Deep Edge, Fault & Recovery Coverage
  // ---------------------------------------------------------------------------
  describe("deep edge cases, fault injection & recovery paths", () => {
    it("Rewind.validate & Rewind.rewind cover pageSize, empty/stale/wrong-lineage frames, pending runs, child spawns, post-commit settlement & restoration faults", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          valCase: Schema.Literals([
            "bad_page_zero",
            "bad_page_huge",
            "empty_seq0",
            "empty_seq1",
            "past_tail",
            "wrong_lineage",
            "missing_frame_seq",
            "limit_exceeded",
            "journal_fail"
          ]),
          rwCase: Schema.Literals([
            "pending_run_rollback",
            "whole_repo_no_op",
            "child_spawn_warning",
            "stale_expected_tail",
            "post_commit_archive_fail",
            "restoration_fence_lost",
            "rollback_fails_terminal",
            "attached_live_child",
            "detached_no_liveness_fn",
            "activation_lost",
            "heartbeat_lost"
          ])
        })
      )
      await runFuzz(
        arb,
        ({ valCase, rwCase }) =>
          Effect.gen(function*() {
            const lineage = "rw2/root"
            const owner = makeOwner("rw2", 300)

            // Part A: Rewind.validate edge cases
            const baseEntries: Array<JournalEvent.Entry> = valCase === "empty_seq0" || valCase === "empty_seq1"
              ? []
              : valCase === "missing_frame_seq"
              ? [
                {
                  runId: "rw2" as JournalEvent.RunId,
                  seq: 0 as JournalEvent.Seq,
                  eventId: "e0",
                  sourceId: "s" as JournalEvent.SourceId,
                  sourceSeq: 0 as JournalEvent.SourceSeq,
                  emittedAtMs: 0,
                  eventType: "t",
                  payload: {},
                  meta: { lineageId: lineage }
                },
                {
                  runId: "rw2" as JournalEvent.RunId,
                  seq: 3 as JournalEvent.Seq,
                  eventId: "e3",
                  sourceId: "s" as JournalEvent.SourceId,
                  sourceSeq: 3 as JournalEvent.SourceSeq,
                  emittedAtMs: 3,
                  eventType: "t",
                  payload: {},
                  meta: { lineageId: lineage }
                }
              ]
              : [0, 1, 2, 3].map((seq) => ({
                runId: "rw2" as JournalEvent.RunId,
                seq: seq as JournalEvent.Seq,
                eventId: `e${seq}`,
                sourceId: "s" as JournalEvent.SourceId,
                sourceSeq: seq as JournalEvent.SourceSeq,
                emittedAtMs: seq,
                eventType: "t",
                payload: {},
                meta: { lineageId: valCase === "wrong_lineage" ? "other/lin" : lineage }
              }))

            const valJournal = valCase === "journal_fail"
              ? Journal.makeNoop({
                entries: () => Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "io" }))
              })
              : journalOf(baseEntries)

            const valRes = yield* Effect.result(
              Rewind.validate({
                runId: "rw2",
                frame: {
                  lineageId: lineage,
                  seq: valCase === "empty_seq1"
                    ? 1
                    : valCase === "past_tail"
                    ? 9
                    : valCase === "missing_frame_seq"
                    ? 2
                    : 0
                },
                ...(valCase === "bad_page_zero" ? { pageSize: 0 } : {}),
                ...(valCase === "bad_page_huge" ? { pageSize: Journal.maxEntriesLimit + 1 } : {}),
                ...(valCase === "limit_exceeded" ? { maxEntries: 1 } : {})
              }).pipe(Effect.provideService(Journal.Journal, valJournal))
            )

            if (valCase === "empty_seq0") {
              if (!Result.isSuccess(valRes) || valRes.success.tail !== undefined) return false
            } else {
              if (!Result.isFailure(valRes)) return false
              const expectedCode = valCase === "bad_page_zero" || valCase === "bad_page_huge"
                ? "invalid"
                : valCase === "limit_exceeded"
                ? "limit_exceeded"
                : valCase === "journal_fail"
                ? "unknown"
                : "not_found"
              if (valRes.failure.code !== expectedCode) return false
            }

            // Part B: Rewind.rewind deep fault & edge cases
            const records: Array<MemoryTimeTravelStore.JournalRecord> = [
              makePlainRecord("rw2", lineage, 0, EventTypes.runDecision, {
                state: { version: 1, flowName: "Demo", payload: { s: 0 } }
              }),
              rwCase === "child_spawn_warning"
                ? makeBoundaryRecord("rw2", lineage, 1, {
                  id: "spawn-1",
                  kind: EventTypes.childSpawnKind,
                  tier: "irreversible",
                  status: "succeeded",
                  runId: "rw2",
                  lineageId: lineage,
                  idempotencyKey: "sp-1",
                  output: { childRunId: "spawned-c", flowName: "ChildFlow", attached: false },
                  durableBoundary: true,
                  providerStream: false
                })
                : rwCase === "rollback_fails_terminal"
                ? makeBoundaryRecord("rw2", lineage, 1, {
                  id: "irr-rb",
                  kind: "mail.send",
                  tier: "irreversible",
                  status: "succeeded",
                  runId: "rw2",
                  lineageId: lineage,
                  idempotencyKey: "ik-rb",
                  durableBoundary: true,
                  providerStream: false
                })
                : makePlainRecord("rw2", lineage, 1, "step.done", { x: 1 })
            ]

            const edges: Array<Frame.LineageEdge> = rwCase === "child_spawn_warning"
              ? [{ parentRunId: "rw2", parentSeq: 1, childRunId: "spawned-c", kind: "child", attached: false }]
              : rwCase === "attached_live_child"
              ? [{ parentRunId: "rw2", parentSeq: 1, childRunId: "att-live", kind: "child", attached: true }]
              : rwCase === "detached_no_liveness_fn"
              ? [{ parentRunId: "rw2", parentSeq: 1, childRunId: "det-run", kind: "fork", attached: false }]
              : []

            const childOwner = makeOwner("c-live", 301)
            const initialStatus = rwCase === "pending_run_rollback" ? "pending" : "suspended"
            const runRows: Array<RunStore.RunRow> = [
              makeRow({ runId: "rw2", status: initialStatus, stateJson: "{\"s\":1}" }),
              ...(rwCase === "child_spawn_warning"
                ? [makeRow({ runId: "spawned-c", status: "completed" })]
                : []),
              ...(rwCase === "attached_live_child"
                ? [makeRow({ runId: "att-live", status: "running", owner: childOwner, heartbeatAtMs: 0 })]
                : []),
              ...(rwCase === "detached_no_liveness_fn"
                ? [makeRow({ runId: "det-run", status: "running", owner: childOwner, heartbeatAtMs: 0 })]
                : [])
            ]

            const baseRuns = makeRuns(runRows)
            const runs: RunStore.Service = {
              ...baseRuns,
              activate: (runId, claimant, claimedAtMs, expected) =>
                rwCase === "activation_lost"
                  ? Effect.succeed({ _tag: "ClaimLost" as const })
                  : baseRuns.activate(runId, claimant, claimedAtMs, expected),
              heartbeat: (runId, o, nowMs) =>
                rwCase === "heartbeat_lost"
                  ? Effect.succeed({ _tag: "FenceLost" as const })
                  : baseRuns.heartbeat(runId, o, nowMs),
              transitionOwned: (runId, o, status, stateJson, guard) =>
                rwCase === "restoration_fence_lost" && runId === "rw2"
                  ? Effect.succeed({ _tag: "FenceLost" as const })
                  : baseRuns.transitionOwned(runId, o, status, stateJson, guard)
            }

            const baseStore = MemoryTimeTravelStore.make({
              records,
              edges,
              snapshots: [{ runId: "rw2", frame: { lineageId: lineage, seq: 0 }, changeId: "snap-0" }],
              runs,
              runStatuses: new Map(runRows.map((r) => [r.runId, r.status]))
            })
            const store: TimeTravelStore.Service = rwCase === "post_commit_archive_fail"
              ? {
                ...baseStore,
                archiveAndTruncate: (runId, frame, receipts, o, childOwners) =>
                  baseStore.archiveAndTruncate(runId, frame, receipts, o, childOwners).pipe(
                    Effect.andThen(Effect.fail(TimeTravelError.error("unknown", "post-commit network drop")))
                  )
              }
              : baseStore

            const handlers: Array<CompensationHandlers.Handler> = [
              {
                kind: "mail.send",
                tier: "irreversible",
                requiresIdempotencyKey: true,
                residue: () => "none",
                revert: () => Effect.succeed({ ok: true }),
                rollback: () => Effect.fail(TimeTravelError.error("compensation_failed", "rollback stuck"))
              }
            ]
            const jjMem = makeMemoryJj()
            const env = Layer.mergeAll(
              Layer.succeed(Journal.Journal, journalOf(baseStore)),
              Layer.succeed(RunStore.RunStore, runs),
              Layer.succeed(TimeTravelStore.TimeTravelStore, store),
              Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop()),
              Layer.succeed(Jj.Jj, jjMem.service),
              EffectHandlerRegistry.layer(handlers)
            )

            const exit = yield* Effect.exit(
              Rewind.rewind({
                runId: "rw2",
                frame: { lineageId: lineage, seq: 0 },
                owner,
                ...(rwCase === "whole_repo_no_op" ? { wholeRepo: true } : {}),
                ...(rwCase === "stale_expected_tail"
                  ? { expectedTail: { tail: { seq: 99, lineageId: lineage }, generation: undefined } }
                  : {}),
                ...(rwCase === "detached_no_liveness_fn" ? { detachedChildPolicy: "cancel" } : {}),
                ...(rwCase === "pending_run_rollback" || rwCase === "restoration_fence_lost" ||
                    rwCase === "rollback_fails_terminal"
                  ? {
                    hooks: {
                      beforeStep: (step) =>
                        step === "archive-and-truncate" ? Effect.fail("abort-before-archive") : Effect.void
                    }
                  }
                  : {}),
                ...(rwCase === "heartbeat_lost"
                  ? {
                    hooks: {
                      beforeStep: (step) => step === "assess-boundary" ? Effect.sleep(Duration.millis(5)) : Effect.void
                    }
                  }
                  : {})
              }).pipe(Effect.provide(env))
            )

            if (rwCase === "child_spawn_warning") {
              return Exit.isSuccess(exit) && exit.value.assessments.some((a) => a.classification === "warning")
            }
            if (!Exit.isFailure(exit)) {
              // heartbeat_lost might race and finish before heartbeat ticks; that's valid
              return rwCase === "heartbeat_lost"
            }
            const err = TimeTravelError.fromCause(exit.cause)
            if (rwCase === "pending_run_rollback") {
              return err.code === "unknown" && baseRuns.state("rw2").status === "pending"
            }
            if (rwCase === "whole_repo_no_op") return err.code === "irreversible"
            if (rwCase === "stale_expected_tail") return err.code === "busy" || err.code === "not_found"
            if (rwCase === "post_commit_archive_fail") {
              // Post-commit settlement finishes suspending the run even though caller gets the original error!
              return err.code === "unknown" && baseRuns.state("rw2").status === "suspended"
            }
            if (rwCase === "restoration_fence_lost") return err.code === "unknown"
            if (rwCase === "rollback_fails_terminal") return err.code === "compensation_failed"
            if (rwCase === "attached_live_child" || rwCase === "detached_no_liveness_fn") {
              return err.code === "live_child"
            }
            if (rwCase === "activation_lost") return err.code === "busy"
            return err.code === "fence_lost" || err.code === "busy"
          }),
        { seedOffset: 19, executions: medExecutions }
      )
    })

    it("TimeTravel.makeWith validates options, surfaces recovery outcomes, and guards replay/inspect/fork/rewind inputs", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          optCase: Schema.Literals([
            "bad_comp_zero",
            "bad_comp_inf",
            "bad_rec_zero",
            "bad_rec_inf",
            "recovery_timeout",
            "recovery_failed_audit",
            "valid_full_service"
          ]),
          verbCase: Schema.Literals([
            "bad_position",
            "bad_page_size",
            "empty_ws_root",
            "bad_override",
            "replay_and_inspect"
          ])
        })
      )
      await runFuzz(
        arb,
        ({ optCase, verbCase }) =>
          Effect.gen(function*() {
            const lineage = "tt/root"
            const baseStore = MemoryTimeTravelStore.make({
              records: [
                makePlainRecord("tt", lineage, 0, EventTypes.runDecision, {
                  state: { version: 1, flowName: "TT", payload: {} }
                })
              ],
              runStatuses: new Map([["tt", "suspended"]])
            })
            if (optCase === "recovery_failed_audit") {
              yield* baseStore.writeAudit({
                id: "bad-audit",
                runId: "tt",
                frame: { lineageId: lineage, seq: 0 },
                status: "in_progress",
                detail: { version: 99, corrupt: true }
              })
            }
            const store: TimeTravelStore.Service = optCase === "recovery_timeout"
              ? { ...baseStore, pendingAudits: () => Effect.never }
              : baseStore
            const runs = makeRuns([makeRow({ runId: "tt", status: "suspended" })])
            const jjMem = makeMemoryJj()
            const deps = Layer.mergeAll(
              Layer.succeed(TimeTravelStore.TimeTravelStore, store),
              Layer.succeed(RunStore.RunStore, runs),
              Layer.succeed(Journal.Journal, journalOf(baseStore)),
              Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop()),
              Layer.succeed(Jj.Jj, jjMem.service),
              CompensationHandlers.layer([])
            )

            const opts: TimeTravelOptions = optCase === "bad_comp_zero"
              ? { compensationTimeout: Duration.zero }
              : optCase === "bad_comp_inf"
              ? { compensationTimeout: Duration.infinity }
              : optCase === "bad_rec_zero"
              ? { recoveryTimeout: Duration.zero }
              : optCase === "bad_rec_inf"
              ? { recoveryTimeout: Duration.infinity }
              : optCase === "recovery_timeout"
              ? { recoveryTimeout: Duration.millis(10) }
              : { maxHistoryEntries: 50, isAlive: () => Effect.succeed(false) }

            const buildExit = yield* Effect.scoped(
              Effect.exit(
                Effect.gen(function*() {
                  const tt = yield* TimeTravel
                  const proj: Replay.Projection<number> = { initial: 0, reduce: (n) => n + 1 }
                  if (verbCase === "bad_position") {
                    const e = yield* Effect.flip(tt.replay({ runId: "", frame: { lineageId: lineage, seq: 0 } }, proj))
                    return e.code === "invalid"
                  }
                  if (verbCase === "bad_page_size") {
                    const e = yield* Effect.flip(
                      tt.replay({ runId: "tt", frame: { lineageId: lineage, seq: 0 } }, proj, { pageSize: 0 })
                    )
                    return e.code === "invalid"
                  }
                  if (verbCase === "empty_ws_root") {
                    const e = yield* Effect.flip(
                      tt.fork({ runId: "tt", frame: { lineageId: lineage, seq: 0 } }, { workspaceRoot: "" })
                    )
                    return e.code === "invalid"
                  }
                  if (verbCase === "bad_override") {
                    const e = yield* Effect.flip(
                      tt.fork(
                        { runId: "tt", frame: { lineageId: lineage, seq: 0 } },
                        { override: { stepKeyDigest: "", result: 1 } as any }
                      )
                    )
                    return e.code === "invalid"
                  }
                  const r = yield* tt.replay({ runId: "tt", frame: { lineageId: lineage, seq: 0 } }, proj)
                  const i = yield* tt.inspect({ runId: "tt", frame: { lineageId: lineage, seq: 0 } }, proj)
                  return r === 1 && i === 1
                }).pipe(Effect.provide(TimeTravel.layerWith(opts).pipe(Layer.provide(deps))))
              )
            )

            if (
              optCase === "bad_comp_zero" ||
              optCase === "bad_comp_inf" ||
              optCase === "bad_rec_zero" ||
              optCase === "bad_rec_inf"
            ) {
              return Exit.isFailure(buildExit) && TimeTravelError.fromCause(buildExit.cause).code === "invalid"
            }
            if (optCase === "recovery_timeout") {
              return Exit.isFailure(buildExit) &&
                TimeTravelError.fromCause(buildExit.cause).code === "compensation_failed"
            }
            return Exit.isSuccess(buildExit) && buildExit.value === true
          }),
        { seedOffset: 20, executions: medExecutions }
      )
    })

    it("ForkOperation covers ancestor chains, missing/cached overrides, rebind, refused directory cleanup & maxEntries", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scenario: Schema.Literals([
            "live_grandparent",
            "missing_grandparent",
            "ancestor_cycle_idle",
            "frame_unaddressed",
            "override_not_admitted",
            "override_in_cache",
            "rebind_ok",
            "rebind_fail",
            "commit_fail_cleanup_fs",
            "max_entries_exceeded"
          ])
        })
      )
      await runFuzz(
        arb,
        ({ scenario }) =>
          Effect.gen(function*() {
            const lineage = "fk2/root"
            const storeRecords: Array<MemoryTimeTravelStore.JournalRecord> = [
              {
                runId: "fk2",
                seq: 0,
                eventId: "fk2-ev-0",
                lineageId: lineage,
                eventType: EventTypes.attemptStarted,
                payload: { stepKeyDigest: "s1", attempt: 1 }
              },
              {
                runId: "fk2",
                seq: 1,
                eventId: "fk2-ev-1",
                lineageId: lineage,
                eventType: "step.done",
                payload: { a: 1 }
              },
              {
                runId: "fk2",
                seq: 2,
                eventId: "fk2-ev-2",
                lineageId: lineage,
                eventType: "step.done",
                payload: { a: 2 }
              }
            ]
            const journalEntries: Array<JournalEvent.Entry> = storeRecords.map((r) => ({
              runId: r.runId as JournalEvent.RunId,
              seq: r.seq as JournalEvent.Seq,
              eventId: r.eventId,
              sourceId: "src" as JournalEvent.SourceId,
              sourceSeq: r.seq as JournalEvent.SourceSeq,
              emittedAtMs: r.seq,
              eventType: r.eventType ?? "step.done",
              payload: r.payload,
              meta: { lineageId: lineage }
            }))
            const runRows: Array<RunStore.RunRow> = [
              makeRow({
                runId: "fk2",
                status: "suspended",
                parentRunId: scenario === "live_grandparent" || scenario === "missing_grandparent" ||
                    scenario === "ancestor_cycle_idle"
                  ? "mid"
                  : null
              }),
              ...(scenario === "live_grandparent"
                ? [
                  makeRow({ runId: "mid", status: "suspended", parentRunId: "gp" }),
                  makeRow({ runId: "gp", status: "running", owner: makeOwner("gp"), heartbeatAtMs: 0 })
                ]
                : scenario === "missing_grandparent"
                ? [makeRow({ runId: "mid", status: "suspended", parentRunId: "missing-gp" })]
                : scenario === "ancestor_cycle_idle"
                ? [makeRow({ runId: "mid", status: "suspended", parentRunId: "fk2" })]
                : [])
            ]
            const runs = makeRuns(runRows)
            const store = MemoryTimeTravelStore.make({
              records: storeRecords,
              snapshots: [{ runId: "fk2", frame: { lineageId: lineage, seq: 0 }, changeId: "ch-0" }],
              runStatuses: new Map(runRows.map((r) => [r.runId, r.status])),
              ...(scenario === "commit_fail_cleanup_fs" ? { failAt: "createFork:start" } : {})
            })
            const cache = CacheStore.makeNoop({
              get: (key) =>
                Effect.succeed(
                  scenario === "override_in_cache" && key === "s1"
                    ? Option.some({
                      keyDigest: "s1",
                      result: "cached",
                      meta: {},
                      createdAtMs: 0,
                      recordedRunId: "fk2",
                      recordedEventSeq: 0
                    })
                    : Option.none()
                )
            })
            let removedDir = false
            const fs = FileSystem.makeNoop({
              remove: () =>
                Effect.sync(() => {
                  removedDir = true
                })
            })
            const jjMem = makeMemoryJj()
            const env = Layer.mergeAll(
              Layer.succeed(Journal.Journal, journalOf(journalEntries)),
              Layer.succeed(RunStore.RunStore, runs),
              Layer.succeed(TimeTravelStore.TimeTravelStore, store),
              Layer.succeed(CacheStore.CacheStore, cache),
              Layer.succeed(Jj.Jj, jjMem.service),
              Layer.succeed(FileSystem.FileSystem, fs),
              EffectHandlerRegistry.layerNoop
            )

            const exit = yield* Effect.scoped(
              Effect.exit(
                ForkOperation.fork({
                  parentRunId: "fk2",
                  frame: { lineageId: lineage, seq: scenario === "frame_unaddressed" ? 9 : 0 },
                  workspaceRoot: "/tmp/fuzz-fk2",
                  ...(scenario === "override_not_admitted"
                    ? { override: { stepKeyDigest: "missing-step", result: 1 } }
                    : scenario === "override_in_cache"
                    ? { override: { stepKeyDigest: "s1", result: 1 } }
                    : {}),
                  ...(scenario === "rebind_ok"
                    ? { rebind: () => Effect.succeed({ payload: { rebound: true } }) }
                    : scenario === "rebind_fail"
                    ? { rebind: () => Effect.fail(TimeTravelError.error("invalid", "bad rebind")) }
                    : {}),
                  ...(scenario === "max_entries_exceeded" ? { maxEntries: 1 } : {})
                }).pipe(Effect.provide(env))
              )
            )

            if (scenario === "ancestor_cycle_idle" || scenario === "rebind_ok") {
              return Exit.isSuccess(exit)
            }
            if (!Exit.isFailure(exit)) return false
            const code = TimeTravelError.fromCause(exit.cause).code
            if (scenario === "live_grandparent") return code === "live_parent"
            if (
              scenario === "missing_grandparent" || scenario === "frame_unaddressed" ||
              scenario === "override_not_admitted"
            ) {
              return code === "not_found"
            }
            if (scenario === "override_in_cache" || scenario === "rebind_fail") return code === "invalid"
            if (scenario === "max_entries_exceeded") return code === "limit_exceeded"
            if (scenario === "commit_fail_cleanup_fs") {
              return code === "unknown" && removedDir && jjMem.forgotten.length === 1
            }
            return true
          }),
        { seedOffset: 21, executions: medExecutions }
      )
    })

    it("Recovery.recover handles pendingChildren protocol claims, ownership recovery, foreign claims & release faults", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          committed: Schema.Boolean,
          childKind: Schema.Literals([
            "missing",
            "terminal",
            "proto_claimed_ok",
            "proto_claimed_fail",
            "foreign_claimed",
            "proto_running_dead",
            "proto_running_live",
            "foreign_running",
            "unclaimed_suspended"
          ]),
          releaseFenceLost: Schema.Boolean,
          auditUpdateFailOnRollback: Schema.Boolean
        })
      )
      await runFuzz(
        arb,
        ({ committed, childKind, releaseFenceLost, auditUpdateFailOnRollback }) =>
          Effect.gen(function*() {
            const recoveryOwner = makeOwner("rec2", 60)
            const protoOwner: OwnerId = {
              hostId: recoveryOwner.hostId,
              pid: 61,
              nonce: "prev:rewind-child:p-child"
            }
            const foreignOwner: OwnerId = {
              hostId: recoveryOwner.hostId,
              pid: 62,
              nonce: "unrelated-owner"
            }
            const frame = { lineageId: "run/root", seq: 0 }

            const detail: Rewind.AuditDetail = {
              version: 1,
              phase: committed ? "archive_committed" : "compensated",
              originalStatus: "suspended",
              suffixCount: 1,
              suffixTailSeq: 1,
              warnings: [],
              cancelledChildren: [],
              pendingChildren: ["p-child"]
            }

            const baseStore = MemoryTimeTravelStore.make()
            yield* baseStore.writeAudit({
              id: "audit-p",
              runId: "run",
              frame,
              status: "in_progress",
              detail
            })
            const store: TimeTravelStore.Service = {
              ...baseStore,
              archivedAt: () => Effect.succeed(committed),
              updateAudit: (id, patch) =>
                auditUpdateFailOnRollback && !committed && patch.status === "failed"
                  ? Effect.fail(TimeTravelError.error("unknown", "audit write failed"))
                  : baseStore.updateAudit(id, patch)
            }

            const childRow: RunStore.RunRow | undefined = childKind === "missing"
              ? undefined
              : makeRow({
                runId: "p-child",
                status: childKind === "terminal"
                  ? "completed"
                  : childKind === "proto_running_dead" ||
                      childKind === "proto_running_live" ||
                      childKind === "foreign_running"
                  ? "running"
                  : "suspended",
                owner: childKind === "proto_running_dead" || childKind === "proto_running_live"
                  ? protoOwner
                  : childKind === "foreign_running"
                  ? foreignOwner
                  : null,
                heartbeatAtMs: childKind === "proto_running_dead" ||
                    childKind === "proto_running_live" ||
                    childKind === "foreign_running"
                  ? 0
                  : null,
                claim: childKind === "proto_claimed_ok" || childKind === "proto_claimed_fail"
                  ? protoOwner
                  : childKind === "foreign_claimed"
                  ? foreignOwner
                  : null,
                claimedAtMs: childKind === "proto_claimed_ok" ||
                    childKind === "proto_claimed_fail" ||
                    childKind === "foreign_claimed"
                  ? 0
                  : null
              })

            const baseRuns = makeRuns([
              makeRow({ runId: "run", status: "suspended", stateJson: "{\"x\":1}" }),
              ...(childRow === undefined ? [] : [childRow])
            ])
            const runs: RunStore.Service = {
              ...baseRuns,
              recoverClaim: (runId, claim, claimedAtMs, claimant, nowMs, evidence) => {
                if (childKind === "proto_claimed_fail") {
                  return Effect.succeed({ _tag: "ClaimFresh" as const })
                }
                if (childRow !== undefined && runId === "p-child") {
                  return baseRuns.abandonClaim(runId, claim, claimedAtMs).pipe(
                    Effect.as({ _tag: "Recovered" as const })
                  )
                }
                return baseRuns.recoverClaim(runId, claim, claimedAtMs, claimant, nowMs, evidence)
              },
              transitionOwned: (runId, o, status, stateJson, guard) =>
                releaseFenceLost && runId === "run"
                  ? Effect.succeed({ _tag: "FenceLost" as const })
                  : baseRuns.transitionOwned(runId, o, status, stateJson, guard)
            }

            const journal = Journal.makeNoop({
              emitDurableUnfenced: () =>
                Effect.succeed({
                  _tag: "Accepted",
                  seq: 0 as JournalEvent.Seq,
                  sourceSeq: 0 as JournalEvent.SourceSeq
                }),
              entries: () =>
                Effect.succeed({
                  entries: committed
                    ? []
                    : [
                      {
                        runId: "run" as JournalEvent.RunId,
                        seq: 1 as JournalEvent.Seq,
                        eventId: "e1",
                        sourceId: "s" as JournalEvent.SourceId,
                        sourceSeq: 1 as JournalEvent.SourceSeq,
                        emittedAtMs: 1,
                        eventType: "t",
                        payload: {},
                        meta: { lineageId: "run/root" }
                      }
                    ],
                  hasMore: false
                })
            })

            const env = Layer.mergeAll(
              Layer.succeed(TimeTravelStore.TimeTravelStore, store),
              Layer.succeed(RunStore.RunStore, runs),
              Layer.succeed(Journal.Journal, journal),
              Layer.succeed(Jj.Jj, makeMemoryJj().service),
              EffectHandlerRegistry.layerNoop
            )

            const outcomes = yield* Recovery.recover({
              owner: recoveryOwner,
              livenessEvidence: (_audit, row, _claimant, nowMs) =>
                Effect.succeed(
                  childKind === "proto_running_live" || row.owner === null
                    ? undefined
                    : deadEvidence(row.owner, nowMs)
                )
            }).pipe(Effect.provide(env))

            if (outcomes.length !== 1) return false
            const tag = outcomes[0]!._tag
            return tag === "Completed" || tag === "RolledBack" || tag === "Busy" || tag === "Failed"
          }),
        { seedOffset: 22, executions: medExecutions }
      )
    })

    it("Compensation, SnapshotProjector & Replay cover error paths, malformed payloads, cache errors, out-of-order pages & v2 engine events", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          compFault: Schema.Literals([
            "cache_error",
            "missing_target_change",
            "restore_and_rb_fail",
            "rollback_both_fail"
          ]),
          projFault: Schema.Literals(["bad_snapshot", "bad_plan", "carried_without_prior"]),
          replayFault: Schema.Literals([
            "cache_error",
            "out_of_order_pages",
            "exact_dup_same_id",
            "v2_valid",
            "v2_invalid"
          ])
        })
      )
      await runFuzz(
        arb,
        ({ compFault, projFault, replayFault }) =>
          Effect.gen(function*() {
            // 1. Compensation faults
            const effComp: EffectBoundary.EffectRecord = {
              id: "c1",
              kind: "fs.write",
              tier: "compensable",
              status: "succeeded",
              runId: "r",
              lineageId: "r/root",
              seq: 1,
              changeId: "ch1",
              durableBoundary: true,
              providerStream: false
            }
            const effSeal: EffectBoundary.EffectRecord = {
              id: "s1",
              kind: "read",
              tier: "sealed",
              status: "succeeded",
              runId: "r",
              lineageId: "r/root",
              seq: 1,
              cacheKey: "ck1",
              durableBoundary: true,
              providerStream: false
            }
            const effIrr: EffectBoundary.EffectRecord = {
              id: "i1",
              kind: "mail.send",
              tier: "irreversible",
              status: "succeeded",
              runId: "r",
              lineageId: "r/root",
              seq: 2,
              idempotencyKey: "ik1",
              durableBoundary: true,
              providerStream: false
            }
            const failHandler: CompensationHandlers.Handler = {
              kind: "mail.send",
              tier: "irreversible",
              requiresIdempotencyKey: true,
              residue: () => "none",
              revert: () => Effect.succeed({ ok: 1 }),
              rollback: () => Effect.fail(TimeTravelError.error("compensation_failed", "rb fail"))
            }
            const failCache = Layer.succeed(
              CacheStore.CacheStore,
              CacheStore.makeNoop({
                get: () =>
                  Effect.fail(
                    new CacheStore.CacheStoreError({ code: "persistence_failed", message: "db down", cause: "x" })
                  )
              })
            )
            const failJj = Layer.succeed(Jj.Jj, makeMemoryJj({ failOn: "restore" }).service)
            const regLayer = EffectHandlerRegistry.layer([failHandler])

            if (compFault === "cache_error") {
              const e = yield* Effect.flip(
                Compensation.assess([effSeal]).pipe(Effect.provide(Layer.mergeAll(failCache, regLayer)))
              )
              if (e.code !== "unknown") return false
            } else if (compFault === "missing_target_change") {
              const plan: Compensation.Plan = { effects: [effComp], assessments: [] }
              const e = yield* Effect.flip(
                Compensation.prepareWorkspace(plan, [{ id: "i1:rollback", effect: effIrr, data: {} }]).pipe(
                  Effect.provide(Layer.mergeAll(failJj, regLayer))
                )
              )
              if (e.code !== "compensation_failed") return false
            } else if (compFault === "restore_and_rb_fail") {
              const e = yield* Effect.flip(
                Compensation.restorePreparedWorkspace({
                  handlerReceipts: [{ id: "i1:rollback", effect: effIrr, data: {} }],
                  workspace: { currentChangeId: "cur", targetChangeId: "tgt" }
                }).pipe(Effect.provide(Layer.mergeAll(failJj, regLayer)))
              )
              if (e.code !== "compensation_failed" || Compensation.applied(e) === undefined) return false
            } else {
              const e = yield* Effect.flip(
                Compensation.rollback({
                  handlerReceipts: [{ id: "i1:rollback", effect: effIrr, data: {} }],
                  workspace: { currentChangeId: "cur", targetChangeId: "tgt" }
                }).pipe(Effect.provide(Layer.mergeAll(failJj, regLayer)))
              )
              if (e.code !== "compensation_failed" || Compensation.applied(e) === undefined) return false
            }

            // 2. SnapshotProjector edge cases
            const projEntry: JournalEvent.Entry = {
              runId: "r" as JournalEvent.RunId,
              seq: 0 as JournalEvent.Seq,
              eventId: "e0",
              sourceId: "s" as JournalEvent.SourceId,
              sourceSeq: 0 as JournalEvent.SourceSeq,
              emittedAtMs: 0,
              eventType: projFault === "bad_plan" ? EventTypes.planRecorded : EventTypes.snapshotIdentified,
              payload: projFault === "bad_snapshot"
                ? { version: 99, snapshotId: 123 }
                : projFault === "bad_plan"
                ? { version: 99, digest: 123 }
                : { version: 1, carried: true },
              meta: { lineageId: "r/root" }
            }
            const stepRes = yield* Effect.result(SnapshotProjector.step(SnapshotProjector.initial, projEntry))
            if (projFault === "carried_without_prior") {
              if (!Result.isSuccess(stepRes) || stepRes.success.anchor !== undefined) return false
            } else {
              if (!Result.isFailure(stepRes) || stepRes.failure.code !== "invalid") return false
            }

            // 3. Replay edge cases
            const proj: Replay.Projection<number> = { initial: 0, reduce: (n) => n + 1 }
            const rId = JournalEvent.RunId.make("r-rep")
            const sId = JournalEvent.SourceId.make("src")
            const lId = JournalEvent.LineageId.make("r-rep/root")
            const consumer: EngineEvent.Consumer = {
              runId: rId,
              lineageId: lId,
              rootRunId: rId,
              round: 0,
              parentRunId: null,
              sources: [sId],
              unknown: "ignore"
            }

            if (replayFault === "cache_error") {
              const e = yield* Effect.flip(
                Replay.rederive({ lineageId: lId, seq: 0 }, proj, { runId: rId }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      Layer.succeed(
                        Journal.Journal,
                        journalOf([
                          {
                            runId: rId,
                            seq: 0 as JournalEvent.Seq,
                            eventId: "e0",
                            sourceId: sId,
                            sourceSeq: 0 as JournalEvent.SourceSeq,
                            emittedAtMs: 0,
                            eventType: "t",
                            payload: {},
                            meta: { lineageId: lId, cacheKey: "ck1" }
                          }
                        ])
                      ),
                      failCache
                    )
                  )
                )
              )
              if (e.code !== "unknown") return false
            } else if (replayFault === "out_of_order_pages") {
              let call = 0
              const j = Journal.makeNoop({
                entries: () => {
                  call += 1
                  return Effect.succeed({
                    entries: [
                      {
                        runId: rId,
                        seq: (call === 1 ? 2 : 1) as JournalEvent.Seq,
                        eventId: `e-${call}`,
                        sourceId: sId,
                        sourceSeq: call as JournalEvent.SourceSeq,
                        emittedAtMs: 0,
                        eventType: "t",
                        payload: {},
                        meta: { lineageId: lId }
                      }
                    ],
                    hasMore: call === 1
                  })
                }
              })
              const e = yield* Effect.flip(
                Replay.rederive({ lineageId: lId, seq: 2 }, proj, { runId: rId }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      Layer.succeed(Journal.Journal, j),
                      Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())
                    )
                  )
                )
              )
              if (e.code !== "invalid") return false
            } else if (replayFault === "exact_dup_same_id") {
              const entry0: JournalEvent.Entry = {
                runId: rId,
                seq: 0 as JournalEvent.Seq,
                eventId: "same-id",
                sourceId: sId,
                sourceSeq: 0 as JournalEvent.SourceSeq,
                emittedAtMs: 0,
                eventType: "t",
                payload: {},
                meta: { lineageId: lId }
              }
              const j = Journal.makeNoop({
                entries: () => Effect.succeed({ entries: [entry0, entry0], hasMore: false })
              })
              const n = yield* Replay.rederive({ lineageId: lId, seq: 0 }, proj, { runId: rId }).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    Layer.succeed(Journal.Journal, j),
                    Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())
                  )
                )
              )
              if (n !== 1) return false
            } else {
              const lineageObj = EngineEvent.Lineage.make({
                kind: "root",
                runId: rId,
                lineageId: lId,
                rootRunId: rId,
                round: 0,
                parentRunId: null
              })
              const v2Entry: JournalEvent.Entry = {
                runId: rId,
                seq: 0 as JournalEvent.Seq,
                eventId: "v2-0",
                sourceId: sId,
                sourceSeq: 0 as JournalEvent.SourceSeq,
                emittedAtMs: 0,
                eventType: "flows.engine.v2.custom-unknown",
                payload: replayFault === "v2_valid" ? { lineage: lineageObj, note: 1 } : { bogus: true },
                meta: replayFault === "v2_valid" ? { lineage: lineageObj } : {}
              }
              const res = yield* Effect.result(
                Replay.rederive({ lineageId: lId, seq: 0 }, proj, {
                  runId: rId,
                  engineEvents: consumer
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      Layer.succeed(Journal.Journal, journalOf([v2Entry])),
                      Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop())
                    )
                  )
                )
              )
              if (replayFault === "v2_invalid" && (!Result.isFailure(res) || res.failure.code !== "invalid")) {
                return false
              }
            }
            return true
          }),
        { seedOffset: 23, executions: fastExecutions }
      )
    })

    it("MemoryTimeTravelStore & SqlTimeTravelStore cover failAt, append, migrate, childOwners fencing, multi-gen archives & SQL EffectBoundary settlement", async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          memFailAt: Schema.Literals([
            "recordSnapshot",
            "writeAudit",
            "updateAudit",
            "archiveAndTruncate:start",
            "nextForkId",
            "renewForkIntent",
            "abandonForkIntents",
            "forgetForkIntent",
            "createFork:start",
            "recordReceipt"
          ]),
          childOwnerMatches: Schema.Boolean,
          secondGeneration: Schema.Boolean
        })
      )
      await runFuzz(
        arb,
        ({ memFailAt, childOwnerMatches, secondGeneration }) =>
          Effect.gen(function*() {
            const owner = makeOwner("ms", 400)
            const childOwner = makeOwner("ms-c", 401)
            const wrongChildOwner = makeOwner("ms-w", 402)
            const frame = { lineageId: "r/root", seq: 0 }

            // 1. MemoryTimeTravelStore failAt, append duplicate, layer, rebinding with cancel-requested cutoff
            const failStore = MemoryTimeTravelStore.make({
              records: [makePlainRecord("r", "r/root", 0)],
              failAt: memFailAt
            })
            const callForFail = memFailAt === "recordSnapshot"
              ? failStore.recordSnapshot({ runId: "r", frame, changeId: "c" })
              : memFailAt === "writeAudit"
              ? failStore.writeAudit({ id: "a", runId: "r", frame, status: "in_progress" })
              : memFailAt === "updateAudit"
              ? failStore.updateAudit("a", { status: "completed" })
              : memFailAt === "archiveAndTruncate:start"
              ? failStore.archiveAndTruncate("r", frame, [], owner)
              : memFailAt === "nextForkId"
              ? failStore.nextForkId("r", frame)
              : memFailAt === "renewForkIntent"
              ? failStore.renewForkIntent("c")
              : memFailAt === "abandonForkIntents"
              ? failStore.abandonForkIntents(100)
              : memFailAt === "forgetForkIntent"
              ? failStore.forgetForkIntent("c", 1)
              : memFailAt === "createFork:start"
              ? failStore.createFork("r", frame)
              : failStore.recordReceipt({ id: "rc", auditId: "a", effectId: "e", receipt: {} })
            const fErr = yield* Effect.flip(callForFail)
            if (fErr.code !== "unknown") return false

            const mem = MemoryTimeTravelStore.make({
              records: [
                makePlainRecord("r", "r/root", 0, EventTypes.runDecision, {
                  state: { version: 1, flowName: "R", payload: {} }
                }),
                makePlainRecord("c", "c/root", 0, EventTypes.runDecision, {
                  state: { version: 1, flowName: "C", payload: {} }
                }),
                makePlainRecord("c", "c/root", 1, EventTypes.runDecision, { decision: "cancel-requested" })
              ],
              edges: [{ parentRunId: "r", parentSeq: 0, childRunId: "c", kind: "child", attached: true }],
              runStatuses: new Map([["r", "suspended"], ["c", "suspended"]])
            })
            // append + duplicate append -> throws invalid TimeTravelError synchronously
            mem.append(makePlainRecord("r", "r/root", 1))
            let dupThrewInvalid = false
            try {
              mem.append(makePlainRecord("r", "r/root", 1))
            } catch (err) {
              dupThrewInvalid = err instanceof TimeTravelError.TimeTravelError && err.code === "invalid"
            }
            if (!dupThrewInvalid) return false
            // missing audit update -> not_found
            const missAudit = yield* Effect.flip(mem.updateAudit("missing-a", { status: "completed" }))
            if (missAudit.code !== "not_found") return false
            // override in memory -> not_found
            const memOv = yield* Effect.flip(mem.createFork("r", frame, undefined, { stepKeyDigest: "s", result: 1 }))
            if (memOv.code !== "not_found") return false
            // rebinding with cancel-requested inbound cutoff in memory store
            const rebFork = yield* mem.createFork("r", frame, undefined, undefined, {
              payload: { p: 1 },
              children: [{ from: "c", to: "c-fork", payload: { cp: 1 } }]
            })
            if (rebFork.runId.length === 0) return false
            // existing childRunId -> invalid
            const taken = yield* Effect.flip(mem.createFork("r", frame, "r"))
            if (taken.code !== "invalid") return false
            // MemoryTimeTravelStore.layer
            const layerStore = yield* TimeTravelStore.TimeTravelStore.pipe(
              Effect.provide(MemoryTimeTravelStore.layer())
            )
            if ((yield* layerStore.pendingAudits()).length !== 0) return false

            // 2. SqlTimeTravelStore: standalone migrate, non-terminal attached childOwners fence, multi-gen archives, real SQL EffectBoundary settlement
            const sqlOk = yield* Effect.gen(function*() {
              yield* EngineMigrations.run
              yield* SqlTimeTravelStore.migrate
              const sql = yield* SqlClient.SqlClient
              const sqlStore = yield* SqlTimeTravelStore.make
              const nowMs = yield* Clock.currentTimeMillis

              yield* sql`
                INSERT INTO flows_runs
                  (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
                VALUES
                  ('r', 'running', ${nowMs}, '{}', ${owner.hostId}, ${owner.pid}, ${owner.nonce}, ${nowMs}),
                  ('c-live', 'running', ${nowMs}, '{}', ${childOwner.hostId}, ${childOwner.pid}, ${childOwner.nonce}, ${nowMs})
              `
              yield* sql`
                INSERT INTO flows_journal_events
                  (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
                VALUES
                  ('r', 0, 'r-0', 'src', 0, 0, ${EventTypes.runDecision}, '{"state":{"v":0}}', '{"lineageId":"r/root"}'),
                  ('r', 1, 'r-1', 'src', 1, 0, ${EventTypes.attemptStarted}, '{"stepKeyDigest":"st","attempt":1}', '{"lineageId":"r/root"}'),
                  ('c-live', 0, 'c-0', 'src', 0, 0, 't', '{}', '{"lineageId":"c/root"}')
              `
              yield* sql`
                INSERT INTO flows_attempts
                  (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms, heartbeat_at_ms, outcome_json, meta_json)
                VALUES
                  ('r', 'st', 1, 'running', 0, NULL, 0, NULL, '{}')
              `
              yield* sql`
                INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
                VALUES ('r', 1, 'c-live', 'child', 1)
              `

              const missingUpd = yield* Effect.flip(sqlStore.updateAudit("no-such-audit", { status: "completed" }))
              if (missingUpd.code !== "not_found") return false

              const childMap = new Map([["c-live", childOwnerMatches ? childOwner : wrongChildOwner]])
              const arch1 = yield* Effect.result(sqlStore.archiveAndTruncate("r", frame, [], owner, childMap))
              if (!childOwnerMatches) {
                if (!Result.isFailure(arch1) || arch1.failure.code !== "fence_lost") return false
              } else {
                if (!Result.isSuccess(arch1) || arch1.success.archived < 1) return false
                if (!(yield* sqlStore.archivedAt("r", 1))) return false
                if (!(yield* sqlStore.archivedAt("r", 1, 0))) return false
                if (secondGeneration) {
                  // Append another seq=1 and archive generation 1!
                  yield* sql`
                    INSERT INTO flows_journal_events
                      (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
                    VALUES ('r', 1, 'r-1-g2', 'src', 2, 0, 't', '{}', '{"lineageId":"r/root"}')
                  `
                  const arch2 = yield* sqlStore.archiveAndTruncate("r", frame, [], owner)
                  if (arch2.archived !== 1) return false
                  if (!(yield* sqlStore.archivedAt("r", 1, 1))) return false
                }
              }

              // Real SQL EffectBoundary.guard settlement + invalid description
              yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('r-eb', 'suspended', 0, '{}')`
              const rs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
              const ebExpected = { status: "suspended" as const, owner: null, heartbeatAtMs: null }
              yield* rs.claim("r-eb", ebExpected, owner, 0)
              yield* rs.activate("r-eb", owner, 0, ebExpected)
              return yield* Effect.gen(function*() {
                const realJournal = yield* Journal.Journal
                const badDescErr = yield* Effect.flip(
                  EffectBoundary.guard(
                    {
                      id: "",
                      kind: "k",
                      tier: "sealed",
                      runId: "r-eb",
                      lineageId: "r-eb/root",
                      owner,
                      sourceId: "eb-src",
                      sourceSeq: 10
                    },
                    Effect.succeed("x")
                  ).pipe(Effect.provideService(Journal.Journal, realJournal))
                )
                if (badDescErr.code !== "invalid") return false

                // Real SQL ack-lost confirmation: succeeded commits, ack fails -> unknown conflicts -> confirms succeeded!
                let droppedOnce = false
                const ackLostJournal: Journal.Service = {
                  ...realJournal,
                  emitDurable: (input, holder) => {
                    const status = (input.payload as { readonly effect: { readonly status: string } }).effect.status
                    if (status === "succeeded" && !droppedOnce) {
                      droppedOnce = true
                      return realJournal.emitDurable(input, holder).pipe(
                        Effect.andThen(
                          Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "ack lost" }))
                        )
                      )
                    }
                    return realJournal.emitDurable(input, holder)
                  }
                }
                const confirmed = yield* EffectBoundary.guard(
                  {
                    id: "eb-sql-1",
                    kind: "mail.send",
                    tier: "irreversible",
                    runId: "r-eb",
                    lineageId: "r-eb/root",
                    owner,
                    sourceId: "eb-src",
                    sourceSeq: 20,
                    idempotencyKey: "eb-ik-1"
                  },
                  Effect.succeed("confirmed-val")
                ).pipe(Effect.provideService(Journal.Journal, ackLostJournal))
                return confirmed === "confirmed-val"
              }).pipe(
                Effect.provide(
                  SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(Layer.provide(SqlConsensus.layer))
                )
              )
            }).pipe(Effect.scoped, Effect.provide(TestDatabase.layer))

            return sqlOk
          }),
        { seedOffset: 24, executions: sqlExecutions }
      )
    })
  })
})
