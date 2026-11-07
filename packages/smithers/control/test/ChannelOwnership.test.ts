import { Effect, Layer, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Channels from "../src/Channels.vibe"
import { Control } from "../src/Control.vibe"
import { RunNotFound } from "../src/ControlError.vibe"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { Principal, Receipt } from "../src/ControlSchema.ts"
import { durable } from "./DurableStack.ts"
import * as TestStack from "./TestStack.ts"

const channel = (name: string): Channels.Channel<Channels.InboundResult> => ({
  name,
  schema: Schema.Union([
    Schema.TaggedStruct("Start", { flowId: Schema.String, input: Schema.Json }),
    Schema.TaggedStruct("Signal", {
      runId: Schema.String,
      signal: Schema.Struct({ name: Schema.String, payload: Schema.Json })
    })
  ]),
  verify: () => Effect.void,
  decode: (raw) => Effect.sync(() => JSON.parse(new TextDecoder().decode(raw.body))),
  map: (value) => Effect.succeed(value),
  project: () => ({ operation: "noop", cursor: "0", message: {} })
})

const ingest = (name: string, key: string, body: unknown) =>
  Effect.flatMap(
    Channels.Channels,
    (channels) =>
      channels.ingest({
        channel: name,
        raw: { headers: {}, idempotencyKey: key, body: new TextEncoder().encode(JSON.stringify(body)) }
      })
  )

const runIdOf = (receipt: Receipt) => {
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) throw new Error("expected started run")
  return receipt.runId
}

const start = (key: string, principal?: Principal) =>
  Effect.gen(function*() {
    const control = yield* Control
    const card = yield* control.plan({ flowId: "system/test", input: { key } })
    yield* control.approve(card.approval)
    return runIdOf(
      yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: key,
        ...(principal === undefined ? {} : { principal })
      })
    )
  })

for (const [name, stack] of [["memory", TestStack.live()], ["SQL", durable()]] as const) {
  const layer = Channels.layer.pipe(Layer.provideMerge(stack))
  describe(`channel ownership (${name})`, () => {
    it("attributes channel starts to the channel across redelivery", async () => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const channels = yield* Channels.Channels
          const control = yield* Control
          const runtime = yield* ControlRuntime
          yield* channels.register(channel("hook"))
          const body = { _tag: "Start", flowId: "system/test", input: {} }
          const parked = yield* ingest("hook", "start", body)
          if (parked._tag !== "Parked") return yield* Effect.die("expected pending approval")
          const plan = yield* runtime.getPlan(parked.planId)
          yield* control.approve(plan.card.approval)
          const receipt = yield* ingest("hook", "start", body)
          const runId = runIdOf(receipt)
          expect((yield* runtime.getRun(runId)).launchedBy).toMatchObject({ id: "hook", kind: "channel" })
          expect(yield* ingest("hook", "start", body)).toEqual({ ...receipt, _tag: "AlreadyApplied" })
          const own = yield* control.list({ _tag: "runs", reader: { id: "hook", kind: "channel", stampedAt: 0 } })
          expect(own).toMatchObject({ items: [{ runId }] })
        }).pipe(Effect.provide(layer), Effect.scoped)
      )
    })

    it("refuses signals to another caller's run before admission and replay", async () => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const channels = yield* Channels.Channels
          const runtime = yield* ControlRuntime
          yield* channels.register(channel("hook"))
          const other = yield* start("other")
          const own = yield* start("own", { id: "hook", kind: "channel", stampedAt: 0 })
          const sameIdOtherKind = yield* start("same-id", { id: "hook", kind: "operator", stampedAt: 0 })
          for (const runId of [other, sameIdOtherKind, "absent"]) {
            const result = yield* Effect.result(ingest("hook", "signal", {
              _tag: "Signal",
              runId,
              signal: { name: "ready", payload: true }
            }))
            expect(Result.isFailure(result) && result.failure).toBeInstanceOf(RunNotFound)
            expect(yield* runtime.pendingSignals).toEqual([])
          }
          const body = { _tag: "Signal", runId: own, signal: { name: "ready", payload: true } }
          const receipt = yield* ingest("hook", "signal", body)
          expect(receipt._tag).toBe("Accepted")
          expect(yield* ingest("hook", "signal", body)).toEqual({ ...receipt, _tag: "AlreadyApplied" })
          expect(yield* runtime.pendingSignals).toMatchObject([{
            runId: own,
            principal: { id: "hook", kind: "channel" }
          }])
        }).pipe(Effect.provide(layer), Effect.scoped)
      )
    })
  })
}
