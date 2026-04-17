// @smithers-type-exports-begin
/** @typedef {import("./RalphProps.ts").RalphProps} RalphProps */
// @smithers-type-exports-end

import React from "react";
/** @typedef {import("./LoopProps.ts").LoopProps} LoopProps */

/**
 * @param {LoopProps} props
 */
export function Loop(props) {
    if (props.skipIf)
        return null;
    return React.createElement("smithers:ralph", props, props.children);
}
/** @deprecated Use `Loop` instead. */
export const Ralph = Loop;
