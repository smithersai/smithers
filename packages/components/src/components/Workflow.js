import React from "react";
/** @typedef {import("./WorkflowProps.ts").WorkflowProps} WorkflowProps */

/**
 * @param {WorkflowProps} props
 * @returns {React.DOMElement<WorkflowProps, Element>}
 */
export function Workflow(props) {
    return React.createElement("smithers:workflow", props, props.children);
}
