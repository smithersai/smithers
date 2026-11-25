/**
 * The transport-independent vtable and the deliberately unavailable
 * implementation an optional integration falls back to.
 */
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { Control, layerNoop } from "../src/Control.ts"
import { Unavailable } from "../src/ControlError.ts"

const envelope = { capabilities: [], flows: [], budget: {} }
const principal = { id: "operator", kind: "test", stampedAt: 0 }
const target = { _tag: "Plan" as const, planId: "plan-1", digest: "digest", envelope }
const message = { messageId: "steer-1", runId: "run-1", body: "stop", principal, createdAt: 0 }
const mutation = { runId: "run-1", idempotencyKey: "key" }

describe("Control.layerNoop", () => {
  it("refuses every operation, naming the feature and one shared ticket", async () => {
    const refusals = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        return [
          ["plan", yield* Effect.flip(control.plan({ flowId: "system/test", input: {} }))],
          ["run", yield* Effect.flip(control.run({ _tag: "Resume", runId: "run-1", idempotencyKey: "key" }))],
          ["approve", yield* Effect.flip(control.approve({ target, scope: "run", idempotencyKey: "key" }))],
          ["deny", yield* Effect.flip(control.deny({ target, scope: "run", idempotencyKey: "key" }))],
          ["steer", yield* Effect.flip(control.steer({ runId: "run-1", message, idempotencyKey: "key" }))],
          [
            "signal",
            yield* Effect.flip(
              control.signal({ runId: "run-1", signal: { name: "ready", payload: null }, idempotencyKey: "key" })
            )
          ],
          ["cancel", yield* Effect.flip(control.cancel(mutation))],
          ["pause", yield* Effect.flip(control.pause(mutation))],
          ["resume", yield* Effect.flip(control.resume(mutation))],
          ["list", yield* Effect.flip(control.list({ _tag: "flows" }))],
          ["watch", yield* Effect.flip(Stream.runCollect(control.watch({})))]
        ] as ReadonlyArray<readonly [string, unknown]>
      }).pipe(Effect.provide(layerNoop))
    )

    expect(refusals.map(([operation, error]) => [operation, (error as Unavailable).feature])).toEqual([
      ["plan", "plan"],
      ["run", "run"],
      ["approve", "approve"],
      ["deny", "deny"],
      ["steer", "steer"],
      ["signal", "signal"],
      ["cancel", "cancel"],
      ["pause", "pause"],
      ["resume", "resume"],
      ["list", "list"],
      ["watch", "watch"]
    ])
    expect(
      refusals.every(([, error]) =>
        error instanceof Unavailable && error.ticket === "control-runtime-engine-integration"
      )
    ).toBe(true)
  })
})
