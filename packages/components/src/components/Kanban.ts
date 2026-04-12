import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import { type TaskProps } from "./Task";
type OutputTarget = import("zod").ZodObject<any> | {
    $inferSelect: any;
} | string;
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
/**
 * <Kanban> — Process items through columns with pluggable ticket source.
 *
 * Composes Loop, Sequence, Parallel, and Task to create a board where items
 * flow through columns. Each column processes items via its assigned agent.
 * Items in the same column can be processed in parallel.
 */
export declare function Kanban(props: KanbanProps): React.FunctionComponentElement<import("./Sequence").SequenceProps> | React.FunctionComponentElement<import("./Ralph").LoopProps> | null;
export {};
