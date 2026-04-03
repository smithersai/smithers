import { Effect, Metric } from "effect";
import { fromPromise } from "../effect/interop";
import { runFork, runPromise } from "../effect/runtime";
import { scorerDuration, scorersFinished, scorersFailed, scorersStarted } from "./metrics";
import type { SmithersDb } from "../db/adapter";
import type { EventBus } from "../events";
import type { ScoreResult, ScorerBinding, ScorerContext, ScorersMap } from "./types";
import { nowMs } from "../utils/time";
import type { SmithersError } from "../utils/errors";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function shouldRun(binding: ScorerBinding): boolean {
  const sampling = binding.sampling ?? { type: "all" };
  switch (sampling.type) {
    case "all":
      return true;
    case "none":
      return false;
    case "ratio":
      return Math.random() < sampling.rate;
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Single scorer execution
// ---------------------------------------------------------------------------

function runSingleScorerEffect(
  key: string,
  binding: ScorerBinding,
  ctx: ScorerContext,
  adapter: SmithersDb | null,
  source: "live" | "batch",
  eventBus?: EventBus | null,
): Effect.Effect<ScoreResult | null, SmithersError> {
  const { scorer } = binding;

  return Effect.gen(function* () {
    if (!shouldRun(binding)) {
      return null;
    }

    yield* Metric.increment(scorersStarted);

    // Emit ScorerStarted event
    if (eventBus) {
      yield* Effect.sync(() =>
        eventBus.emit("event", {
          type: "ScorerStarted",
          runId: ctx.runId,
          nodeId: ctx.nodeId,
          scorerId: scorer.id,
          scorerName: scorer.name,
          timestampMs: nowMs(),
        }),
      );
    }

    const start = performance.now();
    const result = yield* fromPromise(`scorer:${scorer.id}`, () =>
      scorer.score({
        input: ctx.input,
        output: ctx.output,
        latencyMs: ctx.latencyMs,
        outputSchema: ctx.outputSchema,
      }),
    {
      code: "SCORER_FAILED",
      details: {
        bindingKey: key,
        scorerId: scorer.id,
        scorerName: scorer.name,
        source,
      },
    },
    ).pipe(
      Effect.tapError((err) =>
        Effect.gen(function* () {
          yield* Metric.increment(scorersFailed);
          if (eventBus) {
            yield* Effect.sync(() =>
              eventBus.emit("event", {
                type: "ScorerFailed",
                runId: ctx.runId,
                nodeId: ctx.nodeId,
                scorerId: scorer.id,
                scorerName: scorer.name,
                error: err instanceof Error ? err.message : String(err),
                timestampMs: nowMs(),
              }),
            );
          }
        }),
      ),
    );

    const durationMs = performance.now() - start;
    yield* Metric.increment(scorersFinished);
    yield* Metric.update(scorerDuration, durationMs);

    // Emit ScorerFinished event
    if (eventBus) {
      yield* Effect.sync(() =>
        eventBus.emit("event", {
          type: "ScorerFinished",
          runId: ctx.runId,
          nodeId: ctx.nodeId,
          scorerId: scorer.id,
          scorerName: scorer.name,
          score: result.score,
          timestampMs: nowMs(),
        }),
      );
    }

    // Persist to DB if adapter is available
    if (adapter) {
      const row = {
        id: crypto.randomUUID(),
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        iteration: ctx.iteration,
        attempt: ctx.attempt,
        scorerId: scorer.id,
        scorerName: scorer.name,
        source,
        score: result.score,
        reason: result.reason ?? null,
        metaJson: result.meta ? JSON.stringify(result.meta) : null,
        inputJson: safeJsonStringify(ctx.input),
        outputJson: safeJsonStringify(ctx.output),
        latencyMs: ctx.latencyMs ?? null,
        scoredAtMs: nowMs(),
        durationMs,
      };
      yield* adapter.insertScorerResultEffect(row);
    }

    return result;
  }).pipe(
    Effect.annotateLogs({ scorer: scorer.id, nodeId: ctx.nodeId }),
    Effect.withLogSpan(`scorer:${scorer.id}`),
  );
}

function safeJsonStringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget scorer execution. Runs all scorers via Effect.runFork
 * so they never block the workflow. Used for live scoring during execution.
 */
export function runScorersAsync(
  scorers: ScorersMap,
  ctx: ScorerContext,
  adapter: SmithersDb | null,
  eventBus?: EventBus | null,
): void {
  const entries = Object.entries(scorers);
  if (entries.length === 0) return;

  const effects = entries.map(([key, binding]) =>
    runSingleScorerEffect(key, binding, ctx, adapter, "live", eventBus).pipe(
      Effect.catchAll((error) =>
        Effect.logError(`Scorer ${key} failed: ${error.message}`).pipe(
          Effect.annotateLogs({ scorer: key, error: error.message }),
          Effect.map(() => null),
        ),
      ),
    ),
  );

  const program = Effect.all(effects, { concurrency: "unbounded", discard: true }).pipe(
    Effect.withLogSpan("scorers:async"),
  );

  runFork(program);
}

/**
 * Blocking scorer execution. Runs all scorers and waits for completion.
 * Returns a map of key -> ScoreResult. Used for batch/test evaluation.
 */
export async function runScorersBatch(
  scorers: ScorersMap,
  ctx: ScorerContext,
  adapter: SmithersDb | null,
  eventBus?: EventBus | null,
): Promise<Record<string, ScoreResult | null>> {
  const entries = Object.entries(scorers);
  if (entries.length === 0) return {};

  const effects = entries.map(([key, binding]) =>
    runSingleScorerEffect(key, binding, ctx, adapter, "batch", eventBus).pipe(
      Effect.map((result) => [key, result] as const),
      Effect.catchAll((error) =>
        Effect.logError(`Scorer ${key} failed: ${error.message}`).pipe(
          Effect.annotateLogs({ scorer: key, error: error.message }),
          Effect.map(() => [key, null] as const),
        ),
      ),
    ),
  );

  const results = await runPromise(
    Effect.all(effects, { concurrency: "unbounded" }).pipe(
      Effect.withLogSpan("scorers:batch"),
    ),
  );

  return Object.fromEntries(results);
}
