import type React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { CategoryConfig } from "./CategoryConfig.ts";
import type { OutputTarget } from "./OutputTarget.ts";

export type ClassifyAndRouteProps = {
	id?: string;
	/** Items to classify. A single item or an array of items. */
	items: unknown | unknown[];
	/** Record mapping category names to agents or config objects. */
	categories: Record<string, AgentLike | CategoryConfig>;
	/** Agent that classifies items into categories. */
	classifierAgent: AgentLike;
	/** Output schema for the classification task. */
	classifierOutput: OutputTarget;
	/** Default output schema for routed work. Can be overridden per-category. */
	routeOutput: OutputTarget;
	/** Classification result used to drive routing. Typically from ctx.outputMaybe(). */
	classificationResult?: {
		classifications: Array<{
			itemId?: string;
			category: string;
			[key: string]: unknown;
		}>;
	} | null;
	/** Max parallel routes. */
	maxConcurrency?: number;
	skipIf?: boolean;
	children?: React.ReactNode;
};
