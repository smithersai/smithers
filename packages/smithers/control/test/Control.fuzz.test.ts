import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Logger, Redacted, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ApprovalAuthority, ScopedToken, WebCryptoCipher } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "150"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])
const asciiId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,20}$/)))

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
            // TextEncoder replaces lone surrogates with U+FFFD, so compare UTF-8 round-trip
            const expectedUtf8 = new TextDecoder().decode(new TextEncoder().encode(secret))
            if (Redacted.value(opened) !== expectedUtf8) return false
            if (
              Result.isSuccess(yield* Effect.result(cipher.open(sealed, { ...ctx, version: version + 1 })))
            ) return false
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

import { Lineage, Monitor, Steering } from "../src/index.ts"

describe("@smthrs/control Monitor, Lineage & Steering projection fuzz invariants", () => {
  it("Monitor.classify & remedyFor preserve strict health precedence (awaiting-human NEVER auto-healed, finished runs healthy)", async () => {
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
            // CRITICAL SAFETY INVARIANT: awaiting-human NEVER gets auto-resumed or auto-cancelled!
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

  it("Lineage.originOf/expand and Steering.expand never drop the original event or throw on arbitrary payloads", async () => {
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
              forkedFromRunId: hasFork ? "f1" : undefined,
              continuedFromRunId: hasPrev ? "c1" : undefined
            } as unknown as Lineage.Ancestry)
            if (origin !== undefined && origin !== "child" && origin !== "fork" && origin !== "continuation") {
              return false
            }
            const ev = {
              runId: "r1",
              seq: 1,
              kind,
              at: 1_700_000_000_000,
              payload: { childRunId: "c2", reason: "fuzz" }
            } as unknown as Parameters<typeof Lineage.expand>[0]
            const linExp = Lineage.expand(ev)
            if (linExp.length < 1 || linExp[0] !== ev) return false
            const steerExp = Steering.expand(ev)
            if (steerExp.length < 1 || steerExp[0] !== ev) return false
            if (typeof Monitor.isBookkeepingEvent(kind) !== "boolean") return false
            return true
          }),
        { seed: seed + 11, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
