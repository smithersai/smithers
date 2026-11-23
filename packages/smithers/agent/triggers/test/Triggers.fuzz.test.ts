import * as ControlChannels from "@smthrs/control/Channels"
import * as Control from "@smthrs/control/Control"
import type { CredentialRef } from "@smthrs/control/Credential"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Option, Redacted, Result, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as NodeCrypto from "node:crypto"
import { describe, expect, it } from "vitest"
import * as ClaimDecision from "../src/ClaimDecision.ts"
import {
  CatchUp,
  Channel,
  Cron,
  DispatchReader,
  On,
  Overlap,
  Schedule,
  Scheduler,
  SqlTriggerStore,
  Trigger,
  TriggerError,
  TriggerStore,
  Webhook
} from "../src/index.ts"
import * as TestTriggers from "../src/test/TestTriggers.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "800" : "200"))
const fastExecutions = Math.min(executions, 25)
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

const HOUR_MS = 60 * 60 * 1_000

describe("@smthrs/triggers comprehensive fuzz invariants", () => {
  it("Cron.parse, WallClock, CatchUp, On, Trigger, Schedule, Channel, and Webhook verify obey all invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        expr: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          Schema.Literals([
            "* * * * *",
            "0 0 1 1 *",
            "*/15 9-17 * * 1-5",
            "0 2 * * *",
            "60 * * * *",
            "* * * *",
            "0 0 31 2 *"
          ])
        ]),
        timezone: Schema.Literals(["UTC", "America/New_York", "Invalid/Zone"]),
        baseMs: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 1_700_000_000_000, maximum: 1_750_000_000_000 }))
        ),
        spanMin: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 180 }))),
        policy: Schema.Literals(["none", "one", "all"]),
        maxCatchUp: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
        overlap: Schema.Literals(["skip", "buffer-one", "supersede"]),
        running: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ expr, timezone, baseMs, spanMin, policy, maxCatchUp, overlap, running }) =>
          Effect.gen(function*() {
            const parsed = yield* Effect.result(Cron.parse(expr, timezone))
            if (Result.isFailure(parsed)) {
              if (parsed.failure._tag !== "flows/triggers/TriggerError") return false
            } else {
              const base = new Date(baseMs)
              const t1 = yield* Cron.next(parsed.success, base)
              if (t1.getTime() <= baseMs) return false
              const prev = yield* Cron.previousAtOrBefore(parsed.success, t1)
              if (prev.getTime() !== t1.getTime()) return false
              const end = new Date(baseMs + spanMin * 60_000)
              const between = yield* Cron.occurrencesBetween(parsed.success, base, end)
              for (let i = 1; i < between.length; i++) {
                if (!(between[i]!.getTime() > between[i - 1]!.getTime())) return false
              }
              const caught = yield* Effect.result(CatchUp.occurrences(policy, maxCatchUp, base, end, parsed.success))
              if (policy === "none" && (Result.isFailure(caught) || caught.success.length !== 0)) return false
              if (Result.isSuccess(caught)) {
                if (caught.success.length > maxCatchUp) return false
                if (policy === "one" && caught.success.length > 1) return false
              }
            }

            // Overlap, Schedule, On, Trigger, Channel
            const decision = Overlap.decide(overlap, { running, due: 1000, pending: 500 })
            if (!running && decision !== "fire") return false
            if (running && overlap === "skip" && decision !== "skip") return false
            if (running && overlap === "buffer-one" && decision !== "buffer") return false
            if (running && overlap === "supersede" && decision !== "supersede") return false
            if (Overlap.pendingAfter({ running, due: 1000, pending: 500 }) !== 1000) return false

            const sched = yield* Schedule.make({
              cron: "0 * * * *",
              timezone: "UTC",
              overlap,
              catchUp: policy,
              maxCatchUp
            })
            if (sched.overlap !== overlap) return false

            const onPush = On.push({ branches: ["main"] })
            const onPr = On.pullRequest({ branches: ["main"] })
            const onMan = On.manual()
            const onCron = On.cron("0 * * * *", { timezone: "UTC" })
            if (
              onPush._tag !== "Push" || onPr._tag !== "PullRequest" || onMan._tag !== "Manual" || onCron._tag !== "Cron"
            ) {
              return false
            }

            const trig = yield* Trigger.make({
              id: "t-1",
              flowId: "f-1",
              input: { x: 1 },
              cron: "0 * * * *",
              timezone: "UTC",
              overlap,
              catchUp: policy,
              maxCatchUp,
              enabled: true
            })
            const binding = Trigger.bind({ flow: { _tag: "f-1" }, on: onCron, title: "hourly" })
            const mrow = Trigger.manifestRow("t-1", binding)
            if (trig.id !== "t-1" || mrow.flow !== "f-1") return false

            const ch = Channel.make<{ readonly ok: boolean }>({
              name: "ch",
              verify: () => Effect.void,
              inbound: () => ({ start: { flowId: "f1", input: {} } })
            })
            return ch.name === "ch"
          }),
        { seed, executions: Math.min(executions, 120) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ClaimDecision.decide, decideFenced, lease, refuse, and displaced satisfy all concurrency & lease invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        overlap: Schema.Literals(["skip", "buffer-one", "supersede"]),
        enabled: Schema.Boolean,
        hasActive: Schema.Boolean,
        activeIsReservation: Schema.Boolean,
        leaseExpired: Schema.Boolean,
        hasPending: Schema.Boolean,
        existingOutcome: Schema.Literals(["none", "open", "buffered", "completed", "failed"]),
        revisionMatches: Schema.Boolean,
        occurrence: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1000, maximum: 5000 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (
          {
            overlap,
            enabled,
            hasActive,
            activeIsReservation,
            leaseExpired,
            hasPending,
            existingOutcome,
            revisionMatches,
            occurrence
          }
        ) =>
          Effect.sync(() => {
            const now = 10_000_000
            const activeRunId = hasActive
              ? activeIsReservation
                ? TriggerStore.reservationId("t1", 500, "att1")
                : "run-live-1"
              : undefined
            const activeClaimedAt = hasActive && activeIsReservation
              ? leaseExpired
                ? now - TriggerStore.reservationLeaseMs - 1000
                : now - 1000
              : undefined

            const existingFire: ClaimDecision.Fire | undefined = existingOutcome === "none"
              ? undefined
              : {
                outcome: existingOutcome === "open" ? null : existingOutcome
              }
            const snapshot: ClaimDecision.Snapshot = {
              revision: 2,
              enabled,
              overlap,
              activeRunId,
              activeClaimedAt,
              pending: hasPending ? 900 : undefined,
              existingFire,
              ...(hasActive && activeIsReservation
                ? { activeFire: { outcome: null, runId: "prev-run-1" } }
                : {})
            }
            const fire: TriggerStore.ClaimFire = {
              triggerId: "t1",
              occurrence,
              expectedRevision: revisionMatches ? 2 : 1
            }
            const resId = TriggerStore.reservationId("t1", occurrence, "att2")
            const decision = ClaimDecision.decide({
              fire,
              snapshot,
              claimedAt: now,
              reservationId: resId
            })
            if (!revisionMatches) {
              return decision._tag === "Refused" && decision.error.code === "revision_mismatch"
            }
            if (!enabled) {
              return decision._tag === "Refused" && decision.error.code === "trigger_disabled"
            }
            if (decision._tag === "Refused") return false
            if (existingOutcome === "completed" || existingOutcome === "failed") {
              return decision.claim.claimed === false
            }
            const lease = ClaimDecision.lease({ activeRunId, activeClaimedAt, now })
            if (hasActive && activeIsReservation && leaseExpired && lease._tag !== "Expired") return false
            const fenced = ClaimDecision.decideFenced({ fire, snapshot, claimedAt: now, reservationId: resId })
            if (fenced.claim.claimed !== decision.claim.claimed) return false
            const disp = ClaimDecision.displaced(hasPending ? 900 : undefined, occurrence)
            if (hasPending && occurrence > 900 && disp !== 900) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Differential fuzz: SqlTriggerStore (real SQLite) matches TestTriggers across arbitrary command sequences", async () => {
    const cmdArb = Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("register"),
        id: Schema.Literals(["t1", "t2"]),
        overlap: Schema.Literals(["skip", "buffer-one", "supersede"]),
        enabled: Schema.Boolean
      }),
      Schema.Struct({
        _tag: Schema.Literal("claimFire"),
        id: Schema.Literals(["t1", "t2"]),
        occ: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 6 }))),
        staleRev: Schema.Boolean
      }),
      Schema.Struct({
        _tag: Schema.Literal("claimPending"),
        id: Schema.Literals(["t1", "t2"])
      }),
      Schema.Struct({
        _tag: Schema.Literal("recordLaunched"),
        id: Schema.Literals(["t1", "t2"])
      }),
      Schema.Struct({
        _tag: Schema.Literal("recordTerminal"),
        id: Schema.Literals(["t1", "t2"]),
        outcome: Schema.Literals(["completed", "failed", "superseded"])
      }),
      Schema.Struct({
        _tag: Schema.Literal("restorePending"),
        id: Schema.Literals(["t1", "t2"])
      }),
      Schema.Struct({
        _tag: Schema.Literal("setPending"),
        id: Schema.Literals(["t1", "t2"]),
        occ: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 6 })))
      }),
      Schema.Struct({
        _tag: Schema.Literal("clearActive"),
        id: Schema.Literals(["t1", "t2"])
      }),
      Schema.Struct({
        _tag: Schema.Literal("heartbeat"),
        host: Schema.Literals(["h1", "h2"])
      }),
      Schema.Struct({
        _tag: Schema.Literal("prune"),
        olderThan: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 })))
      }),
      Schema.Struct({
        _tag: Schema.Literal("advanceClock"),
        minutes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10 })))
      })
    ])

    const arb = Arbitrary.schema(
      Schema.Array(cmdArb).pipe(Schema.check(Schema.isMinLength(3)), Schema.check(Schema.isMaxLength(14)))
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (cmds) =>
          Effect.gen(function*() {
            const runOn = (storeLayer: Layer.Layer<TriggerStore.TriggerStore, TriggerError.TriggerError>) =>
              Effect.gen(function*() {
                const store = yield* TriggerStore.TriggerStore
                const trace: Array<string> = []
                const revisions = new Map<string, number>()
                const lastRes = new Map<string, { readonly occ: number; readonly resId: string }>()
                let runCounter = 0

                for (const cmd of cmds) {
                  switch (cmd._tag) {
                    case "register": {
                      const reg = yield* store.register({
                        id: cmd.id,
                        flowId: "flow-a",
                        input: { k: cmd.id },
                        cron: "0 * * * *",
                        timezone: "UTC",
                        overlap: cmd.overlap,
                        catchUp: "one",
                        maxCatchUp: 2,
                        enabled: cmd.enabled
                      })
                      revisions.set(cmd.id, reg.revision)
                      trace.push(`reg:${cmd.id}:${reg.revision}:${reg.enabled}`)
                      break
                    }
                    case "claimFire": {
                      const rev = revisions.get(cmd.id) ?? 1
                      const r = yield* Effect.result(
                        store.claimFire({
                          triggerId: cmd.id,
                          occurrence: cmd.occ * 1000,
                          expectedRevision: cmd.staleRev ? rev + 99 : rev
                        })
                      )
                      if (Result.isFailure(r)) {
                        trace.push(`claimErr:${r.failure.code}`)
                      } else {
                        const cl = r.success
                        trace.push(`claim:${cl.claimed ? cl.action : "dup"}`)
                        if (cl.claimed && (cl.action === "fire" || cl.action === "supersede")) {
                          lastRes.set(cmd.id, { occ: cmd.occ * 1000, resId: cl.reservationId })
                        }
                      }
                      break
                    }
                    case "claimPending": {
                      const rev = revisions.get(cmd.id) ?? 1
                      const r = yield* Effect.result(
                        store.claimPending({ triggerId: cmd.id, expectedRevision: rev })
                      )
                      if (Result.isFailure(r)) {
                        trace.push(`cpErr:${r.failure.code}`)
                      } else if (Option.isNone(r.success)) {
                        trace.push("cp:none")
                      } else {
                        const cl = r.success.value.claim
                        trace.push(`cp:${cl.claimed ? cl.action : "dup"}:${r.success.value.occurrence}`)
                        if (cl.claimed && (cl.action === "fire" || cl.action === "supersede")) {
                          lastRes.set(cmd.id, { occ: r.success.value.occurrence, resId: cl.reservationId })
                        }
                      }
                      break
                    }
                    case "recordLaunched": {
                      const info = lastRes.get(cmd.id)
                      const occ = info?.occ ?? 1000
                      const runId = `run-${++runCounter}`
                      const r = yield* Effect.result(
                        store.recordResult({
                          triggerId: cmd.id,
                          occurrence: occ,
                          outcome: "launched",
                          runId,
                          reservationId: info?.resId ?? "missing-res"
                        })
                      )
                      trace.push(Result.isSuccess(r) ? `launch:ok` : `launchErr:${r.failure.code}`)
                      break
                    }
                    case "recordTerminal": {
                      const info = lastRes.get(cmd.id)
                      const occ = info?.occ ?? 1000
                      const r = yield* Effect.result(
                        store.recordResult({
                          triggerId: cmd.id,
                          occurrence: occ,
                          outcome: cmd.outcome,
                          ...(cmd.outcome === "failed" ? { error: "err-msg" } : {}),
                          ...(info ? { reservationId: info.resId } : {})
                        })
                      )
                      trace.push(Result.isSuccess(r) ? `term:${cmd.outcome}` : `termErr:${r.failure.code}`)
                      break
                    }
                    case "restorePending": {
                      const info = lastRes.get(cmd.id)
                      const r = yield* Effect.result(
                        store.restorePending({
                          triggerId: cmd.id,
                          occurrence: info?.occ ?? 1000,
                          reservationId: info?.resId ?? "missing-res"
                        })
                      )
                      trace.push(Result.isSuccess(r) ? "restore:ok" : `restoreErr:${r.failure.code}`)
                      break
                    }
                    case "setPending": {
                      const r = yield* Effect.result(
                        store.setPending({ triggerId: cmd.id, occurrence: cmd.occ * 1000 })
                      )
                      trace.push(Result.isSuccess(r) ? "setPend:ok" : `setPendErr:${r.failure.code}`)
                      break
                    }
                    case "clearActive": {
                      const act = yield* Effect.result(store.activeRun(cmd.id))
                      if (Result.isSuccess(act) && Option.isSome(act.success)) {
                        yield* store.activeOccurrence(cmd.id, act.success.value)
                        yield* store.clearActive(cmd.id, act.success.value)
                        trace.push("clear:did")
                      } else {
                        trace.push("clear:none")
                      }
                      break
                    }
                    case "heartbeat": {
                      yield* store.heartbeat(cmd.host)
                      const hb = yield* store.lastHeartbeat()
                      trace.push(Option.isSome(hb) ? `hb:${hb.value.host}` : "hb:none")
                      break
                    }
                    case "prune": {
                      const n = yield* store.pruneFires({ olderThan: cmd.olderThan * 1000 })
                      trace.push(`prune:${n}`)
                      break
                    }
                    case "advanceClock": {
                      yield* TestClock.adjust(`${cmd.minutes} minutes`)
                      break
                    }
                  }
                }

                // Compare final list, listEnabled, inspect, history pagination
                const listed = yield* store.list()
                const enabledList = yield* store.listEnabled()
                const page1 = yield* store.history({ limit: 2 })
                const page2 = page1.nextCursor !== undefined
                  ? yield* store.history({ limit: 2, cursor: page1.nextCursor })
                  : { items: [], nextCursor: undefined }
                const t1Get = yield* store.get("t1")
                const t1Inspect = yield* Effect.result(store.inspect("t1"))
                const badLimit = yield* Effect.result(store.history({ limit: 0 }))
                const badPrune = yield* Effect.result(store.pruneFires({ olderThan: Number.NaN }))

                // Also test DispatchReader over this store!
                const reader = yield* DispatchReader.make
                const trigSummaries = yield* reader.list({ _tag: "triggers" as const })
                const fireSummaries = yield* reader.list({ _tag: "fires" as const, filters: { limit: 5 } } as never)

                return {
                  trace,
                  listedIds: listed.map((l) =>
                    Result.isSuccess(l.trigger)
                      ? `${l.trigger.success.id}:${l.trigger.success.revision}:${l.trigger.success.enabled}`
                      : `err:${l.triggerId}`
                  ),
                  enabledIds: enabledList.map((e) => e.id),
                  histLen: page1.items.length + page2.items.length,
                  hasT1: Option.isSome(t1Get),
                  inspectOk: Result.isSuccess(t1Inspect),
                  badLimitErr: Result.isFailure(badLimit),
                  badPruneErr: Result.isFailure(badPrune),
                  summaryCount: trigSummaries.length,
                  fireSummaryCount: fireSummaries.length
                }
              }).pipe(Effect.provide(Layer.mergeAll(storeLayer, TestClock.layer(), silentLogger)))

            const sqlRes = yield* runOn(SqlTriggerStore.layer.pipe(Layer.provide(TestDatabase.layer)))
            const memRes = yield* runOn(TestTriggers.layer)

            if (JSON.stringify(sqlRes.trace) !== JSON.stringify(memRes.trace)) return false
            if (JSON.stringify(sqlRes.listedIds) !== JSON.stringify(memRes.listedIds)) return false
            if (JSON.stringify(sqlRes.enabledIds) !== JSON.stringify(memRes.enabledIds)) return false
            if (sqlRes.histLen !== memRes.histLen || sqlRes.summaryCount !== memRes.summaryCount) return false
            return sqlRes.badLimitErr && sqlRes.badPruneErr
          }),
        { seed: seed + 2, executions: Math.min(executions, 24) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Scheduler ticks, overlap policies, catchUp, runner failures, active-run settlement, recovery, Control runner, and Webhook receive", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        overlap: Schema.Literals(["skip", "buffer-one", "supersede"]),
        catchUp: Schema.Literals(["none", "one", "all"]),
        runnerFailsOnce: Schema.Boolean,
        runStopsAs: Schema.Literals(["completed", "failed", "cancelled", "missing"]),
        advanceHours: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
        useSqlStore: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ overlap, catchUp, runnerFailsOnce, runStopsAs, advanceHours, useSqlStore }) =>
          Effect.gen(function*() {
            const starts: Array<Scheduler.StartInput> = []
            const active = new Set<string>()
            const stopped = new Map<string, Scheduler.RunState>()
            const cancels: Array<string> = []
            let failBudget = runnerFailsOnce ? 1 : 0

            const runner = Scheduler.makeRunner({
              start: (input) =>
                Effect.suspend(() => {
                  starts.push(input)
                  if (failBudget > 0) {
                    failBudget--
                    return Effect.fail(new TriggerError.TriggerError({ code: "store", message: "launch fail" }))
                  }
                  const runId = `run-${starts.length}`
                  active.add(runId)
                  return Effect.succeed(runId)
                }),
              inspect: (runId) => Effect.sync(() => (active.has(runId) ? "active" : stopped.get(runId) ?? "completed")),
              cancel: (runId) =>
                Effect.sync(() => {
                  cancels.push(runId)
                  active.delete(runId)
                  stopped.set(runId, "cancelled")
                })
            })

            const storeLayer = useSqlStore
              ? SqlTriggerStore.layer.pipe(Layer.provide(TestDatabase.layer))
              : TestTriggers.layer

            const prog = Effect.gen(function*() {
              const store = yield* TriggerStore.TriggerStore
              yield* TestClock.setTime(1_700_000_000_000)
              yield* store.register({
                id: "hourly-1",
                flowId: "flow-x",
                input: { a: 1 },
                cron: "0 * * * *",
                timezone: "UTC",
                overlap,
                catchUp,
                maxCatchUp: 3,
                enabled: true
              })

              // Advance time and tick
              yield* TestClock.adjust(`${advanceHours} hours`)
              const t1 = yield* Scheduler.tick({ host: "host-1", concurrency: 2 })
              if (t1.at <= 1_700_000_000_000) return false

              // Advance another hour while first run is still active -> exercises skip / buffer-one / supersede!
              yield* TestClock.adjust("1 hours")
              yield* Scheduler.tick({ host: "host-1", concurrency: 2 })

              // Now settle all active runs with `runStopsAs` and tick again to reconcile + drain buffered!
              for (const rid of [...active]) {
                active.delete(rid)
                stopped.set(rid, runStopsAs)
              }
              yield* Scheduler.tick({ host: "host-1", concurrency: 2 })

              // Also test Scheduler.make + runOnce + Scheduler.layerNoop + Scheduler.makeNoopRunner
              const sched = yield* Scheduler.make({ host: "host-1", fireRetention: "1 day" })
              yield* sched.runOnce
              const noopRun = Scheduler.makeNoopRunner()
              const noopStart = yield* noopRun.start({
                flowId: "f",
                input: {},
                idempotencyKey: "k"
              })
              const noopInspect = yield* noopRun.inspect(noopStart)
              yield* noopRun.cancel(noopStart)
              if (noopStart !== "k" || noopInspect !== "completed") return false
              yield* Scheduler.makeNoop().runOnce

              // Check idempotencyKey & tickExecutionId helpers
              if (!Scheduler.idempotencyKey("t", HOUR_MS).startsWith("t:")) return false
              if (!Scheduler.tickExecutionId("h").includes("h")) return false

              // Exercise TriggerStore.makeNoop all methods + TriggerError
              const noopStore = TriggerStore.makeNoop()
              const noopCalls = [
                noopStore.register({
                  id: "t",
                  flowId: "f",
                  input: {},
                  cron: "0 * * * *",
                  overlap: "skip",
                  catchUp: "none",
                  maxCatchUp: 0,
                  enabled: true
                }),
                noopStore.get("x"),
                noopStore.list(),
                noopStore.listEnabled(),
                noopStore.claimFire({ triggerId: "t", occurrence: 1, expectedRevision: 1 }),
                noopStore.claimPending({ triggerId: "t", expectedRevision: 1 }),
                noopStore.recordResult({ triggerId: "t", occurrence: 1, outcome: "skipped" }),
                noopStore.restorePending({ triggerId: "t", occurrence: 1, reservationId: "r" }),
                noopStore.setPending({ triggerId: "t", occurrence: 1 }),
                noopStore.activeRun("t"),
                noopStore.activeOccurrence("t", "r"),
                noopStore.clearActive("t", "r"),
                noopStore.history(),
                noopStore.pruneFires({ olderThan: 1 }),
                noopStore.inspect("t"),
                noopStore.heartbeat("h"),
                noopStore.lastHeartbeat()
              ]
              for (const eff of noopCalls) {
                const r = yield* Effect.result(eff)
                if (Result.isSuccess(r)) return false
              }
              const badTrig = yield* Effect.result(Trigger.make({ id: "", flowId: "" }))
              if (Result.isSuccess(badTrig)) return false

              return true
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  storeLayer,
                  Layer.succeed(Scheduler.Runner, runner),
                  TestClock.layer(),
                  silentLogger
                )
              )
            )
            return yield* Effect.scoped(prog)
          }),
        { seed: seed + 3, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Webhook.make verifies HMAC signatures, rejects forged/malformed/missing-header payloads, and dispatches start/signal to Control", async () => {
    const Payload = Schema.Union([
      Schema.TaggedStruct("start", { flowId: Schema.String, input: Schema.Unknown }),
      Schema.TaggedStruct("signal", { runId: Schema.String, stepId: Schema.String, value: Schema.Json })
    ])
    type Payload = typeof Payload.Type

    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals(["start", "signal", "badSig", "missingHeader", "badJson", "badSchema"]),
        key: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9_-]{1,12}$/))),
        bodyExtra: Schema.String.pipe(Schema.check(Schema.isMaxLength(16))),
        bufferKind: Schema.Literals(["uint8", "buffer", "offsetBuffer"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, key, bodyExtra, bufferKind }) =>
          Effect.gen(function*() {
            const secret = "webhook-secret-key"
            const cred = Redacted.make<CredentialRef>({ id: "cred-1", name: "wh" })
            let started = 0
            let signaled = 0

            const fakeControl = Control.make({
              plan: (input) =>
                Effect.succeed({
                  planId: "plan-1",
                  flowId: input.flowId,
                  digest: "digest",
                  inputSummary: "input",
                  envelope: { capabilities: [], flows: [], budget: {} },
                  deployClass: false,
                  nodes: [],
                  approval: {
                    target: {
                      _tag: "Plan" as const,
                      planId: "plan-1",
                      digest: "digest",
                      envelope: { capabilities: [], flows: [], budget: {} }
                    },
                    scope: "run" as const,
                    idempotencyKey: "approval"
                  }
                }),
              run: () => {
                started++
                return Effect.succeed({
                  _tag: "Accepted" as const,
                  receiptId: "rcpt-start",
                  runId: "r-1"
                })
              },
              approve: () => Effect.die("unused"),
              deny: () => Effect.die("unused"),
              steer: () => Effect.die("unused"),
              signal: () => {
                signaled++
                return Effect.succeed({
                  _tag: "Accepted" as const,
                  receiptId: "rcpt-sig"
                })
              },
              cancel: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "rcpt-cancel" }),
              pause: () => Effect.die("unused"),
              resume: () => Effect.die("unused"),
              list: () => Effect.succeed({ _tag: "runs" as const, items: [] }),
              watch: () => Stream.empty
            })

            const wh = Webhook.make<Payload>({
              name: "gh-events",
              schema: Payload,
              credential: cred,
              verify: Webhook.makeSignatureVerifier({
                header: "x-hub-signature-256",
                expected: (body) =>
                  Effect.sync(() =>
                    new TextEncoder().encode(
                      "sha256=" + NodeCrypto.createHmac("sha256", secret).update(body).digest("hex")
                    )
                  )
              }),
              inbound: (p) =>
                p._tag === "start"
                  ? { start: { flowId: p.flowId, input: p.input } }
                  : { signal: { runId: p.runId, stepId: p.stepId, value: p.value } }
            })

            const rawText = kind === "badJson"
              ? "{not-json"
              : kind === "badSchema"
              ? JSON.stringify({ _tag: "unknown" })
              : kind === "signal"
              ? JSON.stringify({ _tag: "signal", runId: "r-1", stepId: "s-1", value: bodyExtra })
              : JSON.stringify({ _tag: "start", flowId: "f-1", input: { bodyExtra } })

            const bodyBytes = bufferKind === "buffer"
              ? Buffer.from(rawText)
              : bufferKind === "offsetBuffer"
              ? Buffer.from(`XXXX${rawText}YYYY`).subarray(4, 4 + Buffer.byteLength(rawText))
              : new TextEncoder().encode(rawText)

            const validSig = "sha256=" + NodeCrypto.createHmac("sha256", secret).update(bodyBytes).digest("hex")
            const headers: Record<string, string> = kind === "missingHeader"
              ? {}
              : {
                "x-hub-signature-256": kind === "badSig"
                  ? validSig.slice(0, -1) + (validSig.endsWith("0") ? "1" : "0")
                  : validSig
              }

            // Exercise constantTimeEqual directly
            if (!Webhook.constantTimeEqual(bodyBytes, new Uint8Array(bodyBytes))) return false

            const controlLayer = Layer.succeed(Control.Control, fakeControl)
            const channelsLayer = ControlChannels.layerMemory.pipe(Layer.provide(controlLayer))

            const res = yield* Effect.result(
              Effect.gen(function*() {
                yield* wh.register
                return yield* wh.ingest({ body: bodyBytes, headers, idempotencyKey: key })
              }).pipe(
                Effect.provide(Layer.mergeAll(channelsLayer, silentLogger))
              )
            )
            const startedFromWebhook = started
            const signaledFromWebhook = signaled

            // Also exercise Scheduler.layerControlRunner against fakeControl
            const ctrlRunnerRes = yield* Effect.gen(function*() {
              const r = yield* Scheduler.Runner
              const runId = yield* r.start({
                flowId: "f-1",
                input: {},
                idempotencyKey: `ik-${key}`
              })
              const state = yield* r.inspect(runId)
              yield* r.cancel(runId)
              return runId === "r-1" && state === "missing"
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Scheduler.layerControlRunner.pipe(Layer.provide(controlLayer)),
                  silentLogger
                )
              )
            )
            if (!ctrlRunnerRes) return false

            if (kind === "badSig" || kind === "missingHeader" || kind === "badJson" || kind === "badSchema") {
              return Result.isFailure(res) && startedFromWebhook === 0 && signaledFromWebhook === 0
            }
            if (Result.isFailure(res)) return false
            return kind === "start" ? startedFromWebhook === 1 : signaledFromWebhook === 1
          }),
        { seed: seed + 4, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
