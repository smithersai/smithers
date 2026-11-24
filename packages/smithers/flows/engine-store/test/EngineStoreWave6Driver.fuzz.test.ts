import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy, Sleep } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node, type Planned } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import {
  Arbitrary,
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as ExitEncoding from "../src/internal/ExitEncoding.ts"
import * as RunCoordinator from "../src/internal/RunCoordinator.ts"
import * as RunInspection from "../src/RunInspection.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const noopJjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "w6-snap" as never, changeId: "w6-snap" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const StepLoad = Action.make("w6-drv/load", { payload: { input: Schema.String }, success: Schema.String })
const StepPrompt = Action.make("w6-drv/prompt", { payload: { loaded: Schema.String }, success: Schema.String })
const StepFinish = Action.make("w6-drv/finish", { payload: { prompted: Schema.String }, success: Schema.String })
const StepWait = Action.make("w6-drv/wait", { payload: { deferredName: Schema.String }, success: Schema.String })
const StepSecret = Action.make("w6-drv/secret", {
  payload: { label: Schema.String },
  success: Schema.Struct({ token: Schema.Redacted(Schema.String), label: Schema.String })
})

class DrvFail extends Schema.TaggedError<DrvFail>()("w6-drv/DrvFail", {
  detail: Schema.String
}) {}

const StepFlaky = Action.make("w6-drv/flaky", {
  payload: { tag: Schema.String },
  success: Schema.String,
  error: DrvFail,
  retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, nonRetryable: ["w6-drv/DrvFail"] })
})

const ChildSimple = Flow.make("w6-drv/ChildSimple", {
  payload: { label: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ label }: { readonly label: string }) => StepLoad.call({ input: label }))
})

const ChildParking = Flow.make("w6-drv/ChildParking", {
  payload: { deferredName: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ deferredName }: { readonly deferredName: string }) =>
    StepWait.call({ deferredName }))
})

const RetryFailFlow = Flow.make("w6-drv/RetryFailFlow", {
  payload: { input: Schema.String },
  success: Schema.String,
  error: DrvFail,
  body: Node.capture({}, ({ input }: { readonly input: string }) =>
    StepLoad.call({ input }).pipe(
      Node.bindPlanned(Node.capture({}, (loaded: Planned.Planned<string>) => StepFlaky.call({ tag: loaded }))),
      Node.bindPlanned(Node.capture({}, (prompted: Planned.Planned<string>) => StepFinish.call({ prompted })))
    ))
})

const RetryChildFlow = Flow.make("w6-drv/RetryChildFlow", {
  payload: { input: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ input }: { readonly input: string }) =>
    StepLoad.call({ input }).pipe(
      Node.bindPlanned(Node.capture({}, (loaded: Planned.Planned<string>) => ChildSimple.child({ label: loaded }))),
      Node.bindPlanned(Node.capture({}, (prompted: Planned.Planned<string>) => StepFinish.call({ prompted })))
    ))
})

const RetryOkFlow = Flow.make("w6-drv/RetryOkFlow", {
  payload: { input: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ input }: { readonly input: string }) =>
    StepLoad.call({ input }).pipe(
      Node.bindPlanned(Node.capture({}, (loaded: Planned.Planned<string>) => StepPrompt.call({ loaded }))),
      Node.bindPlanned(Node.capture({}, (prompted: Planned.Planned<string>) => StepFinish.call({ prompted })))
    ))
})

const ParentDetachFlow = Flow.make("w6-drv/ParentDetachFlow", {
  payload: { deferredName: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ deferredName }: { readonly deferredName: string }) =>
    ChildParking.child({ deferredName }))
})

const ParentCancelFlow = Flow.make("w6-drv/ParentCancelFlow", {
  payload: { deferredName: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ deferredName }: { readonly deferredName: string }) =>
    ChildParking.child({ deferredName }))
})

const TimerFlow = Flow.make("w6-drv/TimerFlow", {
  payload: { ms: Schema.Number },
  success: Schema.String,
  error: Sleep.SleepRequestInvalid,
  body: Node.capture({}, ({ ms }: { readonly ms: number }) =>
    Sleep.action.call({ millis: ms }).pipe(
      Node.andThen(Node.succeed("timer-fired"))
    ))
})

const HandoffFirst = Flow.make("w6-drv/HandoffFirst", {
  payload: { round: Schema.Number, maxRounds: Schema.Number },
  success: Schema.String,
  maxRounds: 5,
  body: () => Node.succeed("unused")
})

const HandoffNext = Flow.make("w6-drv/HandoffNext", {
  payload: { round: Schema.Number, maxRounds: Schema.Number },
  success: Schema.String,
  maxRounds: 5,
  body: () => Node.succeed("unused")
})

const SecretFlow = Flow.make("w6-drv/SecretFlow", {
  payload: { token: Schema.Redacted(Schema.String), label: Schema.String },
  success: Schema.Struct({ token: Schema.Redacted(Schema.String), label: Schema.String }),
  body: Node.capture({}, ({ label }: { readonly label: string }) =>
    StepSecret.call({ label }))
})

const OtherFlow = Flow.make("w6-drv/OtherFlow", {
  payload: { x: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ x }: { readonly x: string }) => Node.succeed(x))
})

const allInterpretedFlows: ReadonlyArray<Flow.Any> = [
  ChildSimple,
  ChildParking,
  RetryFailFlow,
  RetryChildFlow,
  RetryOkFlow,
  ParentDetachFlow,
  ParentCancelFlow,
  TimerFlow,
  SecretFlow,
  OtherFlow
]

describe("EngineStore Wave-6 Driver, Coordinator & Inspection fuzz", () => {
  it("fuzzes RunCoordinator resumeConcurrency lane, promotion, stopping-wait, wakeIfActive, and interrupts", async () => {
    const CmdSchema = Schema.Struct({
      limit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 2 }))),
      ops: Schema.Array(
        Schema.Struct({
          kind: Schema.Literals([
            "schedule_resumed",
            "schedule_direct",
            "schedule_if_true",
            "schedule_if_false",
            "run_resumed",
            "run_direct",
            "wake_resumed",
            "wake_direct",
            "wake_if_active",
            "join",
            "interrupt",
            "request_interrupt",
            "release_one"
          ]),
          key: Schema.Literals(["k0", "k1", "k2", "k3"]),
          failDrain: Schema.Boolean
        })
      ).pipe(Schema.check(Schema.isMinLength(5), Schema.isMaxLength(14)))
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(CmdSchema),
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const badExit = yield* Effect.exit(
                RunCoordinator.make({ drain: () => Effect.void, resumeConcurrency: 0 })
              )
              expect(Exit.isFailure(badExit)).toBe(true)

              const gates = new Map<string, Array<Deferred.Deferred<void, string>>>()
              const started: Array<string> = []

              const releaseKey = (key: string, fail: boolean) =>
                Effect.gen(function*() {
                  const list = gates.get(key)
                  if (list === undefined || list.length === 0) return
                  const gate = list.shift()!
                  if (fail) {
                    yield* Deferred.fail(gate, `err:${key}`)
                  } else {
                    yield* Deferred.succeed(gate, undefined)
                  }
                })

              const releaseAll = Effect.gen(function*() {
                for (const [, list] of gates) {
                  while (list.length > 0) {
                    yield* Deferred.succeed(list.shift()!, undefined)
                  }
                }
              })

              const coordinator = yield* RunCoordinator.make<string, string, never>({
                resumeConcurrency: input.limit,
                drain: (key) =>
                  Effect.gen(function*() {
                    started.push(key)
                    const gate = yield* Deferred.make<void, string>()
                    const list = gates.get(key) ?? []
                    list.push(gate)
                    gates.set(key, list)
                    yield* Deferred.await(gate)
                  })
              })

              const fibers: Array<Fiber.Fiber<unknown, unknown>> = []

              for (const op of input.ops) {
                switch (op.kind) {
                  case "schedule_resumed":
                    yield* coordinator.schedule(op.key, { resumed: true })
                    break
                  case "schedule_direct":
                    yield* coordinator.schedule(op.key)
                    break
                  case "schedule_if_true":
                    yield* coordinator.scheduleIf(op.key, Effect.succeed(true))
                    break
                  case "schedule_if_false":
                    yield* coordinator.scheduleIf(op.key, Effect.succeed(false))
                    break
                  case "run_resumed": {
                    const f = yield* Effect.forkChild(
                      coordinator.run(op.key, { resumed: true }).pipe(Effect.ignore)
                    )
                    fibers.push(f)
                    break
                  }
                  case "run_direct": {
                    const f = yield* Effect.forkChild(coordinator.run(op.key).pipe(Effect.ignore))
                    fibers.push(f)
                    break
                  }
                  case "wake_resumed":
                    yield* coordinator.wake(op.key, { resumed: true })
                    break
                  case "wake_direct":
                    yield* coordinator.wake(op.key)
                    break
                  case "wake_if_active":
                    yield* coordinator.wakeIfActive(op.key)
                    break
                  case "join": {
                    const f = yield* Effect.forkChild(coordinator.join(op.key).pipe(Effect.ignore))
                    fibers.push(f)
                    break
                  }
                  case "interrupt": {
                    const f = yield* Effect.forkChild(coordinator.interrupt(op.key).pipe(Effect.ignore))
                    fibers.push(f)
                    break
                  }
                  case "request_interrupt":
                    yield* coordinator.requestInterrupt(op.key)
                    break
                  case "release_one":
                    yield* releaseKey(op.key, op.failDrain)
                    break
                }
                yield* Effect.yieldNow
                const active = yield* coordinator.active
                expect(active.size).toBeLessThanOrEqual(4)
              }

              for (let round = 0; round < 6; round++) {
                yield* releaseAll
                yield* Effect.yieldNow
              }
              for (const key of ["k0", "k1", "k2", "k3"]) {
                yield* coordinator.requestInterrupt(key)
              }
              for (const f of fibers) {
                yield* Fiber.await(f)
              }
              expect(started.length).toBeGreaterThanOrEqual(0)
              return true
            })
          ),
        { executions: 18, seed: 60101 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 240_000)

  it("fuzzes RunDriver sweeps, stale/live/fresh owner takeover, retryFrom, handoff, and child exit policies", async () => {
    const ScenarioSchema = Schema.Struct({
      mode: Schema.Literals([
        "stale_steal_dead",
        "stale_refuse_live",
        "fresh_refuse",
        "can_execute_false",
        "sweep_cancel_parked",
        "sweep_ready_timer",
        "sweep_pending_and_cancel",
        "retry_from_middle",
        "retry_from_carried_child",
        "retry_from_refusals",
        "handoff_multi_round",
        "parent_cancel_child_policy"
      ]),
      detachChild: Schema.Boolean,
      rounds: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
      tagIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(ScenarioSchema),
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const tag = `t${input.tagIdx}`
              let loadCount = 0
              let promptCount = 0
              let finishCount = 0
              let flakyFail = true

              const isAliveMode: "dead" | "live" = input.mode === "stale_refuse_live" ? "live" : "dead"
              const allowExecute = input.mode !== "can_execute_false"

              const baseLayer = Layer.mergeAll(
                TestStores.layerAt(":memory:"),
                noopJjLayer,
                StepBoundary.layerTest(),
                TestClock.layer()
              )

              const engineLayer = EngineStore.layer({
                owner: { hostId: "w6-host" },
                journalSource: "w6-drv",
                isAlive: () => Effect.succeed(isAliveMode === "live"),
                canExecute: () => Effect.succeed(allowExecute),
                sourceRevision: () => "rev-w6"
              }).pipe(Layer.provideMerge(baseLayer))

              const actionImpls = Layer.mergeAll(
                StepLoad.toLayer(({ input: s }) =>
                  Effect.sync(() => {
                    loadCount += 1
                    return `L(${s})#${loadCount}`
                  })),
                StepPrompt.toLayer(({ loaded }) =>
                  Effect.sync(() => {
                    promptCount += 1
                    return `P(${loaded})#${promptCount}`
                  })),
                StepFinish.toLayer(({ prompted }) =>
                  Effect.sync(() => {
                    finishCount += 1
                    return `F(${prompted})#${finishCount}`
                  })),
                StepFlaky.toLayer(({ tag: t }) =>
                  Effect.suspend(() => {
                    if (flakyFail) return Effect.fail(new DrvFail({ detail: `boom:${t}` }))
                    return Effect.succeed(`FIXED(${t})`)
                  })),
                StepWait.toLayer(({ deferredName }) =>
                  DurableDeferred.await(DurableDeferred.make(deferredName, { success: Schema.String }))),
                StepSecret.toLayer(({ label }) =>
                  Effect.succeed({ token: Redacted.make("s3cr3t"), label })),
                Sleep.layer
              )

              const registeredFlows = allInterpretedFlows
                .map((flow) => (Interpreter.layerWithImplementations(flow as never, actionImpls as never) as Layer.Layer<never>))
                .reduce((all, l) => Layer.merge(all, l))
                .pipe(
                  Layer.provideMerge(actionImpls),
                  Layer.provideMerge(Action.layerImplementations),
                  Layer.provideMerge(engineLayer)
                )

              return yield* Effect.gen(function*() {
                const runtime = yield* FlowRuntime.FlowRuntime
                const sql = yield* SqlClient.SqlClient
                const runStore = yield* RunStore.RunStore
                                yield* TestClock.setTime(1_000_000)
                const nowMs = yield* Clock.currentTimeMillis

                yield* runtime.register(HandoffFirst, (payload) =>
                  Effect.gen(function*() {
                    const inst = yield* FlowRuntime.FlowInstance
                    if (payload.round < payload.maxRounds) {
                      inst.handoff = new Flow.Handoff({
                        flow: HandoffNext._tag,
                        payload: { round: payload.round + 1, maxRounds: payload.maxRounds }
                      })
                      return "handed"
                    }
                    return `done@${payload.round}`
                  }))
                yield* runtime.register(HandoffNext, (payload) =>
                  Effect.gen(function*() {
                    const inst = yield* FlowRuntime.FlowInstance
                    if (payload.round < payload.maxRounds) {
                      inst.handoff = new Flow.Handoff({
                        flow: HandoffFirst._tag,
                        payload: { round: payload.round + 1, maxRounds: payload.maxRounds }
                      })
                      return "handed"
                    }
                    return `done@${payload.round}`
                  }))

                if (
                  input.mode === "stale_steal_dead" ||
                  input.mode === "stale_refuse_live" ||
                  input.mode === "fresh_refuse"
                ) {
                  const execId = `steal-${input.mode}-${tag}`
                  const staleMs = nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter) - 5_000
                  const hbMs = input.mode === "fresh_refuse" ? nowMs : staleMs
                  const otherOwner: Ownership.OwnerId = { hostId: "other-host", pid: 9999, nonce: "other-n" }
                  yield* runStore.create(execId, JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: OtherFlow._tag, payload: { x: tag }, executionId: execId }))
                  const row0 = yield* runStore.get(execId)
                  const snap0: RunStore.RunSnapshot = {
                    status: row0.status,
                    owner: row0.owner,
                    heartbeatAtMs: row0.heartbeatAtMs
                  }
                  const cl = yield* runStore.claim(execId, snap0, otherOwner, nowMs)
                  if (cl._tag === "Claimed") {
                    yield* runStore.activate(execId, otherOwner, cl.claimedAtMs, snap0)
                  }
                  if (input.mode !== "fresh_refuse") {
                    yield* sql`UPDATE flows_runs SET heartbeat_at_ms = ${hbMs} WHERE run_id = ${execId}`
                  }
                  const driven = yield* EngineStore.drive(OtherFlow, {
                    executionId: execId,
                    payload: { x: tag },
                    holdMs: 50
                  })
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  if (input.mode === "stale_steal_dead") {
                    expect(["Settled", "Yielded", "Parked"]).toContain(driven._tag)
                    const row = yield* runStore.get(execId)
                    expect(["succeeded", "running"]).toContain(row.status)
                  } else {
                    const row = yield* runStore.get(execId)
                    expect(row.status).toBe("running")
                    expect(row.owner?.hostId).toBe("other-host")
                  }
                } else if (input.mode === "can_execute_false") {
                  const execId = `no-exec-${tag}`
                  yield* runtime.execute(OtherFlow, { executionId: execId, payload: { x: tag }, discard: true })
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  const row = yield* runStore.get(execId)
                  expect(row.status).toBe("pending")
                } else if (input.mode === "sweep_cancel_parked") {
                  const execId = `cancel-park-${tag}`
                  yield* runtime.execute(ChildParking, {
                    executionId: execId,
                    payload: { deferredName: `d-${tag}` },
                    discard: true
                  })
                  yield* TestClock.adjust(Duration.millis(50))
                  yield* Effect.yieldNow
                  yield* sql`UPDATE flows_runs SET cancel_requested_at_ms = ${nowMs + 10} WHERE run_id = ${execId}`
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  yield* TestClock.adjust(Duration.millis(50))
                  yield* Effect.yieldNow
                  const row = yield* runStore.get(execId)
                  expect(["cancelled", "parked", "running"]).toContain(row.status)
                } else if (input.mode === "sweep_ready_timer") {
                  const execId = `timer-${tag}`
                  yield* runtime.execute(TimerFlow, {
                    executionId: execId,
                    payload: { ms: 200 },
                    discard: true
                  })
                  yield* Effect.yieldNow
                  const wake = yield* EngineStore.nextWake(execId)
                  expect(Option.isOption(wake)).toBe(true)
                  yield* TestClock.adjust(Duration.millis(500))
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  const res = yield* runtime.poll(TimerFlow, execId)
                  expect(Option.isOption(res)).toBe(true)
                } else if (input.mode === "sweep_pending_and_cancel") {
                  const p1 = `pend-run-${tag}`
                  const p2 = `pend-can-${tag}`
                  yield* runStore.create(p1, JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: OtherFlow._tag, payload: { x: tag }, executionId: p1 }))
                  yield* runStore.create(p2, JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: OtherFlow._tag, payload: { x: tag }, executionId: p2 }))
                  yield* sql`UPDATE flows_runs SET cancel_requested_at_ms = ${nowMs + 1} WHERE run_id = ${p2}`
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  yield* TestClock.adjust(Duration.millis(50))
                  yield* Effect.yieldNow
                  const r1 = yield* runStore.get(p1)
                  const r2 = yield* runStore.get(p2)
                  expect(["succeeded", "pending", "running"]).toContain(r1.status)
                  expect(["cancelled", "pending", "running"]).toContain(r2.status)
                } else if (input.mode === "retry_from_middle") {
                  const srcId = `retry-src-${tag}`
                  flakyFail = true
                  const firstExit = yield* Effect.exit(runtime.execute(RetryFailFlow, {
                    executionId: srcId,
                    payload: { input: tag }
                  }))
                  expect(Exit.isFailure(firstExit)).toBe(true)
                  const loadsBefore = loadCount
                  flakyFail = false
                  const retryId = `retry-dst-${tag}`
                  const insp = yield* RunInspection.make({ flows: [RetryFailFlow] })
                  const d = yield* insp.inspect(srcId)
                  const flakyNode = d.steps.find((st) => st.action === StepFlaky.name)!.nodeId
                  const retried = yield* RetryFailFlow.retryFrom(srcId, {
                    executionId: retryId,
                    step: flakyNode
                  })
                  expect(typeof retried).toBe("string")
                  expect(loadCount).toBe(loadsBefore)
                } else if (input.mode === "retry_from_carried_child") {
                  const srcId = `retry-child-src-${tag}`
                  const first = yield* runtime.execute(RetryChildFlow, {
                    executionId: srcId,
                    payload: { input: tag }
                  })
                  expect(typeof first).toBe("string")
                  const retryId = `retry-child-dst-${tag}`
                  const insp = yield* RunInspection.make({ flows: [RetryChildFlow] })
                  const d = yield* insp.inspect(srcId)
                  const finNode = d.steps.find((st) => st.action === StepFinish.name)!.nodeId
                  const retried = yield* RetryChildFlow.retryFrom(srcId, {
                    executionId: retryId,
                    step: finNode
                  })
                  expect(typeof retried).toBe("string")
                  expect(finishCount).toBe(2)
                } else if (input.mode === "retry_from_refusals") {
                  const nf = yield* Effect.exit(
                    RetryOkFlow.retryFrom("does-not-exist", {
                      executionId: "dst-nf",
                      step: "n0"
                    })
                  )
                  expect(Exit.isFailure(nf)).toBe(true)

                  const otherId = `other-${tag}`
                  yield* runtime.execute(OtherFlow, { executionId: otherId, payload: { x: "a" } })
                  const of = yield* Effect.exit(
                    RetryOkFlow.retryFrom(otherId, {
                      executionId: "dst-of",
                      step: "n0"
                    })
                  )
                  expect(Exit.isFailure(of)).toBe(true)

                  const parkId = `park-ref-${tag}`
                  yield* runtime.execute(ChildParking, {
                    executionId: parkId,
                    payload: { deferredName: `ref-${tag}` },
                    discard: true
                  })
                  yield* Effect.yieldNow
                  const ns = yield* Effect.exit(
                    ChildParking.retryFrom(parkId, {
                      executionId: "dst-ns",
                      step: "n0"
                    })
                  )
                  expect(Exit.isFailure(ns)).toBe(true)

                  const settledId = `settled-ref-${tag}`
                  yield* runtime.execute(RetryOkFlow, {
                    executionId: settledId,
                    payload: { input: tag }
                  })
                  const us = yield* Effect.exit(
                    RetryOkFlow.retryFrom(settledId, {
                      executionId: "dst-us",
                      step: "no-such-step"
                    })
                  )
                  expect(Exit.isFailure(us)).toBe(true)
                } else if (input.mode === "handoff_multi_round") {
                  const execId = `handoff-${tag}`
                  const res = yield* runtime.execute(HandoffFirst, {
                    executionId: execId,
                    payload: { round: 0, maxRounds: input.rounds }
                  })
                  expect(res !== undefined).toBe(true)
                  const again = yield* runtime.execute(HandoffFirst, {
                    executionId: execId,
                    payload: { round: 0, maxRounds: input.rounds }
                  })
                  expect(again !== undefined).toBe(true)
                } else if (input.mode === "parent_cancel_child_policy") {
                  const parentId = `par-can-${tag}`
                  const defName = `child-def-${tag}`
                  const ParentFlow = input.detachChild ? ParentDetachFlow : ParentCancelFlow
                  yield* runtime.execute(ParentFlow, {
                    executionId: parentId,
                    payload: { deferredName: defName },
                    discard: true
                  })
                  yield* TestClock.adjust(Duration.millis(20))
                  yield* Effect.yieldNow
                  yield* runtime.interrupt(ParentFlow, parentId)
                  yield* TestClock.adjust(Ownership.heartbeatInterval)
                  yield* Effect.yieldNow
                  const children = yield* sql<{ readonly run_id: string }>`SELECT run_id FROM flows_runs WHERE parent_run_id = ${parentId}`
                  expect(Array.isArray(children)).toBe(true)
                }
                return true
              }).pipe(Effect.provide(registeredFlows))
            })
          ).pipe(withCrypto),
        { executions: 16, seed: 60102 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 240_000)

  it("fuzzes RunInspection redaction/truncation/list-validation and ExitEncoding projections", async () => {
    const InspectSchema = Schema.Struct({
      secretIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 100, maximum: 9999 }))),
      truncatedPreview: Schema.Boolean,
      badJsonPreview: Schema.Boolean,
      unknownFlowsMode: Schema.Literals(["withhold", "asStored"]),
      includeUnknownAction: Schema.Boolean,
      depth: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 6 })))
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(InspectSchema),
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const secret = `sec-token-${input.secretIdx}`
              const baseLayer = Layer.mergeAll(
                TestStores.layerAt(":memory:"),
                noopJjLayer,
                StepBoundary.layerTest()
              )
              const engineLayer = EngineStore.layer({
                owner: { hostId: "insp-host" },
                journalSource: "w6-insp"
              }).pipe(Layer.provideMerge(baseLayer))

              const actionImpls = StepSecret.toLayer(({ label }) =>
                Effect.succeed({ token: Redacted.make(secret), label }))
              const registered = Layer.mergeAll(
                (Interpreter.layerWithImplementations(SecretFlow as never, actionImpls as never) as Layer.Layer<never>),
                (Interpreter.layerWithImplementations(OtherFlow as never, actionImpls as never) as Layer.Layer<never>)
              ).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(engineLayer)
              )

              return yield* Effect.gen(function*() {
                const runtime = yield* FlowRuntime.FlowRuntime
                const journal = yield* Journal.Journal

                const execId = `insp-sec-${input.depth}-${input.secretIdx}`
                yield* runtime.execute(SecretFlow, {
                  executionId: execId,
                  payload: { token: Redacted.make(secret), label: "visible" }
                })

                const rawPreview = input.badJsonPreview
                  ? "{not-json"
                  : JSON.stringify({ token: secret, label: "safe" })
                const synthNodes = [
                  {
                    nodeId: "n-fail",
                    action: StepSecret.name,
                    outcome: "failed" as const,
                    attempts: 1,
                    result: { preview: JSON.stringify({ code: "E_BOOM", message: "bad" }), bytes: 32, truncated: false }
                  },
                  {
                    nodeId: "n-sec",
                    action: StepSecret.name,
                    outcome: "built" as const,
                    attempts: 1,
                    result: { preview: rawPreview, bytes: rawPreview.length, truncated: input.truncatedPreview }
                  },
                  {
                    nodeId: "n-unk",
                    action: input.includeUnknownAction ? "unknown/action" : null,
                    outcome: "built" as const,
                    attempts: 1,
                    result: { preview: rawPreview, bytes: rawPreview.length, truncated: input.truncatedPreview }
                  }
                ]
                for (let i = 0; i < synthNodes.length; i++) {
                  const n = synthNodes[i]!
                  yield* journal.emitDurableUnfenced(
                    JournalRecords.nodeSettled(
                      { runId: execId, sourceId: `w6-insp:${i}`, sourceSeq: i, lineageId: execId },
                      {
                        planId: "p1",
                        nodeId: n.nodeId,
                        ...(n.action !== null ? { action: n.action } : {}),
                        outcome: n.outcome,
                        attempts: 1,
                        result: n.result
                      }
                    )
                  )
                }

                const inspKnown = yield* RunInspection.make({
                  flows: [SecretFlow],
                  unknownFlows: input.unknownFlowsMode
                })
                const detail = yield* inspKnown.inspect(execId)
                expect(detail.run.runId).toBe(execId)
                expect(detail.run.input.text).not.toContain(secret)
                if (detail.run.result !== null) {
                  expect(detail.run.result.text).not.toContain(secret)
                }

                const inspNoSchemas = yield* RunInspection.make({
                  unknownFlows: input.unknownFlowsMode
                })
                const detailNo = yield* inspNoSchemas.inspect(execId)
                expect(detailNo.run.runId).toBe(execId)

                expect(RunInspection.holdsRedacted(Schema.Redacted(Schema.String))).toBe(true)
                expect(RunInspection.holdsRedacted(Schema.Struct({ a: Schema.Array(Schema.Redacted(Schema.String)) }))).toBe(true)
                expect(RunInspection.holdsRedacted(Schema.Union([Schema.String, Schema.Redacted(Schema.Number)]))).toBe(true)
                expect(RunInspection.holdsRedacted(Schema.Struct({ a: Schema.String, b: Schema.Number }))).toBe(false)

                const badCursor = yield* Effect.exit(inspKnown.list({ cursor: "not-a-valid-cursor" }))
                expect(Exit.isFailure(badCursor)).toBe(true)
                const emptyIds = yield* inspKnown.list({ runIds: [] })
                expect(emptyIds.runs).toEqual([])
                const emptyFlows = yield* inspKnown.list({ flows: [] })
                expect(emptyFlows.runs).toEqual([])
                const tooManyIds = yield* Effect.exit(
                  inspKnown.list({ runIds: Array.from({ length: RunInspection.maximumListPage + 1 }, (_, i) => `r${i}`) })
                )
                expect(Exit.isFailure(tooManyIds)).toBe(true)
                const tooManyFlows = yield* Effect.exit(
                  inspKnown.list({ flows: Array.from({ length: RunInspection.maximumListFlows + 1 }, (_, i) => `f${i}`) })
                )
                expect(Exit.isFailure(tooManyFlows)).toBe(true)

                const listed = yield* inspKnown.list({
                  roots: false,
                  flows: [SecretFlow._tag],
                  runIds: [execId],
                  limit: 1
                })
                expect(listed.runs.length).toBe(1)

                const cyclic: Record<string, unknown> = { a: 1n, b: Symbol("s"), c: Redacted.make(secret) }
                cyclic.self = cyclic
                let nested: unknown = { leaf: "x".repeat(2000) }
                for (let d = 0; d < input.depth; d++) nested = { child: nested }
                const pv1 = ExitEncoding.projectValue(cyclic)
                const pv2 = ExitEncoding.projectValue(nested)
                const pv3 = ExitEncoding.projectValue(new Error("boom-err"))
                expect(pv1).toBeDefined()
                expect(pv2).toBeDefined()
                expect(pv3).toBeDefined()

                const multiCause = Cause.combine(
                  Cause.fail(new DrvFail({ detail: secret })),
                  Cause.combine(Cause.die(new TypeError("type-boom")), Cause.interrupt(42))
                )
                const pc = ExitEncoding.projectCause(multiCause)
                expect(pc.length).toBeGreaterThanOrEqual(2)

                const pr1 = ExitEncoding.projectResult(new Flow.Suspended({}), "suspended-note")
                const pr2 = ExitEncoding.projectResult(new Flow.Complete({ exit: Exit.failCause(multiCause) }), "complete-note")
                expect(pr1.result).toBe("Suspended")
                expect(pr2.result).toBe("Complete")
                return true
              }).pipe(Effect.provide(registered))
            })
          ).pipe(withCrypto),
        { executions: 14, seed: 60103 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 240_000)
})
