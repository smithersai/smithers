import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Effect, Result, Schema, Stream } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import type { ControlError } from "../src/ControlError.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { Receipt } from "../src/ControlSchema.ts"
import { durable, fileBundle } from "./DurableStack.ts"
import { memoryRuntime } from "./TestStack.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const keySlot = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))
const action = Schema.Literals(["pause", "resume", "continue", "signal", "start", "approve", "cancel"])
const scenario = Arbitrary.schema(Schema.Struct({
  operations: Schema.Array(Schema.Struct({ kind: action, slot: keySlot })).check(Schema.isMaxLength(10)),
  text: Schema.Literals(["ready", "é😀", "../🕰", "line\nend", "a\u0000b"]),
  finish: Schema.Literals(["cancelled", "completed", "failed"])
}))

const events = (runId: string) =>
  Effect.flatMap(Control, (control) => Stream.runCollect(control.watch({ runId, follow: false })))

it("checks lifecycle, receipts and journal effects after each command and after reopening SQLite", async () => {
  const report = await Effect.runPromise(Fuzz.run(scenario, ({ operations, text, finish }) =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "control-fuzz-"))),
      (dir) =>
        Effect.gen(function*() {
          const open = () => durable({ database: fileBundle(join(dir, "control.sqlite")) })
          const saved = yield* Effect.gen(function*() {
            const control = yield* Control
            const runtime = yield* ControlRuntime
            const plan = { flowId: "system/test", input: { text }, idempotencyKey: "plan" }
            const card = yield* control.plan(plan)
            expect(yield* control.plan(plan)).toEqual(card)
            const start = {
              _tag: "Plan",
              planId: card.planId,
              digest: card.digest,
              envelope: card.envelope,
              idempotencyKey: "start"
            } as const
            expect((yield* control.run(start))._tag).toBe("Parked")
            expect((yield* control.approve(card.approval))._tag).toBe("Accepted")
            const started = yield* control.run(start)
            if (started._tag !== "Accepted" || started.runId === undefined) return yield* Effect.die("expected launch")
            const runId = started.runId
            // Drive the admitted row through the same fenced writes as a host.
            yield* runtime.resume(runId)
            const fence = yield* runtime.claimFence(runId)
            yield* runtime.writeStatus(runId, fence, "running")
            let status: "running" | "accepted" | "parked" | "cancelled" = "running"
            const applied = new Set<string>()
            const signalKeys = new Set<string>()
            const script: Array<{ kind: typeof action.Type; slot: number }> = [
              { kind: "pause", slot: 0 },
              { kind: "continue", slot: 0 },
              { kind: "signal", slot: 0 },
              ...operations
            ]
            for (const { kind, slot } of script) {
              const verb = kind === "continue" ? "resume" : kind
              const key = `${verb}:${slot}`
              const input = { runId, idempotencyKey: key }
              const invoke = (): Effect.Effect<Receipt, ControlError> => {
                switch (kind) {
                  case "start":
                    return control.run(start)
                  case "approve":
                    return control.approve(card.approval)
                  case "continue":
                    return control.run({ _tag: "Resume", ...input })
                  case "signal":
                    return control.signal({ ...input, signal: { name: "ready", payload: text } })
                  default:
                    return control[kind](input)
                }
              }
              let expected: Receipt["_tag"] | "InvalidInput"
              if (kind === "start" || kind === "approve") expected = "AlreadyApplied"
              else if (kind === "signal" && signalKeys.has(key)) expected = "AlreadyApplied"
              else if (status === "cancelled" || kind === "cancel") {
                expected = "Terminal"
                status = "cancelled"
              } else if (applied.has(key)) expected = "AlreadyApplied"
              else if (kind === "pause" && status === "parked") expected = "InvalidInput"
              else {
                expected = "Accepted"
                applied.add(key)
                if (kind === "pause") status = "parked"
                else if (verb === "resume" && status === "parked") status = "accepted"
                else if (kind === "signal") signalKeys.add(key)
              }
              const first = yield* Effect.result(invoke())
              const observed = Result.isSuccess(first) ? first.success._tag : first.failure._tag
              expect(observed, key).toBe(expected === "InvalidInput" ? "/control/InvalidInput" : expected)
              const before = yield* runtime.getRun(runId)
              expect(before.status, key).toBe(status)
              const history = yield* events(runId)
              const repeat = yield* Effect.result(invoke())
              if (Result.isSuccess(first) && first.success._tag === "Accepted") {
                expect(repeat).toMatchObject({ success: { _tag: "AlreadyApplied", receiptId: key, runId } })
              } else {
                expect(repeat).toEqual(first)
              }
              if (kind === "signal" && signalKeys.has(key)) {
                const conflict = yield* control.signal({ ...input, signal: { name: "ready", payload: { text } } })
                expect(conflict._tag).toBe("Conflict")
              }
              expect(yield* events(runId)).toEqual(history)
              expect(yield* runtime.getRun(runId)).toEqual(before)
              const inbox = yield* runtime.querySignals({ runId, limit: 20 })
              expect(inbox.items.map((item) => item.receiptId).sort()).toEqual([...signalKeys].sort())
            }
            const finalStatus = status === "cancelled" ? status : finish
            if (finalStatus === "cancelled") {
              expect(yield* control.cancel({ runId, idempotencyKey: "stop", reason: "operator stop" }))
                .toMatchObject({ _tag: "Terminal", status: finalStatus, runId })
            } else {
              yield* runtime.resume(runId)
              yield* runtime.writeStatus(runId, yield* runtime.claimFence(runId), finalStatus)
            }
            expect((yield* runtime.getRun(runId)).status).toBe(finalStatus)
            return { start, approval: card.approval, runId, finalStatus, history: yield* events(runId) }
          }).pipe(Effect.provide(open()), Effect.scoped)
          yield* Effect.gen(function*() {
            const control = yield* Control
            const runtime = yield* ControlRuntime
            const { runId, finalStatus } = saved
            expect(yield* control.run(saved.start)).toMatchObject({ _tag: "AlreadyApplied", runId })
            expect((yield* control.approve(saved.approval))._tag).toBe("AlreadyApplied")
            const input = { runId, idempotencyKey: "after-reopen" }
            for (
              const verb of [
                control.pause(input),
                control.resume(input),
                control.run({ _tag: "Resume", ...input }),
                control.signal({ ...input, signal: { name: "done", payload: null } }),
                control.cancel(input)
              ]
            ) {
              expect(yield* verb).toEqual({ _tag: "Terminal", status: finalStatus, runId })
              expect((yield* runtime.getRun(runId)).status).toBe(finalStatus)
            }
            expect(yield* events(runId)).toEqual(saved.history)
            expect((yield* runtime.queryRuns({ limit: 10 })).items.map((run) => run.runId)).toEqual([runId])
          }).pipe(Effect.provide(open()), Effect.scoped)
          return true
        }),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
    ), { seed, executions: ioExecutions }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
})

it("gives concurrent run-key claimants exactly one reservation and preserves the winner's receipt", async () => {
  const report = await Effect.runPromise(
    Fuzz.run(Arbitrary.schema(Schema.Tuple([keySlot, keySlot, keySlot])), (slots) =>
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const claims = yield* Effect.forEach(slots, (slot) => Effect.result(runtime.claimRunKey("key", String(slot))), {
          concurrency: "unbounded"
        })
        const winners = claims.flatMap((claim, index) =>
          Result.isSuccess(claim) && claim.success._tag === "Claimed" ? [index] : []
        )
        expect(winners).toHaveLength(1)
        const winner = slots[winners[0]!]!
        const receipt = { _tag: "Accepted", receiptId: "key", runId: `run-${winner}` } as const
        yield* runtime.recordMutation("key", String(winner), receipt)
        for (const [index, slot] of slots.entries()) {
          if (index !== winners[0]) {
            expect(claims[index]).toMatchObject({
              failure: {
                _tag: slot === winner ? "/control/PersistenceError" : "/control/InvalidInput"
              }
            })
          }
          const replay = yield* Effect.result(runtime.claimRunKey("key", String(slot)))
          if (slot === winner) expect(replay).toMatchObject({ success: { _tag: "Raced", receipt } })
          else expect(replay).toMatchObject({ failure: { _tag: "/control/InvalidInput" } })
        }
        return true
      }).pipe(Effect.provide(memoryRuntime({ now: () => 0 }))), {
      seed,
      executions: pureExecutions,
      execution: FuzzSimulation.execution()
    })
  )
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
})
