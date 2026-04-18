import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";

export type CheckConfig = {
	id: string;
	agent?: AgentLike;
	command?: string;
	label?: string;
};
