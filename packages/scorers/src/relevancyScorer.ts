import type { AgentLike } from "@smithers/agents/AgentLike";
import type { Scorer } from "./types";
/**
 * Creates a relevancy scorer that uses an LLM judge to evaluate whether
 * the output is relevant to the input.
 */
export declare function relevancyScorer(judge: AgentLike): Scorer;
