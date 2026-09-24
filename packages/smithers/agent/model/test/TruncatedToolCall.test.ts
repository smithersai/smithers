/**
 * One policy for a tool call the output budget cuts off, on every protocol.
 *
 * The call closes, with the text that arrived, before the turn settles
 * `length`; the stream does not fail; and the next request omits the call,
 * because a truncated turn's calls were never run and have no results.
 */
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as AnthropicMessages from "../src/AnthropicMessages.ts"
import { settledMessage } from "../src/ModelEvent.ts"
import type { ModelEvent } from "../src/ModelEvent.ts"
import { GenerationParams, Message, ModelRequest } from "../src/ModelRequest.ts"
import * as OpenAIChatCompletions from "../src/OpenAIChatCompletions.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"
import type * as Protocol from "../src/Protocol.ts"

const partial = "{\"cmd\":\"rm -"

const request = (modelId: string, messages: ModelRequest["messages"] = [Message.user("clean up")]) =>
  ModelRequest.make({ modelId, system: [], messages, tools: [], params: GenerationParams.make() })

const replay = <B, E, S>(
  protocol: Protocol.Protocol<B, string, E, S>,
  modelId: string,
  frames: ReadonlyArray<unknown>
): ReadonlyArray<ModelEvent> => {
  let state = protocol.stream.initial(request(modelId))
  const events: Array<ModelEvent> = []
  for (const frame of frames) {
    const event = Schema.decodeUnknownSync(protocol.stream.event)(JSON.stringify(frame))
    const [next, emitted] = Effect.runSync(protocol.stream.step(state, event))
    state = next
    events.push(...emitted)
  }
  events.push(...(protocol.stream.onHalt?.(state) ?? []))
  return events
}

const cases = [
  {
    name: "OpenAI Responses",
    protocol: OpenAIResponses.protocol as Protocol.Protocol<unknown, string, unknown, unknown>,
    modelId: "gpt-5",
    frames: [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" }
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: partial },
      {
        type: "response.incomplete",
        response: { id: "resp_1", incomplete_details: { reason: "max_output_tokens" } }
      }
    ]
  },
  {
    name: "Anthropic Messages",
    protocol: AnthropicMessages.protocol as Protocol.Protocol<unknown, string, unknown, unknown>,
    modelId: "claude-sonnet-4-5",
    frames: [
      { type: "message_start", message: { id: "msg_1" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "bash", input: {} }
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: partial } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      { type: "message_stop" }
    ]
  },
  {
    name: "Chat Completions",
    protocol: OpenAIChatCompletions.protocol as Protocol.Protocol<unknown, string, unknown, unknown>,
    modelId: "gpt-4o",
    frames: [
      {
        id: "chat_1",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: partial } }]
          }
        }]
      },
      { id: "chat_1", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }
    ]
  }
]

describe.each(cases)("a tool call the output budget cuts off on $name", ({ protocol, modelId, frames }) => {
  it("closes the call with what arrived before the turn settles length", () => {
    const events = replay(protocol, modelId, frames)
    const kinds = events.map((event) => event.type).filter((type) => type !== "usage")

    expect(kinds.at(-1)).toBe("settle")
    expect(kinds.filter((type) => type === "tool-call-end")).toHaveLength(1)
    expect(events.find((event) => event.type === "tool-call-end")).toMatchObject({ id: "call_1", arguments: partial })
    expect(events.find((event) => event.type === "settle")).toMatchObject({ stopReason: "length" })
  })

  it("omits the truncated call from the next request", () => {
    const { message } = settledMessage(replay(protocol, modelId, frames))
    expect(message.stopReason).toBe("length")

    const body = Effect.runSync(
      protocol.body.from(request(modelId, [Message.user("clean up"), message, Message.user("try again")]), {
        native: false
      })
    )

    expect(JSON.stringify(body)).not.toContain("call_1")
  })
})
