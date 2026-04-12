// @smithers-type-exports-begin
/** @typedef {import("./Debate.ts").DebateProps} DebateProps */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Parallel } from "./Parallel.js";
import { Loop } from "./Ralph.js";
import { Task } from "./Task.js";
/**
 * <Debate> — Adversarial rounds with rebuttals, followed by a judge verdict.
 *
 * Composes: Sequence > Loop[Parallel(proposer, opponent)] > Task(judge)
 */
export function Debate(props) {
    if (props.skipIf)
        return null;
    const { id, proposer, opponent, judge, rounds = 2, argumentOutput, verdictOutput, topic, } = props;
    const prefix = id ?? "debate";
    // Build round tasks inside a loop
    // Each round: proposer and opponent argue in parallel
    const proposerTask = React.createElement(Task, {
        id: `${prefix}-proposer`,
        output: argumentOutput,
        agent: proposer,
        label: "Proposer",
        children: React.createElement(React.Fragment, null, "Argue FOR the following topic:\n\n", topic),
    });
    const opponentTask = React.createElement(Task, {
        id: `${prefix}-opponent`,
        output: argumentOutput,
        agent: opponent,
        label: "Opponent",
        children: React.createElement(React.Fragment, null, "Argue AGAINST the following topic:\n\n", topic),
    });
    const roundParallel = React.createElement(Parallel, null, proposerTask, opponentTask);
    const roundSequence = React.createElement(Sequence, null, roundParallel);
    // Loop wraps the round sequence
    // `until` is always false here — the runtime re-renders the tree each frame,
    // so the caller controls iteration via their own ctx-based condition.
    // We set maxIterations to cap the rounds.
    const loopEl = React.createElement(Loop, {
        id: `${prefix}-loop`,
        until: false,
        maxIterations: rounds,
        onMaxReached: "return-last",
    }, roundSequence);
    // Judge verdict after all rounds
    const judgeNeeds = {
        [`${prefix}-proposer`]: `${prefix}-proposer`,
        [`${prefix}-opponent`]: `${prefix}-opponent`,
    };
    const judgeTask = React.createElement(Task, {
        id: `${prefix}-judge`,
        output: verdictOutput,
        agent: judge,
        needs: judgeNeeds,
        label: "Judge",
        children: React.createElement(React.Fragment, null, "Review all arguments from both sides and render a verdict on:\n\n", topic),
    });
    return React.createElement(Sequence, null, loopEl, judgeTask);
}
