import type { SmithersDb } from "@smithers/db/adapter";
import type { EventBus } from "@smithers/engine/events";
import type { ScoreResult, ScorerContext, ScorersMap } from "./types";
/**
 * Fire-and-forget scorer execution. Runs all scorers via Effect.runFork
 * so they never block the workflow. Used for live scoring during execution.
 */
export declare function runScorersAsync(scorers: ScorersMap, ctx: ScorerContext, adapter: SmithersDb | null, eventBus?: EventBus | null): void;
/**
 * Blocking scorer execution. Runs all scorers and waits for completion.
 * Returns a map of key -> ScoreResult. Used for batch/test evaluation.
 */
export declare function runScorersBatch(scorers: ScorersMap, ctx: ScorerContext, adapter: SmithersDb | null, eventBus?: EventBus | null): Promise<Record<string, ScoreResult | null>>;
