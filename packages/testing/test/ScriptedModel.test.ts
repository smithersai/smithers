import { describe, expect, it } from "@effect/vitest"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import { ModelRequest } from "@smthrs/model/ModelRequest"
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import * as ScriptedModel from "../src/ScriptedModel.vibe"
import * as TurnGate from "../src/TurnGate.vibe"
import * as TurnLog from "../src/TurnLog.ts"

const request = (text: string, system = "Teach.") =>
  ModelRequest.make({
    modelId: "m",
    system: [{ type: "text", text: system }],
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools: [{ name: "write", description: "Write.", parameters: {} }],
    params: {}
  })

const greet: ScriptedModel.Turn = {
  name: "greet",
  when: (r) => ScriptedModel.transcript(r).some((message) => message.content.includes("hello")),
  reply: () => "hi"
}

const collect = (model: Model.Model, r: ModelRequest) =>
  Stream.runCollect(model.stream(r)).pipe(Effect.map((events) => [...events]))

const text = (events: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  events.flatMap((event) => event.type === "text-delta" ? [event.text] : []).join("")

describe("ScriptedModel.transcript", () => {
  it("joins each message's text, tool-call arguments and tool results", () => {
    const conversation = ModelRequest.make({
      modelId: "m",
      system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "u" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hidden" },
            { type: "text", text: "a" },
            { type: "tool-call", id: "c", name: "write", arguments: "{}" }
          ],
          stopReason: "tool-calls"
        },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c", content: "ok", addedToolNames: [] }] }
      ],
      tools: [],
      params: {}
    })
    expect(ScriptedModel.transcript(conversation)).toEqual([
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a{}" },
      { role: "tool", content: "ok" }
    ])
  })
})

describe("ScriptedModel.fromTurns", () => {
  it("answers with the first turn whose when holds, and its hold", () => {
    const script = ScriptedModel.fromTurns([
      { ...greet, hold: () => "k" },
      { name: "second", when: () => true, reply: () => "later" }
    ])
    expect(script(request("hello"))).toEqual({ name: "greet", text: "hi", hold: "k" })
    expect(script(request("other"))).toEqual({ name: "second", text: "later", hold: undefined })
    expect(ScriptedModel.fromTurns([greet])(request("other"))).toBeUndefined()
  })
})

describe("ScriptedModel.make", () => {
  it.effect("streams a scripted answer and then the usage a metering proxy reads", () =>
    Effect.gen(function*() {
      const events = yield* collect(ScriptedModel.make({ script: ScriptedModel.fromTurns([greet]) }), request("hello"))
      expect(events.map((event) => event.type)).toEqual(["text-start", "text-delta", "text-end", "settle", "usage"])
      expect(text(events)).toBe("hi")
      expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 100, outputTokens: 100, totalTokens: 200 })
      const priced = yield* collect(
        ScriptedModel.make({ script: ScriptedModel.fromTurns([greet]), usage: { inputTokens: 3, outputTokens: 4 } }),
        request("hello")
      )
      expect(priced.at(-1)).toEqual({ type: "usage", inputTokens: 3, outputTokens: 4, totalTokens: 7 })
    }))

  it.effect("sends what the script does not answer to the fallback, keeping its provider name", () =>
    Effect.gen(function*() {
      const fallback = Model.make({
        providerName: "recorded",
        stream: () => Stream.make({ type: "text-delta" as const, id: "t", text: "from the fallback" })
      })
      const model = ScriptedModel.make({ script: ScriptedModel.fromTurns([greet]), fallback })
      expect(model.providerName).toBe("recorded")
      expect(text(yield* collect(model, request("other")))).toBe("from the fallback")
      expect(text(yield* collect(model, request("hello")))).toBe("hi")
      expect(ScriptedModel.make({ script: () => undefined }).providerName).toBeUndefined()
      expect(
        ScriptedModel.make({ script: () => undefined, fallback: Model.make({ stream: () => Stream.empty }) })
          .providerName
      )
        .toBeUndefined()
    }))

  it.effect("dies with UnscriptedModelError, naming counts and tools, when nothing answers", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(collect(ScriptedModel.make({ script: () => undefined }), request("other")))
      expect(Exit.isFailure(exit)).toBe(true)
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(defect).toMatchObject({
        _tag: "UnscriptedModelError",
        modelId: "m",
        messageCount: 1,
        toolNames: ["write"]
      })
    }))

  it.effect("refuses the request with a 400 ModelError when the script throws", () =>
    Effect.gen(function*() {
      const thrown = (value: unknown) =>
        collect(
          ScriptedModel.make({
            script: () => {
              throw value
            }
          }),
          request("x")
        ).pipe(Effect.flip)
      const error = yield* thrown(new Error("no flow"))
      expect(error).toBeInstanceOf(ModelError)
      expect(error).toMatchObject({
        code: "invalid_request",
        httpStatus: 400,
        message: "The script refused the request: no flow"
      })
      expect((yield* thrown("plain")).message).toBe("The script refused the request: plain")
    }))

  it.live("holds a reply that names a key until the gate releases it", () =>
    Effect.gen(function*() {
      const gate = yield* TurnGate.make()
      const model = ScriptedModel.make({ script: ScriptedModel.fromTurns([{ ...greet, hold: () => "k" }]), gate })
      const fiber = yield* Effect.forkChild(collect(model, request("hello")))
      while ((yield* gate.held()).length === 0) yield* Effect.sleep("5 millis")
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* gate.release("k")
      expect(text(yield* Fiber.join(fiber))).toBe("hi")
      // Without a gate, a hold answers at once.
      const ungated = ScriptedModel.make({ script: ScriptedModel.fromTurns([{ ...greet, hold: () => "k" }]) })
      expect(text(yield* collect(ungated, request("hello")))).toBe("hi")
    }))

  it.effect("logs each turn at dispatch, with its hold and detail, and unscripted ones by that name", () =>
    Effect.gen(function*() {
      const log = yield* TurnLog.make()
      const gate = yield* TurnGate.make()
      yield* gate.release("k")
      const script: ScriptedModel.Script = (r) =>
        ScriptedModel.transcript(r).some((message) => message.content === "hello")
          ? { name: "greet", text: "hi", hold: "k", detail: { note: 1 } }
          : undefined
      const model = ScriptedModel.make({
        script,
        gate,
        log,
        fallback: Model.make({ stream: () => Stream.empty })
      })
      yield* collect(model, request("hello"))
      yield* collect(model, request("other"))
      const entries = yield* log.entries()
      expect(entries.map(({ at: _at, ...entry }) => entry)).toEqual([
        { n: 1, kind: "chat", step: "greet", model: "m", messageCount: 1, note: 1, hold: "k" },
        { n: 2, kind: "chat", step: "unscripted", model: "m", messageCount: 1 }
      ])
    }))
})
