import React from "react";
import { Task } from "./Task.js";
import { Sequence } from "./Sequence.js";
import { Branch } from "./Branch.js";
import { Loop } from "./Ralph.js";
/** @typedef {import("./DriftDetectorProps.ts").DriftDetectorProps} DriftDetectorProps */

/**
 * @param {DriftDetectorProps} props
 */
export function DriftDetector(props) {
    if (props.skipIf)
        return null;
    const prefix = props.id ?? "drift";
    // Determine if drift was detected from comparison output.
    // At render time, comparison may not exist yet, so default to false.
    const drifted = false; // Resolved at runtime via reactive re-render
    const captureTask = React.createElement(Task, {
        id: `${prefix}-capture`,
        output: props.captureOutput,
        agent: props.captureAgent,
        children: `Capture the current state for drift detection. Baseline reference: ${typeof props.baseline === "string"
            ? props.baseline
            : JSON.stringify(props.baseline)}`,
    });
    const compareTask = React.createElement(Task, {
        id: `${prefix}-compare`,
        output: props.compareOutput,
        agent: props.compareAgent,
        dependsOn: [`${prefix}-capture`],
        children: `Compare the captured current state against the baseline and determine if meaningful drift has occurred. Include a "drifted" boolean and "significance" string in your response. Baseline: ${typeof props.baseline === "string"
            ? props.baseline
            : JSON.stringify(props.baseline)}`,
    });
    const alertBranch = props.alert
        ? React.createElement(Branch, {
            if: drifted,
            then: props.alert,
        })
        : null;
    const sequenceChildren = [captureTask, compareTask];
    if (alertBranch)
        sequenceChildren.push(alertBranch);
    const sequence = React.createElement(Sequence, null, ...sequenceChildren);
    if (props.poll) {
        return React.createElement(Loop, {
            id: `${prefix}-poll`,
            until: false,
            maxIterations: props.poll.maxPolls ?? 100,
            onMaxReached: "return-last",
        }, sequence);
    }
    return sequence;
}
