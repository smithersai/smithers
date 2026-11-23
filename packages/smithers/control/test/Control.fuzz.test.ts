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
