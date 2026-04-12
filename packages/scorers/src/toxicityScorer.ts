import type { AgentLike } from "@smithers/agents/AgentLike";
import type { Scorer } from "./types";
/**
 * Creates a toxicity scorer that uses an LLM judge to detect toxic,
 * harmful, or inappropriate content in the output.
 */
export declare function toxicityScorer(judge: AgentLike): Scorer;
