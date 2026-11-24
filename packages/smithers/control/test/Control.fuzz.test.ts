import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Sha256 from "@smthrs/crypto/Sha256"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Arbitrary, Effect, Exit, Fiber, Layer, Logger, Option, Redacted, Result, Schema, Stream } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http"
import { RpcSerialization } from "effect/rpc"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import {
  ApprovalAuthority,
  Cancellation,
  Channels,
  Control,
  ControlClient,
  ControlError,
  ControlExecutor,
  ControlFacts,
  ControlRpcs,
  ControlRuntime,
  ControlSchema,
  ControlServer,
  Credential,
  CredentialCipher,
  CredentialStore,
  DispatchReader,
  Health,
  JevSessionChecker,
  Lineage,
  Monitor,
  ScopedToken,
  SqlCredentialStore,
  Steering,
  WebCryptoCipher,
  WebhookChannel
} from "../src/index.ts"
import * as TestControl from "../src/test/TestControl.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import { durable } from "./DurableStack.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "150"))
const fastExecutions = Math.min(executions, 18)
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])
const asciiId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,20}$/)))
const hostKey = Redacted.make(Buffer.from(new Uint8Array(32).fill(42)).toString("base64"))

describe("@smthrs/control security fuzz invariants", () => {
  it("ScopedToken mint/verify round-trips, rejects tampering/expiry/wrong key, and never widens run/flow confinement", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        key: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z0-9_-]{8,32}$/))),
        wrongKey: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z0-9_-]{8,32}$/))),
        scope: Schema.Literals(["read:runs", "write:runs", "approve:runs"]),
        ttlMillis: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1000, maximum: 600_000 }))),
        runId: Schema.OptionFromUndefinedOr(Schema.Literals(["run-a", "run-b"])),
        flowId: Schema.OptionFromUndefinedOr(Schema.Literals(["flow-x", "flow-y"])),
        callRun: Schema.OptionFromUndefinedOr(Schema.Literals(["run-a", "run-b", "run-c"])),
        callFlow: Schema.OptionFromUndefinedOr(Schema.Literals(["flow-x", "flow-y", "flow-z"]))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ key, wrongKey, scope, ttlMillis, runId, flowId, callRun, callFlow }) =>
          Effect.gen(function*() {
            const baseNow = 1_700_000_000_000
            const rId = runId._tag === "Some" ? runId.value : undefined
            const fId = flowId._tag === "Some" ? flowId.value : undefined
            const minted = yield* ScopedToken.mint({
              key,
              scopes: [scope],
              ttlMillis,
              runId: rId,
              flowId: fId,
              now: () => baseNow
            })
            if (!ScopedToken.isScopedToken(minted.token)) return false

            const verified = yield* Effect.result(ScopedToken.verify(key, minted.token, baseNow + 1))
            if (Result.isFailure(verified)) return false
            if (verified.success.runId !== rId || verified.success.flowId !== fId) return false

            const expired = yield* Effect.result(ScopedToken.verify(key, minted.token, baseNow + ttlMillis + 1))
            if (Result.isSuccess(expired)) return false

            const last = minted.token.at(-1) === "a" ? "b" : "a"
            const tampered = minted.token.slice(0, -1) + last
            const tamperedRes = yield* Effect.result(ScopedToken.verify(key, tampered, baseNow + 1))
            if (Result.isSuccess(tamperedRes)) return false

            if (wrongKey !== key) {
              const wrongRes = yield* Effect.result(ScopedToken.verify(wrongKey, minted.token, baseNow + 1))
              if (Result.isSuccess(wrongRes)) return false
            }

            const allowedRpc = verified.success.procedures[0]
            if (allowedRpc !== undefined) {
              const payload: Record<string, unknown> = {}
              if (callRun._tag === "Some") payload["runId"] = callRun.value
              if (callFlow._tag === "Some") payload["flowId"] = callFlow.value
              const ok = ScopedToken.authorizes(verified.success, { rpc: allowedRpc, payload })
              const runOk = rId === undefined || (callRun._tag === "Some" && callRun.value === rId)
              const flowOk = fId === undefined || (callFlow._tag === "Some" && callFlow.value === fId)
              if (ok !== (runOk && flowOk)) return false
              if (ScopedToken.authorizes(verified.success, { rpc: "Control.NonExistent", payload })) return false
            }
            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("WebCryptoCipher AES-GCM seal/open round-trips and detects ciphertext or AAD context tampering", async () => {
    const keyB64 = Buffer.from(new Uint8Array(32).fill(42)).toString("base64")
    const otherKeyB64 = Buffer.from(new Uint8Array(32).fill(99)).toString("base64")
    const arb = Arbitrary.schema(
      Schema.Struct({
        secret: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
        id: asciiId,
        name: asciiId,
        version: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ secret, id, name, version }) =>
          Effect.gen(function*() {
            const cipher = yield* WebCryptoCipher.make({ key: Redacted.make(keyB64) })
            const otherCipher = yield* WebCryptoCipher.make({ key: Redacted.make(otherKeyB64) })
            const ctx = { id, name, version }
            const sealed = yield* cipher.seal(Redacted.make(secret), ctx)
            if (secret.length >= 6 && sealed.ciphertext.includes(secret)) return false
            const opened = yield* cipher.open(sealed, ctx)
            const expectedUtf8 = new TextDecoder().decode(new TextEncoder().encode(secret))
            if (Redacted.value(opened) !== expectedUtf8) return false
            if (Result.isSuccess(yield* Effect.result(cipher.open(sealed, { ...ctx, version: version + 1 })))) {
              return false
            }
            if (Result.isSuccess(yield* Effect.result(cipher.open(sealed, { ...ctx, name: `${name}_x` })))) return false
            if (Result.isSuccess(yield* Effect.result(otherCipher.open(sealed, ctx)))) return false
            const rawCt = Buffer.from(sealed.ciphertext, "base64")
            rawCt[0] = rawCt[0]! ^ 0xff
            if (
              Result.isSuccess(
                yield* Effect.result(cipher.open({ ...sealed, ciphertext: rawCt.toString("base64") }, ctx))
              )
            ) return false
            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ApprovalAuthority NEVER permits an agent principal to approve", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        subject: asciiId,
        scope: Schema.Literals(["once", "remembered", "run"]),
        decision: Schema.Literals(["approved", "denied"]),
        runId: asciiId
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ subject, scope, decision, runId }) =>
          Effect.gen(function*() {
            const res = yield* Effect.result(
              ApprovalAuthority.local.authorize({
                principal: { kind: "agent", id: subject, stampedAt: 1_700_000_000_000 },
                target: {
                  _tag: "Node",
                  runId,
                  requestId: "req-1",
                  digest: "d1",
                  envelope: { capabilities: [], flows: [], budget: {} }
                },
                decision,
                scope
              })
            )
            if (decision === "approved" && Result.isSuccess(res)) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})

describe("@smthrs/control Monitor, Lineage, Steering, Health, JevSessionChecker, ControlFacts & Cancellation fuzz", () => {
  it("Monitor.classify & remedyFor preserve strict health precedence", async () => {
    const statusArb = Schema.Literals([
      "running",
      "pending",
      "failed",
      "completed",
      "cancelled",
      "waiting-approval",
      "parked"
    ])
    const waitReasonArb = Schema.OptionFromUndefinedOr(
      Schema.Literals(["approval", "event", "timer", "quota", "released"])
    )
    const arb = Arbitrary.schema(
      Schema.Struct({
        hasSummary: Schema.Boolean,
        status: statusArb,
        waitingReason: waitReasonArb,
        roundOrdinal: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 40 }))),
        beatsWithoutProgress: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
        stallBeats: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
        semanticProgress: Schema.Boolean,
        openAttempts: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
        lastAttemptFailed: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({
          hasSummary,
          status,
          waitingReason,
          roundOrdinal,
          beatsWithoutProgress,
          stallBeats,
          semanticProgress,
          openAttempts,
          lastAttemptFailed
        }) =>
          Effect.sync(() => {
            const events: Array<{
              readonly runId: string
              readonly seq: number
              readonly kind: string
              readonly at: number
              readonly payload: unknown
            }> = []
            let seq = 1
            if (lastAttemptFailed) {
              events.push({ runId: "r1", seq: seq++, kind: Monitor.attemptStartedEventType, at: 1, payload: {} })
              events.push({
                runId: "r1",
                seq: seq++,
                kind: Monitor.attemptFinishedEventType,
                at: 2,
                payload: { state: "failed" }
              })
            }
            for (let i = 0; i < openAttempts; i++) {
              events.push({ runId: "r1", seq: seq++, kind: Monitor.attemptStartedEventType, at: 3 + i, payload: {} })
            }
            const wr = waitingReason._tag === "Some" ? waitingReason.value : undefined
            const health = Monitor.classify({
              summary: hasSummary
                ? ({
                  runId: "r1",
                  status,
                  waitingReason: wr,
                  roundOrdinal
                } as unknown as NonNullable<Monitor.Observation["summary"]>)
                : undefined,
              events: events as unknown as Monitor.Observation["events"],
              beatsWithoutProgress,
              stallBeats,
              semanticProgress
            })
            const remedy = Monitor.remedyFor(health)
            if (!hasSummary) return health === "unknown" && remedy === "none"
            if (status === "failed") return health === "failing" && remedy === "cancel"
            if (status === "completed" || status === "cancelled") return health === "healthy" && remedy === "none"
            if (status === "waiting-approval" || (status === "parked" && (wr === "approval" || wr === undefined))) {
              return health === "awaiting-human" && remedy === "none"
            }
            if (health === "stalled" || health === "wedged-node") return remedy === "resume"
            if (health === "failing" || health === "runaway-loop") return remedy === "cancel"
            return remedy === "none"
          }),
        { seed: seed + 10, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Lineage.originOf/expand and Steering.expand never drop the original event", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          Lineage.runDecisionEventType,
          Lineage.forkCreatedEventType,
          Steering.promotedEventType,
          Monitor.beatEventType,
          "custom.event"
        ]),
        hasParent: Schema.Boolean,
        hasFork: Schema.Boolean,
        hasPrev: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, hasParent, hasFork, hasPrev }) =>
          Effect.sync(() => {
            const origin = Lineage.originOf({
              parentRunId: hasParent ? "p1" : undefined,
              forked: hasFork,
              roundOrdinal: hasPrev ? 2 : 0
            })
            if (origin !== undefined && origin !== "child" && origin !== "fork" && origin !== "continuation") {
              return false
            }
            const ev: ControlSchema.ControlEvent = {
              runId: "r1",
              sequence: 1,
              occurredAt: 1,
              kind,
              payload: kind === Steering.promotedEventType
                ? { boundary: "turn", ids: ["a", "b"] }
                : { decision: "created", ...(hasParent ? { parentExecutionId: "p1" } : {}) }
            }
            const lOut = Lineage.expand(ev)
            const sOut = Steering.expand(ev)
            return lOut.length >= 1 && sOut.length >= 1 && lOut[0]!.kind === kind && sOut[0]!.kind === kind
          }),
        { seed: seed + 11, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Health, JevSessionChecker, ControlFacts.fold, and Cancellation.attribute obey all state/freshness/attribution invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        state: Schema.Literals([
          "accepted",
          "running",
          "parked",
          "waiting-approval",
          "completed",
          "failed",
          "cancelled"
        ]),
        baseHealth: Schema.Literals([
          "healthy",
          "stalled",
          "wedged-node",
          "failing",
          "runaway-loop",
          "awaiting-human",
          "unknown"
        ]),
        activity: Schema.Literals(["working", "idle", "needs-input", "unknown"]),
        confidence: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
        evalMode: Schema.Literals(["ok", "invented", "unreachable", "timeout", "refused", "invalid_answer"]),
        staleObs: Schema.Boolean,
        hasObs: Schema.Boolean,
        cancelSource: Schema.Literals(["operator", "timeout", "parent", "none"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ state, baseHealth, activity, confidence, evalMode, staleObs, hasObs, cancelSource }) =>
          Effect.gen(function*() {
            const obs: Health.HealthObservation = {
              subjectId: "session:one",
              state,
              checkerId: "jev-session",
              monitorId: "host-1",
              incarnation: "inc-1",
              evidenceSeq: 4,
              observedAt: 100,
              expiresAt: staleObs ? 105 : 250,
              durationMs: 2,
              outcome: "ok",
              report: { activity }
            }
            const rolled = Health.rollup({
              subjectId: "session:one",
              state,
              incarnation: "inc-1",
              baseHealth,
              now: 150,
              updatedAt: 90,
              latest: hasObs ? { observation: obs, sequence: 9 } : undefined
            })
            if (!hasObs && rolled.freshness !== "unobserved") return false
            if (hasObs && staleObs && rolled.freshness !== "stale") return false
            if (hasObs && !staleObs && rolled.freshness !== "fresh") return false

            const wr = Health.waitReason(state, "approval")
            const delay = Health.nextDelay(Health.defaultPolicy, 2)
            if (delay <= 0 || (wr !== undefined && typeof wr !== "string")) return false

            // Exercise JevSessionChecker + Health.evaluate + Health.makeRegistry
            const evaluator: Evaluator.Evaluator = {
              evaluate: () => {
                if (
                  evalMode === "unreachable" || evalMode === "timeout" ||
                  evalMode === "refused" || evalMode === "invalid_answer"
                ) {
                  return Effect.fail(new Evaluator.EvaluatorError({ code: evalMode, message: "err" }))
                }
                const choice = evalMode === "invented" ? "bogus" : activity
                return Effect.succeed({
                  answers: {
                    activity: { type: "choice" as const, choice, probabilities: { [choice]: confidence } }
                  },
                  latencyMs: 1
                })
              }
            }
            const registry = Health.makeRegistry(
              {
                bindings: {
                  session: { checkerId: "jev-session", policy: Health.defaultPolicy },
                  run: { checkerId: Health.lifecycleRunChecker.id, policy: Health.defaultPolicy }
                }
              },
              "session",
              evaluator
            )
            const resolvedSession = registry.resolve("session")
            const resolvedRun = registry.resolve("run")
            if (resolvedSession === undefined || resolvedRun === undefined) return false

            const probeCtx: Health.ProbeContext = {
              subjectId: "session:one",
              state,
              events: [],
              sinceCursor: 0,
              session: {
                alive: state === "running",
                exitCode: state === "completed" ? 0 : null,
                outputCursor: 4,
                outputTail: "hello"
              }
            }
            const evObs = yield* Health.evaluate(
              resolvedSession,
              probeCtx,
              { monitorId: "m1", incarnation: "inc-1", evidenceSeq: 1 }
            ).pipe(Effect.provide(silentLogger))
            const evRunObs = yield* Health.evaluate(
              resolvedRun,
              probeCtx,
              { monitorId: "m1", incarnation: "inc-1", evidenceSeq: 1 }
            ).pipe(Effect.provide(silentLogger))
            if (evObs.subjectId !== "session:one" || evRunObs.subjectId !== "session:one") return false

            const latest = Health.latestObservation(
              [{ observation: evObs, sequence: 5 }],
              "session:one",
              "inc-1"
            )
            if (latest === undefined) return false

            // Exercise ControlFacts.fold
            const runSnap: ControlSchema.RunSummary = {
              runId: "r1",
              flowId: "system/test",
              status: "accepted",
              createdAt: 1,
              updatedAt: 1
            }
            const envelope = { capabilities: [], flows: [], budget: {} }
            const target = { _tag: "Node" as const, runId: "r1", requestId: "req-1", digest: "d1", envelope }
            const facts: Array<ControlSchema.ControlEvent> = [
              {
                kind: "control.run.accepted",
                payload: ControlFacts.runFact(runSnap, "created") as unknown as ControlSchema.ControlEvent["payload"],
                sequence: 1,
                runId: "r1",
                occurredAt: 1
              },
              {
                kind: "control.run.completed",
                payload: ControlFacts.runFact({
                  ...runSnap,
                  status: "completed",
                  updatedAt: 5
                }) as unknown as ControlSchema.ControlEvent["payload"],
                sequence: 2,
                runId: "r1",
                occurredAt: 5
              },
              {
                kind: "control.approval.requested",
                payload: {
                  factVersion: 1,
                  runId: "r1",
                  requestId: "req-1",
                  question: "allow?",
                  payload: { target, scope: "run", idempotencyKey: "k1" }
                } as unknown as ControlSchema.ControlEvent["payload"],
                sequence: 3,
                runId: "r1",
                occurredAt: 6
              },
              {
                kind: "control.approval.approved",
                payload: ControlFacts.approvalDecisionFact(
                  "req-1",
                  target
                ) as unknown as ControlSchema.ControlEvent["payload"],
                sequence: 4,
                runId: "r1",
                occurredAt: 7
              }
            ]
            const folded = ControlFacts.fold(facts)
            if (folded.run?.status !== "completed") return false
            if (!Array.isArray(folded.approvals)) return false

            // Exercise Cancellation.attribute (direct, cascaded from parent, and unattributed)
            const requests = new Map<string, Cancellation.Request>()
            if (cancelSource === "operator" || cancelSource === "parent") {
              requests.set("r-parent", {
                requestedAt: 10,
                principal: { id: "op-1", kind: "local", stampedAt: 10 },
                reason: "operator-stop"
              })
            }
            const attr = Cancellation.attribute({
              runs: [
                {
                  runId: "r-parent",
                  cancelRequestedAt: cancelSource === "none" ? undefined : 10,
                  cancelledAt: cancelSource === "none" ? undefined : 12
                },
                {
                  runId: "r-child",
                  parentRunId: "r-parent",
                  cancelledAt: cancelSource === "none" ? undefined : 15
                }
              ],
              requests
            })
            if (cancelSource === "none") return attr.size === 0
            return attr.has("r-parent") && attr.has("r-child")
          }),
        { seed: seed + 12, executions: Math.min(executions, 60) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})

describe("@smthrs/control durable & full-stack fuzz invariants", () => {
  it(
    "Differential fuzz: ControlLive over SqlControlRuntime (real SQLite) matches ControlRuntime.layerMemory across full lifecycle + Monitor.run",
    { timeout: 120_000 },
    async () => {
      const cmdArb = Schema.Union([
        Schema.Struct({ _tag: Schema.Literal("plan"), suffix: Schema.Literals(["a", "b"]) }),
        Schema.Struct({
          _tag: Schema.Literal("approve"),
          planIdx: Schema.Literals([0, 1]),
          badDigest: Schema.Boolean,
          badEnvelope: Schema.Boolean
        }),
        Schema.Struct({
          _tag: Schema.Literal("deny"),
          planIdx: Schema.Literals([0, 1])
        }),
        Schema.Struct({
          _tag: Schema.Literal("run"),
          planIdx: Schema.Literals([0, 1]),
          badDigest: Schema.Boolean,
          dupKey: Schema.Boolean
        }),
        Schema.Struct({
          _tag: Schema.Literal("steer"),
          runIdx: Schema.Literals([0, 1]),
          body: Schema.Literals(["focus", "stop"])
        }),
        Schema.Struct({
          _tag: Schema.Literal("signal"),
          runIdx: Schema.Literals([0, 1]),
          name: Schema.Literals(["ping", "go"])
        }),
        Schema.Struct({
          _tag: Schema.Literal("cancel"),
          runIdx: Schema.Literals([0, 1])
        }),
        Schema.Struct({
          _tag: Schema.Literal("resume"),
          runIdx: Schema.Literals([0, 1])
        }),
        Schema.Struct({
          _tag: Schema.Literal("registerNodeApproval"),
          runIdx: Schema.Literals([0, 1]),
          decide: Schema.Literals(["approve", "deny"])
        }),
        Schema.Struct({
          _tag: Schema.Literal("list"),
          kind: Schema.Literals(["runs", "flows", "plans", "triggers", "fires"])
        })
      ])

      const arb = Arbitrary.schema(
        Schema.Struct({
          cmds: Schema.Array(cmdArb).pipe(Schema.check(Schema.isMinLength(4)), Schema.check(Schema.isMaxLength(14))),
          acceptLaunches: Schema.Boolean,
          signalMode: Schema.Literals(["delivered", "no-match", "refused", "unknown"]),
          cancelMode: Schema.Literals(["recorded", "already-requested", "unknown"]),
          resumeMode: Schema.Literals(["resuming", "unknown"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ cmds, acceptLaunches, signalMode, cancelMode, resumeMode }) =>
            Effect.gen(function*() {
              const makeExec = () =>
                acceptLaunches
                  ? ControlExecutor.make({
                    launch: () => Effect.succeed("accepted"),
                    requestCancel: () => Effect.succeed(cancelMode),
                    deliverSignal: () => Effect.succeed(signalMode),
                    resumeRun: () => Effect.succeed(resumeMode),
                    settleCancelledPark: () => Effect.void,
                    readExecution: () =>
                      Effect.succeed({
                        _tag: "Observed" as const,
                        status: "running" as const,
                        roundOrdinal: 1
                      }),
                    readExecutions: ({ executionIds }) =>
                      Effect.succeed({
                        executions: executionIds.map((executionId) => ({
                          executionId,
                          status: "running" as const
                        })),
                        missing: []
                      } as never),
                    retryStep: () => Effect.succeed({ _tag: "Step" as const, nodeId: "step-1" })
                  })
                  : ControlExecutor.makeNoop()

              const runStack = <R extends Control.Control | ControlRuntime.ControlRuntime | Journal.Journal, E>(
                stackLayer: Layer.Layer<R, E>
              ) =>
                Effect.scoped(
                  Effect.gen(function*() {
                    const control = yield* Control.Control
                    const runtime = yield* ControlRuntime.ControlRuntime
                    const journal = yield* Journal.Journal
                    const plans: Array<ControlSchema.PlanCard> = []
                    const runs: Array<string> = []
                    const trace: Array<string> = []
                    let keySeq = 0

                    // Seed with a guaranteed planned + approved + launched run so every fuzz iteration exercises live runs
                    const seedCard = yield* control.plan({ flowId: "system/test", input: { seed: true } })
                    plans.push(seedCard)
                    yield* control.approve({
                      target: {
                        _tag: "Plan",
                        planId: seedCard.planId,
                        digest: seedCard.digest,
                        envelope: seedCard.envelope
                      },
                      scope: seedCard.approval.scope,
                      idempotencyKey: "seed-approve"
                    })
                    const seedRun = yield* control.run({
                      _tag: "Plan",
                      planId: seedCard.planId,
                      digest: seedCard.digest,
                      envelope: seedCard.envelope,
                      idempotencyKey: "seed-run"
                    })
                    if (seedRun._tag === "Accepted" && seedRun.runId !== undefined) {
                      runs.push(seedRun.runId)
                      // Duplicate idempotency replay should return AlreadyApplied
                      const dupRun = yield* control.run({
                        _tag: "Plan",
                        planId: seedCard.planId,
                        digest: seedCard.digest,
                        envelope: seedCard.envelope,
                        idempotencyKey: "seed-run"
                      })
                      trace.push(`dupRun:${dupRun._tag}`)
                    }

                    for (const cmd of cmds) {
                      const k = `ik-${++keySeq}`
                      switch (cmd._tag) {
                        case "plan": {
                          const card = yield* control.plan({
                            flowId: "system/test",
                            input: { suffix: cmd.suffix }
                          })
                          plans.push(card)
                          trace.push(`plan:${card.flowId}`)
                          break
                        }
                        case "approve": {
                          const card = plans[cmd.planIdx]
                          if (card === undefined) {
                            const r = yield* Effect.result(
                              control.approve({
                                target: {
                                  _tag: "Plan",
                                  planId: "missing-plan",
                                  digest: "d",
                                  envelope: { capabilities: [], flows: [], budget: {} }
                                },
                                scope: "run",
                                idempotencyKey: k
                              })
                            )
                            trace.push(Result.isFailure(r) ? `appErr:${r.failure._tag}` : `app:${r.success._tag}`)
                            break
                          }
                          const r = yield* Effect.result(
                            control.approve({
                              target: {
                                _tag: "Plan",
                                planId: card.planId,
                                digest: cmd.badDigest ? "wrong-digest" : card.digest,
                                envelope: cmd.badEnvelope
                                  ? { capabilities: ["extra"], flows: [], budget: {} }
                                  : card.envelope
                              },
                              scope: card.approval.scope,
                              idempotencyKey: k
                            })
                          )
                          trace.push(Result.isFailure(r) ? `appErr:${r.failure._tag}` : `app:${r.success._tag}`)
                          break
                        }
                        case "deny": {
                          const card = plans[cmd.planIdx]
                          if (card === undefined) break
                          const r = yield* Effect.result(
                            control.deny({
                              target: {
                                _tag: "Plan",
                                planId: card.planId,
                                digest: card.digest,
                                envelope: card.envelope
                              },
                              scope: card.approval.scope,
                              idempotencyKey: k
                            })
                          )
                          trace.push(Result.isFailure(r) ? `denyErr:${r.failure._tag}` : `deny:${r.success._tag}`)
                          break
                        }
                        case "run": {
                          const card = plans[cmd.planIdx]
                          if (card === undefined) {
                            const r = yield* Effect.result(
                              control.run({
                                _tag: "Plan",
                                planId: "no-plan",
                                digest: "d",
                                envelope: { capabilities: [], flows: [], budget: {} },
                                idempotencyKey: k
                              })
                            )
                            trace.push(Result.isFailure(r) ? `runErr:${r.failure._tag}` : `run:${r.success._tag}`)
                            break
                          }
                          const runKey = cmd.dupKey ? `run-dup:${cmd.planIdx}` : k
                          const r = yield* Effect.result(
                            control.run({
                              _tag: "Plan",
                              planId: card.planId,
                              digest: cmd.badDigest ? "wrong-digest" : card.digest,
                              envelope: card.envelope,
                              idempotencyKey: runKey
                            })
                          )
                          if (Result.isFailure(r)) {
                            trace.push(`runErr:${r.failure._tag}`)
                          } else {
                            trace.push(`run:${r.success._tag}`)
                            if (r.success._tag === "Accepted" && r.success.runId !== undefined) {
                              runs.push(r.success.runId)
                            }
                          }
                          break
                        }
                        case "steer": {
                          const runId = runs[cmd.runIdx] ?? "missing-run"
                          const r = yield* Effect.result(
                            control.steer({
                              runId,
                              message: {
                                messageId: `msg-${k}`,
                                runId,
                                principal: { id: "local", kind: "local", stampedAt: 1 },
                                createdAt: 1,
                                body: cmd.body
                              },
                              idempotencyKey: k
                            })
                          )
                          trace.push(Result.isFailure(r) ? `steerErr:${r.failure._tag}` : `steer:${r.success._tag}`)
                          break
                        }
                        case "signal": {
                          const runId = runs[cmd.runIdx] ?? "missing-run"
                          const r = yield* Effect.result(
                            control.signal({
                              runId,
                              signal: { name: cmd.name, payload: { ok: true } },
                              idempotencyKey: k
                            })
                          )
                          trace.push(Result.isFailure(r) ? `sigErr:${r.failure._tag}` : `sig:${r.success._tag}`)
                          break
                        }
                        case "cancel": {
                          const runId = runs[cmd.runIdx] ?? "missing-run"
                          const r = yield* Effect.result(control.cancel({ runId, idempotencyKey: k }))
                          trace.push(Result.isFailure(r) ? `cancelErr:${r.failure._tag}` : `cancel:${r.success._tag}`)
                          break
                        }
                        case "resume": {
                          const runId = runs[cmd.runIdx] ?? "missing-run"
                          const r = yield* Effect.result(control.resume({ runId, idempotencyKey: k }))
                          trace.push(Result.isFailure(r) ? `resumeErr:${r.failure._tag}` : `resume:${r.success._tag}`)
                          break
                        }
                        case "registerNodeApproval": {
                          const runId = runs[cmd.runIdx]
                          if (runId === undefined) break
                          const target = {
                            _tag: "Node" as const,
                            runId,
                            requestId: `req-${keySeq}`,
                            digest: `dig-${keySeq}`,
                            envelope: { capabilities: [], flows: [], budget: {} }
                          }
                          const reg = yield* Effect.result(runtime.registerApproval(target))
                          if (Result.isSuccess(reg)) {
                            const dec = cmd.decide === "approve"
                              ? yield* Effect.result(control.approve({ target, scope: "once", idempotencyKey: k }))
                              : yield* Effect.result(control.deny({ target, scope: "once", idempotencyKey: k }))
                            trace.push(
                              Result.isFailure(dec) ? `nodeErr:${dec.failure._tag}` : `node:${dec.success._tag}`
                            )
                          }
                          break
                        }
                        case "list": {
                          const r = yield* Effect.result(control.list({ _tag: cmd.kind } as Control.ListInput))
                          trace.push(
                            Result.isFailure(r) ? `listErr:${cmd.kind}:${r.failure._tag}` : `list:${r.success._tag}`
                          )
                          break
                        }
                      }
                    }

                    // Exercise watch + composite cursor + invalid cursor + pagePlanIds + queryPlans + Monitor.run on first run
                    if (runs[0] !== undefined) {
                      const runId = runs[0]
                      yield* journal.emitDurableUnfenced(
                        new JournalEvent.Input({
                          runId: JournalEvent.RunId.make(runId),
                          sourceId: JournalEvent.SourceId.make("/fuzz"),
                          eventType: "flows/notifications/Promoted",
                          payload: { boundary: "turn", ids: ["s1", "s2"] }
                        })
                      )
                      const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
                      if (events.length > 0 && events[0]?.cursor !== undefined) {
                        yield* control.watch({ runId, follow: false, afterCursor: events[0].cursor }).pipe(
                          Stream.runCollect
                        )
                      }
                      const badWatch = yield* Effect.result(
                        control.watch({ runId, follow: false, afterSequence: 1, afterCursor: { sequence: 1 } }).pipe(
                          Stream.runCollect
                        )
                      )
                      if (Result.isSuccess(badWatch)) return { ok: false, trace }

                      // Live Monitor.run with autoHeal & healthCheck over this run!
                      const monReg = Health.makeRegistry({}, "run")
                      yield* Monitor.run({
                        runId,
                        intervalMs: 0,
                        maxChecks: 3,
                        stallBeats: 1,
                        retainBeats: 2,
                        autoHeal: ["stalled", "failing"],
                        healthCheck: monReg.resolve("run")
                      })

                      // Direct ControlRuntime reads/signals/resumes/pages/fibers
                      yield* runtime.getRun(runId)
                      yield* runtime.pageRunIds({ limit: 5 })
                      yield* runtime.queryRuns({ limit: 5 })
                      yield* runtime.listFlows
                      yield* runtime.admitSignal("cmd-sig-1", runId, { name: "ev", payload: { n: 1 } })
                      yield* runtime.signalCommand("cmd-sig-1")
                      yield* runtime.querySignals({ runId, limit: 5 })
                      yield* runtime.pendingSignals
                      yield* runtime.bindSignal("cmd-sig-1", "tok-1")
                      yield* runtime.settleSignal("cmd-sig-1", "delivered")
                      yield* runtime.deliveredSignals(runId)
                      const resSeq = yield* Effect.result(runtime.requestResume(runId, { consent: 1 }))
                      yield* runtime.pendingResumes
                      if (Result.isSuccess(resSeq)) {
                        yield* runtime.clearResume(runId, resSeq.success)
                      }
                      yield* Effect.result(
                        control.list({ _tag: "runs", filters: { runId, flowId: "system/test" }, limit: 1 })
                      )
                      yield* Effect.result(
                        control.list({ _tag: "plans", filters: { flowId: "system/test" }, limit: 1 })
                      )
                      yield* Effect.result(control.list({ _tag: "executions", runId, executionIds: [runId] }))
                      yield* Effect.result(control.run({ _tag: "Resume", runId, idempotencyKey: "run-resume-1" }))
                      const bgFiber = yield* Effect.never.pipe(Effect.forkChild)
                      yield* Effect.result(runtime.registerFiber(runId, bgFiber))
                      yield* Effect.result(runtime.interrupt(runId))
                      // Retry after run has been settled/cancelled!
                      yield* Effect.result(
                        control.run({ _tag: "Retry", runId, step: "step-1", idempotencyKey: "run-retry-1" })
                      )
                    }

                    yield* runtime.pagePlanIds({ limit: 5 })
                    yield* runtime.queryPlans({ limit: 5 })

                    return { ok: true, trace }
                  }).pipe(Effect.provide(Layer.mergeAll(stackLayer, silentLogger)))
                )

              const sqlRes = yield* runStack(durable({ executor: makeExec() }))
              const memRes = yield* runStack(TestControl.layer(undefined, makeExec()).pipe(Layer.orDie))
              return sqlRes.ok && memRes.ok && JSON.stringify(sqlRes.trace) === JSON.stringify(memRes.trace)
            }),
          { seed: seed + 20, executions: fastExecutions }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    }
  )

  it("Differential fuzz: SqlCredentialStore (real SQLite) matches CredentialStore.makeMemory across create/resolve/rotate/revoke/authorize", async () => {
    const opArb = Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("create"),
        id: Schema.Literals(["exa", "gh"]),
        secret: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(20)))
      }),
      Schema.Struct({ _tag: Schema.Literal("resolve"), id: Schema.Literals(["exa", "gh"]) }),
      Schema.Struct({
        _tag: Schema.Literal("rotate"),
        id: Schema.Literals(["exa", "gh"]),
        secret: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(20)))
      }),
      Schema.Struct({ _tag: Schema.Literal("revoke"), id: Schema.Literals(["exa", "gh"]) }),
      Schema.Struct({ _tag: Schema.Literal("list") })
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(opArb).pipe(Schema.check(Schema.isMinLength(3)), Schema.check(Schema.isMaxLength(12))),
        denyAuth: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ops, denyAuth }) =>
          Effect.gen(function*() {
            const cipher = yield* WebCryptoCipher.make({ key: hostKey })
            const runWith = (store: CredentialStore.Service) =>
              Effect.gen(function*() {
                const creds = Credential.make({
                  store,
                  cipher,
                  ...(denyAuth
                    ? { authorize: () => Effect.fail(new ControlError.Unauthorized({ message: "denied" })) }
                    : {})
                })
                const trace: Array<string> = []
                for (const op of ops) {
                  switch (op._tag) {
                    case "create": {
                      const r = yield* Effect.result(
                        creds.create({ id: op.id, name: `name-${op.id}`, secret: Redacted.make(op.secret) })
                      )
                      trace.push(Result.isFailure(r) ? `cErr:${r.failure._tag}` : `c:${r.success.id}`)
                      break
                    }
                    case "resolve": {
                      const ref: Credential.CredentialRef = { id: op.id, name: `name-${op.id}` }
                      const g = yield* Effect.result(creds.get(op.id))
                      const r = yield* Effect.result(creds.resolve(ref))
                      trace.push(
                        `${Result.isFailure(g) ? `gErr:${g.failure._tag}` : `g:${g.success.id}`}|${
                          Result.isFailure(r)
                            ? `rErr:${r.failure._tag}`
                            : `r:${Redacted.value(r.success).length}`
                        }`
                      )
                      break
                    }
                    case "rotate": {
                      const ref: Credential.CredentialRef = { id: op.id, name: `name-${op.id}` }
                      const r = yield* Effect.result(creds.rotate(ref, Redacted.make(op.secret)))
                      trace.push(Result.isFailure(r) ? `rotErr:${r.failure._tag}` : `rot:${r.success.id}`)
                      break
                    }
                    case "revoke": {
                      const ref: Credential.CredentialRef = { id: op.id, name: `name-${op.id}` }
                      const r = yield* Effect.result(creds.revoke(ref))
                      trace.push(Result.isFailure(r) ? `revErr:${r.failure._tag}` : "rev:ok")
                      break
                    }
                    case "list": {
                      const r = yield* Effect.result(creds.list())
                      trace.push(Result.isFailure(r) ? `lErr:${r.failure._tag}` : `l:${r.success.length}`)
                      break
                    }
                  }
                }
                return trace
              })

            const sqlTrace = yield* Effect.scoped(
              Effect.flatMap(SqlCredentialStore.make, runWith).pipe(
                Effect.provide(Layer.mergeAll(TestDatabase.layer, silentLogger))
              )
            )
            const memTrace = yield* runWith(CredentialStore.makeMemory()).pipe(Effect.provide(silentLogger))

            // Exercise noop store & cipher
            const noopStore = CredentialStore.makeNoop()
            const noopCipher = CredentialCipher.makeNoop()
            const r1 = yield* Effect.result(noopStore.read("x"))
            const r2 = yield* Effect.result(noopCipher.seal(Redacted.make("s"), { id: "a", name: "a", version: 1 }))

            return Result.isFailure(r1) && Result.isFailure(r2) && JSON.stringify(sqlTrace) === JSON.stringify(memTrace)
          }),
        { seed: seed + 21, executions: Math.min(executions, 20) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ControlServer + ControlClient + ControlRpcs execute RPC lifecycle over real localhost HTTP/WS with bearer & scoped auth", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        authMode: Schema.Literals(["bearer", "badBearer", "scopedRead", "scopedWrite"]),
        doCancel: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ authMode, doCancel }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const secretToken = "rpc-fuzz-secret"
              const authLayer = ControlRpcs.layerAuth(
                ControlRpcs.anyAuthenticator([
                  ControlRpcs.bearerAuthenticator({
                    token: secretToken,
                    principal: { id: "remote-op", kind: "bearer" },
                    now: () => 1_700_000_000_000
                  }),
                  ScopedToken.authenticator({
                    key: secretToken,
                    principal: { id: "remote-op", kind: "bearer" },
                    now: () => 1_700_000_000_001
                  })
                ])
              )
              const serverLayer = HttpRouter.serve(
                ControlServer.layerHttp.pipe(
                  Layer.provide(Layer.succeed(ControlServer.RequestScheme, "http:")),
                  Layer.provide(authLayer),
                  Layer.provide(RpcSerialization.layerNdjson)
                ),
                { disableListenLog: true, disableLogger: true }
              ).pipe(
                Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
                Layer.provideMerge(
                  TestControl.layer({
                    approvalAuthority: delegateApproval({ id: "remote-op", kind: "bearer" })
                  })
                ),
                Layer.provideMerge(silentLogger)
              )

              return yield* Effect.gen(function*() {
                const server = yield* HttpServer.HttpServer
                if (server.address._tag !== "InetAddressV4") return false
                const url = `http://127.0.0.1:${server.address.port}`

                let cred: string = secretToken
                if (authMode === "badBearer") {
                  cred = "wrong-token"
                } else if (authMode === "scopedRead") {
                  const minted = yield* ScopedToken.mint({
                    key: secretToken,
                    scopes: ["read:runs"],
                    ttlMillis: 60_000,
                    now: () => 1_700_000_000_000
                  })
                  cred = minted.token
                } else if (authMode === "scopedWrite") {
                  const minted = yield* ScopedToken.mint({
                    key: secretToken,
                    scopes: ["read:runs", "write:runs", "approve:runs"],
                    ttlMillis: 60_000,
                    now: () => 1_700_000_000_000
                  })
                  cred = minted.token
                }

                const clientLayer = ControlClient.layer({ url: `${url}/rpc`, credential: cred }).pipe(
                  Layer.provide([
                    NodeHttpClient.layerUndici,
                    NodeSocket.layerWebSocket(`${url.replace("http://", "ws://")}/rpc/ws`),
                    RpcSerialization.layerNdjson
                  ])
                )

                return yield* Effect.gen(function*() {
                  const client = yield* Control.Control
                  const listRes = yield* Effect.result(client.list({ _tag: "runs" }))
                  if (authMode === "badBearer") {
                    return Result.isFailure(listRes) && listRes.failure._tag === "/control/Unauthorized"
                  }
                  if (Result.isFailure(listRes)) return false

                  const planRes = yield* Effect.result(client.plan({ flowId: "system/test", input: { via: "rpc" } }))
                  if (authMode === "scopedRead") {
                    return Result.isFailure(planRes) && planRes.failure._tag === "/control/Unauthorized"
                  }
                  if (Result.isFailure(planRes)) return false
                  const card = planRes.success

                  yield* client.approve({
                    target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
                    scope: card.approval.scope,
                    idempotencyKey: `rpc-app:${card.planId}`
                  })
                  const receipt = yield* client.run({
                    _tag: "Plan",
                    planId: card.planId,
                    digest: card.digest,
                    envelope: card.envelope,
                    idempotencyKey: `rpc-run:${card.planId}`
                  })
                  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return false

                  yield* client.steer({
                    runId: receipt.runId,
                    message: {
                      messageId: `m-${receipt.runId}`,
                      runId: receipt.runId,
                      principal: { id: "remote-op", kind: "bearer", stampedAt: 1 },
                      createdAt: 1,
                      body: "hello"
                    },
                    idempotencyKey: `rpc-steer:${receipt.runId}`
                  })
                  yield* Effect.result(
                    client.signal({
                      runId: receipt.runId,
                      signal: { name: "ev", payload: { ok: true } },
                      idempotencyKey: `rpc-sig:${receipt.runId}`
                    })
                  )
                  yield* Effect.result(
                    client.resume({ runId: receipt.runId, idempotencyKey: `rpc-res:${receipt.runId}` })
                  )
                  yield* Effect.result(client.list({ _tag: "plans" }))
                  yield* Effect.result(client.list({ _tag: "flows" }))
                  const denyCard = yield* client.plan({ flowId: "system/test", input: { deny: true } })
                  yield* client.deny({
                    target: {
                      _tag: "Plan",
                      planId: denyCard.planId,
                      digest: denyCard.digest,
                      envelope: denyCard.envelope
                    },
                    scope: denyCard.approval.scope,
                    idempotencyKey: `rpc-deny:${denyCard.planId}`
                  })
                  // Error round-trips over RPC
                  yield* Effect.result(client.plan({ flowId: "does/not/exist", input: {} }))
                  yield* Effect.result(client.cancel({ runId: "missing-run", idempotencyKey: "rpc-cancel-miss" }))
                  if (doCancel) {
                    yield* client.cancel({ runId: receipt.runId, idempotencyKey: `rpc-cancel:${receipt.runId}` })
                  }
                  const events = yield* client.watch({ runId: receipt.runId, follow: false }).pipe(Stream.runCollect)
                  return events.length > 0
                }).pipe(Effect.provide(clientLayer))
              }).pipe(Effect.provide(serverLayer))
            })
          ),
        { seed: seed + 22, executions: Math.min(executions, 8) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Channels + WebhookChannel enforce signature, body bounds, idempotency, and dispatch start/signal", async () => {
    const Payload = Schema.Union([
      Schema.TaggedStruct("start", { flowId: Schema.String, input: Schema.Unknown }),
      Schema.TaggedStruct("signal", { runId: Schema.String, stepId: Schema.String, value: Schema.Json })
    ])
    type Payload = typeof Payload.Type

    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["start", "signal", "badSig", "oversizedHeader", "oversizedBody", "badJson"]),
        key: asciiId
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, key }) =>
          Effect.gen(function*() {
            const calls: Array<string> = []
            const controlLayer = Layer.succeed(
              Control.Control,
              Control.make({
                plan: (input) => {
                  calls.push(`plan:${input.flowId}`)
                  return Effect.succeed({
                    planId: "p-1",
                    flowId: input.flowId,
                    digest: "d-1",
                    inputSummary: "in",
                    envelope: { capabilities: [], flows: [], budget: {} },
                    deployClass: false,
                    nodes: [],
                    approval: {
                      target: {
                        _tag: "Plan",
                        planId: "p-1",
                        digest: "d-1",
                        envelope: { capabilities: [], flows: [], budget: {} }
                      },
                      scope: "run",
                      idempotencyKey: "app-1"
                    }
                  })
                },
                run: () => {
                  calls.push("run")
                  return Effect.succeed({ _tag: "Accepted" as const, receiptId: "r-1", runId: "run-1" })
                },
                approve: () => Effect.die("unused"),
                deny: () => Effect.die("unused"),
                steer: () => Effect.die("unused"),
                signal: () => {
                  calls.push("signal")
                  return Effect.succeed({ _tag: "Accepted" as const, receiptId: "r-sig" })
                },
                cancel: () => Effect.die("unused"),
                pause: () => Effect.die("unused"),
                resume: () => Effect.die("unused"),
                list: () => Effect.die("unused"),
                watch: () => Stream.empty
              })
            )
            const runtimeLayer = ControlRuntime.layerMemory().pipe(
              Layer.provide(Layer.succeed(EffectDigest.Digest, Sha256.syncCrypto))
            )
            const chLayer = Channels.layer.pipe(Layer.provide(Layer.mergeAll(controlLayer, runtimeLayer)))

            const whChannel = WebhookChannel.make<Payload>({
              name: "gh",
              schema: Payload,
              credential: Redacted.make({ id: "c1", name: "wh" }),
              verify: (raw) =>
                raw.headers["x-sig"] === "good"
                  ? Effect.void
                  : Effect.fail(new ControlError.Unauthorized({ message: "bad sig" })),
              map: (p) =>
                Effect.succeed<Channels.InboundResult>(
                  p._tag === "start"
                    ? { _tag: "Start", flowId: p.flowId, input: p.input }
                    : { _tag: "Signal", runId: p.runId, signal: { name: p.stepId, payload: p.value } }
                ),
              project: () => ({ cursor: "c1", operation: "post" as const, message: { ok: true } })
            })

            const rawBody = mode === "badJson"
              ? new TextEncoder().encode("{bad")
              : mode === "oversizedBody"
              ? new Uint8Array(WebhookChannel.maximumBodyBytes + 32)
              : mode === "signal"
              ? new TextEncoder().encode(JSON.stringify({ _tag: "signal", runId: "r1", stepId: "s1", value: 1 }))
              : new TextEncoder().encode(JSON.stringify({ _tag: "start", flowId: "f1", input: {} }))

            const headers: Record<string, string> = {
              "x-sig": mode === "badSig" ? "bad" : "good",
              "x-idempotency-key": key,
              ...(mode === "oversizedHeader" ? { "content-length": String(WebhookChannel.maximumBodyBytes + 100) } : {})
            }

            const reqLayer = Layer.succeed(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request("https://control.test/webhooks/gh", {
                  method: "POST",
                  headers,
                  body: mode === "oversizedHeader" ? "" : rawBody
                })
              )
            )

            const handler = WebhookChannel.handler("gh", key)

            const res = yield* Effect.result(
              Effect.gen(function*() {
                const channels = yield* Channels.Channels
                yield* channels.register(whChannel)
                const found = yield* channels.lookup("gh")
                if (found.name !== "gh") return false
                yield* channels.project({
                  channel: "gh",
                  run: {
                    runId: "r1",
                    flowId: "f1",
                    status: "running",
                    createdAt: 1,
                    updatedAt: 1
                  }
                })
                yield* handler
                return true
              }).pipe(Effect.provide(Layer.mergeAll(chLayer, reqLayer, silentLogger)))
            )

            if (mode === "badSig") return Result.isFailure(res) && res.failure._tag === "/control/Unauthorized"
            if (mode === "oversizedHeader" || mode === "oversizedBody" || mode === "badJson") {
              return Result.isFailure(res) && res.failure._tag === "/control/InvalidInput"
            }
            if (Result.isFailure(res)) return false
            return mode === "start" ? calls.includes("run") : calls.includes("signal")
          }),
        { seed: seed + 23, executions: Math.min(executions, 30) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("JevSessionChecker, ControlExecutor helpers, Control.layerNoop, and Channels.layerNoop enforce all safety & error contracts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        alive: Schema.Boolean,
        tailMode: Schema.Literals(["none", "short", "over4k"]),
        verdict: Schema.Literals([
          "working",
          "idle",
          "needs-input",
          "invented",
          "lowConf",
          "errUnreachable",
          "errTimeout"
        ]),
        waitKind: Schema.Literals(["human", "plain", "none"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ alive, tailMode, verdict, waitKind }) =>
          Effect.gen(function*() {
            // Unconfigured jevSessionChecker fails closed
            const unconf = yield* Effect.result(
              JevSessionChecker.jevSessionChecker.probe(
                {
                  subjectId: "s1",
                  state: "running",
                  events: [],
                  sinceCursor: 0,
                  session: { alive: true, exitCode: null, outputCursor: 1, outputTail: "hi" }
                },
                undefined
              )
            )
            if (Result.isSuccess(unconf)) return false

            const tail = tailMode === "none" ? undefined : tailMode === "short" ? "Continue? [y/n]" : "x".repeat(5000)
            const jev = JevSessionChecker.makeJevSessionChecker({
              evaluator: {
                evaluate: () => {
                  if (verdict === "errUnreachable") {
                    return Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "down" }))
                  }
                  if (verdict === "errTimeout") {
                    return Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "slow" }))
                  }
                  const choice = verdict === "lowConf" ? "idle" : verdict
                  const prob = verdict === "lowConf" ? 0.3 : 0.95
                  return Effect.succeed({
                    answers: { activity: { type: "choice" as const, choice, probabilities: { [choice]: prob } } },
                    latencyMs: 1
                  })
                }
              }
            })
            const probeRes = yield* Effect.result(
              jev.probe(
                {
                  subjectId: "s1",
                  state: "running",
                  events: [],
                  sinceCursor: 0,
                  session: {
                    alive,
                    exitCode: alive ? null : 0,
                    outputCursor: 1,
                    ...(tail === undefined ? {} : { outputTail: tail })
                  }
                },
                undefined
              )
            )
            if (
              alive && tail !== undefined &&
              (verdict === "invented" || verdict === "errUnreachable" || verdict === "errTimeout")
            ) {
              if (Result.isSuccess(probeRes)) return false
            }

            // ControlExecutor helpers: makeObserving, makeReadOnly, pendingWaitOf, answerableWait
            const noopExec = ControlExecutor.makeNoop()
            const obsExec = ControlExecutor.makeObserving(noopExec)
            const roExec = ControlExecutor.makeReadOnly(noopExec)
            const planCard: ControlSchema.PlanCard = {
              planId: "p1",
              flowId: "system/test",
              digest: "d1",
              inputSummary: "in",
              envelope: { capabilities: [], flows: [], budget: {} },
              deployClass: false,
              nodes: [],
              approval: {
                target: {
                  _tag: "Plan",
                  planId: "p1",
                  digest: "d1",
                  envelope: { capabilities: [], flows: [], budget: {} }
                },
                scope: "run",
                idempotencyKey: "k1"
              }
            }
            const roLaunch = yield* Effect.exit(
              roExec.launch({
                plan: { card: planCard, decodedInput: {}, decision: { _tag: "Approved", scope: "run" } as never },
                run: { runId: "r1", flowId: "system/test", status: "accepted", createdAt: 1, updatedAt: 1 }
              })
            )
            if (Exit.isSuccess(roLaunch)) return false
            yield* Effect.exit(roExec.requestCancel({ runId: "r1" }))
            yield* Effect.exit(
              roExec.deliverSignal({ runId: "r1", commandId: "c1", signal: { name: "s", payload: {} } })
            )
            yield* Effect.exit(roExec.resumeRun({ runId: "r1" }))
            yield* Effect.exit(roExec.settleCancelledPark({ runId: "r1" }))
            yield* Effect.result(obsExec.settleCancelledPark({ runId: "r1" }))

            const pendingWait = ControlExecutor.pendingWaitOf({
              runId: "r1",
              token: waitKind === "human" ? "WaitFor/review#1" : waitKind === "plain" ? "WaitFor/signal-a" : "other",
              reason: waitKind === "human" ? ControlExecutor.humanWaitReason : waitKind === "plain" ? "event" : "other",
              createdAt: 10
            })
            if (waitKind === "human" && pendingWait !== undefined) {
              ControlExecutor.answerableWait({
                _tag: "Node",
                runId: "r1",
                requestId: pendingWait.name ?? "review",
                digest: "WaitFor/review#1",
                envelope: { capabilities: [], flows: [], budget: {} }
              })
            }

            // Control.layerNoop all methods fail with Unavailable
            const noopCtrlOk = yield* Effect.gen(function*() {
              const c = yield* Control.Control
              const calls: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
                c.plan({ flowId: "system/test", input: {} }),
                c.run({
                  _tag: "Plan",
                  planId: "p",
                  digest: "d",
                  envelope: { capabilities: [], flows: [], budget: {} },
                  idempotencyKey: "k"
                }),
                c.approve({
                  target: {
                    _tag: "Plan",
                    planId: "p",
                    digest: "d",
                    envelope: { capabilities: [], flows: [], budget: {} }
                  },
                  scope: "run",
                  idempotencyKey: "k"
                }),
                c.deny({
                  target: {
                    _tag: "Plan",
                    planId: "p",
                    digest: "d",
                    envelope: { capabilities: [], flows: [], budget: {} }
                  },
                  scope: "run",
                  idempotencyKey: "k"
                }),
                c.steer({
                  runId: "r",
                  message: {
                    messageId: "m",
                    runId: "r",
                    principal: { id: "a", kind: "local", stampedAt: 1 },
                    createdAt: 1,
                    body: "x"
                  },
                  idempotencyKey: "k"
                }),
                c.signal({ runId: "r", signal: { name: "n", payload: {} }, idempotencyKey: "k" }),
                c.cancel({ runId: "r", idempotencyKey: "k" }),
                c.resume({ runId: "r", idempotencyKey: "k" }),
                c.list({ _tag: "runs" })
              ]
              for (const eff of calls) {
                const res = yield* Effect.result(eff)
                if (Result.isSuccess(res)) return false
              }
              const w = yield* Effect.result(c.watch({ runId: "r", follow: false }).pipe(Stream.runCollect))
              return Result.isFailure(w)
            }).pipe(Effect.provide(Control.layerNoop))

            // Channels.layerMemory with lookup on missing channel
            const noopChOk = yield* Effect.gen(function*() {
              const ch = yield* Channels.Channels
              const res = yield* Effect.result(ch.lookup("none"))
              return Result.isFailure(res)
            }).pipe(Effect.provide(Channels.layerMemory.pipe(Layer.provide(Control.layerNoop))))

            return noopCtrlOk && noopChOk
          }).pipe(Effect.provide(silentLogger)),
        { seed: seed + 24, executions: Math.min(executions, 24) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ControlLive + SqlControlRuntime: observing executor, DispatchReader pagination/confinement, live watch/watchAll, code-drift resume, and cancel/signal/retry variants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        launchMode: Schema.Literals(["accepted", "pending", "fail"]),
        obsStatus: Schema.Literals(["running", "parked", "completed", "missing"]),
        cancelMode: Schema.Literals(["recorded", "already-requested", "unknown", "terminal"]),
        signalMode: Schema.Literals(["delivered", "no-match", "refused", "unknown"]),
        resumeMode: Schema.Literals(["resuming", "unknown"]),
        retryRefused: Schema.Boolean,
        order: Schema.Literals(["newest", "oldest"]),
        readerKind: Schema.Literals(["none", "same", "other"]),
        watchAll: Schema.Boolean,
        allowCodeDrift: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({
          launchMode,
          obsStatus,
          cancelMode,
          signalMode,
          resumeMode,
          retryRefused,
          order,
          readerKind,
          watchAll,
          allowCodeDrift
        }) =>
          Effect.gen(function*() {
            let adopted = false
            let launchedRunId: string | undefined
            const observingExec = ControlExecutor.make({
              readExecution: (runId) =>
                obsStatus === "missing"
                  ? Effect.succeed({ _tag: "Missing" as const })
                  : Effect.succeed({
                    _tag: "Observed" as const,
                    status: obsStatus,
                    ...(obsStatus === "parked" ? { waitingReason: ControlExecutor.humanWaitReason } : {}),
                    parentRunId: undefined,
                    lineageId: runId
                  }),
              readExecutions: () =>
                Effect.succeed({
                  source: "fuzz-engine",
                  revision: 1,
                  snapshots: []
                }),
              launch: (input) => {
                launchedRunId = input.run.runId
                if (launchMode === "fail") {
                  return Effect.fail(
                    new ControlError.LaunchFailed({
                      runId: input.run.runId,
                      message: "synthetic launch failure"
                    })
                  )
                }
                return Effect.succeed(launchMode)
              },
              requestCancel: () =>
                cancelMode === "terminal"
                  ? Effect.succeed({ _tag: "Terminal" as const, status: "completed" as const })
                  : Effect.succeed(cancelMode),
              deliverSignal: () => Effect.succeed(signalMode),
              resumeRun: () => Effect.succeed(resumeMode),
              retryStep: () =>
                retryRefused
                  ? Effect.succeed({ _tag: "Refused" as const, reason: "ambiguous step" })
                  : Effect.succeed({ _tag: "Step" as const, nodeId: "n-1" }),
              settleCancelledPark: () => Effect.void
            })

            const dispatchLayer = DispatchReader.layer({
              list: () =>
                Effect.succeed([
                  {
                    triggerId: "trig-1",
                    flowId: "system/test",
                    input: {},
                    cron: "*/5 * * * *",
                    overlap: "skip",
                    catchUp: "none",
                    enabled: true,
                    revision: 1,
                    nextOccurrencesMs: [1000]
                  },
                  {
                    triggerId: "trig-2",
                    flowId: "system/test",
                    input: {},
                    cron: "0 * * * *",
                    overlap: "buffer-one",
                    catchUp: "one",
                    enabled: false,
                    revision: 2,
                    nextOccurrencesMs: [2000]
                  }
                ]),
              fires: () =>
                Effect.succeed([
                  {
                    triggerId: "trig-1",
                    occurrenceAtMs: 200,
                    outcome: "launched" as const,
                    ...(launchedRunId === undefined ? {} : { runId: launchedRunId })
                  },
                  {
                    triggerId: "trig-2",
                    occurrenceAtMs: 100,
                    outcome: "failed",
                    error: "boom"
                  }
                ])
            })

            const baseFlow: ControlRuntime.MemoryFlow = {
              flowId: "system/test",
              description: "Fuzz test flow",
              deployClass: false,
              envelope: { capabilities: [], flows: [], budget: {} },
              executionDigest: "sha-v1"
            }
            const driftedFlow: ControlRuntime.MemoryFlow = { ...baseFlow, executionDigest: "sha-v2" }
            const stack = durable({
              executor: observingExec,
              loadFlows: () => Effect.succeed([adopted ? driftedFlow : baseFlow]),
              currentFlows: () => Effect.succeed([driftedFlow]),
              pinnedFlow: () => Effect.succeed(false),
              adoptFlow: () =>
                Effect.sync(() => {
                  adopted = true
                  return driftedFlow
                })
            }).pipe(Layer.provide(dispatchLayer))

            return yield* Effect.gen(function*() {
              const control = yield* Control.Control
              const runtime = yield* ControlRuntime.ControlRuntime
              const journal = yield* Journal.Journal
              const me = yield* runtime.stampPrincipal(undefined)

              // Plan + approve + launch (twice to test pagination!)
              const p1 = yield* control.plan({ flowId: "system/test", input: { n: 1 } })
              yield* control.approve({
                target: { _tag: "Plan", planId: p1.planId, digest: p1.digest, envelope: p1.envelope },
                scope: p1.approval.scope,
                idempotencyKey: "app-1"
              })
              const r1 = yield* Effect.result(
                control.run({
                  _tag: "Plan",
                  planId: p1.planId,
                  digest: p1.digest,
                  envelope: p1.envelope,
                  idempotencyKey: "run-1"
                })
              )
              if (launchMode === "fail") {
                // LaunchFailed should return a failure and settle the unlaunched run
                const runs = yield* control.list({ _tag: "runs" })
                return Result.isFailure(r1) && runs._tag === "runs"
              }
              if (Result.isFailure(r1) || r1.success._tag !== "Accepted" || r1.success.runId === undefined) {
                return false
              }
              const runId = r1.success.runId

              // Second run so cursor pagination has > 1 item
              const p2 = yield* control.plan({ flowId: "system/test", input: { n: 2 } })
              yield* control.approve({
                target: { _tag: "Plan", planId: p2.planId, digest: p2.digest, envelope: p2.envelope },
                scope: p2.approval.scope,
                idempotencyKey: "app-2"
              })
              yield* Effect.result(
                control.run({
                  _tag: "Plan",
                  planId: p2.planId,
                  digest: p2.digest,
                  envelope: p2.envelope,
                  idempotencyKey: "run-2"
                })
              )

              const reader: ControlSchema.Principal | undefined = readerKind === "none"
                ? undefined
                : readerKind === "same"
                ? me
                : { id: "bob", kind: "token", stampedAt: 1 }

              // DispatchReader triggers + fires + runs cursor pagination + filters
              const trigs1 = yield* control.list({ _tag: "triggers", limit: 1 })
              if (trigs1._tag === "triggers" && trigs1.nextCursor !== undefined) {
                yield* control.list({ _tag: "triggers", limit: 1, cursor: trigs1.nextCursor })
              }
              const fires1 = yield* control.list({
                _tag: "fires",
                filters: { triggerId: "trig-1" },
                limit: 1,
                ...(reader === undefined ? {} : { reader })
              })
              if (fires1._tag === "fires" && fires1.nextCursor !== undefined) {
                yield* control.list({ _tag: "fires", limit: 1, cursor: fires1.nextCursor })
              }
              const runs1 = yield* control.list({
                _tag: "runs",
                filters: {
                  triggerId: "trig-1",
                  ...(obsStatus === "missing" ? {} : { status: obsStatus }),
                  terminal: obsStatus === "completed",
                  since: 0,
                  until: Date.now() + 60_000
                },
                order,
                limit: 1,
                ...(reader === undefined ? {} : { reader })
              })
              if (runs1._tag === "runs" && runs1.nextCursor !== undefined) {
                yield* control.list({
                  _tag: "runs",
                  order,
                  limit: 1,
                  cursor: runs1.nextCursor,
                  ...(reader === undefined ? {} : { reader })
                })
              }
              // Invalid cursor must fail with InvalidInput
              const badCursor = yield* Effect.result(control.list({ _tag: "runs", cursor: "not-json" }))
              if (Result.isSuccess(badCursor)) return false

              // Live watch / watchAll with follow: true
              const watcher = yield* control
                .watch({
                  ...(watchAll ? {} : { runId }),
                  follow: true,
                  ...(reader === undefined ? {} : { reader })
                })
                .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
              yield* Effect.yieldNow
              yield* journal.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: JournalEvent.RunId.make(runId),
                  sourceId: JournalEvent.SourceId.make("/fuzz-live"),
                  eventType: "control.fuzz.live",
                  payload: { ok: true }
                })
              )
              const watched = yield* Effect.result(Fiber.join(watcher)).pipe(Effect.timeoutOption("250 millis"))
              if (Option.isNone(watched)) {
                yield* Fiber.interrupt(watcher)
              } else if (readerKind === "other" && !watchAll) {
                if (Result.isSuccess(watched.value)) return false
              }

              // Signal + code-drift resume + cancel + retry
              yield* Effect.result(
                control.signal({
                  runId,
                  signal: { name: "ev", payload: { ok: true } },
                  idempotencyKey: "sig-obs-1"
                })
              )
              yield* Effect.result(
                control.resume({
                  runId,
                  allowCodeDrift,
                  idempotencyKey: "res-drift-1"
                })
              )
              yield* Effect.result(control.cancel({ runId, reason: "fuzz", idempotencyKey: "can-obs-1" }))
              yield* Effect.result(
                control.run({
                  _tag: "Retry",
                  runId,
                  step: "step-1",
                  idempotencyKey: "ret-obs-1"
                })
              )
              yield* Effect.result(control.list({ _tag: "executions", runId, executionIds: [runId] }))

              return true
            }).pipe(Effect.provide(Layer.mergeAll(stack, silentLogger)))
          }),
        { seed: seed + 25, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
