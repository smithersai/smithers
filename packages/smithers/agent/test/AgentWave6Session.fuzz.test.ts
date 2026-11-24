import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Control, ControlExecutor, ControlFacts, ControlLive, ControlRuntime, ControlSchema } from "@smthrs/control"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, WaitFor } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Jj from "@smthrs/jj"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { NodeRuntime } from "@smthrs/platform-node"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import {
  Arbitrary,
  Deferred,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
  Stream
} from "effect"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  Agent,
  AgentSession,
  Budget,
  type FlowEngineLike,
  RunawayGuard,
  ScriptedJudge,
  Seat,
  SeatResolver
} from "../src/index.ts"
import * as Safety from "./Safety.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "80"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const prepared: Route.PreparedRequest = {
  routeId: "route-w6",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const cellEvents = (source: string, id: string): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + source + "\n```" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
  ModelEvent.ModelEvent.Usage({ inputTokens: 10, outputTokens: 5 }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

const scratchDirs = new Set<string>()
const makeScratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.add(dir)
  return dir
}

afterAll(async () => {
  await Promise.all([...scratchDirs].map((dir) => rm(dir, { recursive: true, force: true })))
  scratchDirs.clear()
})

const awaitStatus = (
  runtime: ControlRuntime.Service,
  runId: string,
  status: ControlSchema.RunStatus,
  attempts = 4_000
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    const run = yield* runtime.getRun(runId)
    if (run.status === status) return
    if (attempts <= 0) return yield* Effect.die(`run ${runId} stuck at ${run.status}, expected ${status}`)
    yield* Effect.sleep("2 millis")
    return yield* awaitStatus(runtime, runId, status, attempts - 1)
  })

const awaitStatuses = (
  runtime: ControlRuntime.Service,
  runId: string,
  statuses: ReadonlyArray<ControlSchema.RunStatus>,
  attempts = 4_000
): Effect.Effect<ControlSchema.RunStatus, unknown> =>
  Effect.gen(function*() {
    const run = yield* runtime.getRun(runId)
    if (statuses.includes(run.status)) return run.status
    if (attempts <= 0) return yield* Effect.die(`run ${runId} stuck at ${run.status}, expected ${statuses.join("|")}`)
    yield* Effect.sleep("2 millis")
    return yield* awaitStatuses(runtime, runId, statuses, attempts - 1)
  })

describe("@smthrs/agent Wave-6 AgentSession deep fuzz invariants", () => {
  it("AgentSession.budgetParking, approvedEnvelope & timeoutParks over SQLite Journal + SqlControlRuntime", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scope: Schema.Literals(["tokens", "usd", "latency"]),
        decision: Schema.Literals(["approve", "deny", "pending"]),
        timeoutDecision: Schema.Literals(["continue-then-deny", "pending", "deny-first"]),
        onExceeded: Schema.Literals(["park", "fail"]),
        baseTokens: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 100, maximum: 5_000 }))),
        baseUsdCents: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
        baseMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1_000, maximum: 60_000 }))),
        timeoutLimitMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 500, maximum: 30_000 })))
      })
    )
    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scope, decision, timeoutDecision, onExceeded, baseTokens, baseUsdCents, baseMs, timeoutLimitMs }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const idx = ++seq
              let runId = `budget-run-${idx}`
              const baseUsd = baseUsdCents / 100
              const stores = TestStores.layerAt(":memory:").pipe(Layer.provideMerge(NodeCrypto.layer))
              const runtimeLayer = SqlControlRuntime.layer({
                flows: [{
                  flowId: "budget/test",
                  executionDigest: "a".repeat(64),
                  description: "budget test flow",
                  deployClass: false,
                  envelope: { capabilities: [], flows: [], budget: {} }
                }]
              }).pipe(Layer.provideMerge(stores))

              return yield* Effect.gen(function*() {
                const journal = yield* Journal.Journal
                const runtime = yield* ControlRuntime.ControlRuntime
                const principal = yield* runtime.stampPrincipal()
                const { card: bCard } = yield* runtime.plan({ flowId: "budget/test", input: {} })
                const bTok = yield* runtime.lookupApproval(bCard.approval.target)
                yield* runtime.resolveApproval(bTok, "approved", principal)
                const bLaunched = yield* runtime.launch(bCard.planId, bCard.digest, bCard.envelope)
                if (bLaunched._tag !== "Started") throw new Error("expected Started")
                runId = bLaunched.run.runId

                const baseEnvelope: ControlSchema.Envelope = {
                  capabilities: [],
                  flows: [],
                  budget: {
                    tokens: baseTokens,
                    usd: baseUsd,
                    milliseconds: baseMs,
                    onExceeded
                  }
                }
                const parking = AgentSession.budgetParking(journal, runtime)(runId, baseEnvelope)
                if (parking.guardsTimeouts !== (onExceeded === "park")) return false

                // 1) Budget park() for tokens/usd/milliseconds
                const max = scope === "tokens" ? baseTokens : scope === "usd" ? baseUsd : baseMs
                const exceeded = new Budget.BudgetExceeded({
                  scope,
                  used: max + 10,
                  max,
                  next: max + 10,
                  onExceeded: "park",
                  message: `${scope} budget exceeded`
                })
                const firstPark = yield* parking.park(exceeded)
                if (firstPark.waiting.reason !== "budget") return false
                const requestId = firstPark.waiting.token!
                if (!requestId.includes(runId)) return false

                // Re-parking while pending reuses recorded approval fact idempotently
                const secondPark = yield* parking.park(exceeded)
                if (secondPark.waiting.token !== requestId) return false

                const beforeRaise = yield* AgentSession.approvedEnvelope(journal, runId, baseEnvelope)
                if (beforeRaise.budget.tokens !== baseTokens) return false

                const entries = (yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 })).entries
                const reqEntry = entries.find((e) => e.eventType === "control.approval.requested")
                if (reqEntry === undefined) return false
                const reqFact = Schema.decodeUnknownSync(ControlFacts.ApprovalRequestFact)(reqEntry.payload)
                const token = yield* runtime.lookupApproval(reqFact.payload.target)

                if (decision === "approve") {
                  yield* runtime.resolveApproval(token, "approved", principal)
                  yield* journal.emitDurableUnfenced(
                    new JournalEvent.Input({
                      runId: JournalEvent.RunId.make(runId),
                      sourceId: JournalEvent.SourceId.make("/control/test"),
                      sourceSeq: JournalEvent.SourceSeq.make(1),
                      eventType: "control.approval.approved",
                      payload: ControlFacts.approvalDecisionFact(token.tokenId, reqFact.payload.target)
                    })
                  )
                  const raised = yield* AgentSession.approvedEnvelope(journal, runId, baseEnvelope)
                  const raisedVal = scope === "tokens"
                    ? raised.budget.tokens!
                    : scope === "usd"
                    ? raised.budget.usd!
                    : raised.budget.milliseconds!
                  if (!(raisedVal > max)) return false

                  // Re-parking on already-approved token returns HarnessError(model_failed)
                  const afterApprove = yield* Effect.result(parking.park(exceeded))
                  if (!Result.isFailure(afterApprove)) return false
                } else if (decision === "deny") {
                  yield* runtime.resolveApproval(token, "denied", principal)
                  const afterDeny = yield* Effect.result(parking.park(exceeded))
                  if (!Result.isFailure(afterDeny)) return false
                }

                // 2) Timeout trip() and admit() across ordinals
                const subject = `tool/exec/${idx}`
                const initialAdmit = yield* parking.admit(subject)
                if (initialAdmit._tag !== "proceed" || initialAdmit.continued !== 0) return false

                const timeout = new RunawayGuard.Timeout({
                  source: "tool-call",
                  subject,
                  limitMillis: timeoutLimitMs,
                  message: `Tool ${subject} timed out.`
                })
                const tripped1 = yield* parking.trip(timeout)
                const tReq1 = tripped1.waiting.token!
                if (!tReq1.endsWith("/1")) return false

                // Re-tripping while pending reuses ordinal 1
                const tripped1Again = yield* parking.trip(timeout)
                if (tripped1Again.waiting.token !== tReq1) return false

                // admit() while pending returns _tag: "park"
                const pendingAdmit = yield* parking.admit(subject)
                if (pendingAdmit._tag !== "park") return false

                const tEntries = (yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 })).entries
                const tReqEntry = tEntries.find((e) => {
                  if (e.eventType !== "control.approval.requested") return false
                  const parsed = Schema.decodeUnknownOption(ControlFacts.ApprovalRequestFact)(e.payload)
                  return Option.isSome(parsed) && parsed.value.requestId === tReq1
                })
                if (tReqEntry === undefined) return false
                const tReqFact = Schema.decodeUnknownSync(ControlFacts.ApprovalRequestFact)(tReqEntry.payload)
                const tTok1 = yield* runtime.lookupApproval(tReqFact.payload.target)

                if (timeoutDecision === "deny-first") {
                  yield* runtime.resolveApproval(tTok1, "denied", principal)
                  yield* journal.emitDurableUnfenced(
                    new JournalEvent.Input({
                      runId: JournalEvent.RunId.make(runId),
                      sourceId: JournalEvent.SourceId.make("/control/test"),
                      sourceSeq: JournalEvent.SourceSeq.make(10),
                      eventType: "control.approval.denied",
                      payload: ControlFacts.approvalDecisionFact(tTok1.tokenId, tReqFact.payload.target)
                    })
                  )
                  const p2 = AgentSession.budgetParking(journal, runtime)(runId, baseEnvelope)
                  const deniedAdmit = yield* Effect.result(p2.admit(subject))
                  const deniedTrip = yield* Effect.result(p2.trip(timeout))
                  if (!Result.isFailure(deniedAdmit) || !Result.isFailure(deniedTrip)) return false
                } else if (timeoutDecision === "continue-then-deny") {
                  yield* runtime.resolveApproval(tTok1, "approved", principal)
                  yield* journal.emitDurableUnfenced(
                    new JournalEvent.Input({
                      runId: JournalEvent.RunId.make(runId),
                      sourceId: JournalEvent.SourceId.make("/control/test"),
                      sourceSeq: JournalEvent.SourceSeq.make(11),
                      eventType: "control.approval.approved",
                      payload: ControlFacts.approvalDecisionFact(tTok1.tokenId, tReqFact.payload.target)
                    })
                  )
                  const p2 = AgentSession.budgetParking(journal, runtime)(runId, baseEnvelope)
                  const afterContinue = yield* p2.admit(subject)
                  if (afterContinue._tag !== "proceed" || afterContinue.continued !== 1) return false

                  // Second timeout allocates ordinal 2
                  const tripped2 = yield* p2.trip(timeout)
                  const tReq2 = tripped2.waiting.token!
                  if (!tReq2.endsWith("/2") || tReq2 === tReq1) return false

                  const tEntries2 = (yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 })).entries
                  const tReqEntry2 = tEntries2.find((e) => {
                    if (e.eventType !== "control.approval.requested") return false
                    const parsed = Schema.decodeUnknownOption(ControlFacts.ApprovalRequestFact)(e.payload)
                    return Option.isSome(parsed) && parsed.value.requestId === tReq2
                  })
                  if (tReqEntry2 === undefined) return false
                  const tReqFact2 = Schema.decodeUnknownSync(ControlFacts.ApprovalRequestFact)(tReqEntry2.payload)
                  const tTok2 = yield* runtime.lookupApproval(tReqFact2.payload.target)
                  yield* runtime.resolveApproval(tTok2, "denied", principal)

                  const stoppedOnCommit = yield* Effect.result(p2.trip(timeout))
                  if (!Result.isFailure(stoppedOnCommit)) return false
                }
                return true
              }).pipe(Effect.provide(runtimeLayer))
            })
          ),
        { executions: Math.min(executions, 40), seed }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("AgentSession.deliverSignal, drainRecordedSignals, requestCancel, trace clipping & childTracer invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        signalMode: Schema.Literals([
          "match",
          "mismatch",
          "outside_change_name",
          "outside_change_payload",
          "human_authorized",
          "human_no_principal",
          "bring_in_todo",
          "unknown_run",
          "bound_retry_conflict",
          "command_bind_and_drain"
        ]),
        payloadText: Schema.Literals(["alpha", "beta-1", "gamma_2", "delta"]),
        oversizedLen: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 66_000, maximum: 68_000 }))),
        markKeepCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4 })))
      })
    )
    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ signalMode, payloadText, oversizedLen, markKeepCount }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const idx = ++seq

              // Pure trace / childTracer / prompt / promptRendered coverage & invariants
              const bigInput = { a: "x".repeat(oversizedLen), b: "keep-short", nested: { c: "y".repeat(20_000) } }
              const tracer = AgentSession.tracer()
              const callId = new Cell.CallIdentity({
                session: `s-${idx}`,
                frame: 0,
                cell: "a".repeat(64),
                ordinal: 0,
                declaration: "b".repeat(64),
                layers: []
              })
              const effects = { reads: [], writes: [], mode: "expected" as const, onConflict: "serialize" as const, tier: "sealed" as const }
              const callStarted = tracer(
                new AgentEvent.CellCallStarted({
                  eventType: "flows.harness.cell-call-started.v1",
                  call: new Cell.Call({
                    flowName: "std/echo",
                    input: bigInput,
                    capabilities: [],
                    effects,
                    placement: Option.none(),
                    identity: callId
                  })
                })
              )
              if (callStarted === undefined) throw new Error("check failed at L385")
              if (JSON.stringify(callStarted.payload).length > AgentSession.maxTracedBytes + 4096) throw new Error("check failed at L386")

              const marks: Array<{ readonly digest: string; readonly mark: "keep" | "squash" | "remove" }> = []
              for (let m = 0; m < markKeepCount + 2; m++) {
                marks.push({
                  digest: `d-${m}`,
                  mark: m < markKeepCount ? "keep" : m === markKeepCount ? "squash" : "remove"
                })
              }
              const markedTrace = tracer({
                _tag: "compaction-settled",
                eventType: "flows.harness.compaction-settled.v1",
                replacedPrefixDigest: "p".repeat(64),
                marks,
                removedTokens: 120
              } as any)
              if (markedTrace === undefined) throw new Error("check failed at L402")

              const cTracer = AgentSession.childTracer()
              const childMeta = { callId: `child-call-${idx}`, flow: "agents/sub", session: `child-scope-${idx}` }
              const rec1 = cTracer(
                childMeta,
                new AgentEvent.CellCallStarted({
                  eventType: "flows.harness.cell-call-started.v1",
                  call: new Cell.Call({
                    flowName: "std/read",
                    input: { path: "README.md" },
                    capabilities: [],
                    effects,
                    placement: Option.none(),
                    identity: callId
                  })
                })
              )
              const rec2 = cTracer(
                childMeta,
                new AgentEvent.CellCallSettled({
                  eventType: "flows.harness.cell-call-settled.v1",
                  flowName: "std/read",
                  identity: callId,
                  result: { outcome: "success", value: { ok: true } }
                })
              )
              if (rec1 === undefined || rec2 === undefined || rec2.sourceSeq === rec1.sourceSeq) throw new Error("check failed at L429")

              const rendered = AgentSession.prompt("Hello {{name}}", { name: payloadText })
              if (!rendered.text.includes("Hello")) throw new Error("check failed at L432")
              if (!JSON.stringify(AgentSession.promptRendered(rendered)).includes(payloadText)) throw new Error("check failed at L433")

              // Real SQLite EngineStore + SqlControlRuntime for deliverSignal / drainRecordedSignals / requestCancel
              const jj = Jj.layerNoop({
                snapshot: () => Effect.succeed({ commitId: "s0", changeId: "c0" }),
                restore: () => Effect.void,
                diff: () => Effect.succeed("")
              })
              const stores = Layer.mergeAll(
                TestStores.layerAt(":memory:"),
                StepBoundary.layerTest(),
                jj
              ).pipe(Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(NodeServices.layer))

              const runtimeLayer = SqlControlRuntime.layer({
                flows: [
                  {
                    flowId: "todo",
                    executionDigest: "c".repeat(64),
                    description: "todo flow",
                    deployClass: false,
                    envelope: { capabilities: [], flows: [], budget: {} }
                  }
                ]
              }).pipe(Layer.provideMerge(stores))

              return yield* Effect.gen(function*() {
                const engine = yield* EngineStore.make({
                  owner: { hostId: `sig-host-${idx}` },
                  journalSource: `sig-host-${idx}`
                })
                const state = yield* DurableEngineState.DurableEngineState
                const runtime = yield* ControlRuntime.ControlRuntime
                const principal = yield* runtime.stampPrincipal()

                const sigName = `sig_${idx}`
                const waitFlow = Flow.make(`sig/wait-${idx}`, {
                  payload: { human: Schema.Boolean },
                  success: Schema.Unknown,
                  body: () => Node.succeed(undefined)
                })
                yield* engine.register(waitFlow, ({ human }) =>
                  Effect.gen(function*() {
                    const deferred = WaitFor.deferred(sigName)
                    const token = yield* DurableDeferred.token(deferred)
                    yield* FlowRuntime.annotateWaiting({
                      reason: human ? ControlExecutor.humanWaitReason : "event",
                      token
                    })
                    return yield* DurableDeferred.await(deferred)
                  })
                )

                // requestCancel on unknown run
                const unknownCancel = yield* AgentSession.requestCancel({
                  runId: `missing-run-${idx}`
                })
                if (unknownCancel !== "unknown") throw new Error("check failed at L491")

                const execId = `sig-exec-${idx}`
                const isHuman = signalMode.startsWith("human_")
                yield* engine.execute(waitFlow, { executionId: execId, payload: { human: isHuman }, discard: true })
                let waited = yield* state.waiting(execId)
                for (let w = 0; w < 500 && Option.isNone(waited); w++) {
                  yield* Effect.sleep("2 millis")
                  waited = yield* state.waiting(execId)
                }
                if (Option.isNone(waited)) throw new Error(`waitFlow ${execId} did not park`)

                // requestCancel: recorded -> already-requested
                const cancel1 = yield* AgentSession.requestCancel({ runId: execId })
                const cancel2 = yield* AgentSession.requestCancel({ runId: execId })
                if (cancel1 !== "recorded" || cancel2 !== "already-requested") throw new Error("check failed at L506")

                const deliver = (input: ControlExecutor.Signal) =>
                  AgentSession.deliverSignal(input).pipe(
                    Effect.provideService(FlowRuntime.FlowRuntime, engine)
                  )

                if (signalMode === "outside_change_name") {
                  const res = yield* deliver({
                    runId: execId,
                    signal: { name: "outside_change", payload: { x: 1 } }
                  })
                  if (res !== "refused") throw new Error("check failed at L518")
                } else if (signalMode === "outside_change_payload") {
                  const res = yield* deliver({
                    runId: execId,
                    signal: { name: sigName, payload: { kind: "outside_change" } }
                  })
                  if (res !== "refused") throw new Error("check failed at L524")
                } else if (signalMode === "unknown_run") {
                  const res = yield* deliver({
                    runId: `no-such-run-${idx}`,
                    signal: { name: sigName, payload: { v: payloadText } }
                  })
                  if (res !== "unknown") throw new Error("check failed at L530")
                } else if (signalMode === "mismatch") {
                  const res = yield* deliver({
                    runId: execId,
                    signal: { name: "other_signal", payload: { v: payloadText } }
                  })
                  if (res !== "no-match") throw new Error("check failed at L536")
                } else if (signalMode === "human_no_principal") {
                  const res = yield* deliver({
                    runId: execId,
                    signal: { name: sigName, payload: { v: payloadText } }
                  })
                  if (res !== "refused") throw new Error("check failed at L542")
                } else if (signalMode === "human_authorized") {
                  const res = yield* deliver({
                    runId: execId,
                    signal: { name: sigName, payload: { v: payloadText } },
                    principal
                  })
                  if (res !== "delivered") throw new Error("check failed at L549")
                } else if (signalMode === "bring_in_todo") {
                  const { card } = yield* runtime.plan({ flowId: "todo", input: {} })
                  const tok = yield* runtime.lookupApproval(card.approval.target)
                  yield* runtime.resolveApproval(tok, "approved", principal)
                  const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
                  if (launched._tag !== "Started") throw new Error("check failed at L555")
                  const res = yield* deliver({
                    runId: launched.run.runId,
                    signal: { name: "bring_in", payload: { sha: "a".repeat(40), wait: `w-${idx}` } }
                  })
                  if (res !== "delivered") throw new Error("check failed at L560")
                } else if (signalMode === "match" || signalMode === "bound_retry_conflict" || signalMode === "command_bind_and_drain") {
                  const waitingRow = yield* state.waiting(execId)
                  if (Option.isNone(waitingRow) || waitingRow.value.token === null) throw new Error("check failed at L563")
                  const token = waitingRow.value.token
                  if (signalMode === "command_bind_and_drain") {
                    const { card } = yield* runtime.plan({ flowId: "todo", input: {} })
                    const tok = yield* runtime.lookupApproval(card.approval.target)
                    yield* runtime.resolveApproval(tok, "approved", principal)
                    const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
                    if (launched._tag !== "Started") throw new Error("check failed at L570")
                    yield* runtime.admitSignal(`rec-sig-${idx}`, launched.run.runId, {
                      name: "outside_change",
                      payload: { x: 1 }
                    })
                    yield* runtime.admitSignal(`rec-sig-bind-${idx}`, execId, {
                      name: sigName,
                      payload: { v: payloadText }
                    })
                    yield* AgentSession.drainRecordedSignals.pipe(
                      Effect.provideService(FlowRuntime.FlowRuntime, engine)
                    )
                  }
                  const res1 = yield* deliver({
                    runId: execId,
                    token,
                    signal: { name: sigName, payload: { v: payloadText } }
                  })
                  const res2 = yield* deliver({
                    runId: execId,
                    token,
                    signal: { name: sigName, payload: { v: payloadText } }
                  })
                  if (res1 !== "delivered" || res2 !== "delivered") throw new Error("check failed at L591")
                  if (signalMode === "bound_retry_conflict") {
                    const conflict = yield* deliver({
                      runId: execId,
                      token,
                      signal: { name: sigName, payload: { v: payloadText + "-conflict" } }
                    })
                    if (conflict !== "no-match") throw new Error("check failed at L598")
                  }
                }

                // Completed flow requestCancel returns Terminal
                const doneFlow = Flow.make(`sig/done-${idx}`, {
                  payload: {},
                  success: Schema.String,
                  body: () => Node.succeed("ok")
                })
                yield* engine.register(doneFlow, () => Effect.succeed("ok"))
                const doneId = `done-exec-${idx}`
                const doneRes = yield* engine.execute(doneFlow, { executionId: doneId, payload: {} })
                if (doneRes !== "ok") throw new Error(`unexpected doneRes: ${JSON.stringify(doneRes)}`)
                const termCancel = yield* AgentSession.requestCancel({ runId: doneId })
                return typeof termCancel === "object" && termCancel._tag === "Terminal" && termCancel.status === "completed"
              }).pipe(Effect.provide(runtimeLayer))
            })
          ),
        { executions: Math.min(executions, 40), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("AgentSession native module execution, reenterModules, requestComplete, pause/resume & sandbox provider invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "module_reenter_complete",
          "module_simple",
          "sandbox_prompt_ok",
          "sandbox_refused",
          "sandbox_unconfigured",
          "sandbox_module_refused",
          "pause_and_resume"
        ]),
        payloadValue: Schema.Literals(["val-a", "val-b", "val-c"]),
        freshCtx: Schema.Boolean
      })
    )
    const principal: ControlSchema.Principal = { id: "operator", kind: "test", stampedAt: 1 }
    let seq = 0

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, payloadValue, freshCtx }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const idx = ++seq
              const root = makeScratch(`w6-sess-${idx}-`)
              const isModule = mode === "module_reenter_complete" || mode === "module_simple" || mode === "sandbox_module_refused"
              const withSandbox = mode.startsWith("sandbox_")
              const flowId = isModule ? "agents/module" : "agents/notes"
              const digest = (isModule ? "b" : "a").repeat(64)

              const descriptor = new Descriptor.FlowDescriptor({
                name: flowId,
                description: "Wave6 test flow.",
                body: isModule
                  ? new Descriptor.BodyRefModule({ path: `/flows/${flowId}/flow.ts`, contentDigest: digest })
                  : new Descriptor.BodyRefMarkdown({
                    path: `/flows/${flowId}/flow.md`,
                    baseDirectory: `/flows/${flowId}`,
                    contentDigest: digest
                  }),
                input: new Descriptor.SchemaRefNone(),
                output: new Descriptor.SchemaRefNone(),
                model: isModule ? Option.none() : Option.some("anthropic:test-model"),
                flows: [],
                capabilities: [],
                effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
                placement: Option.none(),
                ...(withSandbox ? { sandbox: { provider: "container", network: "none", cpus: 2 } as const } : {}),
                modelInvocable: false,
                path: `/flows/${flowId}`,
                frontmatter: {},
                provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
              })

              const moduleCalls: Array<unknown> = []
              let activeRunId = ""
              const ModWork = Action.make(`w6/mod-work-${idx}`, {
                payload: {},
                success: Schema.Number,
                error: Schema.Never
              })
              const nativeFlow = Flow.make(`w6/mod-${idx}`, {
                payload: Executable.Payload,
                success: Schema.Struct({ echoed: Schema.String, count: Schema.Number }),
                body: () => ModWork.call({}).pipe(Node.map((count) => ({ echoed: payloadValue, count })))
              })
              const nativeFlowLayer = Interpreter.layer(nativeFlow).pipe(
                Layer.provideMerge(
                  ModWork.toLayer(() =>
                    Effect.gen(function*() {
                      const queue = yield* NotificationQueue.NotificationQueue
                      const instance = yield* FlowRuntime.FlowInstance
                      if (activeRunId.length > 0) {
                        yield* queue.drain({
                          runId: activeRunId,
                          targetLineageId: activeRunId,
                          boundary: instance.executionId,
                          wouldIdle: false
                        })
                      }
                      moduleCalls.push(instance.executionId)
                      return moduleCalls.length
                    }).pipe(Effect.orDie)
                  )
                )
              )

              const catalog = {
                executables: isModule
                  ? [{
                    descriptor,
                    input: undefined,
                    delegate: `w6/mod-${idx}`,
                    lowered: { cache: undefined, placement: undefined, priority: undefined },
                    invocation: (input: unknown) => ({
                      flow: descriptor.name,
                      input,
                      prompt: "",
                      model: null,
                      placement: null,
                      placementOptions: null,
                      capabilities: [],
                      flows: [`w6/mod-${idx}`]
                    } as const),
                    flow: nativeFlow as any,
                    layer: nativeFlowLayer as any
                  }]
                  : [],
                refused: []
              }

              const pauseGate = yield* Deferred.make<void>()
              const modelStarted = yield* Deferred.make<void>()
              let sandboxOpened = 0

              const model = Model.make({
                stream: () =>
                  Stream.unwrap(
                    Effect.gen(function*() {
                      if (mode === "pause_and_resume") {
                        yield* Deferred.succeed(modelStarted, void 0)
                        yield* Deferred.await(pauseGate).pipe(Effect.timeout("2 seconds"), Effect.ignore)
                      }
                      return Stream.fromIterable(
                        cellEvents(`ctx.done(${JSON.stringify(payloadValue)})`, `t-${idx}`)
                      )
                    })
                  )
              })

              const registryService = Registry.makeNoop({
                list: () => Effect.succeed([descriptor]),
                visible: () => Effect.succeed([]),
                get: (name) =>
                  name === flowId
                    ? Effect.succeed(descriptor)
                    : Effect.flatMap(Registry.makeNoop().get(name), () => Effect.die("unreachable")),
                getOption: (name) => Effect.succeed(name === flowId ? Option.some(descriptor) : Option.none()),
                loadBody: (name) =>
                  Effect.succeed(
                    name === flowId && !isModule
                      ? new Descriptor.FlowBodyPrompt({ text: `Handle ${payloadValue}`, baseDirectory: `/flows/${flowId}` })
                      : new Descriptor.FlowBodyModule({ path: `/flows/${flowId}/flow.ts` })
                  )
              })

              const sandboxOption: AgentSession.Options["sandbox"] = mode === "sandbox_prompt_ok"
                ? () =>
                  Effect.succeed((_session: string) =>
                    Effect.acquireRelease(
                      Effect.sync(() => {
                        sandboxOpened++
                        return { flows: [] as ReadonlyArray<FlowBinding.Source> }
                      }),
                      () => Effect.void
                    )
                  )
                : mode === "sandbox_refused"
                ? () =>
                  Effect.fail(
                    new AgentSession.SandboxRefused({
                      provider: "container",
                      reason: "options",
                      message: "Container runtime busy"
                    })
                  )
                : undefined

              const registration = AgentSession.layer({
                quotaPolicy: Safety.quotaPolicy,
                budget: Safety.budget,
                limits: { memoryBytes: 32 * 1024 * 1024, steps: 2_000_000 },
                reenterModules: mode === "module_reenter_complete" ? [flowId] : undefined,
                sandbox: sandboxOption,
                freshContext: () => freshCtx,
                instructions: () => Effect.succeed([`Rule for ${payloadValue}`]),
                flows: []
              }).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(Executable.Catalog, catalog as unknown as Executable.Catalog),
                                        Agent.layer,
                    SeatResolver.layer({
                      resolve: (id) =>
                        Effect.succeed(
                          Seat.make({ id, modelId: "test-model", model, route, contextWindowTokens: 200_000 })
                        )
                    }),
                    ScriptedJudge.layer
                  ).pipe(Layer.provide(Safety.layer))
                )
              )

              let snap = 0
              const jj = Jj.layerNoop({
                snapshot: () => Effect.sync(() => ({ commitId: `s-${snap++}`, changeId: `c-${snap}` })),
                restore: () => Effect.void,
                diff: () => Effect.succeed("")
              })

              let resumes: ControlRuntime.Service | undefined
              const bindControl = Layer.effectDiscard(
                Effect.map(ControlRuntime.ControlRuntime, (svc) => {
                  resumes = svc
                })
              )

              const engine = NodeRuntime.layer(
                {
                  filename: join(root, "engine.db"),
                  workspaceRoot: root,
                  owner: { hostId: `w6-sess-${idx}` },
                  isAlive: () => Effect.succeed(false),
                  requestResume: (runId) =>
                    Effect.suspend(() =>
                      resumes === undefined ? Effect.void : Effect.ignore(resumes.requestResume(runId))
                    )
                },
                StepBoundary.layer,
                WorkspaceSandbox.layerFileSystem(),
                registration,
                isModule ? (nativeFlowLayer as any) : Layer.empty
              ).pipe(Layer.provide([AtomicFileSystem.layer, NodeCrypto.layer, jj]))

              const journal = TestJournal.layer()
              const notifications = NotificationQueue.layer.pipe(Layer.provide(journal))
              const runtime = ControlRuntime.layerMemory({
                flows: [
                  {
                    flowId,
                    executionDigest: Descriptor.executionDigest(descriptor),
                    description: "Wave6 test flow.",
                    deployClass: false,
                    envelope: { capabilities: [], flows: isModule ? [`w6/mod-${idx}`] : [], budget: {} }
                  }
                ]
              }).pipe(Layer.provide(NodeCrypto.layer))
              const registry = Layer.succeed(Registry.Registry)(registryService)

              const fullLayer = ControlLive.layer.pipe(
                Layer.provideMerge(engine),
                Layer.provideMerge(
                  bindControl.pipe(Layer.provideMerge(Layer.mergeAll(runtime, journal, notifications, registry)))
                ),
                Layer.provide(Action.layerImplementations)
              )

              return yield* Effect.gen(function*() {
                const control = yield* Control.Control
                const rt = yield* ControlRuntime.ControlRuntime
                const executor = yield* ControlExecutor.ControlExecutor

                const card = yield* control.plan({ flowId, input: { v: payloadValue } })
                yield* control.approve(card.approval)

                const launchRes = yield* Effect.result(
                  control.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: `w6-run-${idx}`
                  })
                )

                if (mode === "sandbox_refused" || mode === "sandbox_unconfigured" || mode === "sandbox_module_refused") {
                  if (Result.isSuccess(launchRes) && launchRes.success._tag === "Accepted" && launchRes.success.runId) {
                    const finalStatus = yield* awaitStatuses(rt, launchRes.success.runId, ["failed", "completed"])
                    return finalStatus === "failed"
                  }
                  return Result.isFailure(launchRes)
                }

                if (Result.isFailure(launchRes)) throw new Error(`launch failed (${mode}): ${String(launchRes.failure)}`)
                if (launchRes.success._tag !== "Accepted" || !launchRes.success.runId) throw new Error(`launch not accepted (${mode}): ${JSON.stringify(launchRes.success)}`)
                const runId = launchRes.success.runId
                activeRunId = runId

                if (mode === "module_simple") {
                  yield* awaitStatus(rt, runId, "completed")
                  return moduleCalls.length === 1
                }
                if (mode === "sandbox_prompt_ok") {
                  yield* awaitStatus(rt, runId, "completed")
                  return sandboxOpened === 1
                }
                if (mode === "module_reenter_complete") {
                  yield* awaitStatus(rt, runId, "parked")
                  if (moduleCalls.length !== 1) return false
                  yield* control.steer({
                    runId,
                    message: { messageId: `steer-${idx}`, runId, body: `retry ${payloadValue}`, principal, createdAt: 1 },
                    idempotencyKey: `steer-${idx}`
                  })
                  const waitReentry = (n = 3000): Effect.Effect<void, unknown> =>
                    Effect.gen(function*() {
                      const st = (yield* rt.getRun(runId)).status
                      if (moduleCalls.length >= 2 && st === "parked") return
                      if (n <= 0) return yield* Effect.die(`reentry stuck: calls=${moduleCalls.length}, st=${st}`)
                      yield* Effect.sleep("5 millis")
                      return yield* waitReentry(n - 1)
                    })
                  yield* waitReentry()
                  const done = yield* executor.requestComplete!({ runId, receiptId: `complete-${idx}` })
                  if (done._tag !== "Accepted") return false
                  yield* awaitStatus(rt, runId, "completed")
                  const repeat = yield* executor.requestComplete!({ runId, receiptId: `complete-${idx}` })
                  return repeat._tag === "Terminal"
                }
                if (mode === "pause_and_resume") {
                  yield* Deferred.await(modelStarted).pipe(Effect.timeout("5 seconds"), Effect.ignore)
                  yield* control.pause({ runId, reason: "fuzz-pause", idempotencyKey: `pause-${idx}` })
                  yield* awaitStatuses(rt, runId, ["parked"])
                  yield* Deferred.succeed(pauseGate, void 0)
                  yield* control.resume({ runId, idempotencyKey: `resume-${idx}` })
                  yield* awaitStatus(rt, runId, "completed")
                  return true
                }
                return true
              }).pipe(Effect.provide(fullLayer))
            })
          ),
        { executions: Math.min(executions, 21), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 120_000)
})
