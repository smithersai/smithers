import React from "react";
/** @typedef {import("./Branch.ts").BranchProps} BranchProps */

/**
 * @param {BranchProps} props
 */
export function Branch(props) {
    if (props.skipIf)
        return null;
    const chosen = props.if ? props.then : (props.else ?? null);
    return React.createElement("smithers:branch", props, chosen);
}
