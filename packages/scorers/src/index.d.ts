import * as _smithers_agents_AgentLike from '@smithers-orchestrator/agents/AgentLike';
import { AgentLike as AgentLike$3 } from '@smithers-orchestrator/agents/AgentLike';
import { ZodObject } from 'zod';
import * as _smithers_db_adapter from '@smithers-orchestrator/db/adapter';
import * as effect_MetricState from 'effect/MetricState';
import * as effect_MetricKeyType from 'effect/MetricKeyType';
import { Metric } from 'effect';

/** The result returned by every scorer function. */
type ScoreResult$2 = {
    /** Normalized quality score between 0 and 1. */
    score: number;
    /** Optional human-readable explanation of the score. */
    reason?: string;
    /** Arbitrary metadata for downstream consumption. */
    meta?: Record<string, unknown>;
};
/** The input passed to a scorer function when evaluating a task. */
type ScorerInput$1 = {
    /** The original task input or prompt. */
    input: unknown;
    /** The task's produced output. */
    output: unknown;
    /** Expected output for comparison (optional). */
    groundTruth?: unknown;
    /** Additional context such as retrieved documents (optional). */
    context?: unknown;
    /** How long the task took in milliseconds (optional). */
    latencyMs?: number;
    /** The Zod schema the output should match (optional). */
    outputSchema?: ZodObject;
};
/** An async function that evaluates a scorer input and returns a score result. */
type ScorerFn$1 = (input: ScorerInput$1) => Promise<ScoreResult$2>;
/** A named, self-describing scorer. */
type Scorer$8 = {
    /** Unique identifier for the scorer. */
    id: string;
    /** Human-readable name. */
    name: string;
    /** Description of what this scorer evaluates. */
    description: string;
    /** The scoring function. */
    score: ScorerFn$1;
};
/** Controls how often a scorer runs. */
type SamplingConfig$1 = {
    type: "all";
} | {
    type: "ratio";
    rate: number;
} | {
    type: "none";
};
/** Binds a scorer to a task with optional sampling configuration. */
type ScorerBinding$1 = {
    scorer: Scorer$8;
    sampling?: SamplingConfig$1;
};
/** A named map of scorer bindings attached to a task. */
type ScorersMap$2 = Record<string, ScorerBinding$1>;
/** A full row in the _smithers_scorers table. */
type ScoreRow$1 = {
    id: string;
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    scorerId: string;
    scorerName: string;
    source: "live" | "batch";
    score: number;
    reason: string | null;
    metaJson: string | null;
    inputJson: string | null;
    outputJson: string | null;
    latencyMs: number | null;
    scoredAtMs: number;
    durationMs: number | null;
};
/** Aggregated statistics for a scorer across multiple runs. */
type AggregateScore$2 = {
    scorerId: string;
    scorerName: string;
    count: number;
    mean: number;
    min: number;
    max: number;
    p50: number;
    stddev: number;
};
/** Context provided to the scorer execution engine. */
type ScorerContext$2 = {
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    input: unknown;
    output: unknown;
    latencyMs?: number;
    outputSchema?: ZodObject;
};

type LlmJudgeConfig$2 = {
    id: string;
    name: string;
    description: string;
    /** An agent that will act as the judge. */
    judge: AgentLike$3;
    /** System-level instructions for the judge agent. */
    instructions: string;
    /**
     * Build the prompt sent to the judge from the scorer input.
     * The prompt should instruct the judge to respond with JSON: `{ "score": <0-1>, "reason": "<text>" }`.
     */
    promptTemplate: (input: ScorerInput$1) => string;
};

type CreateScorerConfig$2 = {
    id: string;
    name: string;
    description: string;
    score: ScorerFn$1;
};

type AggregateOptions$2 = {
    /** Filter to a specific run. */
    runId?: string;
    /** Filter to a specific node. */
    nodeId?: string;
    /** Filter to a specific scorer. */
    scorerId?: string;
};

/** @typedef {import("./AggregateOptions.js").AggregateOptions} AggregateOptions */
/** @typedef {import("./types.js").AggregateScore} AggregateScore */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/**
 * Computes aggregate statistics for scorer results.
 *
 * Returns one row per scorer with count, mean, min, max, p50, and stddev.
 * Uses a simple SQL aggregation query plus in-memory p50 calculation,
 * since SQLite does not support PERCENTILE_CONT or correlated subqueries
 * in GROUP BY reliably.
 *
 * @param {SmithersDb} adapter
 * @param {AggregateOptions} [opts]
 * @returns {Promise<AggregateScore[]>}
 */
declare function aggregateScores(adapter: SmithersDb$1, opts?: AggregateOptions$1): Promise<AggregateScore$1[]>;
type AggregateOptions$1 = AggregateOptions$2;
type AggregateScore$1 = AggregateScore$2;
type SmithersDb$1 = _smithers_db_adapter.SmithersDb;

/**
 * Drizzle table definition for the `_smithers_scorers` table.
 * Stores individual scorer results for each task execution.
 */
declare const smithersScorers: any;

/** @typedef {import("./CreateScorerConfig.js").CreateScorerConfig} CreateScorerConfig */
/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a scorer from a plain configuration object.
 *
 * ```ts
 * const myScorer = createScorer({
 *   id: "word-count",
 *   name: "Word Count",
 *   description: "Scores based on word count",
 *   score: async ({ output }) => ({
 *     score: Math.min(String(output).split(/\s+/).length / 200, 1),
 *   }),
 * });
 * ```
 *
 * @param {CreateScorerConfig} config
 * @returns {Scorer}
 */
declare function createScorer(config: CreateScorerConfig$1): Scorer$7;
type CreateScorerConfig$1 = CreateScorerConfig$2;
type Scorer$7 = Scorer$8;

/** @typedef {import("./LlmJudgeConfig.js").LlmJudgeConfig} LlmJudgeConfig */
/** @typedef {import("./types.js").Scorer} Scorer */
/** @typedef {import("./types.js").ScorerInput} ScorerInput */
/** @typedef {import("./types.js").ScoreResult} ScoreResult */
/**
 * Creates an LLM-as-judge scorer that delegates evaluation to an AI agent.
 *
 * The judge agent receives a prompt constructed from `promptTemplate` and is
 * expected to return a JSON object with `score` (0-1) and optional `reason`.
 *
 * ```ts
 * const toneScorer = llmJudge({
 *   id: "tone",
 *   name: "Professional Tone",
 *   description: "Evaluates professional tone",
 *   judge: new AnthropicAgent({ model: "claude-sonnet-4-20250514" }),
 *   instructions: "You evaluate text for professional tone.",
 *   promptTemplate: ({ output }) =>
 *     `Rate the professionalism of this text (0-1 JSON):\n\n${String(output)}`,
 * });
 * ```
 *
 * @param {LlmJudgeConfig} config
 * @returns {Scorer}
 */
declare function llmJudge(config: LlmJudgeConfig$1): Scorer$6;
type LlmJudgeConfig$1 = LlmJudgeConfig$2;
type Scorer$6 = Scorer$8;

/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a relevancy scorer that uses an LLM judge to evaluate whether
 * the output is relevant to the input.
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
declare function relevancyScorer(judge: AgentLike$2): Scorer$5;
type AgentLike$2 = _smithers_agents_AgentLike.AgentLike;
type Scorer$5 = Scorer$8;

/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a toxicity scorer that uses an LLM judge to detect toxic,
 * harmful, or inappropriate content in the output.
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
declare function toxicityScorer(judge: AgentLike$1): Scorer$4;
type AgentLike$1 = _smithers_agents_AgentLike.AgentLike;
type Scorer$4 = Scorer$8;

/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a faithfulness scorer that uses an LLM judge to check whether
 * the output is faithful to the provided context (no hallucinations).
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
declare function faithfulnessScorer(judge: AgentLike): Scorer$3;
type AgentLike = _smithers_agents_AgentLike.AgentLike;
type Scorer$3 = Scorer$8;

/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a schema adherence scorer that validates the output against
 * the task's Zod schema. Returns 1.0 if valid, 0.0 if invalid.
 *
 * @returns {Scorer}
 */
declare function schemaAdherenceScorer(): Scorer$2;
type Scorer$2 = Scorer$8;

/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a latency scorer that scores based on execution time.
 * Returns 1.0 at or below `targetMs`, linearly decreasing to 0.0 at `maxMs`.
 *
 * @param {{ targetMs: number; maxMs: number }} opts
 * @returns {Scorer}
 */
declare function latencyScorer(opts: {
    targetMs: number;
    maxMs: number;
}): Scorer$1;
type Scorer$1 = Scorer$8;

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
declare function runScorersAsync(scorers: ScorersMap$1, ctx: ScorerContext$1, adapter: SmithersDb | null, eventBus?: EventBus | null): void;
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
declare function runScorersBatch(scorers: ScorersMap$1, ctx: ScorerContext$1, adapter: SmithersDb | null, eventBus?: EventBus | null): Promise<Record<string, ScoreResult$1 | null>>;
type EventBus = any;
type ScoreResult$1 = ScoreResult$2;
type ScorerContext$1 = ScorerContext$2;
type ScorersMap$1 = ScorersMap$2;
type SmithersDb = _smithers_db_adapter.SmithersDb;

declare const scorersStarted: Metric.Metric.Counter<number>;
declare const scorersFinished: Metric.Metric.Counter<number>;
declare const scorersFailed: Metric.Metric.Counter<number>;
declare const scorerDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

type AggregateOptions = AggregateOptions$2;
type AggregateScore = AggregateScore$2;
type CreateScorerConfig = CreateScorerConfig$2;
type LlmJudgeConfig = LlmJudgeConfig$2;
type SamplingConfig = SamplingConfig$1;
type Scorer = Scorer$8;
type ScorerBinding = ScorerBinding$1;
type ScorerContext = ScorerContext$2;
type ScoreResult = ScoreResult$2;
type ScorerFn = ScorerFn$1;
type ScorerInput = ScorerInput$1;
type ScoreRow = ScoreRow$1;
type ScorersMap = ScorersMap$2;

export { type AggregateOptions, type AggregateScore, type CreateScorerConfig, type LlmJudgeConfig, type SamplingConfig, type ScoreResult, type ScoreRow, type Scorer, type ScorerBinding, type ScorerContext, type ScorerFn, type ScorerInput, type ScorersMap, aggregateScores, createScorer, faithfulnessScorer, latencyScorer, llmJudge, relevancyScorer, runScorersAsync, runScorersBatch, schemaAdherenceScorer, scorerDuration, scorersFailed, scorersFinished, scorersStarted, smithersScorers, toxicityScorer };
