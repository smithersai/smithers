import type React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { ColumnDef } from "./ColumnDef.ts";
import type { OutputTarget } from "./OutputTarget.ts";

export type KanbanProps = {
	id?: string;
	/** Column definitions in order. Items flow left to right. */
	columns: ColumnDef[];
	/** Function that returns ticket items to process. Each item must have an `id` field. */
	useTickets: () => Array<{
		id: string;
		[key: string]: unknown;
	}>;
	/** Record mapping column names to agents. Overrides column-level agents. */
	agents?: Record<string, AgentLike>;
	/** Max items processed in parallel per column. */
	maxConcurrency?: number;
	/** Callback output schema when an item reaches the final column. */
	onComplete?: OutputTarget;
	/** Whether the board loop is done. When true, the loop exits. */
	until?: boolean;
	/** Max iterations through the column pipeline. */
	maxIterations?: number;
	skipIf?: boolean;
	children?: React.ReactNode | Record<string, unknown>;
};
