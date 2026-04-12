// @smithers-type-exports-begin
/** @typedef {import("./Supervisor.ts").SupervisorProps} SupervisorProps */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Task } from "./Task.js";
import { Parallel } from "./Parallel.js";
import { Loop } from "./Ralph.js";
import { Worktree } from "./Worktree.js";
/**
 * <Supervisor> — Boss plans, delegates to parallel workers, reviews, re-delegates failures.
 *
 * Composes: Sequence → [plan Task, Loop(until allDone) [Parallel worker Tasks, review Task], final Task]
 */
export function Supervisor(props) {
    if (props.skipIf)
        return null;
    const prefix = props.id ?? "supervisor";
    const maxIterations = props.maxIterations ?? 3;
    const maxConcurrency = props.maxConcurrency ?? 5;
    const useWorktrees = props.useWorktrees ?? false;
    const workerNames = Object.keys(props.workers);
    // Build a worker Task element for each worker type.
    // At render time the runtime resolves which tasks are active based on
    // the plan output; here we declare one slot per worker type.
    const workerElements = workerNames.map((workerType) => {
        const workerId = `${prefix}-worker-${workerType}`;
        const workerTask = React.createElement(Task, {
            key: workerId,
            id: workerId,
            output: props.workerOutput,
            agent: props.workers[workerType],
            continueOnFail: true,
            needs: { plan: `${prefix}-plan` },
            label: `Worker: ${workerType}`,
            children: `Execute tasks assigned to worker type "${workerType}". Refer to the plan for your specific instructions.`,
        });
        if (useWorktrees) {
            return React.createElement(Worktree, {
                key: workerId,
                path: `.worktrees/${workerId}`,
                branch: `worker/${workerId}`,
            }, workerTask);
        }
        return workerTask;
    });
    // Parallel worker execution
    const parallelWorkers = React.createElement(Parallel, { maxConcurrency }, ...workerElements);
    // Boss review Task
    const reviewTask = React.createElement(Task, {
        id: `${prefix}-review`,
        output: props.reviewOutput,
        agent: props.boss,
        needs: { plan: `${prefix}-plan` },
        label: "Supervisor review",
        children: "Review worker results. Set allDone to true if all tasks are satisfactory. List retriable task IDs in retriable[] if any need re-doing.",
    });
    // Loop body: parallel workers then review
    const loopBody = React.createElement(Sequence, null, parallelWorkers, reviewTask);
    // Loop: repeat until boss says allDone (runtime resolves `until` reactively)
    const delegateLoop = React.createElement(Loop, {
        id: `${prefix}-loop`,
        until: false, // runtime re-evaluates reactively based on review output
        maxIterations,
        onMaxReached: "return-last",
    }, loopBody);
    // Boss plan Task
    const planTask = React.createElement(Task, {
        id: `${prefix}-plan`,
        output: props.planOutput,
        agent: props.boss,
        label: "Supervisor plan",
        children: props.children,
    });
    // Final summary Task
    const finalTask = React.createElement(Task, {
        id: `${prefix}-final`,
        output: props.finalOutput,
        needs: { review: `${prefix}-review`, plan: `${prefix}-plan` },
        label: "Supervisor summary",
        children: "Summarize the overall results from all delegation cycles.",
    });
    return React.createElement(Sequence, null, planTask, delegateLoop, finalTask);
}
