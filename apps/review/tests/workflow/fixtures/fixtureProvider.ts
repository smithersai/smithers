/**
 * A local Anthropic Messages endpoint for the suites that run a real provider
 * route: every request is answered with one SSE response whose text is a fenced
 * cell block completing with the value `respond` returns.
 */
import { createServer } from "node:http";

/** One Anthropic SSE response carrying a fenced cell block with `answer`. */
export function sseCell(answer: unknown): string {
  const cell = "```cell\n" + `ctx.done(${JSON.stringify(answer)})` + "\n```";
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: cell } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
}

/** A listening fixture provider. */
export interface FixtureProvider {
  /** The origin to put in `ANTHROPIC_BASE_URL`. */
  readonly url: string;
  /** How many requests it has answered so far. */
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}

/** Starts a provider on a free loopback port; `respond` is asked once per request. */
export async function startFixtureProvider(respond: () => unknown): Promise<FixtureProvider> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const answer = respond();
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sseCell(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
