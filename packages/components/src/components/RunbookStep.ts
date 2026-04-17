import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type RunbookStep = {
	/** Unique step identifier. */
	id: string;
	/** Agent for this step (falls back to `defaultAgent`). */
	agent?: AgentLike;
	/** Shell command or instruction for the step. */
	command?: string;
	/** Risk classification: safe auto-executes, risky/critical require approval. */
	risk: "safe" | "risky" | "critical";
	/** Human-readable label for the step. */
	label?: string;
	/** Per-step output schema override. */
	output?: OutputTarget;
};
