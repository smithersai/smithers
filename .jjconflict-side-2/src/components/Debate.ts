import React from "react";
import type { AgentLike } from "../AgentLike";
import type { OutputTarget } from "./Task";
import { Sequence } from "./Sequence";
import { Parallel } from "./Parallel";
import { Loop } from "./Ralph";
import { Task } from "./Task";

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

/**
 * <Debate> — Adversarial rounds with rebuttals, followed by a judge verdict.
 *
 * Composes: Sequence > Loop[Parallel(proposer, opponent)] > Task(judge)
 */
export function Debate(props: DebateProps) {
  if (props.skipIf) return null;

  const {
    id,
    proposer,
    opponent,
    judge,
    rounds = 2,
    argumentOutput,
    verdictOutput,
    topic,
  } = props;

  const prefix = id ?? "debate";

  // Build round tasks inside a loop
  // Each round: proposer and opponent argue in parallel
  const proposerTask = React.createElement(Task, {
    id: `${prefix}-proposer`,
    output: argumentOutput,
    agent: proposer,
    label: "Proposer",
    children: React.createElement(
      React.Fragment,
      null,
      "Argue FOR the following topic:\n\n",
      topic,
    ),
  } as any);

  const opponentTask = React.createElement(Task, {
    id: `${prefix}-opponent`,
    output: argumentOutput,
    agent: opponent,
    label: "Opponent",
    children: React.createElement(
      React.Fragment,
      null,
      "Argue AGAINST the following topic:\n\n",
      topic,
    ),
  } as any);

  const roundParallel = React.createElement(
    Parallel,
    null,
    proposerTask,
    opponentTask,
  );

  const roundSequence = React.createElement(Sequence, null, roundParallel);

  // Loop wraps the round sequence
  // `until` is always false here — the runtime re-renders the tree each frame,
  // so the caller controls iteration via their own ctx-based condition.
  // We set maxIterations to cap the rounds.
  const loopEl = React.createElement(
    Loop,
    {
      id: `${prefix}-loop`,
      until: false,
      maxIterations: rounds,
      onMaxReached: "return-last" as const,
    },
    roundSequence,
  );

  // Judge verdict after all rounds
  const judgeNeeds: Record<string, string> = {
    [`${prefix}-proposer`]: `${prefix}-proposer`,
    [`${prefix}-opponent`]: `${prefix}-opponent`,
  };

  const judgeTask = React.createElement(Task, {
    id: `${prefix}-judge`,
    output: verdictOutput,
    agent: judge,
    needs: judgeNeeds,
    label: "Judge",
    children: React.createElement(
      React.Fragment,
      null,
      "Review all arguments from both sides and render a verdict on:\n\n",
      topic,
    ),
  } as any);

  return React.createElement(Sequence, null, loopEl, judgeTask);
}
