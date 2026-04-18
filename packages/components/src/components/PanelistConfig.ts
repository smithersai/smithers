import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";

export type PanelistConfig = {
	agent: AgentLike;
	role?: string;
	label?: string;
};
