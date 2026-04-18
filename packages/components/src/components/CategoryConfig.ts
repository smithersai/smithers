import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type CategoryConfig = {
	agent: AgentLike;
	/** Output schema for this category's route handler. Overrides `routeOutput`. */
	output?: OutputTarget;
	/** Optional prompt for the route handler. Receives the classified item. */
	prompt?: (item: unknown) => string;
};
