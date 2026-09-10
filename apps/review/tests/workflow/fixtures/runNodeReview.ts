/**
 * Runs one review under the durable Node composition, against a local provider.
 *
 * This is a Node entry point on purpose. `layerNode` builds the host's undici
 * HTTP client, which does not construct under Bun, so the composition the
 * shipped CLI actually runs can only be exercised from Node. The suite spawns
 * this file and reads the one JSON line it prints.
 *
 * Argv: repository, database, execution ID, optional file path to pause before.
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { Action } from "@smthrs/flow";
import { Effect } from "effect";
import { ReviewFile } from "../../../src/workflow/reviewAgentActions.ts";
import { RenderWalkthrough } from "../../../src/workflow/reviewActions.ts";
import { Review } from "../../../src/workflow/reviewFlow.ts";
import { layerNode } from "../../../src/workflow/reviewLayer.ts";
import { reviewSeatResolver } from "../../../src/workflow/reviewSeatResolver.ts";
import { resolveReviewSeats } from "../../../src/workflow/reviewSeats.ts";

const reviewAnswer = {
  status: "success",
  message: "",
  summary: null,
  comments: [
    {
      path: "src/file0.ts",
      content: "The new binding shadows the old one.",
      severity: "major",
      category: "correctness",
      confidence: "confirmed",
      startLine: 2,
      endLine: 2,
      existingCode: "",
      suggestionCode: "",
      thinking: "",
    },
  ],
  warnings: [],
};

/** One Anthropic SSE response carrying a fenced cell block with `answer`. */
function sseCell(answer: unknown): string {
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

const repo = process.argv[2]!;
const filename = process.argv[3]!;
const executionId = process.argv[4] ?? `review-layer-node-${Date.now()}`;
const pauseBefore = process.argv[5];
const calls: string[] = [];
let currentPath = "";
let diffs: unknown;

let requests = 0;
const provider = createServer((request, response) => {
  requests += 1;
  calls.push(currentPath);
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sseCell({ ...reviewAnswer, comments: reviewAnswer.comments.map((comment) => ({ ...comment, path: currentPath })) }));
  });
});

await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
const port = typeof address === "object" && address !== null ? address.port : 0;

const environment = {
  ANTHROPIC_API_KEY: "fixture-key",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  SMITHERS_REVIEW_SEAT: "anthropic:claude-sonnet-4-5",
};

const report = (value: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

try {
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const table = yield* Action.Implementations;
      const reviewFile = yield* ReviewFile.requirement;
      yield* table.add({
        ...reviewFile,
        action: (payload) => Effect.gen(function*() {
          const { path } = payload as { path: string };
          if (path === pauseBefore) {
            // With concurrency 1, reaching this action means the preceding
            // file batch and its handoff have committed in an earlier round.
            report({ paused: true, requests, calls });
            yield* Effect.never;
          }
          currentPath = path;
          return yield* reviewFile.action(payload);
        }),
      }, { override: true });
      const render = yield* RenderWalkthrough.requirement;
      yield* table.add({
        ...render,
        action: (payload) => Effect.gen(function*() {
          diffs = (payload as { changes: { files: unknown } }).changes.files;
          return yield* render.action(payload);
        }),
      }, { override: true });
      return yield* Review.execute(
        {
          repo,
          concurrency: 1,
          narrate: false,
          quiz: "off",
          verify: false,
          out: join(repo, ".smithers-review", "walkthrough.html"),
        } as Parameters<typeof Review.execute>[0],
        { executionId },
      );
    }).pipe(
      Effect.provide(
        layerNode({
          filename,
          seats: reviewSeatResolver(resolveReviewSeats(environment), environment),
          environment,
        }),
      ),
      Effect.scoped,
    ),
  );
  report({
    ok: true,
    requests,
    calls,
    diffs,
    findings: result.review.comments,
    status: result.review.status,
    paths: result.review.comments.map((comment) => comment.path),
    warnings: result.review.warnings.map((warning) => warning.type),
  });
} catch (error) {
  report({ ok: false, requests, error: (error as Error)?.message ?? String(error) });
} finally {
  provider.close();
}

process.exit(0);
