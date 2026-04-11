import React from "react";
import type { AgentLike } from "@smithers/agents/AgentLike";
import { Sequence } from "./Sequence";
import { Parallel } from "./Parallel";
import { Task } from "./Task";

type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type SourceDef = {
  agent: AgentLike;
  /** Prompt for this source. A string or ReactNode. */
  prompt?: string;
  /** Output schema for this specific source. Overrides `gatherOutput`. */
  output?: OutputTarget;
  children?: React.ReactNode;
};

export type GatherAndSynthesizeProps = {
  id?: string;
  /** Record mapping source names to source definitions. */
  sources: Record<string, SourceDef>;
  /** Agent that synthesizes gathered data. */
  synthesizer: AgentLike;
  /** Default output schema for each source gather task. */
  gatherOutput: OutputTarget;
  /** Output schema for the synthesis task. */
  synthesisOutput: OutputTarget;
  /** Gathered results keyed by source name. Typically from ctx.outputMaybe(). */
  gatheredResults?: Record<string, unknown> | null;
  /** Max parallel gatherers. */
  maxConcurrency?: number;
  /** Prompt for the synthesis task. If omitted, a default prompt is generated. */
  synthesisPrompt?: string;
  skipIf?: boolean;
  children?: React.ReactNode;
};

/**
 * <GatherAndSynthesize> — Parallel data collection from different sources,
 * then synthesis into a unified result.
 *
 * Composes Sequence, Parallel, and Task. First a Parallel block gathers data
 * from each source agent, then a synthesis Task receives all gathered data
 * and produces a combined output.
 */
export function GatherAndSynthesize(props: GatherAndSynthesizeProps) {
  if (props.skipIf) return null;

  const {
    id,
    sources,
    synthesizer,
    gatherOutput,
    synthesisOutput,
    gatheredResults,
    maxConcurrency,
    synthesisPrompt,
    children,
  } = props;

  const prefix = id ?? "gather-and-synthesize";
  const sourceNames = Object.keys(sources);

  // Step 1: Parallel gather from all sources
  const gatherTasks = sourceNames.map((name) => {
    const source = sources[name];
    const output = source.output ?? gatherOutput;
    const taskId = `${prefix}-gather-${name}`;

    const content =
      source.children ??
      source.prompt ??
      `Gather data from source "${name}".`;

    return React.createElement(Task, {
      key: taskId,
      id: taskId,
      output,
      agent: source.agent,
      label: `Gather: ${name}`,
      children: content,
    });
  });

  const gatherParallel = React.createElement(
    Parallel,
    {
      key: `${prefix}-gather`,
      id: `${prefix}-gather`,
      maxConcurrency,
    },
    ...gatherTasks,
  );

  // Step 2: Build needs map — synthesis task depends on all gather tasks
  const needs: Record<string, string> = {};
  for (const name of sourceNames) {
    needs[name] = `${prefix}-gather-${name}`;
  }

  // Build synthesis prompt from gathered results
  const defaultSynthesisPrompt = gatheredResults
    ? `Synthesize the following gathered data into a unified result:\n\n${Object.entries(gatheredResults)
        .map(([name, data]) => `## ${name}\n${JSON.stringify(data, null, 2)}`)
        .join("\n\n")}`
    : `Synthesize the gathered data from sources: ${sourceNames.join(", ")}.`;

  const synthesisContent =
    children ?? synthesisPrompt ?? defaultSynthesisPrompt;

  const synthesisTask = React.createElement(Task, {
    key: `${prefix}-synthesize`,
    id: `${prefix}-synthesize`,
    output: synthesisOutput,
    agent: synthesizer,
    needs,
    label: "Synthesize",
    children: synthesisContent,
  });

  return React.createElement(Sequence, null, gatherParallel, synthesisTask);
}
