import { Effect, Layer, Schema, Stream } from "effect"
import { RpcTest } from "effect/rpc"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { InvalidInput, PersistenceError, Unauthorized } from "../src/ControlError.ts"
import { ControlRpcs, layerNoopAuth } from "../src/ControlRpcs.ts"
import { type ApprovalTarget, WatchFilter } from "../src/ControlSchema.ts"
import * as ControlServer from "../src/ControlServer.ts"
import { live } from "./TestStack.ts"

const invalidSequences = [
  { label: "negative", value: -1 },
  { label: "fractional", value: 1.5 },
  { label: "unallocatable", value: Number.MAX_SAFE_INTEGER },
  { label: "unsafe", value: Number.MAX_SAFE_INTEGER + 1 },
  { label: "NaN", value: Number.NaN },
  { label: "infinite", value: Number.POSITIVE_INFINITY },
  { label: "negative infinity", value: Number.NEGATIVE_INFINITY }
]

const invalidRunIds = [
  { label: "empty", value: "" },
  { label: "oversized", value: "r".repeat(1025) },
  { label: "NUL", value: "run\u0000hidden" },
  { label: "high surrogate", value: "run\ud800" },
  { label: "low surrogate", value: "run\udc00" }
]

describe("journal input bounds", () => {
  it.each(invalidSequences)("rejects a $label afterSequence on the wire", ({ value }) => {
    const filter = { runId: "run-1", afterSequence: value }
    expect(() => Schema.decodeUnknownSync(WatchFilter)(filter)).toThrow()
    expect(() => Schema.encodeSync(WatchFilter)(filter)).toThrow()
  })

  it.each([0, 1, Number.MAX_SAFE_INTEGER - 1])(
    "preserves journal sequence boundary %s on the wire",
    (afterSequence) => {
      const filter = { runId: "run-1", afterSequence }
      expect(Schema.decodeUnknownSync(WatchFilter)(Schema.encodeSync(WatchFilter)(filter))).toEqual(filter)
    }
  )

  for (const follow of [true, false]) {
    it.each(invalidSequences)(
      `returns InvalidInput for a $label afterSequence with follow=${follow}`,
      async ({ value }) => {
        await Effect.runPromise(
          Effect.gen(function*() {
            const control = yield* Control
            const stream = control.watch({ runId: "run-1", afterSequence: value, follow })
            const error = yield* Effect.flip(Stream.runCollect(stream))
            expect(error).toBeInstanceOf(InvalidInput)
            expect((error as InvalidInput).issue).toContain("afterSequence")
          }).pipe(Effect.provide(live()), Effect.scoped)
        )
      }
    )

    it.each(invalidRunIds)(`returns InvalidInput for a $label runId with follow=${follow}`, async ({ value }) => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const stream = control.watch({ runId: value, follow })
          const error = yield* Effect.flip(Stream.runCollect(stream))
          expect(error).toBeInstanceOf(InvalidInput)
          expect((error as InvalidInput).issue).toContain("runId")
          expect((error as InvalidInput).issue).not.toContain(value || "Schema validation failed")
        }).pipe(Effect.provide(live()), Effect.scoped)
      )
    })
  }

  it.each([{ label: "minimum", runId: "r" }, { label: "maximum", runId: "r".repeat(1024) }, {
    label: "surrogate pair",
    runId: "run-😀"
  }])("accepts a $label journal run identifier", async ({ runId }) => {
    const events = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        return yield* Stream.runCollect(control.watch({ runId, follow: false }))
      }).pipe(Effect.provide(live()), Effect.scoped)
    )
    expect(events).toEqual([])
  })

  it.each(invalidRunIds)("returns a typed RPC error for a $label runId", async ({ value }) => {
    const layer = Layer.merge(ControlServer.layer, layerNoopAuth()).pipe(Layer.provide(live()))
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const rpc = yield* RpcTest.makeClient(ControlRpcs)
        return yield* Effect.flip(Stream.runCollect(rpc.Watch({ runId: value })))
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
    expect(error).toBeInstanceOf(InvalidInput)
    expect((error as InvalidInput).issue).toContain("runId")
  })

  const envelope = { capabilities: [], flows: [], budget: {} }
  const targets: ReadonlyArray<{ readonly label: string; readonly target: ApprovalTarget }> = [
    ...invalidRunIds.filter(({ label }) => !label.includes("surrogate")).map(({ label, value }) => ({
      label: `${label} node`,
      target: { _tag: "Node" as const, runId: value, requestId: "approval", digest: "digest", envelope }
    })),
    {
      label: "oversized plan partition",
      target: { _tag: "Plan", planId: "p".repeat(1020), digest: "digest", envelope }
    }
  ]

  const validTargets: ReadonlyArray<{ readonly label: string; readonly target: ApprovalTarget }> = [
    {
      label: "maximum node partition",
      target: { _tag: "Node", runId: "r".repeat(1024), requestId: "approval", digest: "digest", envelope }
    },
    {
      label: "maximum plan partition",
      target: { _tag: "Plan", planId: "p".repeat(1019), digest: "digest", envelope }
    }
  ]

  for (const decision of ["approve", "deny"] as const) {
    it.each(targets)(
      `returns PersistenceError when ${decision} cannot build a refusal audit for $label`,
      async ({ target }) => {
        const error = await Effect.runPromise(
          Effect.gen(function*() {
            const control = yield* Control
            const error = yield* Effect.flip(control[decision]({
              target,
              scope: "once",
              idempotencyKey: "refused-decision",
              principal: { id: "untrusted", kind: "agent", stampedAt: 0 }
            }))
            return error
          }).pipe(Effect.provide(live()), Effect.scoped)
        )
        expect(error).toBeInstanceOf(PersistenceError)
        expect(error).toMatchObject({
          operation: "control.approval.refused",
          message: "Failed to persist control.approval.refused",
          cause: expect.anything()
        })
      }
    )

    it.each(validTargets)(`preserves Unauthorized after ${decision} journals a $label refusal`, async ({ target }) => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const error = yield* Effect.flip(control[decision]({
            target,
            scope: "once",
            idempotencyKey: "refused-decision",
            principal: { id: "untrusted", kind: "agent", stampedAt: 0 }
          }))
          expect(error).toBeInstanceOf(Unauthorized)
          const runId = target._tag === "Plan" ? `plan:${target.planId}` : target.runId
          const events = yield* Stream.runCollect(control.watch({ runId, follow: false }))
          expect(events).toHaveLength(1)
          expect(events[0]).toMatchObject({
            kind: "control.approval.refused",
            payload: { decision: decision === "approve" ? "approved" : "denied" }
          })
        }).pipe(Effect.provide(live()), Effect.scoped)
      )
    })
  }
})
