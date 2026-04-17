import React from "react";
/** @typedef {import("./SequenceProps.ts").SequenceProps} SequenceProps */

/**
 * @param {SequenceProps} props
 */
export function Sequence(props) {
    if (props.skipIf)
        return null;
    return React.createElement("smithers:sequence", props, props.children);
}
