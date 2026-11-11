import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { EventTypes } from "@smthrs/engine-store/EventTypes"
import * as Jj from "@smthrs/jj"
import { Journal, SqlJournal } from "@smthrs/journal"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import { RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { error } from "../src/TimeTravelError.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const owner = { hostId: "test-host", pid: 20, nonce: "commit-owner" }
const frame = { lineageId: "run/root", seq: 0 }
const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
const persistence = SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(Layer.provideMerge(database))

describe("Rewind archive commit boundary", () => {
  for (
    const scenario of [
      "interrupt",
      "post-commit failure",
      "journal evidence failure",
      "archive evidence failure"
    ] as const
  ) {
    it.effect(`preserves the committed archive after ${scenario}`, () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const base = yield* SqlTimeTravelStore.make
        const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
        const journal = yield* Journal.Journal
        yield* sql`
          INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
          VALUES ('run', 'suspended', 0, '{"cursor":9}')
        `
        const effect: Omit<EffectBoundary.EffectRecord, "seq"> = {
          id: "send",
          kind: "send",
          tier: "irreversible",
          status: "succeeded",
          runId: "run",
          lineageId: frame.lineageId,
          idempotencyKey: "send-key",
          durableBoundary: true,
          providerStream: false
        }
        const workspaceEffect: Omit<EffectBoundary.EffectRecord, "seq"> = {
          ...effect,
          id: "workspace",
          kind: "fs-write",
          tier: "compensable",
          changeId: "target"
        }
        for (const seq of [0, 1, 2]) {
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
               event_type, payload_json, meta_json)
            VALUES ('run', ${seq}, ${`event-${seq}`}, 'commit-test', ${seq}, 0,
              ${seq === 0 ? "baseline" : EffectBoundary.eventType},
              ${JSON.stringify(seq === 0 ? {} : { version: 1, effect: seq === 1 ? effect : workspaceEffect })},
              ${JSON.stringify({ lineageId: frame.lineageId })})
          `
        }
        yield* base.recordSnapshot({ runId: "run", frame, changeId: "target" })
        const committed = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
        const release = yield* Deferred.make<void>()
        let archiveReturned = false
        const store: TimeTravelStore["Service"] = {
          ...base,
          archivedAt: (...args) =>
            scenario === "archive evidence failure"
              ? Effect.fail(error("unknown", "archive evidence unreadable"))
              : base.archivedAt(...args),
          archiveAndTruncate: (...args) =>
            // Hold the real SQL store's result in an uninterruptible region,
            // as SqlClient does while finalizing COMMIT. Cancellation must not
            // escape between that durable write and Rewind's local flag.
            Effect.uninterruptible(
              base.archiveAndTruncate(...args).pipe(
                Effect.tap(() => Deferred.succeed(committed, Fiber.getCurrent()!)),
                Effect.tap(() => Deferred.await(release)),
                Effect.tap(() =>
                  Effect.sync(() => {
                    archiveReturned = true
                  })
                ),
                Effect.tap(() =>
                  scenario !== "interrupt"
                    ? Effect.fail(error("unknown", "publication failed after commit"))
                    : Effect.void
                )
              )
            )
        }
        let pointer = "current"
        const external = ["sent"]
        const rollbacks: Array<string> = []
        const registry = yield* EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message remains sent",
          revert: () => Effect.sync(() => ({ value: external.pop() })),
          rollback: (_effect, receipt) =>
            Effect.sync(() => {
              rollbacks.push("send")
              external.push((receipt as { readonly value: string }).value)
            })
        }])
        const fiber = yield* Rewind.rewind({ runId: "run", frame, owner, auditId: "audit" }).pipe(
          Effect.provideService(TimeTravelStore, store),
          Effect.provideService(Journal.Journal, {
            ...journal,
            entries: (options) =>
              archiveReturned && scenario === "journal evidence failure"
                ? Effect.fail(new Journal.JournalError({ code: "read_failed", message: "journal evidence unreadable" }))
                : journal.entries(options)
          }),
          Effect.provideService(RunStore.RunStore, runs),
          Effect.provideService(EffectHandlerRegistry.EffectHandlerRegistry, registry),
          Effect.provide(CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })),
          Effect.provideService(
            Jj.Jj,
            Jj.makeNoop({
              snapshot: () => Effect.succeed({ commitId: pointer, changeId: pointer }),
              restore: (changeId) =>
                Effect.sync(() => {
                  pointer = changeId
                })
            })
          ),
          Effect.forkChild
        )
        const committingFiber = yield* Deferred.await(committed)
        if (scenario === "interrupt") {
          // Request cancellation without awaiting the masked fiber, then let
          // its commit return. No timing or scheduler sleeps are involved.
          yield* Effect.sync(() => committingFiber.interruptUnsafe())
        }
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (scenario === "interrupt") {
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        } else {
          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("publication failed after commit")
        }
        const live = yield* sql<{ readonly seq: number }>`SELECT seq FROM flows_journal_events WHERE run_id = 'run'`
        expect(live.map((row) => row.seq)).toEqual([0])
        expect(yield* base.archivedAt("run", 2, 0)).toBe(true)
        expect(rollbacks).toEqual([])
        expect(external).toEqual([])
        expect(pointer).toBe("target")
        if (scenario === "interrupt" || scenario === "post-commit failure") {
          expect(yield* runs.get("run")).toMatchObject({ status: "suspended", owner: null })
          expect(yield* base.pendingAudits()).toEqual([])
          return
        }
        expect(yield* runs.get("run")).toMatchObject({ status: "running", owner })
        expect(yield* base.pendingAudits()).toMatchObject([{
          id: "audit",
          status: "in_progress",
          detail: {
            generation: 0,
            phase: scenario === "journal evidence failure" || scenario === "archive evidence failure"
              ? "compensated"
              : "archive_committed"
          }
        }])
      }).pipe(Effect.provide(persistence)))
  }
})

describe("rewind takeover fence", () => {
  const owner = { hostId: "time-travel:test", pid: 0, nonce: "rewind" }
  const frame = { lineageId: "run/root", seq: 0 }
  const frameState = JSON.stringify({ version: 1, flowName: "Demo", payload: { cursor: 1 } })
  const laterState = JSON.stringify({ version: 1, flowName: "Demo", payload: { cursor: 9 } })
  const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
  const persistence = SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(Layer.provideMerge(database))

  const seed = (sql: SqlClient.SqlClient) =>
    Effect.gen(function*() {
      yield* sql`
        INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES ('run', 'suspended', 0, ${laterState})
      `
      for (const [seq, state] of [[0, frameState], [1, laterState]] as const) {
        yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES ('run', ${seq}, ${`event-${seq}`}, 'rewind', ${seq}, 0, ${EventTypes.runDecision},
                  ${JSON.stringify({ state: JSON.parse(state) })}, ${JSON.stringify({ lineageId: frame.lineageId })})
        `
      }
    })

  for (const status of ["completed", "failed"] as const) {
    it.effect(`holds quarantine until the audit closes as ${status}`, () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const store = yield* SqlTimeTravelStore.make
        const engineState = yield* DurableEngineState.make
        yield* seed(sql)
        yield* sql`
          UPDATE flows_runs SET waiting_reason = 'approval', waiting_token = 'original',
            waiting_request = '"request"', waiting_wake_at_ms = 123 WHERE run_id = 'run'
        `
        yield* store.writeAudit({ id: "audit", runId: "run", frame, status: "in_progress" })
        expect(yield* engineState.waiting("run")).toMatchObject({
          value: { reason: "quarantine", token: "time-travel:audit" }
        })
        yield* store.updateAudit("audit", { detail: { phase: "compensated" } })
        expect(yield* engineState.waiting("run")).toMatchObject({ value: { reason: "quarantine" } })
        yield* store.updateAudit("audit", { status })
        expect(yield* engineState.waiting("run")).toEqual(
          status === "completed" ? Option.none() : Option.some({
            runId: "run",
            reason: "approval",
            token: "original",
            request: "request",
            wakeAt: 123
          })
        )
      }).pipe(Effect.provide(persistence)))
  }

  it.effect("refuses a second audit without replacing an unfinished rewind's quarantine", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* SqlTimeTravelStore.make
      yield* seed(sql)
      yield* store.writeAudit({ id: "first", runId: "run", frame, status: "in_progress" })
      const refused = yield* Effect.flip(store.writeAudit({ id: "second", runId: "run", frame, status: "in_progress" }))
      expect(refused.code).toBe("busy")
      expect(yield* store.pendingAudits()).toMatchObject([{ id: "first" }])
      const rows = yield* sql<{ waiting_token: string }>`SELECT waiting_token FROM flows_runs WHERE run_id = 'run'`
      expect(rows).toEqual([{ waiting_token: "time-travel:first" }])
    }).pipe(Effect.provide(persistence)))

  it.effect("audit closure preserves a replacement wait", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* SqlTimeTravelStore.make
      yield* seed(sql)
      yield* store.writeAudit({ id: "audit", runId: "run", frame, status: "in_progress" })
      yield* sql`UPDATE flows_runs SET waiting_reason = 'quarantine', waiting_token = 'replacement' WHERE run_id = 'run'`
      yield* store.updateAudit("audit", { status: "completed" })
      const waiting = yield* (yield* DurableEngineState.make).waiting("run")
      expect(waiting).toMatchObject({ value: { reason: "quarantine", token: "replacement" } })
    }).pipe(Effect.provide(persistence)))

  it.effect("commits the frame state with the truncated journal while retaining quarantine", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* SqlTimeTravelStore.make
      yield* seed(sql)
      yield* sql`
        UPDATE flows_runs SET status = 'running', owner_host_id = ${owner.hostId},
          owner_pid = ${owner.pid}, owner_nonce = ${owner.nonce}, heartbeat_at_ms = 0 WHERE run_id = 'run'
      `
      yield* store.writeAudit({ id: "audit", runId: "run", frame, status: "in_progress" })
      yield* store.archiveAndTruncate("run", frame, [], owner)
      const rows = yield* sql<{ state_json: string; waiting_reason: string }>`
        SELECT state_json, waiting_reason FROM flows_runs WHERE run_id = 'run'
      `
      expect(rows).toEqual([{ state_json: frameState, waiting_reason: "quarantine" }])
      const live = yield* sql<{ seq: number }>`SELECT seq FROM flows_journal_events WHERE run_id = 'run'`
      expect(live).toEqual([{ seq: 0 }])
    }).pipe(Effect.provide(persistence)))

  for (
    const fault of [
      "archive phase",
      "frame state",
      "suspension",
      "audit close",
      "child cancellation",
      "child progress"
    ] as const
  ) {
    it.effect(`settles a committed rewind after a transient ${fault} failure in the same call`, () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* seed(sql)
        const base = yield* SqlTimeTravelStore.make
        const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
        const registry = yield* EffectHandlerRegistry.make()
        if (fault.startsWith("child")) {
          yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES ('child', 'suspended', 0, '{}')
          `
          yield* sql`
            INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
            VALUES ('run', 1, 'child', 'child', 1)
          `
        }
        let committed = false
        let injected = false
        const failOnce = (at: typeof fault) => {
          if (fault !== at || !committed || injected) return false
          injected = true
          return true
        }
        const store: TimeTravelStore["Service"] = {
          ...base,
          archiveAndTruncate: (...args) =>
            base.archiveAndTruncate(...args).pipe(Effect.tap(() =>
              Effect.sync(() => {
                committed = true
              })
            )),
          stateAt: (...args) =>
            Effect.suspend(() =>
              failOnce("frame state") ? Effect.fail(error("unknown", "frame unavailable")) : base.stateAt(...args)
            ),
          updateAudit: (id, patch) =>
            Effect.suspend(() => {
              const detail = patch.detail as { phase?: string; cancelledChildren?: ReadonlyArray<string> } | undefined
              const at = patch.status === "completed" ?
                "audit close"
                : (detail?.cancelledChildren?.length ?? 0) > 0
                ? "child progress"
                : "archive phase"
              return failOnce(at) ? Effect.fail(error("unknown", "audit unavailable")) : base.updateAudit(id, patch)
            })
        }
        const faultyRuns: RunStore.Service = {
          ...runs,
          transitionOwned: (...args) =>
            Effect.suspend(() =>
              failOnce(args[0] === "child" ? "child cancellation" : "suspension")
                ? Effect.fail(
                  new RunStore.RunStoreError({
                    code: "persistence_failed",
                    method: "transitionOwned",
                    message: "unavailable",
                    cause: "injected"
                  })
                )
                : runs.transitionOwned(...args)
            )
        }
        const failure = yield* Effect.flip(
          Rewind.rewind({ runId: "run", frame, owner, auditId: "audit", detachedChildPolicy: "cancel" }).pipe(
            Effect.provideService(TimeTravelStore, store),
            Effect.provideService(RunStore.RunStore, faultyRuns),
            Effect.provideService(EffectHandlerRegistry.EffectHandlerRegistry, registry),
            Effect.provideService(Jj.Jj, Jj.makeNoop({})),
            Effect.provide(CacheStore.layerNoop())
          )
        )
        expect(injected).toBe(true)
        expect(failure.code).toBe("unknown")
        expect(yield* runs.get("run")).toMatchObject({ status: "suspended", owner: null, stateJson: frameState })
        expect(yield* base.pendingAudits()).toEqual([])
        const audit = yield* sql<{ status: string }>`SELECT status FROM flows_time_travel_audits WHERE id = 'audit'`
        expect(audit).toEqual([{ status: "completed" }])
        if (fault.startsWith("child")) {
          expect(yield* runs.get("child")).toMatchObject({ status: "cancelled", owner: null })
        }
        expect(yield* (yield* DurableEngineState.make).waiting("run")).toEqual(Option.none())
      }).pipe(Effect.provide(persistence)))
  }
})
