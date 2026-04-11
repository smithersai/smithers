import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import { Sequence } from "./Sequence";
import { Parallel } from "./Parallel";
import { Loop } from "./Ralph";
import { Task, type TaskProps } from "./Task";

type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;
type ColumnTaskProps = Omit<
  Partial<TaskProps<unknown>>,
  "agent" | "children" | "id" | "key" | "output" | "smithersContext"
>;

export type ColumnDef = {
  name: string;
  agent: AgentLike;
  /** Output schema for tasks in this column. */
  output: OutputTarget;
  /** Prompt template. Receives `{ item, column }` and returns a string. */
  prompt?: (ctx: { item: unknown; column: string }) => string;
  /** Optional Task props applied to each generated item task in this column. */
  task?: ColumnTaskProps;
};

export type KanbanProps = {
  id?: string;
  /** Column definitions in order. Items flow left to right. */
  columns: ColumnDef[];
  /** Function that returns ticket items to process. Each item must have an `id` field. */
  useTickets: () => Array<{ id: string; [key: string]: unknown }>;
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
export function Kanban(props: KanbanProps) {
  if (props.skipIf) return null;

  const {
    id,
    columns,
    useTickets,
    agents,
    maxConcurrency,
    onComplete,
    until = false,
    maxIterations = 5,
    children,
  } = props;

  const prefix = id ?? "kanban";
  const tickets = useTickets();

  // Build a Sequence of columns. Each column processes all tickets in Parallel.
  const columnElements = columns.map((col, colIdx) => {
    const agent = agents?.[col.name] ?? col.agent;
    const taskElements = tickets.map((item) => {
      const taskId = `${prefix}-${col.name}-${item.id}`;
      const taskProps = col.task ?? {};
      const prompt = col.prompt
        ? col.prompt({ item, column: col.name })
        : `Process item ${item.id} in column "${col.name}".`;
      return React.createElement(Task, {
        ...taskProps,
        key: `${col.name}-${item.id}`,
        id: taskId,
        output: col.output,
        agent,
        continueOnFail: taskProps.continueOnFail ?? true,
        label: taskProps.label ?? `${col.name}: ${item.id}`,
        children: prompt,
      });
    });

    return React.createElement(
      Parallel,
      {
        key: `col-${colIdx}-${col.name}`,
        id: `${prefix}-col-${col.name}`,
        maxConcurrency,
      },
      ...taskElements,
    );
  });

  const sequence = React.createElement(Sequence, null, ...columnElements);
  const loop = React.createElement(
    Loop,
    {
      id: `${prefix}-loop`,
      until,
      maxIterations,
      onMaxReached: "return-last" as const,
    },
    sequence,
  );

  if (!onComplete) {
    return loop;
  }

  return React.createElement(
    Sequence,
    null,
    loop,
    React.createElement(Task, {
      key: `${prefix}-complete`,
      id: `${prefix}-complete`,
      output: onComplete,
      label: "Board complete",
      children: children ?? null,
    }),
  );
}
