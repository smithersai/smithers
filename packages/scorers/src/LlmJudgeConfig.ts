import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";
import type { ScorerInput } from "./types";

export type LlmJudgeConfig = {
  id: string;
  name: string;
  description: string;
  /** An agent that will act as the judge. */
  judge: AgentLike;
  /** System-level instructions for the judge agent. */
  instructions: string;
  /**
   * Build the prompt sent to the judge from the scorer input.
   * The prompt should instruct the judge to respond with JSON: `{ "score": <0-1>, "reason": "<text>" }`.
   */
  promptTemplate: (input: ScorerInput) => string;
};
