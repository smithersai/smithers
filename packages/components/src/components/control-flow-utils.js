import React from "react";
/**
 * @param {unknown} node
 * @returns {unknown}
 */
function mapChildren(node) {
    if (Array.isArray(node)) {
        return node.map((child) => forceContinueOnFail(child));
    }
    if (React.isValidElement(node)) {
        return forceContinueOnFail(node);
    }
    return node;
}
/**
 * Failure-boundary components need inner tasks to fail "softly" so the
 * scheduler can decide whether to run catch/finally or compensations.
 */
export function forceContinueOnFail(node) {
    if (!React.isValidElement(node)) {
        return node;
    }
    const props = (node.props ?? {});
    const nextProps = {};
    if ("output" in props) {
        nextProps.continueOnFail = true;
    }
    if ("children" in props) {
        nextProps.children = mapChildren(props.children);
    }
    if (Object.keys(nextProps).length === 0) {
        return node;
    }
    return React.cloneElement(node, nextProps);
}
