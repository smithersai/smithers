import type React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type DebateProps = {
	id?: string;
	proposer: AgentLike;
	opponent: AgentLike;
	judge: AgentLike;
	rounds?: number;
	argumentOutput: OutputTarget;
	verdictOutput: OutputTarget;
	topic: string | React.ReactNode;
	skipIf?: boolean;
};
