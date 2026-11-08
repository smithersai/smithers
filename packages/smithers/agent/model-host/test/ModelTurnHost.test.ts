import { Model, type ModelEvent, RequestExecutor, Route } from "@smthrs/model"
import type { NativeAgent } from "@smthrs/rpc"
import { Effect, Fiber, Redacted, Result, Stream } from "effect"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, test } from "vitest"
import { providerRequest, runModelTurn, StreamingCredentialCutter } from "./fixtures/durable.ts"

const turn: NativeAgent.StartAgentTurnRequest = {
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
    const frames: Array<NativeAgent.AgentTurnFrame> = []
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
    const frames: Array<NativeAgent.AgentTurnFrame> = []
    await Effect.runPromise(
      runModelTurn(Model.make({ stream: () => Stream.fromIterable(events) }), turn, {
        modelId: "m",
        credential: "sk-secret"
      }, (frame) => Effect.sync(() => frames.push(frame)))
    )
    expect(JSON.stringify(frames)).not.toContain("sk-secret")
    expect(frames.some((frame) => frame.type === "delta" && frame.text.includes("safe"))).toBe(true)
  })

  test("refuses a tool call whose provider id carries the credential", async () => {
    const events: ReadonlyArray<ModelEvent.ModelEvent> = [
      { type: "tool-call-start", id: "call-sk-secret", name: "write" },
      { type: "tool-call-end", id: "call-sk-secret", arguments: "{}" },
      { type: "settle", stopReason: "tool-calls" }
    ]
    const frames: Array<NativeAgent.AgentTurnFrame> = []
    const exit = await Effect.runPromise(Effect.result(
      runModelTurn(Model.make({ stream: () => Stream.fromIterable(events) }), turn, {
        modelId: "m",
        credential: "sk-secret"
      }, (frame) => Effect.sync(() => frames.push(frame)))
    ))
    expect(Result.isFailure(exit) && exit.failure).toMatchObject({ code: "invalid_provider_output" })
    expect(JSON.stringify(exit)).not.toContain("sk-secret")
    expect(JSON.stringify(frames)).not.toContain("sk-secret")
  })

  test("fiber interruption emits no invented completion", async () => {
    const frames: Array<NativeAgent.AgentTurnFrame> = []
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

const collect = async (events: ReadonlyArray<ModelEvent.ModelEvent>, credential?: string) => {
  const frames: NativeAgent.AgentTurnFrame[] = []
  await Effect.runPromise(runModelTurn(
    Model.make({ stream: () => Stream.fromIterable(events) }),
    turn,
    { modelId: "fixture", ...(credential === undefined ? {} : { credential }) },
    (frame) =>
      Effect.sync(() => {
        frames.push(frame)
      })
  ))
  return frames
}

test("groups consecutive calls and results without merging ordinary assistant messages", () => {
  const call = { type: "function_call", call_id: "first", name: "read", arguments: "{}" } as const
  const result = { type: "function_call_output", call_id: "first", output: "ok" } as const
  const request = providerRequest({
    ...turn,
    messages: [call, { ...call, call_id: "second" }, result, { ...result, call_id: "second" }, {
      role: "assistant",
      content: "done"
    }, call]
  }, { modelId: "fixture" })
  expect(request.messages.map((message) => [message.role, message.content.length])).toEqual([
    ["assistant", 2],
    ["tool", 2],
    ["assistant", 1],
    ["assistant", 1]
  ])
  expect(
    providerRequest({ runId: turn.runId, instructions: turn.instructions, messages: [result] }, { modelId: "fixture" })
      .tools
  ).toEqual([])
})

test.each(["aborted", "error", "content-filter", "unknown", "stop", "length"] as const)(
  "preserves the terminal meaning of %s",
  async (stopReason) => {
    const frames = await collect([{ type: "settle", stopReason }])
    expect(frames).toEqual([{
      runId: turn.runId,
      type: "done",
      reason: stopReason === "aborted" ? "cancelled" : "stop",
      ...(["error", "content-filter", "unknown", "length"].includes(stopReason)
        ? { error: `model stopped: ${stopReason}` }
        : {})
    }])
  }
)

test("reports the call's merged usage on every done frame, tool calls included", async () => {
  expect(
    await collect([
      { type: "usage", inputTokens: 1_000, cachedInputTokens: 900 },
      { type: "usage", outputTokens: 40, reasoningTokens: 7 },
      { type: "settle", stopReason: "tool-calls" }
    ])
  ).toEqual([{
    runId: turn.runId,
    type: "done",
    reason: "tool_call",
    usage: { inputTokens: 1_000, cachedInputTokens: 900, outputTokens: 40 }
  }])
  expect(
    await collect([
      { type: "usage", inputTokens: 5, outputTokens: 1 },
      { type: "retry", attempt: 1, code: "overloaded", delayMillis: 0 },
      { type: "usage", outputTokens: 2 },
      { type: "settle", stopReason: "stop" }
    ])
  ).toEqual([{ runId: turn.runId, type: "done", reason: "stop", usage: { outputTokens: 2 } }])
})

test("omits usage when the provider reports none or only invalid counts", async () => {
  expect(
    await collect([{ type: "usage", inputTokens: -1, outputTokens: Number.NaN }, {
      type: "settle",
      stopReason: "stop"
    }])
  ).toEqual([{ runId: turn.runId, type: "done", reason: "stop" }])
})

test("reports a Chat Completions usage chunk sent after finish_reason on the done frame, body left open (#3849)", async () => {
  // api.openai.com and Ollama send the counters in a choice-less chunk after
  // the finish_reason chunk; the body stays open, as a proxy may hold it.
  const wire = [
    "{\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}",
    "{\"id\":\"c\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}",
    "{\"id\":\"c\",\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":1,\"total_tokens\":10}}"
  ]
  const route = Result.getOrThrow(Route.openaiChatCompatible({
    providerName: "openai",
    id: "compat",
    baseUrl: "https://compat.test",
    apiKey: Redacted.make("secret")
  }))
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (httpRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(
        httpRequest,
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(wire.map((frame) => `data: ${frame}\n\n`).join("")))
            }
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      ))
  })
  const frames: Array<NativeAgent.AgentTurnFrame> = []
  await Effect.runPromise(
    Effect.scoped(
      Route.toModel(route as Route.Config<unknown, string, unknown, unknown>).pipe(
        Effect.flatMap((model) =>
          runModelTurn(model, turn, { modelId: "gpt" }, (frame) => Effect.sync(() => frames.push(frame)))
        ),
        Effect.provideService(RequestExecutor.RequestExecutor, executor)
      )
    ).pipe(Effect.timeout("2 seconds"))
  )
  expect(frames.at(-1)).toEqual({
    runId: turn.runId,
    type: "done",
    reason: "stop",
    usage: { inputTokens: 9, outputTokens: 1 }
  })
})

test("flushes held text and reasoning at settlement and uses accumulated tool arguments", async () => {
  expect(
    await collect([
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", text: "abc" },
      { type: "thinking-delta", id: "thought", text: "abc" },
      { type: "tool-call-start", id: "call", name: "abcdefinspect" },
      { type: "tool-call-delta", id: "call", arguments: "{\"value\":\"abcdef\"}" },
      { type: "tool-call-end", id: "call" },
      { type: "settle", stopReason: "tool-calls" }
    ], "abcdef")
  ).toEqual([
    { runId: turn.runId, type: "tool_call", call_id: "call", name: "inspect", arguments: "{\"value\":\"\"}" },
    { runId: turn.runId, type: "delta", kind: "reasoning", text: "abc" },
    { runId: turn.runId, type: "delta", kind: "text", text: "abc" },
    { runId: turn.runId, type: "done", reason: "tool_call" }
  ])
  const cutter = new StreamingCredentialCutter("")
  expect(cutter.push("unchanged")).toBe("unchanged")
})

test.each(
  [
    [[{ type: "tool-call-delta", id: "missing", arguments: "{}" }], "tool delta preceded its start"],
    [[{ type: "tool-call-end", id: "missing" }], "tool end preceded its start"],
    [[{ type: "settle", stopReason: "stop" }, { type: "settle", stopReason: "stop" }], "model settled twice"],
    [[], "model stream ended without settlement"]
  ] satisfies Array<[ModelEvent.ModelEvent[], string]>
)("rejects malformed event sequences %j", async (events, message) => {
  await expect(collect(events)).rejects.toThrow(message)
})

test("cuts subscription token and account identity across every chunk boundary", () => {
  const access = "private-access-token"
  const account = "private-account-id"
  const credential = JSON.stringify({ accessToken: access, accountId: account })
  for (const secret of [access, account]) {
    for (let boundary = 0; boundary <= secret.length; boundary++) {
      const cutter = new StreamingCredentialCutter(credential)
      const output = cutter.push(`before ${secret.slice(0, boundary)}`) +
        cutter.push(`${secret.slice(boundary)} after`) + cutter.finish()
      expect(output).toBe("before  after")
    }
  }
})

test("never lets a cut echo join emitted text into the secret, at any pair of chunk boundaries", () => {
  // Cutting the inner echo joins the outer halves back into the secret.
  // The whole stream, as a reader concatenates it, must still hold no secret.
  const secret = "sk-live-0123456789abcdef"
  const nested = `say ${secret.slice(0, 5)}${secret}${secret.slice(5)} end`
  for (let first = 0; first <= nested.length; first++) {
    for (let second = first; second <= nested.length; second++) {
      const cutter = new StreamingCredentialCutter(secret)
      const output = cutter.push(nested.slice(0, first)) + cutter.push(nested.slice(first, second)) +
        cutter.push(nested.slice(second)) + cutter.finish()
      expect(output).not.toContain(secret)
      expect(output.startsWith("say ")).toBe(true)
      expect(output.endsWith(" end")).toBe(true)
    }
  }
})

test("cuts every fallback credential from text, reasoning and tools", async () => {
  const primary = "primary-secret"
  const fallback = "backup-secret"
  const access = "subscription-token"
  const account = "subscription-account"
  const events: ModelEvent.ModelEvent[] = [
    { type: "text-delta", id: "text", text: `before ${fallback.slice(0, 6)}` },
    { type: "text-delta", id: "text", text: `${fallback.slice(6)} ${primary} after` },
    { type: "thinking-delta", id: "reasoning", text: `${access} ${account}` },
    { type: "tool-call-start", id: "call", name: `${fallback}inspect` },
    { type: "tool-call-end", id: "call", arguments: JSON.stringify({ key: fallback, access, account }) },
    { type: "settle", stopReason: "tool-calls" }
  ]
  const frames: NativeAgent.AgentTurnFrame[] = []
  await Effect.runPromise(runModelTurn(Model.make({ stream: () => Stream.fromIterable(events) }), turn, {
    modelId: "fallback",
    credential: primary,
    additionalCredentials: [fallback, JSON.stringify({ accessToken: access, accountId: account })]
  }, (frame) =>
    Effect.sync(() => {
      frames.push(frame)
    })))
  const rendered = frames.filter((frame) => frame.type === "delta").map((frame) => frame.text).join("")
  for (const secret of [primary, fallback, access, account]) {
    expect(rendered).not.toContain(secret)
    expect(JSON.stringify(frames)).not.toContain(secret)
  }
  expect(frames).toContainEqual({
    runId: turn.runId,
    type: "tool_call",
    call_id: "call",
    name: "inspect",
    arguments: "{\"key\":\"\",\"access\":\"\",\"account\":\"\"}"
  })
  await expect(Effect.runPromise(runModelTurn(
    Model.make({
      stream: () =>
        Stream.succeed({
          type: "tool-call-start",
          id: fallback,
          name: "inspect"
        })
    }),
    turn,
    { modelId: "fallback", additionalCredentials: [fallback] },
    () => Effect.void
  ))).rejects.toThrow("tool call id contains the credential")
})

test("cutting a fallback cannot reassemble another credential across chunks", () => {
  const first = "abcdef"
  const second = "xyz"
  const input = `before abc${second}def after`
  for (let boundary = 0; boundary <= input.length; boundary++) {
    const cutter = new StreamingCredentialCutter(first, [second])
    const output = cutter.push(input.slice(0, boundary)) + cutter.push(input.slice(boundary)) + cutter.finish()
    expect(output).not.toContain(first)
    expect(output).not.toContain(second)
    expect(output.startsWith("before ")).toBe(true)
    expect(output.endsWith(" after")).toBe(true)
  }
})
