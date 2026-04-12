import type { AgentLike } from "@smithers/agents/AgentLike";
import type { Scorer } from "./types";
/**
 * Creates a faithfulness scorer that uses an LLM judge to check whether
 * the output is faithful to the provided context (no hallucinations).
 */
export declare function faithfulnessScorer(judge: AgentLike): Scorer;
