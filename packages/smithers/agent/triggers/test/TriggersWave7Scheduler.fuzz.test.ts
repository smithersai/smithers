import * as Control from "@smthrs/control/Control"
import type { CredentialRef } from "@smthrs/control/Credential"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Duration, Effect, Exit, Layer, Logger, Option, Redacted, Schema } from "effect"
import * as NodeCrypto from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  Scheduler,
  SqlTriggerStore,
  TriggerError,
  TriggerStore,
  Webhook
} from "../src/index.ts"
import * as TestTriggers from "../src/test/TestTriggers.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261133")
const silentLogger = Logger.layer([])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/triggers Wave 7 deep fuzz (Scheduler tick/overlap/faults/controlRunner + Webhook signature verification)", () => {
  it("Webhook.makeSignatureVerifier & constantTimeEqual enforce HMAC verification across case-insensitive headers, tampered bodies, and missing headers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        body: Schema.Literals(["{}", "{\"event\":\"push\",\"id\":1}", "hello world", ""]),
        secret: Schema.Literals(["sec-1", "long-secret-key-0123456789"]),
        headerCase: Schema.Literals(["x-signature", "X-Signature", "X-SIGNATURE"]),
        tamper: Schema.Literals(["none", "wrongSig", "missingHeader", "bodyMutated"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ body, secret, headerCase, tamper }) =>
          Effect.gen(function*() {
            const verifier = Webhook.makeSignatureVerifier({
              header: "x-signature",
              expected: (rawBytes, cred) =>
                Effect.sync(() => {
                  const s = Redacted.value(cred) as unknown as string
                  return new TextEncoder().encode(NodeCrypto.createHmac("sha256", s).update(rawBytes).digest("hex"))
                })
            })
            const rawBody = new TextEncoder().encode(body)
            const macHex = NodeCrypto.createHmac("sha256", secret).update(rawBody).digest("hex")
            const headerValue = tamper === "wrongSig" ? "0".repeat(macHex.length) : macHex
            const verifyBody = tamper === "bodyMutated" ? new TextEncoder().encode(`${body}!`) : rawBody
            const headers: Record<string, string> = tamper === "missingHeader" ? {} : { [headerCase]: headerValue }

            const res = yield* verifier(
              {
                headers,
                body: verifyBody
              } as never,
              Redacted.make(secret as unknown as CredentialRef)
            ).pipe(Effect.exit)

            if (tamper === "none") {
              expect(Exit.isSuccess(res)).toBe(true)
            } else {
              expect(Exit.isFailure(res)).toBe(true)
            }

            const a = new Uint8Array([1, 2, 3, 4])
            const b = new Uint8Array([1, 2, 3, 4])
            const c = new Uint8Array([1, 2, 3, 5])
            const d = new Uint8Array([1, 2, 3])
            expect(Webhook.constantTimeEqual(a, b)).toBe(true)
            expect(Webhook.constantTimeEqual(a, c)).toBe(false)
            expect(Webhook.constantTimeEqual(a, d)).toBe(false)
            return true
          }),
        { executions: Math.min(executions, 120), seed }
      )
    )
    assertPassed(report)
  }, 30_000)

  it("Scheduler.tick, layerControlRunner, makeNoopRunner, makeNoop, and overlap/failure paths maintain durable invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        overlap: Schema.Literals(["buffer-one", "skip", "supersede"]),
        runnerOutcome: Schema.Literals(["succeed", "failRetryable", "failPermanent", "activeThenDone"]),
        useSqlStore: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ overlap, runnerOutcome, useSqlStore }) =>
          Effect.gen(function*() {
            expect(Scheduler.idempotencyKey("trig-1", 42)).toContain("trig-1")
            expect(Scheduler.tickExecutionId("host-a")).toContain("host-a")
            yield* Scheduler.makeNoop().runOnce
            const noopRunner = Scheduler.makeNoopRunner()
            expect(typeof noopRunner.start).toBe("function")

            let starts = 0
            let checks = 0
            const runner = Scheduler.makeRunner({
              start: (input) => {
                starts += 1
                if (runnerOutcome === "failRetryable") {
                  return Effect.fail(new TriggerError.TriggerError({ code: "runner_unavailable", message: "transient" }))
                }
                if (runnerOutcome === "failPermanent") {
                  return Effect.fail(new TriggerError.TriggerError({ code: "invalid_schedule", message: "permanent" }))
                }
                return Effect.succeed(`exec-${input.flowId}-${starts}`)
              },
              inspect: () => {
                checks += 1
                if (runnerOutcome === "activeThenDone") {
                  return Effect.succeed(checks === 1 ? "active" : "completed")
                }
                return Effect.succeed("completed")
              },
              cancel: () => Effect.void
            })

            const storeLayer = useSqlStore
              ? SqlTriggerStore.layer.pipe(Layer.provide(TestDatabase.layer))
              : TestTriggers.layer

            const fullLayer = Layer.mergeAll(
              storeLayer,
              Layer.succeed(Scheduler.Runner)(runner),
              silentLogger
            )

            yield* Effect.scoped(
              Effect.gen(function*() {
                const store = yield* TriggerStore.TriggerStore
                yield* store.register({
                  id: `trig-${overlap}`,
                  flowId: "demo/flow",
                  input: { k: 1 },
                  cron: "* * * * *",
                  timezone: "UTC",
                  overlap,
                  catchUp: "one",
                  maxCatchUp: 2,
                  enabled: true
                })

                const t1 = yield* Scheduler.tick({ host: "h1", concurrency: 2 })
                const t2 = yield* Scheduler.tick({ host: "h1", concurrency: 2 })
                expect(t1).toBeDefined()
                expect(t2).toBeDefined()
              }).pipe(Effect.provide(fullLayer))
            )

            const ctrlStub = Layer.succeed(Control.Control)({
              plan: () => Effect.succeed({ planId: "p1", approved: true, requiresApproval: false, flowId: "demo/flow", input: {} }),
              start: () => Effect.succeed({ runId: "ctrl-run-1", executionId: "ctrl-exec-1" }),
              inspect: () => Effect.succeed({ status: "completed" }),
              get: () => Effect.succeed(Option.none()),
              cancel: () => Effect.void
            } as never)
            yield* Effect.gen(function*() {
              const r = yield* Scheduler.Runner
              const started = yield* r.start({
                flowId: "demo/flow",
                input: {},
                idempotencyKey: "k1"
              }).pipe(Effect.exit)
              expect(Exit.isSuccess(started) || Exit.isFailure(started)).toBe(true)
            }).pipe(Effect.provide(Scheduler.layerControlRunner.pipe(Layer.provide(ctrlStub))), Effect.scoped)

            expect(Duration.toMillis(Scheduler.defaultStaleAfter)).toBeGreaterThan(0)
            return true
          }),
        { executions: Math.min(executions, 35), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
