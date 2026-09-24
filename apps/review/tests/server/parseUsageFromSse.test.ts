import { describe, expect, test } from "bun:test";
import { teeForMetering } from "../../src/server/proxy/teeForMetering.ts";

async function metered(stream: string) {
  const { passthrough, collected } = teeForMetering(new Response(stream), true, new AbortController());
  await new Response(passthrough).text();
  return (await collected).summary;
}

function stream(lineEnding: "\n" | "\r\n"): string {
  return [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":300,"output_tokens":1,"cache_creation_input_tokens":200,"cache_read_input_tokens":4000}}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":300,"output_tokens":42}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join(lineEnding);
}

describe("streaming metering", () => {
  test("parses an LF-delimited stream", async () => {
    expect(await metered(stream("\n"))).toEqual({
      model: "claude-sonnet-4-6",
      inputTokens: 300,
      outputTokens: 42,
      cacheCreationTokens: 200,
      cacheReadTokens: 4000,
    });
  });

  test("parses a CRLF-delimited stream identically (an intermediary may rewrite line endings)", async () => {
    expect(await metered(stream("\r\n"))).toEqual(await metered(stream("\n")));
  });

  test("returns null when no message frames appear", async () => {
    expect(await metered("event: ping\r\ndata: {}\r\n\r\n")).toBeNull();
  });
});
