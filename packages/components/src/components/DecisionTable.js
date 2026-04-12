// @smithers-type-exports-begin
/** @typedef {import("./DecisionTable.ts").DecisionRule} DecisionRule */
/** @typedef {import("./DecisionTable.ts").DecisionTableProps} DecisionTableProps */
// @smithers-type-exports-end

import React from "react";
import { Branch } from "./Branch.js";
import { Parallel } from "./Parallel.js";
/**
 * Structured deterministic routing. Replaces deeply nested Branches with a
 * flat, declarative rule table.
 *
 * - `"first-match"` builds nested Branch elements so the first matching rule wins.
 * - `"all-match"` gathers all matching rules' `then` elements into a Parallel.
 *
 * Composes Branch and Parallel internally.
 */
export function DecisionTable(props) {
    if (props.skipIf)
        return null;
    const { rules, strategy = "first-match" } = props;
    if (strategy === "all-match") {
        const matching = rules.filter((r) => r.when).map((r) => r.then);
        if (matching.length === 0) {
            return props.default ?? null;
        }
        return React.createElement(Parallel, { id: props.id }, ...matching);
    }
    // "first-match": build nested Branches from the last rule backward.
    // The innermost else is the default fallback.
    let fallback = props.default ?? null;
    for (let i = rules.length - 1; i >= 0; i--) {
        const rule = rules[i];
        fallback = React.createElement(Branch, {
            if: rule.when,
            then: rule.then,
            else: fallback,
        });
    }
    return fallback;
}
