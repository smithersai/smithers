import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type EscalationLevel = {
	/** Agent to handle this escalation level. */
	agent: AgentLike;
	/** Output target for this level's result. */
	output: OutputTarget;
	/** Display label for this level. */
	label?: string;
	/** Predicate evaluated on the level's result. Return `true` to escalate. */
	escalateIf?: (result: unknown) => boolean;
};
