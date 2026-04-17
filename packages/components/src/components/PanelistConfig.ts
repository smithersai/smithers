import type { AgentLike } from "@smithers/agents/AgentLike";

export type PanelistConfig = {
	agent: AgentLike;
	role?: string;
	label?: string;
};
