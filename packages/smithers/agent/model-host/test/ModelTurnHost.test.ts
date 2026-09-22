import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { providerRequest, runModelTurn, StreamingCredentialCutter } from "../src/ModelTurnHost.ts"

const turn: StartAgentTurnRequest = {
  runId: "run-1",
  instructions: "help",
  messages: [
    { role: "user", content: "inspect" },
    { type: "function_call", call_id: "old", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "old", output: "ok" }
  ],
  tools: [{ type: "function", name: "write", description: "write a file", parameters: { type: "object" } }]
}

describe("ModelTurnHost", () => {
  test("projects the established wire into the canonical model request", () => {
    const request = providerRequest(turn, { modelId: "model-a", maxTokens: 99 })
    expect(request.modelId).toBe("model-a")
    expect(request.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect(request.tools[0]?.name).toBe("write")
    expect(request.params.maxTokens).toBe(99)
  })

  test("streams deterministic text and tool invocation before a real terminal", async () => {
    const events: ReadonlyArray<ModelEvent.ModelEvent> = [
      { type: "text-delta", id: "text", text: "hello " },
      { type: "text-delta", id: "text", text: "world" },
      { type: "tool-call-start", id: "call-1", name: "write" },
      { type: "tool-call-delta", id: "call-1", arguments: "{\"path\":" },
      { type: "tool-call-end", id: "call-1", arguments: "{\"path\":\"a\"}" },
      { type: "settle", stopReason: "tool-calls" }
    ]
    const model = Model.make({ stream: () => Stream.fromIterable(events) })
    const frames: Array<AgentTurnFrame> = []
    await Effect.runPromise(
      runModelTurn(model, turn, { modelId: "model-a" }, (frame) => Effect.sync(() => frames.push(frame)))
    )
    expect(frames).toEqual([
      { runId: "run-1", type: "delta", kind: "text", text: "hello " },
      { runId: "run-1", type: "delta", kind: "text", text: "world" },
      { runId: "run-1", type: "tool_call", call_id: "call-1", name: "write", arguments: "{\"path\":\"a\"}" },
      { runId: "run-1", type: "done", reason: "tool_call" }
    ])
  })

  test("cuts a credential split across provider chunks and tool arguments", async () => {
    const events: ReadonlyArray<ModelEvent.ModelEvent> = [
      { type: "text-delta", id: "text", text: "key=sk-se" },
      { type: "text-delta", id: "text", text: "cret safe" },
      { type: "tool-call-start", id: "call", name: "write" },
      { type: "tool-call-end", id: "call", arguments: "{\"key\":\"sk-secret\"}" },
      { type: "settle", stopReason: "tool-calls" }
    ]
    const frames: Array<AgentTurnFrame> = []
    await Effect.runPromise(
      runModelTurn(Model.make({ stream: () => Stream.fromIterable(events) }), turn, {
        modelId: "m",
        credential: "sk-secret"
      }, (frame) => Effect.sync(() => frames.push(frame)))
    )
    expect(JSON.stringify(frames)).not.toContain("sk-secret")
    expect(frames.some((frame) => frame.type === "delta" && frame.text.includes("safe"))).toBe(true)
  })

  test("fiber interruption emits no invented completion", async () => {
    const frames: Array<AgentTurnFrame> = []
    const model = Model.make({ stream: () => Stream.never })
    const fiber = Effect.runFork(
      runModelTurn(model, turn, { modelId: "m" }, (frame) => Effect.sync(() => frames.push(frame)))
    )
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(frames).toEqual([])
  })

  test("credential cutter holds only a possible secret prefix", () => {
    const cutter = new StreamingCredentialCutter("abcdef")
    expect(cutter.push("safe abc")).toBe("safe ")
    expect(cutter.push("xyz")).toBe("abcxyz")
    expect(cutter.finish()).toBe("")
  })
})
