import { Effect, Metric } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { scorerDuration, scorersFinished, scorersFailed, scorersStarted } from "./metrics.js";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import crypto from "node:crypto";
/** @typedef {import("@smithers-orchestrator/engine/events").EventBus} EventBus */
/** @typedef {import("./types.js").ScoreResult} ScoreResult */
/** @typedef {import("./types.js").ScorerContext} ScorerContext */
/** @typedef {import("./types.js").ScorerBinding} ScorerBinding */
/** @typedef {import("./types.js").ScorersMap} ScorersMap */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------
/**
 * @param {ScorerBinding} binding
 * @returns {boolean}
 */
function shouldRun(binding) {
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
/**
 * @param {string} key
 * @param {ScorerBinding} binding
 * @param {ScorerContext} ctx
 * @param {SmithersDb | null} adapter
 * @param {"live" | "batch"} source
 * @param {EventBus | null} [eventBus]
 * @returns {Effect.Effect<ScoreResult | null, SmithersError>}
 */
function runSingleScorerEffect(key, binding, ctx, adapter, source, eventBus) {
    const { scorer } = binding;
    return Effect.gen(function* () {
        if (!shouldRun(binding)) {
            return null;
        }
        yield* Metric.increment(scorersStarted);
        // Emit ScorerStarted event
        if (eventBus) {
            yield* Effect.sync(() => eventBus.emit("event", {
                type: "ScorerStarted",
                runId: ctx.runId,
                nodeId: ctx.nodeId,
                scorerId: scorer.id,
                scorerName: scorer.name,
                timestampMs: nowMs(),
            }));
        }
        const start = performance.now();
        const result = yield* Effect.tryPromise({
            try: () => scorer.score({
                input: ctx.input,
                output: ctx.output,
                latencyMs: ctx.latencyMs,
                outputSchema: ctx.outputSchema,
            }),
            catch: (cause) => toSmithersError(cause, `scorer:${scorer.id}`, {
                code: "SCORER_FAILED",
                details: {
                    bindingKey: key,
                    scorerId: scorer.id,
                    scorerName: scorer.name,
                    source,
                },
            }),
        }).pipe(Effect.tapError((err) => Effect.gen(function* () {
            yield* Metric.increment(scorersFailed);
            if (eventBus) {
                yield* Effect.sync(() => eventBus.emit("event", {
                    type: "ScorerFailed",
                    runId: ctx.runId,
                    nodeId: ctx.nodeId,
                    scorerId: scorer.id,
                    scorerName: scorer.name,
                    error: err instanceof Error ? err.message : String(err),
                    timestampMs: nowMs(),
                }));
            }
        })));
        const durationMs = performance.now() - start;
        yield* Metric.increment(scorersFinished);
        yield* Metric.update(scorerDuration, durationMs);
        // Emit ScorerFinished event
        if (eventBus) {
            yield* Effect.sync(() => eventBus.emit("event", {
                type: "ScorerFinished",
                runId: ctx.runId,
                nodeId: ctx.nodeId,
                scorerId: scorer.id,
                scorerName: scorer.name,
                score: result.score,
                timestampMs: nowMs(),
            }));
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
            yield* adapter.insertScorerResult(row);
        }
        return result;
    }).pipe(Effect.annotateLogs({ scorer: scorer.id, nodeId: ctx.nodeId }), Effect.withLogSpan(`scorer:${scorer.id}`));
}
/**
 * @param {unknown} value
 * @returns {string | null}
 */
function safeJsonStringify(value) {
    if (value === undefined || value === null)
        return null;
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Fire-and-forget scorer execution. Runs all scorers via Effect.runFork
 * so they never block the workflow. Used for live scoring during execution.
 *
 * @param {ScorersMap} scorers
 * @param {ScorerContext} ctx
 * @param {SmithersDb | null} adapter
 * @param {EventBus | null} [eventBus]
 * @returns {void}
 */
export function runScorersAsync(scorers, ctx, adapter, eventBus) {
    const entries = Object.entries(scorers);
    if (entries.length === 0)
        return;
    const effects = entries.map(([key, binding]) => runSingleScorerEffect(key, binding, ctx, adapter, "live", eventBus).pipe(Effect.catchAll((error) => Effect.logError(`Scorer ${key} failed: ${error.message}`).pipe(Effect.annotateLogs({ scorer: key, error: error.message }), Effect.map(() => null)))));
    const program = Effect.all(effects, { concurrency: "unbounded", discard: true }).pipe(Effect.withLogSpan("scorers:async"));
    Effect.runFork(program);
}
/**
 * Blocking scorer execution. Runs all scorers and waits for completion.
 * Returns a map of key -> ScoreResult. Used for batch/test evaluation.
 *
 * @param {ScorersMap} scorers
 * @param {ScorerContext} ctx
 * @param {SmithersDb | null} adapter
 * @param {EventBus | null} [eventBus]
 * @returns {Promise<Record<string, ScoreResult | null>>}
 */
export async function runScorersBatch(scorers, ctx, adapter, eventBus) {
    const entries = Object.entries(scorers);
    if (entries.length === 0)
        return {};
    const effects = entries.map(([key, binding]) => runSingleScorerEffect(key, binding, ctx, adapter, "batch", eventBus).pipe(Effect.map((result) => [key, result]), Effect.catchAll((error) => Effect.logError(`Scorer ${key} failed: ${error.message}`).pipe(Effect.annotateLogs({ scorer: key, error: error.message }), Effect.map(() => [key, null])))));
    const results = await Effect.runPromise(Effect.all(effects, { concurrency: "unbounded" }).pipe(Effect.withLogSpan("scorers:batch")));
    return Object.fromEntries(results);
}
