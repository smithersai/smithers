import React from "react";
import type { AgentLike } from "../AgentLike";
import type { OutputTarget } from "./Task";
import { Sequence } from "./Sequence";
import { Parallel } from "./Parallel";
import { Task } from "./Task";

export type PanelistConfig = {
  agent: AgentLike;
  role?: string;
  label?: string;
};

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

function normalizePanelist(
  entry: PanelistConfig | AgentLike,
  index: number,
): PanelistConfig {
  if ("generate" in entry && !("agent" in entry)) {
    return { agent: entry as AgentLike, label: `panelist-${index}` };
  }
  return entry as PanelistConfig;
}

/**
 * <Panel> — Parallel specialists review the same input, then a moderator synthesizes.
 *
 * Composes: Sequence > Parallel[Task per panelist] > Task(moderator)
 */
export function Panel(props: PanelProps) {
  if (props.skipIf) return null;

  const {
    id,
    panelists,
    moderator,
    panelistOutput,
    moderatorOutput,
    strategy = "synthesize",
    minAgree,
    maxConcurrency,
    children,
  } = props;

  const prefix = id ?? "panel";
  const normalized = panelists.map(normalizePanelist);

  // Build parallel panelist tasks
  const panelistTasks = normalized.map((p, i) => {
    const taskId = `${prefix}-${p.label ?? p.role ?? `panelist-${i}`}`;
    return React.createElement(Task, {
      key: taskId,
      id: taskId,
      output: panelistOutput,
      agent: p.agent,
      label: p.role ?? p.label,
      children,
    } as any);
  });

  const parallelEl = React.createElement(
    Parallel,
    { maxConcurrency },
    ...panelistTasks,
  );

  // Build needs map: each panelist task id -> its task id
  const needs: Record<string, string> = {};
  normalized.forEach((p, i) => {
    const taskId = `${prefix}-${p.label ?? p.role ?? `panelist-${i}`}`;
    needs[taskId] = taskId;
  });

  // Moderator prompt includes strategy metadata
  const strategyPrompt =
    strategy === "vote"
      ? `\n\nStrategy: VOTE. Count how many panelists agree. ${minAgree ? `Minimum agreement required: ${minAgree}.` : ""}`
      : strategy === "consensus"
        ? `\n\nStrategy: CONSENSUS. All panelists must converge. ${minAgree ? `Minimum agreement required: ${minAgree}.` : ""}`
        : `\n\nStrategy: SYNTHESIZE. Combine all panelist outputs into a single coherent result.`;

  const moderatorChildren = `Synthesize the following panelist outputs.${strategyPrompt}`;

  const moderatorTask = React.createElement(Task, {
    id: `${prefix}-moderator`,
    output: moderatorOutput,
    agent: moderator,
    needs,
    children: moderatorChildren,
  } as any);

  return React.createElement(Sequence, null, parallelEl, moderatorTask);
}
