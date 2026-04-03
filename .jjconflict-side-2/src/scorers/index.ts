// Types
export type {
  ScoreResult,
  ScorerInput,
  ScorerFn,
  Scorer,
  SamplingConfig,
  ScorerBinding,
  ScorersMap,
  ScoreRow,
  AggregateScore,
  ScorerContext,
} from "./types";

// Factories
export { createScorer, llmJudge } from "./create-scorer";
export type { CreateScorerConfig, LlmJudgeConfig } from "./create-scorer";

// Built-in scorers
export {
  relevancyScorer,
  toxicityScorer,
  faithfulnessScorer,
  schemaAdherenceScorer,
  latencyScorer,
} from "./builtins";

// Execution
export { runScorersAsync, runScorersBatch } from "./run-scorers";

// Aggregation
export { aggregateScores } from "./aggregate";
export type { AggregateOptions } from "./aggregate";

// Schema
export { smithersScorers } from "./schema";

// Metrics
export {
  scorersStarted,
  scorersFinished,
  scorersFailed,
  scorerDuration,
} from "./metrics";
