import React from "react";
/** @typedef {import("./ParallelProps.ts").ParallelProps} ParallelProps */

/**
 * @param {ParallelProps} props
 */
export function Parallel(props) {
    if (props.skipIf)
        return null;
    // Align prop sanitization with other structural components
    const next = {
        maxConcurrency: props.maxConcurrency,
        id: props.id,
    };
    return React.createElement("smithers:parallel", next, props.children);
}
