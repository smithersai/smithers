import type React from "react";
import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";
import type { OutputTarget } from "./OutputTarget.ts";

export type SuperSmithersProps = {
	/** Optional ID prefix for all generated task IDs. */
	id?: string;
	/** Markdown string or MDX component describing the intervention strategy. */
	strategy: string | React.ReactElement;
	/** Agent that reads code and decides modifications. */
	agent: AgentLike;
	/** Glob patterns of files the agent can modify. */
	targetFiles?: string[];
	/** Output schema for the intervention report (Zod object). */
	reportOutput?: OutputTarget;
	/** If true, reports changes without applying them. */
	dryRun?: boolean;
	/** Standard skip predicate. */
	skipIf?: boolean;
};
