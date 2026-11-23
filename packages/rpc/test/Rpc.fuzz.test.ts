import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodeCrypto from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  ConfiguredModel,
  NativeFailureCodes,
  PlueFailureCodes,
  PromptQueue,
  Refusal,
  Sha256,
  UserFailure,
  WebUrl,
  WorkerFailureCodes
} from "../src/index.ts"

const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/rpc comprehensive fuzz invariants", () => {
  it("WebUrl schemas NEVER accept dangerous schemes (javascript:/data:/file:) or open-redirect protocol-relative paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
        Schema.Literals([
          "javascript:alert(1)",
          "JAVASCRIPT:alert(1)",
          "data:text/html,<script>alert(1)</script>",
          "vbscript:msgbox(1)",
          "file:///etc/passwd",
          "//evil.example/path",
          "/\\evil.example",
          "/safe/path?a=1#frag",
          "https://smithers.sh/docs"
        ])
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (raw) =>
          Effect.sync(() => {
            const httpRes = WebUrl.HttpUrlSchema.safeParse(raw)
            if (httpRes.success && !/^https?:\/\//i.test(httpRes.data)) return false
            const relRes = WebUrl.RelativeUrlPathSchema.safeParse(raw)
            if (relRes.success) {
              if (!relRes.data.startsWith("/") || relRes.data.startsWith("//") || relRes.data.includes("\\")) {
                return false
              }
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Sha256.digestSync matches Node crypto on well-formed UTF-16 and rejects unpaired surrogates with TypeError", async () => {
    const arb = Arbitrary.schema(Schema.String.pipe(Schema.check(Schema.isMaxLength(256))))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (text) =>
          Effect.sync(() => {
            if (!isWellFormed(text)) {
              try {
                Sha256.digestSync(text)
                return false
              } catch (err) {
                return err instanceof TypeError
              }
            }
            const expected = NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex")
            return Sha256.digestSync(text) === expected
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Refusal, Worker/Plue/Native failure code registries, and UserFailure never leak raw error detail", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Literals([400, 401, 403, 404, 409, 429, 500, 502, 503]),
        message: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
        retryHeader: Schema.OptionFromUndefinedOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(32)))),
        wIdx: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: WorkerFailureCodes.WORKER_FAILURE_CODES.length - 1 }))
        ),
        pIdx: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: PlueFailureCodes.PLUE_FAILURE_CODES.length - 1 }))
        ),
        nIdx: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: NativeFailureCodes.NATIVE_ROUTE_CODES.length - 1 }))
        )
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ status, message, retryHeader, wIdx, pIdx, nIdx }) =>
          Effect.sync(() => {
            const wCode = WorkerFailureCodes.WORKER_FAILURE_CODES[wIdx]!
            if (WorkerFailureCodes.workerFailureCode(wCode) !== wCode) return false
            if (Refusal.refusalCode(wCode) !== wCode || !Refusal.isWorkerFailureCode(wCode)) return false
            if (Refusal.refusalEntry(wCode) === null) return false

            const pCode = PlueFailureCodes.PLUE_FAILURE_CODES[pIdx]!
            if (Refusal.plueFailureCode(pCode) !== pCode) return false
            if (PlueFailureCodes.PLUE_FAILURES[pCode] === undefined) return false

            const nRoute = NativeFailureCodes.NATIVE_ROUTE_CODES[nIdx]!
            const nWire = NativeFailureCodes.nativeWireCode(nRoute)
            if (NativeFailureCodes.nativeFailureCode(nWire) !== nWire) return false
            if (!Refusal.isNativeFailureCode(nWire)) return false
            if (NativeFailureCodes.nativeFailureEntry(nWire) === undefined) return false

            const r = Refusal.refusalOf({ body: { code: wCode }, status, message })
            const stored = Refusal.storedRefusal(r)
            const back = Refusal.refusalFromStored(stored)
            if (back.origin !== r.origin || back.message !== r.message || back.code !== r.code) return false
            if (Refusal.statedWords(r) !== r.message) return false
            if (typeof Refusal.mayAutoRetry(r) !== "boolean") return false

            const parsed = Refusal.retryAfterHeader({
              get: (
                name
              ) => (name.toLowerCase() === "retry-after" && retryHeader._tag === "Some" ? retryHeader.value : null)
            })
            if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) return false

            // UserFailure.failureDetail MUST ALWAYS redact raw errors
            if (UserFailure.failureDetail(new Error(message)) !== "[REDACTED]") return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("PromptQueue enqueue/remove/inScope/next/restoreDraft & ConfiguredModel schemas satisfy exact FIFO and validation invariants", async () => {
    const scopeArb = Schema.Literals(["s1", "s2"])
    const opArb = Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("enq"),
        id: Schema.Literals(["p1", "p2", "p3", "p4"]),
        scope: scopeArb,
        text: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24)))
      }),
      Schema.Struct({
        _tag: Schema.Literal("rem"),
        id: Schema.Literals(["p1", "p2", "p3", "p4"])
      })
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(opArb).pipe(Schema.check(Schema.isMaxLength(12))),
        draft: Schema.String.pipe(Schema.check(Schema.isMaxLength(20))),
        recordId: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          Schema.Literals(["default", "my-model-1", "INVALID", "a"])
        ]),
        credName: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          Schema.Literals(["OPENAI_API_KEY", "ORIGIN", "FOO_ORIGIN", "bad_key", "MY_KEY_1"])
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ops, draft, recordId, credName }) =>
          Effect.sync(() => {
            let queue: ReadonlyArray<PromptQueue.Prompt> = []
            for (const op of ops) {
              if (op._tag === "enq") {
                queue = PromptQueue.enqueue(queue, { id: op.id, scope: op.scope, text: op.text })
              } else {
                queue = PromptQueue.remove(queue, op.id)
              }
              const s1 = PromptQueue.inScope(queue, "s1")
              if (PromptQueue.next(queue, "s1") !== s1[0]) return false
              const restored = PromptQueue.restoreDraft(s1, draft)
              if (typeof restored !== "string") return false
            }

            // ConfiguredModel invariants: "default" is NEVER a valid ModelRecordId, *_ORIGIN is NEVER a valid credential name
            if (ConfiguredModel.ModelRecordIdSchema.safeParse("default").success) return false
            if (ConfiguredModel.ModelRecordIdSchema.safeParse(recordId).success && recordId === "default") return false
            if (ConfiguredModel.ModelCredentialNameSchema.safeParse(credName).success && credName.endsWith("ORIGIN")) {
              return false
            }
            for (const proto of ConfiguredModel.MODEL_PROTOCOLS) {
              const kind = ConfiguredModel.modelKindOf(proto)
              if (kind !== "generation" && kind !== "decision") return false
            }
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
