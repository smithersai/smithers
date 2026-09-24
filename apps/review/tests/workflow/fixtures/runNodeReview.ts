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
import { join } from "node:path";
import { Action } from "@smthrs/flow";
import { Effect } from "effect";
import { ReviewFile } from "../../../src/workflow/reviewAgentActions.ts";
import { RenderWalkthrough } from "../../../src/workflow/reviewActions.ts";
import { Review } from "../../../src/workflow/reviewFlow.ts";
import { layerNode } from "../../../src/workflow/reviewLayer.ts";
import { reviewSeatResolver } from "../../../src/workflow/reviewSeatResolver.ts";
import { resolveReviewSeats } from "../../../src/workflow/reviewSeats.ts";
import { startFixtureProvider } from "./fixtureProvider.ts";

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

const repo = process.argv[2]!;
const filename = process.argv[3]!;
const executionId = process.argv[4] ?? `review-layer-node-${Date.now()}`;
const pauseBefore = process.argv[5];
const calls: string[] = [];
let currentPath = "";
let diffs: unknown;

const provider = await startFixtureProvider(() => {
  calls.push(currentPath);
  return { ...reviewAnswer, comments: reviewAnswer.comments.map((comment) => ({ ...comment, path: currentPath })) };
});

const environment = {
  ANTHROPIC_API_KEY: "fixture-key",
  ANTHROPIC_BASE_URL: provider.url,
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
            report({ paused: true, requests: provider.requests(), calls });
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
    requests: provider.requests(),
    calls,
    diffs,
    findings: result.review.comments,
    status: result.review.status,
    paths: result.review.comments.map((comment) => comment.path),
    warnings: result.review.warnings.map((warning) => warning.type),
  });
} catch (error) {
  report({ ok: false, requests: provider.requests(), error: (error as Error)?.message ?? String(error) });
} finally {
  await provider.close();
}

process.exit(0);
