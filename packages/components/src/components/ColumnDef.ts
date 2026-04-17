import type { AgentLike } from "@smithers/agents/AgentLike";
import type { TaskProps } from "./TaskProps.ts";
import type { OutputTarget } from "./OutputTarget.ts";

type ColumnTaskProps = Omit<Partial<TaskProps<unknown>>, "agent" | "children" | "id" | "key" | "output" | "smithersContext">;

export type ColumnDef = {
	name: string;
	agent: AgentLike;
	/** Output schema for tasks in this column. */
	output: OutputTarget;
	/** Prompt template. Receives `{ item, column }` and returns a string. */
	prompt?: (ctx: {
		item: unknown;
		column: string;
	}) => string;
	/** Optional Task props applied to each generated item task in this column. */
	task?: ColumnTaskProps;
};
