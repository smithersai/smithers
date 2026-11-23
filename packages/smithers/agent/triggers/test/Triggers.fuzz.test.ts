import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Redacted, Result, Schema } from "effect"
import * as NodeCrypto from "node:crypto"
import { describe, expect, it } from "vitest"
import { CatchUp, Cron, Overlap, Schedule, Webhook } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "800" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/triggers comprehensive fuzz invariants", () => {
  it("Cron.parse never throws unhandled errors on arbitrary strings and rejects malformed expressions cleanly", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
        Schema.Literals(["* * * * *", "0 0 1 1 *", "*/15 9-17 * * 1-5", "60 * * * *", "* * * *", "0 0 31 2 *"])
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (expr) =>
          Effect.gen(function*() {
            const res = yield* Effect.result(Cron.parse(expr))
            if (Result.isFailure(res)) return res.failure._tag === "flows/triggers/TriggerError"
            const base = new Date(1_700_000_000_000)
            const n1 = yield* Cron.next(res.success, base)
            return n1.getTime() > base.getTime()
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Cron next / previousAtOrBefore / occurrencesBetween and CatchUp.occurrences preserve strict monotonicity & bounds", async () => {
    const cronArb = Schema.Literals(["* * * * *", "*/5 * * * *", "0 * * * *", "15 0-23/2 * * *"])
    const arb = Arbitrary.schema(
      Schema.Struct({
        expr: cronArb,
        baseMs: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 1_700_000_000_000, maximum: 1_800_000_000_000 }))
        ),
        spanMin: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 180 }))),
        policy: Schema.Literals(["none", "one", "all"]),
        maxCatchUp: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ expr, baseMs, spanMin, policy, maxCatchUp }) =>
          Effect.gen(function*() {
            const cron = yield* Cron.parse(expr)
            const base = new Date(baseMs)
            const t1 = yield* Cron.next(cron, base)
            const t2 = yield* Cron.next(cron, t1)
            if (!(t1.getTime() > baseMs && t2.getTime() > t1.getTime())) return false
            const prev = yield* Cron.previousAtOrBefore(cron, t2)
            if (prev.getTime() !== t2.getTime()) return false

            const end = new Date(baseMs + spanMin * 60_000)
            const all = yield* Cron.occurrencesBetween(cron, base, end)
            for (let i = 1; i < all.length; i++) {
              if (!(all[i]!.getTime() > all[i - 1]!.getTime())) return false
            }

            const caught = yield* Effect.result(CatchUp.occurrences(policy, maxCatchUp, base, end, cron))
            if (policy === "none") {
              if (Result.isFailure(caught) || caught.success.length !== 0) return false
            } else if (Result.isSuccess(caught)) {
              if (caught.success.length > maxCatchUp) return false
              if (policy === "one" && caught.success.length > 1) return false
            }
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Overlap.decide, pendingAfter, Schedule.make, and Webhook constantTimeEqual/signature verifier satisfy exact invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        overlap: Schema.Literals(["skip", "buffer-one", "supersede"]),
        running: Schema.Boolean,
        pending: Schema.OptionFromUndefinedOr(
          Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1000 })))
        ),
        due: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
        secret: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z0-9_-]{8,24}$/))),
        body: Schema.String.pipe(Schema.check(Schema.isMaxLength(64)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ overlap, running, pending, due, secret, body }) =>
          Effect.gen(function*() {
            const pVal = pending._tag === "Some" ? pending.value : undefined
            const action = Overlap.decide(overlap, { running, pending: pVal, due })
            if (!running && action !== "fire") return false
            if (running && overlap === "skip" && action !== "skip") return false
            if (running && overlap === "buffer-one" && action !== "buffer") return false
            if (running && overlap === "supersede" && action !== "supersede") return false
            const nextPending = Overlap.pendingAfter({ running, pending: pVal, due })
            if (nextPending < due || (pVal !== undefined && nextPending < pVal)) return false

            const sched = yield* Schedule.make({ cron: "*/5 * * * *", overlap, catchUp: "none" })
            if (sched.overlap !== overlap) return false

            const a = new TextEncoder().encode(body)
            const b = new TextEncoder().encode(body + "x")
            if (!Webhook.constantTimeEqual(a, a)) return false
            if (Webhook.constantTimeEqual(a, b) || Webhook.constantTimeEqual(b, a)) return false

            const verifier = Webhook.makeSignatureVerifier({
              header: "x-hub-signature-256",
              expected: (raw, cred) =>
                Effect.sync(() => {
                  const key = typeof Redacted.value(cred) === "string"
                    ? (Redacted.value(cred) as unknown as string)
                    : secret
                  return new TextEncoder().encode(NodeCrypto.createHmac("sha256", key).update(raw).digest("hex"))
                })
            })
            const mac = NodeCrypto.createHmac("sha256", secret).update(a).digest("hex")
            const cred = Redacted.make(secret) as unknown as Parameters<typeof verifier>[1]
            const ok = yield* Effect.result(
              verifier({ body: a, idempotencyKey: "k1", headers: { "x-hub-signature-256": mac } }, cred)
            )
            if (Result.isFailure(ok)) return false
            const flipped = (mac[0] === "a" ? "b" : "a") + mac.slice(1)
            const bad = yield* Effect.result(
              verifier({ body: a, idempotencyKey: "k1", headers: { "x-hub-signature-256": flipped } }, cred)
            )
            if (Result.isSuccess(bad)) return false
            const missing = yield* Effect.result(
              verifier({ body: a, idempotencyKey: "k1", headers: {} }, cred)
            )
            return Result.isFailure(missing)
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
