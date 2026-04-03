import type { ZodObject } from "zod";

// ---------------------------------------------------------------------------
// Core scorer types
// ---------------------------------------------------------------------------

/** The result returned by every scorer function. */
export type ScoreResult = {
  /** Normalized quality score between 0 and 1. */
  score: number;
  /** Optional human-readable explanation of the score. */
  reason?: string;
  /** Arbitrary metadata for downstream consumption. */
  meta?: Record<string, unknown>;
};

/** The input passed to a scorer function when evaluating a task. */
export type ScorerInput = {
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
  outputSchema?: ZodObject<any>;
};

/** An async function that evaluates a scorer input and returns a score result. */
export type ScorerFn = (input: ScorerInput) => Promise<ScoreResult>;

/** A named, self-describing scorer. */
export type Scorer = {
  /** Unique identifier for the scorer. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Description of what this scorer evaluates. */
  description: string;
  /** The scoring function. */
  score: ScorerFn;
};

// ---------------------------------------------------------------------------
// Sampling configuration
// ---------------------------------------------------------------------------

/** Controls how often a scorer runs. */
export type SamplingConfig =
  | { type: "all" }
  | { type: "ratio"; rate: number }
  | { type: "none" };

/** Binds a scorer to a task with optional sampling configuration. */
export type ScorerBinding = {
  scorer: Scorer;
  sampling?: SamplingConfig;
};

/** A named map of scorer bindings attached to a task. */
export type ScorersMap = Record<string, ScorerBinding>;

// ---------------------------------------------------------------------------
// Persistence types
// ---------------------------------------------------------------------------

/** A full row in the _smithers_scorers table. */
export type ScoreRow = {
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
export type AggregateScore = {
  scorerId: string;
  scorerName: string;
  count: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  stddev: number;
};

// ---------------------------------------------------------------------------
// Scorer execution context (passed to run-scorers internally)
// ---------------------------------------------------------------------------

/** Context provided to the scorer execution engine. */
export type ScorerContext = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  input: unknown;
  output: unknown;
  latencyMs?: number;
  outputSchema?: ZodObject<any>;
};
