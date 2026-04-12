// @smithers-type-exports-begin
/** @typedef {import("./Optimizer.ts").OptimizerProps} OptimizerProps */
// @smithers-type-exports-end

import React from "react";
import { Loop } from "./Ralph.js";
import { Sequence } from "./Sequence.js";
import { Task } from "./Task.js";
/**
 * Generate -> evaluate -> improve loop with score convergence.
 *
 * Composes Loop, Sequence, and Task to create an iterative
 * optimization pattern. Each iteration receives the previous
 * score and feedback to guide improvement.
 */
export function Optimizer(props) {
    if (props.skipIf)
        return null;
    const { id, generator, evaluator, generateOutput, evaluateOutput, targetScore, maxIterations = 10, onMaxReached = "return-last", children, } = props;
    const prefix = id ?? "optimizer";
    const generateId = `${prefix}-generate`;
    const evaluateId = `${prefix}-evaluate`;
    // `until` is false — the runtime re-renders and checks the evaluate
    // output's `score` field against `targetScore` each frame.
    // When no targetScore is set, the loop always runs all iterations.
    const isAgentEvaluator = typeof evaluator !== "function";
    return React.createElement(Loop, {
        id: prefix,
        until: false,
        maxIterations,
        onMaxReached,
    }, React.createElement(Sequence, null, React.createElement(Task, {
        id: generateId,
        output: generateOutput,
        agent: generator,
        children,
    }), isAgentEvaluator
        ? React.createElement(Task, {
            id: evaluateId,
            output: evaluateOutput,
            agent: evaluator,
            needs: { candidate: generateId },
            children: `Evaluate the generated candidate and provide a score.`,
        })
        : React.createElement(Task, {
            id: evaluateId,
            output: evaluateOutput,
            needs: { candidate: generateId },
            children: evaluator,
        })));
}
