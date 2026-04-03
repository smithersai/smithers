import { describe, expect, test } from "bun:test";
import { createAgentStdoutTextEmitter } from "../src/agents/BaseCliAgent";

describe("CLI agent stdout transcript emitter", () => {
  test("emits streamed assistant deltas without duplicating the final turn payload", () => {
    let streamed = "";
    const emitter = createAgentStdoutTextEmitter({
      outputFormat: "stream-json",
      onText: (text) => {
        streamed += text;
      },
    });

    emitter.push(JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello" },
    }) + "\n");
    emitter.push(JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: " world" },
    }) + "\n");
    emitter.push(JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    }) + "\n");
    emitter.flush("Hello world");

    expect(streamed).toBe("Hello world");
  });

  test("falls back to the final extracted text when the CLI did not stream deltas", () => {
    let streamed = "";
    const emitter = createAgentStdoutTextEmitter({
      outputFormat: "json",
      onText: (text) => {
        streamed += text;
      },
    });

    emitter.push(JSON.stringify({ type: "turn.completed" }) + "\n");
    emitter.flush("Final assistant reply");

    expect(streamed).toBe("Final assistant reply");
  });
});
