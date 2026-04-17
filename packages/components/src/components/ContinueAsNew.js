import React from "react";
/** @typedef {import("./ContinueAsNewProps.ts").ContinueAsNewProps} ContinueAsNewProps */

/**
 * @param {unknown} state
 * @returns {string | undefined}
 */
function serializeState(state) {
    if (state === undefined)
        return undefined;
    return JSON.stringify(state);
}
/**
 * @param {ContinueAsNewProps} props
 */
export function ContinueAsNew(props) {
    return React.createElement("smithers:continue-as-new", {
        stateJson: serializeState(props.state),
    });
}
/**
 * Convenience helper for conditional continuation inside workflow JSX:
 * `{shouldContinue ? continueAsNew({ cursor }) : null}`
 */
export function continueAsNew(state) {
    return React.createElement(ContinueAsNew, { state });
}
