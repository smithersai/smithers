import type React from "react";
import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";
import type { PanelistConfig } from "./PanelistConfig.ts";
import type { OutputTarget } from "./OutputTarget.ts";

export type PanelProps = {
	id?: string;
	panelists: PanelistConfig[] | AgentLike[];
	moderator: AgentLike;
	panelistOutput: OutputTarget;
	moderatorOutput: OutputTarget;
	strategy?: "synthesize" | "vote" | "consensus";
	minAgree?: number;
	maxConcurrency?: number;
	skipIf?: boolean;
	children: string | React.ReactNode;
};
