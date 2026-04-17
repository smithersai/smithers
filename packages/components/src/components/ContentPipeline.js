// @smithers-type-exports-begin
/** @typedef {import("./ContentPipelineProps.ts").ContentPipelineProps} ContentPipelineProps */
/** @typedef {import("./ContentPipelineStage.ts").ContentPipelineStage} ContentPipelineStage */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Task } from "./Task.js";
/**
 * Progressive content refinement: outline -> draft -> edit -> publish.
 *
 * Composes Sequence and Task to create a typed waterfall where each
 * stage is explicitly defined. Each Task uses `needs` to depend on
 * the previous stage, passing output forward through the pipeline.
 * @param {ContentPipelineProps} props
 */
export function ContentPipeline(props) {
    if (props.skipIf)
        return null;
    const { stages, children } = props;
    const taskElements = stages.map((stage, index) => {
        const taskProps = {
            id: stage.id,
            output: stage.output,
            agent: stage.agent,
            label: stage.label,
        };
        if (index === 0) {
            // First stage receives the initial prompt.
            return React.createElement(Task, taskProps, children);
        }
        // Subsequent stages depend on the previous stage.
        const prevStage = stages[index - 1];
        taskProps.needs = { previous: prevStage.id };
        return React.createElement(Task, taskProps, `Continue from the previous stage's output. Perform: ${stage.label ?? stage.id}`);
    });
    return React.createElement(Sequence, null, ...taskElements);
}
