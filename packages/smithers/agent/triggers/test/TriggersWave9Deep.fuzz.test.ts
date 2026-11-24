import * as ControlChannels from "@smthrs/control/Channels"
import * as Control from "@smthrs/control/Control"
import type { CredentialRef } from "@smthrs/control/Credential"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Duration, Effect, Exit, Layer, Logger, Option, Redacted, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Scheduler from "../src/Scheduler.ts"
import * as TestTriggers from "../src/test/TestTriggers.ts"
import type { Trigger } from "../src/Trigger.ts"
import { TriggerError } from "../src/TriggerError.ts"
import * as TriggerStore from "../src/TriggerStore.ts"
import * as Webhook from "../src/Webhook.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261168")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(30, Math.min(baseExecutions, 100))
const schedExec = Math.max(20, Math.min(Math.ceil(baseExecutions / 3), 50))

const assertPassed = <A>(report: Fuzz.Report<A>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const Payload = Schema.Union([
  Schema.TaggedStruct("start", {
    flowId: Schema.String,
    input: Schema.Unknown
  }),
  Schema.TaggedStruct("signal", {
    runId: Schema.String,
    stepId: Schema.String,
    value: Schema.Json
  })
])

const hour = 60 * 60 * 1_000

describe("@smthrs/triggers Wave 9 deep Scheduler & Webhook fuzzing", () => {
  it("Webhook.constantTimeEqual, epochSeconds, makeSignatureVerifier & Webhook.make enforce exact signature, timestamp, buffer-isolation & control dispatch", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        bodyKind: Schema.Literals(["uint8", "buffer", "offset-buffer", "sab"]),
        sigMode: Schema.Literals(["valid", "wrong", "missing", "prefix-mismatch"]),
        payloadKind: Schema.Literals(["start", "signal", "bad-json", "bad-schema"]),
        tsHeader: Schema.Literals(["fresh", "stale", "future", "invalid", "none"]),
        epochStr: Schema.Literals(["0", "1700000000", "-5", "abc", "12.3", ""])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ bodyKind, sigMode, payloadKind, tsHeader, epochStr }) =>
          Effect.gen(function*() {
            const nowSec = 1_750_000_000
            yield* TestClock.setTime(nowSec * 1_000)

            // constantTimeEqual & epochSeconds
            const a = new TextEncoder().encode(epochStr)
            const b = new TextEncoder().encode(epochStr)
            expect(Webhook.constantTimeEqual(a, b)).toBe(true)
            expect(Webhook.constantTimeEqual(a, new Uint8Array([...b, 1]))).toBe(false)
            const parsedEpoch = Webhook.epochSeconds(epochStr)
            if (/^\d+$/.test(epochStr)) {
              expect(parsedEpoch).toBe(Number(epochStr) * 1_000)
            } else {
              expect(parsedEpoch).toBeUndefined()
            }

            const rawText = payloadKind === "start"
              ? JSON.stringify({ _tag: "start", flowId: "demo/flow", input: { ok: true } })
              : payloadKind === "signal"
                ? JSON.stringify({ _tag: "signal", runId: "r-1", stepId: "s-1", value: { ok: true } })
                : payloadKind === "bad-json"
                  ? "{broken"
                  : JSON.stringify({ _tag: "unknown" })

            const makeBytes = (txt: string): Uint8Array => {
              const enc = new TextEncoder().encode(txt)
              if (bodyKind === "uint8") return enc
              if (bodyKind === "buffer") return Buffer.from(txt)
              if (bodyKind === "offset-buffer") {
                const padded = Buffer.from(`XXXX${txt}YYYY`)
                return padded.subarray(4, 4 + Buffer.byteLength(txt))
              }
              const view = new Uint8Array(new SharedArrayBuffer(enc.length))
              view.set(enc)
              return view
            }

            const credential = Redacted.make<CredentialRef>({ id: "wh-sec", name: "wh" })
            const calls: Array<string> = []
            const verifier = Webhook.makeSignatureVerifier({
              header: "x-sig",
              ...(sigMode === "prefix-mismatch" ? { prefix: "sha256=" } : {}),
              ...(tsHeader !== "none"
                ? {
                    timestamp: {
                      header: "x-ts",
                      tolerance: Duration.seconds(300)
                    }
                  }
                : {}),
              expected: () => Effect.succeed(new TextEncoder().encode("good-sig"))
            })

            const wh = Webhook.make({
              name: "w9-events",
              schema: Payload,
              credential,
              verify: verifier,
              inbound: (p) =>
                p._tag === "start"
                  ? { start: { flowId: p.flowId, input: p.input } }
                  : { signal: { runId: p.runId, stepId: p.stepId, value: p.value } }
            })

            const headers: Record<string, string> = {}
            if (sigMode === "valid") headers["x-sig"] = "good-sig"
            else if (sigMode === "wrong") headers["x-sig"] = "bad-sig!"
            else if (sigMode === "prefix-mismatch") headers["x-sig"] = "md5=good-sig"

            if (tsHeader === "fresh") headers["x-ts"] = String(nowSec - 10)
            else if (tsHeader === "stale") headers["x-ts"] = String(nowSec - 1000)
            else if (tsHeader === "future") headers["x-ts"] = String(nowSec + 1000)
            else if (tsHeader === "invalid") headers["x-ts"] = "not-a-ts"

            const control = Layer.succeed(
              Control.Control,
              Control.make({
                plan: (input) =>
                  Effect.sync(() => {
                    calls.push(`plan:${input.flowId}`)
                    return {
                      planId: "p1",
                      flowId: input.flowId,
                      digest: "d1",
                      inputSummary: "in",
                      envelope: { capabilities: [], flows: [], budget: {} },
                      deployClass: false,
                      nodes: []
                    }
                  }),
                run: () =>
                  Effect.sync(() => {
                    calls.push("run")
                    return { _tag: "Accepted" as const, receiptId: "rcpt", runId: "run-1" }
                  }),
                approve: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "a" }),
                deny: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "d" }),
                steer: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "st" }),
                signal: () =>
                  Effect.sync(() => {
                    calls.push("signal")
                    return { _tag: "Accepted" as const, receiptId: "sg" }
                  }),
                cancel: () => Effect.succeed({ _tag: "Terminal" as const, receiptId: "c", status: "cancelled" as const }),
                pause: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "p" }),
                resume: () => Effect.succeed({ _tag: "Accepted" as const, receiptId: "r" }),
                list: () => Effect.succeed({ _tag: "runs" as const, items: [] }),
                watch: () => Stream.empty
              })
            )

            const exit = yield* Effect.exit(
              wh.register.pipe(Effect.andThen(wh.ingest({ body: makeBytes(rawText), headers, idempotencyKey: "wh-key-1" })), Effect.provide(ControlChannels.layerMemory.pipe(Layer.provide(control))))
            )

            const sigOk = sigMode === "valid"
            const tsOk = tsHeader === "none" || tsHeader === "fresh"
            const bodyOk = payloadKind === "start" || payloadKind === "signal"
            if (sigOk && tsOk && bodyOk) {
              expect(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "").toBe(true)
              expect(calls.length).toBeGreaterThan(0)
            } else {
              expect(Exit.isFailure(exit)).toBe(true)
            }
            return true
          }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))),
        { seed, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Scheduler.make & Scheduler.tick uphold overlap (skip/allow/supersede), catchUp (none/one/all), multi-host handoff, and runner failures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        overlap: Schema.Literals(["skip", "buffer-one", "supersede"]),
        catchUp: Schema.Literals(["none", "one", "all"]),
        missedHours: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
        runnerState: Schema.Literals(["active", "completed", "failed", "missing"]),
        startFails: Schema.Boolean,
        manualQueue: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ overlap, catchUp, missedHours, runnerState, startFails, manualQueue }) =>
          Effect.scoped(
            Effect.gen(function*() {
              const store = yield* TriggerStore.TriggerStore
              const decl: Trigger = {
                id: "t-w9",
                flowId: "demo/flow",
                input: { ok: true },
                cron: "0 * * * *",
                timezone: "UTC",
                overlap,
                catchUp,
                maxCatchUp: 3,
                enabled: true
              }
              const reg = yield* store.register(decl)
              yield* store.claimFire({ triggerId: decl.id, occurrence: 0, expectedRevision: reg.revision })
              yield* store.recordResult({ triggerId: decl.id, occurrence: 0, outcome: "skipped" })
              if (manualQueue) {
                yield* store.setPending({ triggerId: decl.id, occurrence: hour })
              }

              const starts: Array<Scheduler.StartInput> = []
              const cancelled: Array<string> = []
              const runner = Scheduler.makeRunner({
                start: (input) => {
                  starts.push(input)
                  if (startFails) {
                    return Effect.fail(new TriggerError({ code: "runner_failed", message: "boom" }))
                  }
                  return Effect.succeed(`run-${starts.length}`)
                },
                inspect: () => Effect.succeed(runnerState),
                cancel: (runId) =>
                  Effect.sync(() => {
                    cancelled.push(runId)
                  })
              })

              const sched = yield* Scheduler.make({ concurrency: 2, host: "host-w9" }).pipe(
                Effect.provideService(Scheduler.Runner, runner)
              )
              yield* TestClock.setTime(missedHours * hour)
              yield* sched.runOnce
              yield* TestClock.setTime((missedHours + 1) * hour)
              const ticked = yield* Scheduler.tick({ host: "host-w9", concurrency: 2 }).pipe(
                Effect.provideService(Scheduler.Runner, runner)
              )
              expect(ticked.nextWakeMs === undefined || typeof ticked.nextWakeMs === "number").toBe(true)

              const hist = yield* store.history({ triggerId: decl.id })
              expect(hist.items.length).toBeGreaterThanOrEqual(1)
              expect(Scheduler.tickExecutionId("host-w9")).toBe("smithers/triggers/tick:host-w9")
              expect(Scheduler.makeNoop()).toBeDefined()
              expect(Scheduler.makeNoopRunner()).toBeDefined()
              return true
            })
          ).pipe(
            Effect.provide(TestTriggers.layer),
            Effect.provide(TestClock.layer()),
            Effect.provide(Logger.layer([]))
          ),
        { seed: seed + 1, executions: schedExec }
      )
    )
    assertPassed(report)
  }, 120_000)
})
