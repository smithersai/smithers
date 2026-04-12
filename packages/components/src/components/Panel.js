// @smithers-type-exports-begin
/** @typedef {import("./Panel.ts").PanelProps} PanelProps */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Parallel } from "./Parallel.js";
import { Task } from "./Task.js";
/** @typedef {import("@smithers/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./Panel.ts").PanelistConfig} PanelistConfig */

/**
 * @param {PanelistConfig | AgentLike} entry
 * @param {number} index
 * @returns {PanelistConfig}
 */
function normalizePanelist(entry, index) {
    if ("generate" in entry && !("agent" in entry)) {
        return { agent: entry, label: `panelist-${index}` };
    }
    return entry;
}
/**
 * <Panel> — Parallel specialists review the same input, then a moderator synthesizes.
 *
 * Composes: Sequence > Parallel[Task per panelist] > Task(moderator)
 */
export function Panel(props) {
    if (props.skipIf)
        return null;
    const { id, panelists, moderator, panelistOutput, moderatorOutput, strategy = "synthesize", minAgree, maxConcurrency, children, } = props;
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
        });
    });
    const parallelEl = React.createElement(Parallel, { maxConcurrency }, ...panelistTasks);
    // Build needs map: each panelist task id -> its task id
    const needs = {};
    normalized.forEach((p, i) => {
        const taskId = `${prefix}-${p.label ?? p.role ?? `panelist-${i}`}`;
        needs[taskId] = taskId;
    });
    // Moderator prompt includes strategy metadata
    const strategyPrompt = strategy === "vote"
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
    });
    return React.createElement(Sequence, null, parallelEl, moderatorTask);
}
