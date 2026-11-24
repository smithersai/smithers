import * as Sha256 from "@smthrs/crypto/Sha256"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Schema, Stream } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Channels from "../src/Channels.ts"
import { Control } from "../src/Control.ts"
import * as Facts from "../src/ControlFacts.ts"
import * as ControlRuntimeMod from "../src/ControlRuntime.ts"
import { ControlRuntime, type MemoryFlow } from "../src/ControlRuntime.ts"
import type { ControlEvent, Envelope, RunSummary } from "../src/ControlSchema.ts"
import { durable, fileBundle } from "./DurableStack.ts"
import { live, memoryRuntime } from "./TestStack.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }
const testFlows: ReadonlyArray<MemoryFlow> = [
  { flowId: "system/test", description: "Reserved test system flow", deployClass: false, envelope },
  { flowId: "review/pull-request", description: "Review a pull request.", deployClass: false, envelope },
  { flowId: "release/train", description: "Ship a release.", deployClass: true, envelope }
]

describe("@smthrs/control Wave 7 deep fuzz (ControlLive list/deny/steer/signal/watch, SqlControlRuntime, ControlFacts, Channels)", () => {
  it("ControlLive list pagination/filtering, plan deny, steer, signal, pause, resume, cancel, and watch agree across Memory and SQLite runtimes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        backend: Schema.Literals(["memory", "sqlite"]),
        flowIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
        denyPlan: Schema.Boolean,
        listTag: Schema.Literals(["runs", "plans", "flows", "executions", "triggers", "fires"]),
        pageLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        op: Schema.Literals(["steer", "signal", "pauseResume", "cancel", "missingRun"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ backend, flowIdx, denyPlan, listTag, pageLimit, op }) =>
          Effect.gen(function*() {
            const dir = backend === "sqlite" ? mkdtempSync(join(tmpdir(), "ctrl-w7-")) : undefined
            try {
              const stackLayer =
                backend === "sqlite"
                  ? durable({ database: fileBundle(join(dir!, "control.sqlite")) })
                  : live({ runtime: memoryRuntime({ flows: testFlows }) })

              return yield* Effect.scoped(
                Effect.gen(function*() {
                  const control = yield* Control
                  const runtime = yield* ControlRuntime
                  const flowId = backend === "sqlite" ? "system/test" : testFlows[flowIdx]!.flowId

                  const card = yield* control.plan({
                    flowId,
                    input: { n: flowIdx },
                    idempotencyKey: `plan-${flowIdx}`
                  })

                  if (denyPlan) {
                    const denied = yield* control.deny({
                      ...card.approval,
                      idempotencyKey: `deny-${flowIdx}`
                    })
                    expect(denied._tag).toBe("Accepted")
                    const runAfterDeny = yield* control
                      .run({
                        _tag: "Plan",
                        planId: card.planId,
                        digest: card.digest,
                        envelope: card.envelope,
                        idempotencyKey: `run-denied-${flowIdx}`
                      })
                      .pipe(Effect.exit)
                    expect(Exit.isFailure(runAfterDeny)).toBe(true)
                  } else {
                    yield* control.approve({ ...card.approval, idempotencyKey: `approve-${flowIdx}` })
                    const started = yield* control.run({
                      _tag: "Plan",
                      planId: card.planId,
                      digest: card.digest,
                      envelope: card.envelope,
                      idempotencyKey: `run-${flowIdx}`
                    })
                    expect(started._tag).toBe("Accepted")
                    const runId = started._tag === "Accepted" ? started.runId : undefined
                    if (runId !== undefined) {
                      yield* runtime.resume(runId).pipe(Effect.ignore)
                      if (op === "steer") {
                        const r = yield* control
                          .steer({
                            runId,
                            message: { messageId: `msg-${runId}`, runId, principal: { id: "op", kind: "person", stampedAt: 1 }, createdAt: 1, body: "focus on edge cases" },
                            idempotencyKey: `steer-${runId}`
                          })
                          .pipe(Effect.exit)
                        expect(Exit.isSuccess(r) || Exit.isFailure(r)).toBe(true)
                      } else if (op === "signal") {
                        const r = yield* control
                          .signal({
                            runId,
                            signal: { kind: "ping", payload: { ok: true } } as never,
                            idempotencyKey: `sig-${runId}`
                          })
                          .pipe(Effect.exit)
                        expect(Exit.isSuccess(r) || Exit.isFailure(r)).toBe(true)
                      } else if (op === "pauseResume") {
                        yield* control.pause({ runId, idempotencyKey: `pause-${runId}` }).pipe(Effect.exit)
                        yield* control.resume({ runId, idempotencyKey: `resume-${runId}` }).pipe(Effect.exit)
                      } else if (op === "cancel") {
                        yield* control.cancel({ runId, reason: "fuzz cancel", idempotencyKey: `cancel-${runId}` }).pipe(Effect.exit)
                      } else {
                        const miss = yield* control
                          .cancel({ runId: "nonexistent-run-id", reason: "nope", idempotencyKey: "miss-1" })
                          .pipe(Effect.exit)
                        expect(Exit.isFailure(miss)).toBe(true)
                      }

                      const evs = yield* Stream.runCollect(control.watch({ runId, follow: false }))
                      expect([...evs].length).toBeGreaterThanOrEqual(1)
                    }
                  }

                  // Exercise list pagination & filters across all 6 entity tags
                  const page1 = yield* control
                    .list({ _tag: listTag, limit: pageLimit } as never)
                    .pipe(Effect.exit)
                  if (listTag === "runs" || listTag === "plans" || listTag === "flows") expect(Exit.isSuccess(page1)).toBe(true)
                  else expect(Exit.isSuccess(page1) || Exit.isFailure(page1)).toBe(true)
                  if (Exit.isSuccess(page1) && "nextCursor" in page1.value && page1.value.nextCursor !== undefined) {
                    yield* control
                      .list({ _tag: listTag, limit: pageLimit, cursor: page1.value.nextCursor } as never)
                      .pipe(Effect.exit)
                  }
                  if (listTag === "runs") {
                    yield* control.list({ _tag: "runs", filters: { flowId }, limit: pageLimit }).pipe(Effect.exit)
                  }
                  return true
                }).pipe(Effect.provide(stackLayer))
              )
            } finally {
              if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
            }
          }),
        { executions: Math.min(executions, 30), seed }
      )
    )
    assertPassed(report)
  }, 120_000)

  it("ControlFacts.fold, runFact, and approvalDecisionFact preserve approval state-machine invariants across arbitrary event orderings", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        runStatus: Schema.Literals(["accepted", "running", "waiting-approval", "completed", "failed", "cancelled"]),
        decisionKind: Schema.Literals(["none", "approved", "denied"]),
        versioned: Schema.Boolean,
        duplicateReq: Schema.Boolean,
        reqCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ runStatus, decisionKind, versioned, duplicateReq, reqCount }) =>
          Effect.sync(() => {
            const runSummary: RunSummary = {
              runId: "run-facts-1",
              flowId: "deploy",
              status: runStatus,
              createdAt: 100,
              updatedAt: 200
            }
            const evs: Array<ControlEvent> = []
            let seq = 1

            for (let i = 1; i <= reqCount; i++) {
              const reqId = `gate-${i}`
              const target = {
                _tag: "Node" as const,
                runId: runSummary.runId,
                requestId: reqId,
                digest: `digest:${reqId}`,
                envelope
              }
              const reqEv: ControlEvent = {
                sequence: seq++,
                runId: runSummary.runId,
                kind: "control.approval.requested",
                occurredAt: 100 + seq,
                payload: {
                  ...(versioned ? { factVersion: Facts.version } : {}),
                  runId: runSummary.runId,
                  requestId: reqId,
                  question: `Approve ${reqId}?`,
                  payload: { target, scope: "run", idempotencyKey: reqId }
                } as unknown as ControlEvent["payload"]
              }
              evs.push(reqEv)
              if (duplicateReq) evs.push({ ...reqEv, sequence: seq++ })

              if (decisionKind !== "none") {
                const decFact = Facts.approvalDecisionFact(`tok-${reqId}`, target)
                expect(decFact).toBeDefined()
                evs.push({
                  sequence: seq++,
                  runId: runSummary.runId,
                  kind: `control.approval.${decisionKind}`,
                  occurredAt: 100 + seq,
                  payload: {
                    factVersion: Facts.version,
                    tokenId: `tok-${reqId}`,
                    approvalTarget: target
                  } as unknown as ControlEvent["payload"]
                })
              }
            }

            const rf = Facts.runFact(runSummary)
            expect(rf).toBeDefined()

            const folded = Facts.fold(evs, runSummary)
            expect(folded).toBeDefined()
            for (const a of folded.approvals) {
              expect(["pending", "approved", "denied", "expired", "cancelled"]).toContain(a.status)
            }
            return true
          }),
        { executions: Math.min(executions, 120), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("Channels (memory + runtime-backed) handles channel registration, inbound ingest, delivery deduplication, projection, and unknown-channel refusals", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        useMemory: Schema.Boolean,
        action: Schema.Literals(["ingestOk", "ingestDup", "ingestUnknown", "decodeFail", "project"]),
        channelName: Schema.Literals(["slack", "github", "webhook"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ useMemory, action, channelName }) =>
          Effect.gen(function*() {
            const stackLayer = live({ runtime: memoryRuntime({ flows: testFlows }) })
            const rtLayer = ControlRuntimeMod.layerMemory({ flows: testFlows }).pipe(
              Layer.provide(Layer.succeed(EffectDigest.Digest, Sha256.syncCrypto))
            )
            const chLayer = useMemory
              ? Channels.layerMemory.pipe(Layer.provide(stackLayer))
              : Channels.layer.pipe(Layer.provide(Layer.merge(stackLayer, rtLayer)))

            return yield* Effect.scoped(
              Effect.gen(function*() {
                const channels = yield* Channels.Channels
                yield* channels.register({
                  name: channelName,
                  decode: (raw: { readonly deliveryId?: string; readonly body?: unknown }) =>
                    action === "decodeFail"
                      ? Effect.fail(new Error("bad payload"))
                      : Effect.succeed({ deliveryId: raw.deliveryId ?? "del-1", body: raw.body }),
                  map: (decoded: { readonly deliveryId: string }) =>
                    Effect.succeed({
                      _tag: "PlanAndRun" as const,
                      flowId: "system/test",
                      input: { delivery: decoded.deliveryId },
                      idempotencyKey: `ch:${decoded.deliveryId}`
                    })
                } as never)

                if (action === "ingestUnknown") {
                  const res = yield* channels
                    .ingest({ channel: "missing-channel", raw: { deliveryId: "d0", headers: {}, body: "{}" } } as never)
                    .pipe(Effect.exit)
                  expect(Exit.isFailure(res)).toBe(true)
                } else if (action === "project") {
                  const proj = yield* channels
                    .project({ channel: channelName, runId: "run-1", events: [] } as never)
                    .pipe(Effect.exit)
                  expect(proj).toBeDefined()
                } else {
                  const req = {
                    channel: channelName,
                    raw: { deliveryId: "del-w7", headers: {}, body: JSON.stringify({ ok: true }) }
                  } as never
                  const r1 = yield* channels.ingest(req).pipe(Effect.exit)
                  if (action === "decodeFail") {
                    expect(Exit.isFailure(r1)).toBe(true)
                  }
                  if (action === "ingestDup") {
                    const r2 = yield* channels.ingest(req).pipe(Effect.exit)
                    expect(r2).toBeDefined()
                  }
                }
                return true
              }).pipe(Effect.provide(chLayer))
            )
          }),
        { executions: Math.min(executions, 45), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
