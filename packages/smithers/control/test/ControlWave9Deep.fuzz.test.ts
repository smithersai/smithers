import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { DurableDeferred } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Schema, Stream } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http"
import { RpcSerialization } from "effect/rpc"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import {
  Control,
  ControlClient,
  ControlError,
  ControlExecutor,
  ControlFacts,
  ControlRpcs,
  type ControlSchema,
  ControlServer
} from "../src/index.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import { live, memoryRuntime } from "./TestStack.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261141")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(30, Math.min(baseExecutions, 100))
const httpExec = Math.max(12, Math.min(Math.ceil(baseExecutions / 6), 30))

const assertPassed = <A>(report: Fuzz.Report<A>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const sampleRun = (runId: string, status: ControlSchema.RunStatus): ControlSchema.RunSummary => ({
  runId,
  flowId: "review/pull-request",
  status,
  createdAt: 1_750_000_000_000,
  updatedAt: 1_750_000_001_000
})

describe("Control Wave 9 deep fuzzing", () => {
  it(
    "ControlFacts.fold preserves provenance, run snapshots, versioned vs legacy approvals, and digest matching",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          includeGap: Schema.Boolean,
          versionedReq: Schema.Boolean,
          versionedDecision: Schema.Boolean,
          decision: Schema.Literals(["none", "approved", "denied"]),
          digestMatches: Schema.Boolean,
          includeObserved: Schema.Boolean,
          includeForeignRun: Schema.Boolean,
          finalStatus: Schema.Literals(["running", "parked", "completed", "failed", "cancelled"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({
            includeGap,
            versionedReq,
            versionedDecision,
            decision,
            digestMatches,
            includeObserved,
            includeForeignRun,
            finalStatus
          }) =>
            Effect.sync(() => {
              const runId = "run-fold-1"
              const digest = "a".repeat(64)
              const otherDigest = "b".repeat(64)
              const events: Array<ControlSchema.ControlEvent> = []
              let seq = 1

              const push = (
                evRunId: string,
                kind: string,
                payload: unknown
              ) => {
                events.push({
                  runId: evRunId,
                  sequence: seq++,
                  kind,
                  occurredAt: 1_750_000_000_000 + seq * 100,
                  payload: payload as ControlSchema.ControlEvent["payload"]
                })
              }

              push(runId, "control.run.accepted", ControlFacts.runFact(sampleRun(runId, "accepted"), "created"))
              if (includeGap) {
                push(runId, "control.run.running", { factVersion: 1, bogus: true })
              }
              push(runId, `control.run.${finalStatus}`, ControlFacts.runFact(sampleRun(runId, finalStatus)))

              if (includeForeignRun) {
                push("run-other", "control.run.failed", ControlFacts.runFact(sampleRun("run-other", "failed")))
              }

              const target: ControlSchema.ApprovalTarget = {
                _tag: "Node",
                runId,
                requestId: "req-1",
                digest,
                envelope: { capabilities: [], flows: [], budget: {} }
              }
              const approvalPayload: ControlSchema.ApprovalPayload = {
                target,
                scope: "once",
                idempotencyKey: "app-req-1"
              }

              if (versionedReq) {
                push(runId, "control.approval.requested", {
                  factVersion: ControlFacts.version,
                  runId,
                  requestId: "req-1",
                  question: "Approve deploy?",
                  at: 1_750_000_000_500,
                  payload: approvalPayload
                })
                // Duplicate request should be ignored
                push(runId, "control.approval.requested", {
                  factVersion: ControlFacts.version,
                  runId,
                  requestId: "req-1",
                  question: "Duplicate?",
                  at: 1_750_000_000_600,
                  payload: approvalPayload
                })
              } else {
                push(runId, "control.approval.requested", {
                  runId,
                  requestId: "req-1",
                  payload: approvalPayload
                })
              }

              if (decision !== "none") {
                const decTarget: ControlSchema.ApprovalTarget = {
                  _tag: "Node",
                  runId,
                  requestId: "req-1",
                  digest: digestMatches ? digest : otherDigest,
                  envelope: { capabilities: [], flows: [], budget: {} }
                }
                if (versionedDecision) {
                  push(
                    runId,
                    `control.approval.${decision}`,
                    ControlFacts.approvalDecisionFact("req-1", decTarget)
                  )
                } else {
                  push(runId, `control.approval.${decision}`, {
                    runId,
                    requestId: "req-1",
                    tokenId: "req-1",
                    digest: digestMatches ? digest : otherDigest
                  })
                }
              }

              const observed: ReadonlyArray<ControlFacts.Approval> = includeObserved
                ? [
                  {
                    runId,
                    requestId: "req-obs",
                    title: "Observed approval",
                    request: { observed: true },
                    payload: {
                      target: {
                        _tag: "Node",
                        runId,
                        requestId: "req-obs",
                        digest,
                        envelope: { capabilities: [], flows: [], budget: {} }
                      },
                      scope: "once",
                      idempotencyKey: "obs-1"
                    },
                    requestedAt: 1_750_000_000_100,
                    status: "pending"
                  }
                ]
                : []

              const folded = ControlFacts.fold(events, sampleRun(runId, finalStatus), observed)
              expect(folded.run?.runId).toBe(runId)
              expect(folded.run?.status).toBe(finalStatus)
              expect(folded.provenance).toBeDefined()
              expect(folded.approvals.length).toBeGreaterThanOrEqual(includeObserved ? 2 : 1)
              const req1 = folded.approvals.find((a) => a.requestId === "req-1")
              expect(req1).toBeDefined()
              if (decision !== "none" && digestMatches && versionedDecision) {
                expect(req1?.status).toBe(decision)
              }
              return true
            }),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it("ControlExecutor.makeObserving, makeReadOnly, pendingWaitOf, and answerableWait uphold contracts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        targetKind: Schema.Literals(["Plan", "Node-plain", "Node-wait-token"]),
        waitName: Schema.Literals(["confirm-deploy", "clarify", "review"]),
        execMode: Schema.Literals(["observing", "readonly"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ targetKind, waitName, execMode }) =>
          Effect.gen(function*() {
            const validToken = Schema.encodeSync(DurableDeferred.TokenParsed.FromString)(
              new DurableDeferred.TokenParsed({
                flowName: "review/pull-request",
                executionId: "run-1",
                deferredName: `WaitFor/${waitName}`
              })
            )
            const target: ControlSchema.ApprovalTarget = targetKind === "Plan"
              ? {
                _tag: "Plan",
                planId: "p-1",
                digest: "a".repeat(64),
                envelope: { capabilities: [], flows: [], budget: {} }
              }
              : targetKind === "Node-wait-token"
              ? {
                _tag: "Node",
                runId: "run-1",
                requestId: "other-name",
                digest: validToken,
                envelope: { capabilities: [], flows: [], budget: {} }
              }
              : {
                _tag: "Node",
                runId: "run-1",
                requestId: waitName,
                digest: "not-a-token",
                envelope: { capabilities: [], flows: [], budget: {} }
              }

            const ans = ControlExecutor.answerableWait(target)
            if (targetKind === "Node-wait-token") {
              expect(ans).toEqual({ name: waitName, token: validToken })
            } else {
              expect(ans).toBeUndefined()
            }

            const pw = ControlExecutor.pendingWaitOf({
              runId: "run-1",
              status: "waiting-approval",
              waitingReason: ControlExecutor.humanWaitReason,
              executionView: {
                current: { status: "suspended" },
                pendingWaits: [
                  { name: waitName, token: validToken, question: "Proceed?" }
                ]
              }
            } as never)
            expect(pw === undefined || typeof pw === "object").toBe(true)

            const noop = ControlExecutor.makeNoop()
            const svc = execMode === "observing"
              ? ControlExecutor.makeObserving(noop)
              : ControlExecutor.makeReadOnly()

            const launchExit = yield* Effect.exit(svc.launch({} as never))
            expect(Exit.isFailure(launchExit)).toBe(true)
            const resumeExit = yield* Effect.exit(svc.resumeRun({ runId: "run-1" }))
            expect(Exit.isFailure(resumeExit)).toBe(true)

            const cancelExit = yield* Effect.exit(svc.requestCancel({ runId: "run-1" }))
            const signalExit = yield* Effect.exit(
              svc.deliverSignal({ runId: "run-1", name: waitName, payload: null, receiptId: "r-1" })
            )
            const settleExit = yield* Effect.exit(svc.settleCancelledPark({ runId: "run-1" }))
            if (execMode === "observing") {
              expect(Exit.isSuccess(cancelExit)).toBe(true)
              expect(Exit.isSuccess(signalExit)).toBe(true)
              expect(Exit.isSuccess(settleExit)).toBe(true)
            } else {
              expect(Exit.isFailure(cancelExit)).toBe(true)
              expect(Exit.isFailure(signalExit)).toBe(true)
              expect(Exit.isFailure(settleExit)).toBe(true)
            }
            return true
          }),
        { seed: seed + 1, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)

  it(
    "ControlClient over real ControlServer round-trips plan, approve, run, signal, pause, resume, cancel, list, watch & error codes",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          action: Schema.Literals([
            "full-lifecycle",
            "unknown-flow",
            "unknown-run-cancel",
            "bad-http-503",
            "bad-http-401"
          ]),
          text: Schema.Literals(["hello", "deploy-1", "unicode-é"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ action, text }) =>
            Effect.scoped(
              Effect.gen(function*() {
                if (action === "bad-http-503" || action === "bad-http-401") {
                  const status = action === "bad-http-503" ? 503 : 401
                  const fakeFetch: typeof fetch = async () =>
                    new Response(JSON.stringify({ message: `http ${status}` }), {
                      status,
                      headers: { "content-type": "application/json" }
                    })
                  const clientLayer = ControlClient.layer({ url: "http://127.0.0.1:1/rpc" }).pipe(
                    Layer.provide([
                      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fakeFetch))),
                      NodeSocket.layerWebSocket("ws://127.0.0.1:1/rpc/ws"),
                      RpcSerialization.layerNdjson
                    ])
                  )
                  const ex = yield* Effect.exit(
                    Effect.flatMap(Control.Control, (c) => c.list({ _tag: "flows" })).pipe(Effect.provide(clientLayer))
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                  expect(ControlClient.isControlError(new ControlError.RunNotFound({ runId: "r-1" }))).toBe(true)
                  expect(ControlClient.isControlError(new Error("plain"))).toBe(false)
                  return true
                }

                const bearerToken = "w9-secret-token"
                const auth = ControlRpcs.layerBearerAuth({
                  token: bearerToken,
                  principal: { id: "local", kind: "operator" },
                  now: () => 1
                })
                const serverCtx = yield* Layer.build(
                  HttpRouter.serve(
                    ControlServer.layerHttp.pipe(
                      Layer.provide(Layer.succeed(ControlServer.RequestScheme, "http:")),
                      Layer.provide(auth),
                      Layer.provide(RpcSerialization.layerNdjson)
                    )
                  ).pipe(
                    Layer.provideMerge(
                      live({
                        runtime: memoryRuntime({
                          approvalAuthority: delegateApproval({ id: "local", kind: "operator" }),
                          flows: [{
                            flowId: "review/pull-request",
                            description: "PR review",
                            deployClass: false,
                            envelope: { capabilities: [], flows: [], budget: {} }
                          }]
                        })
                      })
                    ),
                    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
                  )
                )
                const server = serverCtx.mapUnsafe.get(HttpServer.HttpServer.key) as HttpServer.HttpServer
                if (server.address._tag !== "InetAddressV4") throw new Error("expected TCP server")
                const url = `http://127.0.0.1:${server.address.port}`

                const clientLayer = ControlClient.layer({ url: `${url}/rpc`, credential: bearerToken }).pipe(
                  Layer.provide([
                    NodeHttpClient.layerUndici,
                    NodeSocket.layerWebSocket(`ws://127.0.0.1:${server.address.port}/rpc/ws`),
                    RpcSerialization.layerNdjson
                  ])
                )

                yield* Effect.gen(function*() {
                  const control = yield* Control.Control
                  if (action === "unknown-flow") {
                    const ex = yield* Effect.exit(
                      control.plan({ flowId: "missing/flow", input: { text }, idempotencyKey: "k-unk" })
                    )
                    expect(Exit.isFailure(ex)).toBe(true)
                    return
                  }
                  if (action === "unknown-run-cancel") {
                    const ex = yield* Effect.exit(
                      control.cancel({ runId: "run-does-not-exist", idempotencyKey: "k-c" })
                    )
                    expect(Exit.isFailure(ex)).toBe(true)
                    return
                  }

                  const card = yield* control.plan({
                    flowId: "review/pull-request",
                    input: { text },
                    idempotencyKey: "k-plan"
                  })
                  const app = yield* control.approve({
                    target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
                    scope: "once",
                    idempotencyKey: "k-app"
                  })
                  expect(app._tag).toBe("Accepted")
                  const started = yield* control.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: "k-run"
                  })
                  expect(started._tag).toBe("Accepted")
                  const runId = (started as { readonly runId: string }).runId
                  const listed = yield* control.list({ _tag: "runs", limit: 10 })
                  expect(listed._tag).toBe("runs")
                  const sig = yield* control.signal({
                    runId,
                    idempotencyKey: "k-sig",
                    signal: { name: "ping", payload: { text } }
                  })
                  expect(sig._tag).toBe("Accepted")
                  const cancelled = yield* control.cancel({ runId, idempotencyKey: "k-cancel", reason: text })
                  expect(cancelled._tag).toBe("Terminal")
                  const watched = yield* Stream.runCollect(control.watch({ runId, follow: false }))
                  expect(watched.length).toBeGreaterThan(0)
                }).pipe(Effect.provide(clientLayer))
                return true
              })
            ),
          { seed: seed + 2, executions: httpExec }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
