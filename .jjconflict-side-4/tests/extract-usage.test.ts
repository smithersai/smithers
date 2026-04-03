import { describe, expect, test } from "bun:test";
import { extractUsageFromOutput } from "../src/agents/BaseCliAgent";

describe("extractUsageFromOutput", () => {
  test("extracts tokens from Claude Code stream-json NDJSON", () => {
    const lines = [
      JSON.stringify({ type: "message_start", message: { id: "msg_01", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-20250514", usage: { input_tokens: 1523, cache_creation_input_tokens: 200, cache_read_input_tokens: 50, output_tokens: 1 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
      JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const raw = lines.join("\n");
    const usage = extractUsageFromOutput(raw);

    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBe(1523);
    expect(usage!.outputTokens).toBe(42);
    expect(usage!.cacheReadTokens).toBe(50);
    expect(usage!.cacheWriteTokens).toBe(200);
  });

  test("extracts tokens from Codex --json JSONL with turn.completed", () => {
    const lines = [
      JSON.stringify({ type: "turn.started", session_id: "sess-1" }),
      JSON.stringify({ type: "message", role: "assistant", content: "Hello world" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 500, output_tokens: 120, cached_input_tokens: 80 } }),
    ];
    const raw = lines.join("\n");
    const usage = extractUsageFromOutput(raw);

    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBe(500);
    expect(usage!.outputTokens).toBe(120);
    expect(usage!.cacheReadTokens).toBe(80);
  });

  test("extracts tokens from Gemini json stats.models", () => {
    const raw = JSON.stringify({
      response: "Hello world",
      stats: {
        models: {
          "gemini-2.5-pro": {
            tokens: { input: 300, output: 75 },
            requests: 1,
          },
          "gemini-2.5-flash": {
            tokens: { input: 100, output: 30 },
            requests: 1,
          },
        },
      },
    });

    const usage = extractUsageFromOutput(raw);

    expect(usage).toBeDefined();
    // Should aggregate across models
    expect(usage!.inputTokens).toBe(400);
    expect(usage!.outputTokens).toBe(105);
  });

  test("extracts tokens from generic usage object", () => {
    const raw = JSON.stringify({ type: "complete", usage: { input_tokens: 250, output_tokens: 60, reasoning_tokens: 15 } });
    const usage = extractUsageFromOutput(raw);

    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBe(250);
    expect(usage!.outputTokens).toBe(60);
    expect(usage!.reasoningTokens).toBe(15);
  });

  test("handles multiple message_start events (multi-turn)", () => {
    const lines = [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0 } } }),
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 20 } }),
      JSON.stringify({ type: "message_stop" }),
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 200, output_tokens: 0 } } }),
      JSON.stringify({ type: "message_delta", usage: { output_tokens: 30 } }),
      JSON.stringify({ type: "message_stop" }),
    ];
    const raw = lines.join("\n");
    const usage = extractUsageFromOutput(raw);

    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBe(300);
    expect(usage!.outputTokens).toBe(50);
  });

  test("returns undefined for plain text output with no usage data", () => {
    const raw = "Hello, I am a helpful assistant.\nHow can I help you today?";
    const usage = extractUsageFromOutput(raw);
    expect(usage).toBeUndefined();
  });

  test("returns undefined for empty output", () => {
    expect(extractUsageFromOutput("")).toBeUndefined();
    expect(extractUsageFromOutput("\n\n")).toBeUndefined();
  });
});
