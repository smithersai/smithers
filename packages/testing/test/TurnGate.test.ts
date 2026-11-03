import { describe, expect, it } from "@effect/vitest"
import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Deferred, Effect, Fiber, Stream } from "effect"
import * as TurnGate from "../src/TurnGate.vibe"

const request = (text: string): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    modelId: "openai:gpt-5-mini",
    system: [],
    messages: [ModelRequest.Message.user(text)],
    tools: [],
    params: ModelRequest.GenerationParams.make()
  })

const answer: ReadonlyArray<ModelEvent.ModelEvent> = [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", text: "done" },
  { type: "text-end", id: "t" },
  { type: "settle", stopReason: "stop" }
]

const live = Model.make({ stream: () => Stream.fromIterable(answer) })

/** The `[HOLD key]` marker a request's last user message carries. */
const marker = (held: ModelRequest.ModelRequest): string | undefined => {
  const last = held.messages.at(-1)
  return last?.role === "user" ? /\[HOLD ([a-z0-9]+)\]/.exec(last.content[0]?.text ?? "")?.[1] : undefined
}

describe("TurnGate", () => {
  it.effect("holds a turn until its key is released, and lists it while it waits", () =>
    Effect.gen(function*() {
      const gate = yield* TurnGate.make()
      const model = TurnGate.model(live, { gate, key: marker })
      const fiber = yield* Effect.forkChild(Stream.runCollect(model.stream(request("edit [HOLD t2]"))))
      yield* Effect.yieldNow
      yield* Effect.repeat(gate.held(), { until: (keys) => keys.includes("t2") })
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* gate.release("t2")
      const events = yield* Fiber.join(fiber)
      expect(events).toEqual(answer)
      expect(yield* gate.held()).toEqual([])
    }))

  it.effect("answers a turn without a key at once", () =>
    Effect.gen(function*() {
      const gate = yield* TurnGate.make()
      const model = TurnGate.model(live, { gate, key: marker })
      expect(yield* Stream.runCollect(model.stream(request("plain turn")))).toEqual(answer)
      expect(yield* gate.held()).toEqual([])
    }))

  it.effect("a release is sticky: every later turn on the key passes at once", () =>
    Effect.gen(function*() {
      const gate = yield* TurnGate.make()
      yield* gate.release("t3")
      const model = TurnGate.model(live, { gate, key: marker })
      expect(yield* Stream.runCollect(model.stream(request("[HOLD t3]")))).toEqual(answer)
      yield* gate.hold("t3")
      expect(yield* gate.held()).toEqual([])
    }))

  it.effect("one release answers every turn held on the key, and leaves other keys held", () =>
    Effect.gen(function*() {
      const gate = yield* TurnGate.make()
      const started = yield* Deferred.make<void>()
      const first = yield* Effect.forkChild(gate.hold("a"))
      const second = yield* Effect.forkChild(Deferred.succeed(started, undefined).pipe(Effect.andThen(gate.hold("a"))))
      const other = yield* Effect.forkChild(gate.hold("b"))
      yield* Deferred.await(started)
      yield* Effect.repeat(gate.held(), { until: (keys) => keys.length === 3 })
      expect(yield* gate.held()).toEqual(["a", "a", "b"])
      yield* gate.release("a")
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(yield* gate.held()).toEqual(["b"])
      expect(other.pollUnsafe()).toBeUndefined()
      yield* gate.release("b")
      yield* Fiber.join(other)
    }))

  it.effect("an interrupted hold leaves the held list", () =>
    Effect.gen(function*() {
      const gate = yield* TurnGate.make()
      const fiber = yield* Effect.forkChild(gate.hold("gone"))
      yield* Effect.repeat(gate.held(), { until: (keys) => keys.includes("gone") })
      yield* Fiber.interrupt(fiber)
      expect(yield* gate.held()).toEqual([])
    }))

  it("keeps the live model's provider name", () => {
    const named = Model.make({ providerName: "openai", stream: () => Stream.empty })
    return Effect.runPromise(Effect.gen(function*() {
      const gate = yield* TurnGate.make()
      expect(TurnGate.model(named, { gate, key: marker }).providerName).toBe("openai")
      expect(TurnGate.model(live, { gate, key: marker }).providerName).toBeUndefined()
    }))
  })
})
