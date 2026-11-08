import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { it as effectIt } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { Failure, fromIntegrationError } from "../src/core/ActionFailure.vibe"
import { CursorStore, layerMemory } from "../src/core/CursorStore.vibe"
import type { ExternalEvent } from "../src/core/ExternalEvent.vibe"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import { type Batch, type RunContext, runWithCursor } from "../src/core/Source.ts"

const event = (id: number): ExternalEvent => ({
  source: "example",
  eventName: "integration:example:message",
  correlationId: null,
  payload: { id },
  dedupeKey: `example:${id}`,
  receivedAtMs: 1
})

const runEffect = <A, E>(effect: Effect.Effect<A, E, RunContext>) => {
  // The real engine executes the runner inside a flow action; callback and
  // cursor observations below happen within that action's live services.
  const step = Action.make("test/source/run", {
    payload: {},
    success: Schema.Unknown,
    error: Failure,
    tier: "irreversible"
  })
  const flow = Flow.make("test/source", {
    payload: {},
    success: Schema.Unknown,
    error: Failure,
    body: () => step.call({})
  })
  const layer = Layer.mergeAll(
    step.toLayer(() => effect.pipe(Effect.mapError(fromIntegrationError))),
    Interpreter.layer(flow)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, layerMemory))
  )
  return flow.execute({}, { executionId: "source-test" }).pipe(
    Effect.provide(layer),
    Effect.scoped,
    Effect.map((value) => value as A)
  )
}

const run = <A, E>(effect: Effect.Effect<A, E, RunContext>) => Effect.runPromise(runEffect(effect))

describe("runWithCursor", () => {
  it("commits each proposed cursor only after the handler succeeds, turn after turn", async () => {
    const polled: Array<string | null> = []
    const handled: Array<ReadonlyArray<number>> = []
    const batches: Record<string, Batch> = {
      start: { events: [event(1), event(2)], cursor: "3" },
      "3": { events: [event(3)], cursor: "4" },
      "4": { events: [] }
    }
    const cursor = await run(Effect.gen(function*() {
      yield* runWithCursor(
        "example",
        (cursor) =>
          Effect.sync(() => {
            polled.push(cursor)
            return batches[cursor ?? "start"]!
          }),
        (events) => Effect.sync(() => void handled.push(events.map((found) => (found.payload as { id: number }).id))),
        { maxTurns: 3, intervalMs: 0 }
      )
      return yield* Effect.flatMap(CursorStore, (cursors) => cursors.get("example"))
    }))
    expect(polled).toEqual([null, "3", "4"])
    expect(handled).toEqual([[1, 2], [3], []])
    // The empty turn proposed no cursor, so the last committed one stands.
    expect(cursor).toBe("4")
  })

  it("leaves the cursor where it was when the handler fails", async () => {
    const [failure, cursor] = await run(Effect.gen(function*() {
      const cursors = yield* CursorStore
      yield* cursors.set("example", "7")
      const failure = yield* Effect.flip(runWithCursor(
        "example",
        () => Effect.succeed<Batch>({ events: [event(7)], cursor: "8" }),
        () => Effect.fail(new IntegrationError("delivery-failed", "handler refused"))
      ))
      return [failure.summary, yield* cursors.get("example")] as const
    }))
    expect(failure).toBe("handler refused")
    expect(cursor).toBe("7")
  })

  it("ends with the poll's failure and commits nothing", async () => {
    const [failure, cursor] = await run(Effect.gen(function*() {
      const failure = yield* Effect.flip(
        runWithCursor(
          "example",
          () => Effect.fail(new IntegrationError("poll-failed", "poll failed")),
          () => Effect.void
        )
      )
      return [failure.summary, yield* Effect.flatMap(CursorStore, (cursors) => cursors.get("example"))] as const
    }))
    expect(failure).toBe("poll failed")
    expect(cursor).toBeNull()
  })

  it("continues until handler failure when no turn budget is supplied", async () => {
    let turns = 0
    const outcome = await run(
      runWithCursor(
        "example",
        () => Effect.sync(() => ({ events: [], cursor: String(++turns) })),
        () => turns >= 3 ? Effect.fail(new IntegrationError("delivery-failed", "stop")) : Effect.void,
        { intervalMs: 0 }
      ).pipe(Effect.flip, Effect.map((error) => error.summary))
    )
    expect(outcome).toBe("stop")
    expect(turns).toBe(3)
  })
})

it.each([
  { intervalMs: -1 },
  { intervalMs: Number.NaN },
  { intervalMs: 0.5 },
  { maxTurns: 0 },
  { maxTurns: 1.5 },
  { maxTurns: Number.POSITIVE_INFINITY }
])("refuses an invalid polling budget before any callback: %j", async (options) => {
  const error = await Effect.runPromise(
    Effect.flip(
      runWithCursor("example", () => Effect.die("must not poll"), () => Effect.die("must not handle"), options)
    ).pipe(Effect.provide(layerMemory)) as Effect.Effect<IntegrationError>
  )
  expect(error.reason).toBe("invalid-config")
})

effectIt.effect(
  "waits on the durable clock between turns, including the default interval",
  () =>
    Effect.gen(function*() {
      const first = yield* Deferred.make<void>()
      let handled = 0
      const fiber = yield* runEffect(
        runWithCursor("example", () => Effect.succeed({ events: [] }), () =>
          Effect.andThen(
            Effect.sync(() => {
              handled++
            }),
            Deferred.succeed(first, undefined)
          ), { maxTurns: 2 }).pipe(Effect.as(null))
      ).pipe(Effect.forkChild)
      yield* Deferred.await(first)
      expect(handled).toBe(1)
      yield* TestClock.adjust("250 millis")
      yield* Fiber.join(fiber)
      expect(handled).toBe(2)
    })
)
