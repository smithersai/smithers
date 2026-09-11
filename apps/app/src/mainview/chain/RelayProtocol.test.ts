import { Model, ModelRequest } from "@smthrs/model"
import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { layerModel } from "./StreamModel"

/*
 * The relay wire's own contract, below the author seat: what a frame means,
 * and what a refusal from the Worker boundary reaches the user as. The failure
 * shapes matter most — a relay that cannot say "sign in" honestly is a relay
 * that renders a blank turn.
 */

const request = (messages: ReadonlyArray<ModelRequest.Message> = [ModelRequest.Message.user("hi")]) =>
  ModelRequest.ModelRequest.make({
    modelId: "gpt-oss-120b",
    system: [ModelRequest.SystemPart.make({ text: "You are Smithers." })],
    messages,
    tools: [],
    params: ModelRequest.GenerationParams.make(),
    toolChoice: "none"
  })

const respondWith = (response: () => Response): { readonly fetchImpl: FetchLike; readonly sent: Array<Request> } => {
  const sent: Array<Request> = []
  return {
    sent,
    fetchImpl: async (input, init) => {
      sent.push(new Request(input, init))
      return response()
    }
  }
}

const ndjson = (frames: ReadonlyArray<Record<string, unknown>>): Response =>
  new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" }
  })

const collect = (
  fetchImpl: FetchLike,
  input = request()
): Promise<ReadonlyArray<unknown>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const model = yield* Model.Model
      return Array.from(yield* Stream.runCollect(model.stream(input)))
    }).pipe(Effect.provide(layerModel({ baseUrl: "https://app.test", fetchImpl }))) as unknown as Effect.Effect<
      ReadonlyArray<unknown>,
      never,
      never
    >
  )

const failure = (fetchImpl: FetchLike, input = request()): Promise<unknown> =>
  Effect.runPromise(
    Effect.exit(
      Effect.gen(function*() {
        const model = yield* Model.Model
        return yield* Stream.runCollect(model.stream(input))
      }).pipe(Effect.provide(layerModel({ baseUrl: "https://app.test", fetchImpl }))) as unknown as Effect.Effect<
        unknown,
        unknown,
        never
      >
    )
  ).then((exit) => (exit._tag === "Failure" ? exit.cause : undefined))

describe("the relay protocol", () => {
  test("folds text and reasoning frames into one settled assistant turn", async () => {
    const { fetchImpl } = respondWith(() =>
      ndjson([
        { type: "delta", kind: "reasoning", text: "hmm" },
        { type: "delta", kind: "text", text: "one " },
        { type: "delta", kind: "text", text: "two" },
        { type: "done", reason: "stop" }
      ])
    )
    const events = (await collect(fetchImpl)) as ReadonlyArray<{ readonly type: string }>
    expect(events.map((event) => event.type)).toEqual([
      "thinking-start",
      "thinking-delta",
      "text-start",
      "text-delta",
      "text-delta",
      "thinking-end",
      "text-end",
      "settle"
    ])
  })

  test("frames a whole tool call as start, delta, end", async () => {
    const { fetchImpl } = respondWith(() =>
      ndjson([
        { type: "tool_call", id: "call_1", call_id: "call_1", name: "watch", arguments: "{\"repo\":\"a/b\"}" },
        { type: "done", reason: "tool_call" }
      ])
    )
    const events = (await collect(fetchImpl)) as ReadonlyArray<{ readonly type: string; readonly id?: string }>
    expect(events.map((event) => event.type)).toEqual([
      "tool-call-start",
      "tool-call-delta",
      "tool-call-end",
      "settle"
    ])
    expect(events[0]!.id).toBe("call_1")
  })

  test("an error frame fails the stream instead of ending it quietly", async () => {
    const { fetchImpl } = respondWith(() =>
      ndjson([{ type: "error", code: "malformed_tool_call", message: "the model produced junk" }])
    )
    expect(JSON.stringify(await failure(fetchImpl))).toContain("the model produced junk")
  })

  test("the Worker's own refusal sentence reaches the caller", async () => {
    const { fetchImpl } = respondWith(
      () =>
        new Response(JSON.stringify({ status: "error", message: "Sign in to run a Smithers turn." }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
    )
    const cause = JSON.stringify(await failure(fetchImpl))
    expect(cause).toContain("Sign in to run a Smithers turn.")
    expect(cause).toContain("authentication")
  })

  test("a tool-bearing request fails locally — the relay serves sealed author calls only", async () => {
    const { fetchImpl, sent } = respondWith(() => ndjson([{ type: "done", reason: "stop" }]))
    const withTools = ModelRequest.ModelRequest.make({
      ...request(),
      tools: [
        ModelRequest.ToolDefinition.make({ name: "bash", description: "run", parameters: { type: "object" } })
      ]
    })
    expect(JSON.stringify(await failure(fetchImpl, withTools))).toContain("sealed author calls only")
    // Nothing left the browser: the refusal never reached the boundary.
    expect(sent).toHaveLength(0)
  })

  test("a tool transcript replays as the upstream's function-call items", async () => {
    const { fetchImpl, sent } = respondWith(() => ndjson([{ type: "done", reason: "stop" }]))
    await collect(
      fetchImpl,
      request([
        ModelRequest.Message.user("watch a/b"),
        ModelRequest.Message.assistant(
          [ModelRequest.ToolCallPart.make({ id: "call_1", name: "watch", arguments: "{}" })],
          { stopReason: "tool-calls" }
        ),
        ModelRequest.Message.tool(ModelRequest.ToolResultPart.make({ toolCallId: "call_1", content: "done" }))
      ])
    )
    expect((await sent[0]!.json()) as unknown).toEqual({
      instructions: "You are Smithers.",
      messages: [
        { role: "user", content: "watch a/b" },
        { type: "function_call", call_id: "call_1", name: "watch", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "done" }
      ]
    })
  })
})
