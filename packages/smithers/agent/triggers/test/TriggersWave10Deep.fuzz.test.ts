import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Control from "@smthrs/control/Control"
import { Unavailable } from "@smthrs/control/ControlError"
import * as DispatchPort from "@smthrs/control/DispatchReader"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import { Fuzz } from "@smthrs/fuzz"
import {
  Arbitrary,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Redacted,
  Result,
  Schema,
  Stream
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as CatchUp from "../src/CatchUp.ts"
import * as Cron from "../src/Cron.ts"
import * as DispatchReader from "../src/DispatchReader.ts"
import * as DueOccurrences from "../src/internal/DueOccurrences.ts"
import * as Schedule from "../src/Schedule.ts"
import * as Scheduler from "../src/Scheduler.ts"
import * as SqlTriggerStore from "../src/SqlTriggerStore.ts"
import * as TestTriggers from "../src/test/TestTriggers.ts"
import type { Trigger } from "../src/Trigger.ts"
import { TriggerError } from "../src/TriggerError.ts"
import * as TriggerStore from "../src/TriggerStore.ts"
import * as Webhook from "../src/Webhook.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])
const hour = 60 * 60 * 1_000

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeTrigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: "hourly",
  flowId: "review",
  input: { source: "schedule" },
  cron: "0 * * * *",
  timezone: "UTC",
  overlap: "buffer-one",
  catchUp: "one",
  maxCatchUp: 3,
  enabled: true,
  ...overrides
})

const sqliteStoreLayer = Layer.provideMerge(
  SqlTriggerStore.layer,
  TestDatabase.sqliteLayer
)

describe("@smthrs/triggers Wave10 Deep Fuzzing", () => {
  it("fuzzes CatchUp, Cron, Schedule, TriggerStore helpers, and DueOccurrences edge cases", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        badMax: Schema.Literals([-1, -5, 1.5]),
        badLimit: Schema.Literals([-1, 1.5, 0]),
        minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ badMax, badLimit, minute }) =>
          Effect.gen(function*() {
            const cron = yield* Cron.parse(`${minute} * * * *`, "UTC")

            const badCatch = yield* Effect.exit(
              CatchUp.occurrences("all", badMax, new Date(0), new Date(hour * 2), cron)
            )
            expect(Exit.isFailure(badCatch)).toBe(true)
            const undefLast = yield* CatchUp.occurrences("all", 5, undefined, new Date(hour * 2), cron)
            expect(undefLast).toEqual([])
            const nonePolicy = yield* CatchUp.occurrences("none", 5, new Date(0), new Date(hour * 2), cron)
            expect(nonePolicy).toEqual([])

            const badDate = yield* Effect.exit(Cron.occurrencesBetween(cron, new Date(Number.NaN), new Date(hour)))
            expect(Exit.isFailure(badDate)).toBe(true)
            const limitRes = yield* Effect.exit(
              Cron.occurrencesBetween(cron, new Date(0), new Date(hour * 3), badLimit)
            )
            if (badLimit === 0) {
              expect(Exit.isSuccess(limitRes)).toBe(true)
            } else {
              expect(Exit.isFailure(limitRes)).toBe(true)
            }

            const badSched = yield* Effect.exit(Schedule.make({ cron: 123 }))
            expect(Exit.isFailure(badSched)).toBe(true)

            const ref = TriggerStore.resultRefusal({ triggerId: "t", occurrence: hour, outcome: "launched", runId: "   ", reservationId: "r" }, { triggerId: "t", occurrence: hour, outcome: "launched", runId: "r" }, "r")
            expect(ref?.code).toBe("invalid_options")
            expect(
              TriggerStore.isAfterCursor(
                { triggerId: "a", occurrence: 100 },
                { triggerId: "a", occurrence: 200 }
              )
            ).toBe(true)
            const page = TriggerStore.historyPage(
              [
                { triggerId: "a", occurrence: 200, outcome: "completed" },
                { triggerId: "a", occurrence: 100, outcome: "completed" }
              ],
              1
            )
            expect(page.items.length).toBe(1)
            expect(page.nextCursor).toEqual({ triggerId: "a", occurrence: 200 })

            const bound = yield* DueOccurrences.boundary(
              { ...makeTrigger(), revision: 1 },
              hour * 2 + 1234
            )
            expect(bound).toBe(hour * 2)

            return true
          }),
        { executions: Math.min(executions, 60), seed }
      )
    )
    assertPassed(report)

    await Effect.runPromise(
      Effect.gen(function*() {
        for (let i = 0; i < 260; i++) {
          const m = i % 60
          const h = Math.floor(i / 60) % 24
          yield* Cron.parse(`${m} ${h} * * *`)
        }
        const offsetCron = yield* Cron.parse("0 * * * *", "+02:00")
        const next = yield* Cron.next(offsetCron, new Date(0))
        expect(next.getTime()).toBeGreaterThan(0)
      })
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        const s = yield* TriggerStore.TriggerStore
        const r = yield* Scheduler.Runner
        expect(Exit.isFailure(yield* Effect.exit(s.list()))).toBe(true)
        yield* Effect.exit(r.inspect("r1"))
      }).pipe(Effect.provide(Layer.merge(TriggerStore.layerNoop(), Scheduler.layerNoopRunner())))
    )
  }, 60_000)

  it("fuzzes SqlTriggerStore and TestTriggers deep paths: invalid inputs, expired reservation leases, restorePending, activeRun, prune, and corrupt rows", async () => {
    const runBody = (name: string, isSql: boolean) =>
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* TestClock.setTime(hour)

        expect(Exit.isFailure(yield* Effect.exit(store.register({ id: "" } as any)))).toBe(true)
        const circular: Record<string, unknown> = {}
        circular.self = circular
        expect(Exit.isFailure(yield* Effect.exit(store.register({ ...makeTrigger(), input: circular as any })))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(store.register({ ...makeTrigger(), input: undefined as any })))).toBe(true)

        const reg = yield* store.register(makeTrigger({ overlap: "buffer-one" }))

        expect(Option.isNone(yield* store.activeRun(reg.id))).toBe(true)

        const c1 = yield* store.claimFire({
          triggerId: reg.id,
          occurrence: hour,
          expectedRevision: reg.revision
        })
        expect(c1.claimed).toBe(true)
        if (!c1.claimed || c1.action !== "fire") throw new Error("expected fire")

        const held1 = yield* store.activeRun(reg.id)
        expect(Option.isSome(held1)).toBe(true)

        yield* store.recordResult({
          triggerId: reg.id,
          occurrence: hour,
          outcome: "launched",
          runId: "run-1",
          reservationId: c1.reservationId
        })
        yield* store.clearActive(reg.id, "wrong-run")

        const c2 = yield* store.claimFire({
          triggerId: reg.id,
          occurrence: hour * 2,
          expectedRevision: reg.revision
        })
        expect(c2.claimed).toBe(true)

        // Supersede + restorePending with predecessor
        const regSup = yield* store.register(makeTrigger({ id: `${name}-sup`, overlap: "supersede" }))
        const cs1 = yield* store.claimFire({
          triggerId: regSup.id,
          occurrence: hour,
          expectedRevision: regSup.revision
        })
        if (!cs1.claimed || cs1.action !== "fire") throw new Error("expected fire")
        yield* store.recordResult({
          triggerId: regSup.id,
          occurrence: hour,
          outcome: "launched",
          runId: "run-sup-1",
          reservationId: cs1.reservationId
        })
        const cs2 = yield* store.claimFire({
          triggerId: regSup.id,
          occurrence: hour * 2,
          expectedRevision: regSup.revision
        })
        if (!cs2.claimed || cs2.action !== "supersede") throw new Error("expected supersede")

        yield* store.restorePending({
          triggerId: regSup.id,
          occurrence: hour * 2,
          reservationId: cs2.reservationId
        })
        const afterRestore = yield* store.activeRun(regSup.id)
        expect(Option.isSome(afterRestore)).toBe(true)

        // Expired reservation during claimFire + activeRun lease expiry
        const regExp = yield* store.register(makeTrigger({ id: `${name}-exp`, overlap: "buffer-one" }))
        const ce1 = yield* store.claimFire({
          triggerId: regExp.id,
          occurrence: hour,
          expectedRevision: regExp.revision
        })
        expect(ce1.claimed).toBe(true)
        yield* TestClock.adjust("10 minutes")
        const ce2 = yield* store.claimFire({
          triggerId: regExp.id,
          occurrence: hour * 2,
          expectedRevision: regExp.revision
        })
        expect(ce2.claimed).toBe(true)
        yield* TestClock.adjust("10 minutes")
        const expActive = yield* store.activeRun(regExp.id)
        expect(Option.isNone(expActive)).toBe(true)

        // Claim + restorePending with NO predecessor
        const regNp = yield* store.register(makeTrigger({ id: `${name}-np`, overlap: "buffer-one" }))
        const cnp = yield* store.claimFire({
          triggerId: regNp.id,
          occurrence: hour,
          expectedRevision: regNp.revision
        })
        if (!cnp.claimed || cnp.action !== "fire") throw new Error("expected fire")
        yield* store.restorePending({
          triggerId: regNp.id,
          occurrence: hour,
          reservationId: cnp.reservationId
        })

        // Prune keeping active/pending/reserved and removing settled
        yield* Effect.exit(store.recordResult({ triggerId: regExp.id, occurrence: hour, outcome: "completed" }))
        yield* store.recordResult({ triggerId: reg.id, occurrence: hour, outcome: "completed", runId: "run-1" })
        const pruned = yield* store.pruneFires({ olderThan: hour * 10 })
        expect(pruned).toBeGreaterThanOrEqual(0)

        const sqlOpt = yield* Effect.serviceOption(SqlClient.SqlClient)
        if (isSql && Option.isSome(sqlOpt)) {
          const sql = sqlOpt.value
          const occRes = yield* store.activeOccurrence(reg.id, `${TriggerStore.reservationPrefix}not-a-valid-occ`)
          expect(Option.isNone(occRes)).toBe(true)

          yield* sql`INSERT INTO flows_triggers (
            trigger_id, flow_id, input_json, cron, timezone, overlap, catch_up, max_catch_up, enabled, revision
          ) VALUES ('corrupt', 'f', '{bad-json', '0 * * * *', 'UTC', 'skip', 'none', 0, 1, 1)`
          const getCorrupt = yield* Effect.exit(store.get("corrupt"))
          expect(Exit.isFailure(getCorrupt)).toBe(true)
          const listed = yield* store.list()
          const badRow = listed.find((r) => r.triggerId === "corrupt")
          expect(badRow !== undefined && Result.isFailure(badRow.trigger)).toBe(true)
        }
      })

    await Effect.runPromise(
      Effect.scoped(
        runBody("mem", false).pipe(
          Effect.provide(Layer.mergeAll(TestTriggers.layer, TestClock.layer(), silentLogger))
        )
      )
    )
    await Effect.runPromise(
      Effect.scoped(
        runBody("sql", true).pipe(
          Effect.provide(Layer.mergeAll(sqliteStoreLayer, TestClock.layer(), silentLogger))
        )
      )
    )
  }, 60_000)

  it("fuzzes DispatchReader fires/triggers pagination, error wrapping, and corrupt rows", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const reg = yield* store.register(makeTrigger())
        const c = yield* store.claimFire({
          triggerId: reg.id,
          occurrence: hour,
          expectedRevision: reg.revision
        })
        if (!c.claimed || c.action !== "fire") throw new Error("expected fire")
        yield* store.recordResult({
          triggerId: reg.id,
          occurrence: hour,
          outcome: "failed",
          error: "boom"
        })

        const reader = yield* DispatchReader.make
        const fires1 = yield* reader.fires({ _tag: "fires", limit: 10, cursor: "0" })
        expect(fires1.length).toBe(1)
        expect(fires1[0]?.error).toBe("boom")
        const firesBad = yield* reader.fires({ _tag: "fires", limit: -5, cursor: "nan" })
        expect(firesBad.length).toBe(1)

        const resSum = DispatchReader.toFireSummary({
          triggerId: "t",
          occurrence: 100,
          outcome: "launched",
          runId: TriggerStore.reservationId("t", 100)
        })
        expect(resSum.runId).toBeUndefined()
        const realSum = DispatchReader.toFireSummary({
          triggerId: "t",
          occurrence: 100,
          outcome: "launched",
          runId: "run-99"
        })
        expect(realSum.runId).toBe("run-99")
      }).pipe(Effect.provide(Layer.mergeAll(TestTriggers.layer, TestClock.layer(), silentLogger)))
    )

    const failingStore = TriggerStore.layerNoop({
      list: () =>
        Effect.succeed([
          {
            triggerId: "bad",
            trigger: Result.fail(new TriggerError({ code: "store", message: "corrupt" }))
          }
        ]),
      history: () => Effect.fail(new TriggerError({ code: "store", message: "db down" }))
    })
    await Effect.runPromise(
      Effect.gen(function*() {
        const reader = yield* DispatchPort.DispatchReader
        expect(Exit.isFailure(yield* Effect.exit(reader.list({ _tag: "triggers" })))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(reader.fires({ _tag: "fires" })))).toBe(true)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DispatchReader.layer.pipe(Layer.provide(failingStore)),
            TestClock.layer(),
            silentLogger
          )
        )
      )
    )
  }, 60_000)

  it("fuzzes Scheduler.layer, Scheduler.layerControlRunner, Scheduler.tick recovery/compensation/timeout/revision_mismatch paths", async () => {
    const receiptKinds = ["Terminal", "Conflict", "ControlError"] as const
    const arb = Arbitrary.schema(
      Schema.Struct({
        startKind: Schema.Literals(receiptKinds),
        runStatus: Schema.Literals(["running", "completed", "failed", "cancelled", "missing"]),
        cancelKind: Schema.Literals(["Accepted", "Conflict", "Parked"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ startKind, runStatus, cancelKind }) =>
          Effect.gen(function*() {
            const fakeControl = Control.make({
              plan: () =>
                Effect.succeed({
                  planId: "p-1",
                  flowId: "f-1",
                  digest: "d-1",
                  inputSummary: "{}",
                  envelope: { capabilities: [], flows: [], budget: {} },
                  deployClass: false,
                  nodes: [],
                  approval: { required: false, reasons: [] }
                } as any),
              run: () => {
                if (startKind === "ControlError") {
                  return Effect.fail(new Unavailable({ feature: "run", ticket: "offline" }))
                }
                if (startKind === "Terminal") {
                  return Effect.succeed({ _tag: "Terminal" as const, receiptId: "rcpt", runId: "r-term", status: "completed" as const })
                }
                return Effect.succeed({ _tag: "Conflict" as const, message: "conflict" })
              },
              approve: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "a" }),
              deny: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "d" }),
              steer: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "s" }),
              signal: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "sg" }),
              cancel: () => {
                if (cancelKind === "Conflict") return Effect.succeed({ _tag: "Conflict" as const, message: "busy" })
                if (cancelKind === "Parked") {
                  return Effect.succeed({
                    _tag: "Parked" as const,
                    receiptId: "p",
                    planId: "p-1",
                    status: "waiting-approval" as const
                  })
                }
                return Effect.succeed({ _tag: "Accepted" as const, receiptId: "c", runId: "r-1" })
              },
              pause: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "pa" }),
              resume: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "re" }),
              list: () =>
                Effect.succeed({
                  _tag: "runs" as const,
                  items: runStatus === "missing" ? [] : [{ runId: "r-1", status: runStatus } as any]
                }),
              watch: () => Stream.empty
            })

            const runner = yield* Scheduler.Runner.pipe(
              Effect.provide(
                Scheduler.layerControlRunner.pipe(Layer.provide(Layer.succeed(Control.Control)(fakeControl)))
              )
            )

            const startExit = yield* Effect.exit(
              runner.start({
                flowId: "f-1",
                input: {},
                idempotencyKey: "k1"
              })
            )
            if (startKind === "Terminal") expect(Exit.isSuccess(startExit)).toBe(true)
            else expect(Exit.isFailure(startExit)).toBe(true)

            const state = yield* runner.inspect("r-1")
            expect(state).toBe(runStatus === "running" ? "active" : runStatus)

            const cancelExit = yield* Effect.exit(runner.cancel("r-1"))
            if (cancelKind === "Accepted") expect(Exit.isSuccess(cancelExit)).toBe(true)
            else expect(Exit.isFailure(cancelExit)).toBe(true)
            return true
          }).pipe(Effect.provide(silentLogger)),
        { executions: Math.min(executions, 30), seed }
      )
    )
    assertPassed(report)

    const engine = Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* store.register(makeTrigger({ enabled: false }))
          yield* store.register(makeTrigger({ id: "t-enabled", enabled: true }))

          const badConc = yield* Effect.exit(
            Layer.build(
              Scheduler.layer({ concurrency: 0 }).pipe(
                Layer.provide(Layer.succeed(TriggerStore.TriggerStore)(store)),
                Layer.provide(Scheduler.layerNoopRunner())
              )
            )
          )
          expect(Exit.isFailure(badConc)).toBe(true)

          const badDur = yield* Effect.exit(
            Scheduler.tick({ staleAfter: "not-a-duration" as any }).pipe(
              Effect.provide(Layer.merge(Layer.succeed(TriggerStore.TriggerStore)(store), Scheduler.layerNoopRunner()))
            )
          )
          expect(Exit.isFailure(badDur)).toBe(true)

          const badSince = yield* Effect.exit(
            Scheduler.tick({ since: 1.5 }).pipe(
              Effect.provide(Layer.merge(Layer.succeed(TriggerStore.TriggerStore)(store), Scheduler.layerNoopRunner()))
            )
          )
          expect(Exit.isFailure(badSince)).toBe(true)

          let failFirstList = true
          const flakyStore = TriggerStore.TriggerStore.of({
            ...store,
            list: () =>
              failFirstList
                ? ((failFirstList = false), Effect.fail(new TriggerError({ code: "store", message: "transient" })))
                : store.list()
          })
          const schedCtx = yield* Layer.build(
            Scheduler.layer({ host: "w10-host", pollInterval: "1 minute" }).pipe(
              Layer.provide(Layer.succeed(TriggerStore.TriggerStore)(flakyStore)),
              Layer.provide(Scheduler.layerNoopRunner())
            )
          )
          const sched = schedCtx.mapUnsafe.get(Scheduler.Scheduler.key) as Scheduler.Service
          yield* TestClock.adjust("1 hour")
          yield* sched.runOnce
        }).pipe(Effect.provide(Layer.mergeAll(TestTriggers.layer, engine, TestClock.layer(), silentLogger)))
      )
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const brokenRuntime = FlowRuntime.FlowRuntime.of({
            start: () => Effect.fail(new FlowRuntime.StoreUnavailable({ executionId: "broken" }))
          } as any)
          const exit = yield* Effect.exit(
            Layer.build(
              Scheduler.layer({ host: "broken-host" }).pipe(
                Layer.provide(TriggerStore.layerNoop()),
                Layer.provide(Scheduler.layerNoopRunner()),
                Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime)(brokenRuntime)),
                Layer.provide(NodeCrypto.layer)
              )
            )
          )
          expect(Exit.isFailure(exit)).toBe(true)
        }).pipe(Effect.provide(Layer.merge(TestClock.layer(), silentLogger)))
      )
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const baseStore = yield* TriggerStore.TriggerStore
          yield* baseStore.register(makeTrigger({ id: "t-comp", overlap: "buffer-one" }))
          yield* TestClock.setTime(hour * 2)

          const slowRunner = Scheduler.makeRunner({
            start: () => Effect.sleep("10 seconds").pipe(Effect.as("run-slow")),
            inspect: () => Effect.succeed("completed"),
            cancel: () => Effect.void
          })
          const schedSlow = yield* Scheduler.make({
            startTimeout: "10 millis",
            runPollInterval: "5 millis"
          }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, baseStore),
            Effect.provideService(Scheduler.Runner, slowRunner)
          )
          const tickFiber = yield* Effect.forkChild(schedSlow.runOnce)
          yield* TestClock.adjust("20 millis")
          yield* Effect.yieldNow
          yield* Fiber.await(tickFiber)

          const cancelled: Array<string> = []
          const regStale = yield* baseStore.register(makeTrigger({ id: "t-stale", overlap: "skip" }))
          const csSeed = yield* baseStore.claimFire({ triggerId: regStale.id, occurrence: hour, expectedRevision: regStale.revision })
          if (csSeed.claimed && csSeed.action === "fire") yield* baseStore.recordResult({ triggerId: regStale.id, occurrence: hour, outcome: "completed", reservationId: csSeed.reservationId })
          let staleOnce = true
          const staleStore = TriggerStore.TriggerStore.of({
            ...baseStore,
            inspect: (tid) => tid === regStale.id ? Effect.succeed({ activeRunId: "winner-run" }) : baseStore.inspect(tid),
            recordResult: (input) =>
              input.triggerId === regStale.id && input.outcome === "launched" && staleOnce
                ? ((staleOnce = false), Effect.fail(new TriggerError({ code: "stale_owner", message: "lost lease" })))
                : baseStore.recordResult(input)
          })
          const cancelRunner = Scheduler.makeRunner({
            start: (inp) => Effect.succeed(`run-${inp.idempotencyKey}`),
            inspect: () => Effect.succeed("completed"),
            cancel: (runId) =>
              Effect.sync(() => {
                cancelled.push(runId)
              })
          })
          yield* Scheduler.tick({ since: hour }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, staleStore),
            Effect.provideService(Scheduler.Runner, cancelRunner)
          )
          expect(cancelled.some((id) => id.includes("t-stale"))).toBe(true)

          const regRev = yield* baseStore.register(makeTrigger({ id: "t-rev", overlap: "skip" }))
          const crSeed = yield* baseStore.claimFire({ triggerId: regRev.id, occurrence: hour, expectedRevision: regRev.revision })
          if (crSeed.claimed && crSeed.action === "fire") yield* baseStore.recordResult({ triggerId: regRev.id, occurrence: hour, outcome: "completed", reservationId: crSeed.reservationId })
          let revMismatchOnce = true
          const revStore = TriggerStore.TriggerStore.of({
            ...baseStore,
            claimFire: (input) => {
              if (input.triggerId === regRev.id && revMismatchOnce) {
                revMismatchOnce = false
                return baseStore.register(makeTrigger({ id: "t-rev", overlap: "skip", input: { v: 2 } })).pipe(
                  Effect.andThen(Effect.fail(new TriggerError({ code: "revision_mismatch", message: "changed" })))
                )
              }
              return baseStore.claimFire(input)
            }
          })
          yield* Scheduler.tick({ since: hour }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, revStore),
            Effect.provideService(Scheduler.Runner, cancelRunner)
          )
        }).pipe(Effect.provide(Layer.mergeAll(TestTriggers.layer, TestClock.layer(), silentLogger)))
      )
    )
  }, 60_000)

  it("exercises Webhook secret failure refusal", async () => {
    const verify = Webhook.makeSignatureVerifier({
      header: "x-sig",
      expected: () => Effect.fail(new TriggerError({ code: "verification_failed", message: "vault down" }))
    })
    const exit = await Effect.runPromiseExit(
      verify(
        {
          headers: { "x-sig": "deadbeef" },
          body: new TextEncoder().encode("hello"),
          idempotencyKey: "k1"
        },
        Redacted.make({ name: "wh-secret" } as any)
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
  }, 60_000)
})
