import { Model, ModelError, type ModelEvent } from "@smthrs/model"
import type { NativeAgent } from "@smthrs/rpc"
import { Effect, Exit, Fiber, Latch, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { runModelTurn } from "../src/ModelTurnHost.vibe"

const turn: NativeAgent.StartAgentTurnRequest = {
  runId: "run",
  instructions: "answer",
  messages: [{ role: "user", content: "hi" }]
}

/** Waits, on real timers, for something the turn's own fibers settle. */
const waitUntil = async (ready: () => boolean, complaint: string): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(complaint)
}

const deltas = (count: number): Array<ModelEvent.ModelEvent> =>
  Array.from({ length: count }, (_, index) => ({ type: "text-delta" as const, id: "a", text: `w${index} ` }))

/**
 * A provider stream that reports how much of itself was read and whether its
 * producer was released. Both are what the production stall turned on: the
 * response stopped being read, and nothing ended it.
 */
const counted = (events: ReadonlyArray<ModelEvent.ModelEvent>) => {
  const state = { produced: 0, released: false }
  return {
    state,
    model: Model.make({
      stream: () =>
        Stream.fromIterable(events).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              state.produced += 1
            })
          ),
          Stream.ensuring(Effect.sync(() => {
            state.released = true
          }))
        )
    })
  }
}

// The production defect, as the contract that was missing. The host stops
// reading the provider's response the moment it has a frame to commit, and
// the commit cannot answer until that response has been released. A host that
// reads only while no commit is in flight cannot finish such a turn at all:
// turn 2d851bdd attempted its first commit 1 ms after its first event and was
// still waiting half an hour later with the response's last bytes unread.
//
// The bound matters as much as the buffering. A finite buffer suspends its
// producer when it fills, which is the same stall one buffer-length later, and
// nothing bounds a turn's event count to a figure the host could pick:
// `fastModelFallback` strips the output token limit for a route that does not
// support one, so that provider answers at its own maximum, and
// `SMITHERS_CHAT_MAX_TOKENS` admits a million. The provider's side has to keep
// draining for as long as the provider keeps answering.
describe("a commit in flight", () => {
  test("does not stop a response longer than any fixed buffer being drained", async () => {
    // Ten times the events twice this turn's own token limit would allow: the
    // figure a capacity derived from `maxTokens` is given.
    const events = [...deltas(20_000), { type: "settle" as const, stopReason: "stop" as const }]
    const { model, state } = counted(events)
    const committed: Array<NativeAgent.AgentTurnFrame> = []
    const fiber = Effect.runFork(
      runModelTurn(model, turn, { modelId: "model", maxTokens: 1024 }, (frame) => {
        committed.push(frame)
        return Effect.never
      })
    )
    await waitUntil(
      () => state.produced === events.length,
      "the provider response was never drained: a commit in flight still stops it"
    )
    // The first frame is in flight and unanswered; that is the whole point.
    expect(committed).toHaveLength(1)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(state.released).toBe(true)
  })

  test("is written before the provider has finished, so the journal advances early", async () => {
    const latch = Latch.makeUnsafe(false)
    const committed: Array<NativeAgent.AgentTurnFrame> = []
    const held: Stream.Stream<ModelEvent.ModelEvent> = Stream.drain(Stream.fromEffect(latch.await))
    const model = Model.make({
      stream: () =>
        Stream.fromIterable(deltas(3)).pipe(
          Stream.concat(held),
          Stream.concat(Stream.fromIterable<ModelEvent.ModelEvent>([{ type: "settle", stopReason: "stop" }]))
        )
    })
    const fiber = Effect.runFork(
      runModelTurn(model, turn, { modelId: "model" }, (frame) =>
        Effect.sync(() => {
          committed.push(frame)
        }))
    )
    await waitUntil(() => committed.length >= 3, "no frame was committed while the provider was still answering")
    expect(committed.map((frame) => frame.type)).toEqual(["delta", "delta", "delta"])
    latch.openUnsafe()
    await Effect.runPromise(Fiber.join(fiber))
    expect(committed.at(-1)).toMatchObject({ type: "done", reason: "stop" })
  })
})

describe("buffering the provider's side", () => {
  test("still fails the turn with the provider's own failure", async () => {
    const model = Model.make({
      stream: () =>
        Stream.fromIterable(deltas(2)).pipe(
          Stream.concat(
            Stream.fail(new ModelError.ModelError({ code: "provider_internal", message: "upstream fault" }))
          )
        )
    })
    const exit = await Effect.runPromiseExit(runModelTurn(model, turn, { modelId: "model" }, () => Effect.void))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(Exit.isFailure(exit) ? exit.cause : {})).toContain("upstream fault")
  })

  test("still fails a stream that ends without settling", async () => {
    const exit = await Effect.runPromiseExit(
      runModelTurn(
        Model.make({ stream: () => Stream.fromIterable(deltas(2)) }),
        turn,
        { modelId: "model" },
        () => Effect.void
      )
    )
    expect(JSON.stringify(Exit.isFailure(exit) ? exit.cause : {})).toContain("ended without settlement")
  })

  test("releases the provider's producer when the turn is interrupted", async () => {
    const { model, state } = counted(deltas(4))
    const fiber = Effect.runFork(runModelTurn(model, turn, { modelId: "model" }, () => Effect.never))
    await waitUntil(() => state.produced > 0, "the provider stream was never started")
    await Effect.runPromise(Fiber.interrupt(fiber))
    await waitUntil(() => state.released, "an interrupted turn left the provider's producer running")
  })

  test("keeps a held tool call and its terminal frame", async () => {
    const events: Array<ModelEvent.ModelEvent> = [
      { type: "tool-call-start", id: "c1", name: "read" },
      { type: "tool-call-delta", id: "c1", arguments: "{\"path\":" },
      { type: "tool-call-delta", id: "c1", arguments: "\"a\"}" },
      { type: "tool-call-end", id: "c1" },
      { type: "settle", stopReason: "tool-calls" }
    ]
    const committed: Array<NativeAgent.AgentTurnFrame> = []
    const held = await Effect.runPromise(runModelTurn(
      Model.make({ stream: () => Stream.fromIterable(events) }),
      turn,
      { modelId: "model" },
      (frame) =>
        Effect.sync(() => {
          committed.push(frame)
        }),
      { usage: undefined }
    ))
    expect(held?.calls).toEqual([{ id: "c1", name: "read", arguments: "{\"path\":\"a\"}" }])
    expect(committed).toHaveLength(0)
  })
})
