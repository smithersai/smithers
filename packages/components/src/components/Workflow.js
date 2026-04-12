import React from "react";
/** @typedef {import("./Workflow.ts").WorkflowProps} WorkflowProps */

/**
 * @param {WorkflowProps} props
 */
export function Workflow(props) {
    return React.createElement("smithers:workflow", props, props.children);
}
