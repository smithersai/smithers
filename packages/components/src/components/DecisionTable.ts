import React from "react";
export type DecisionRule = {
    /** Condition evaluated at render time. */
    when: boolean;
    /** Element to render when this rule matches. */
    then: React.ReactElement;
    /** Optional display label for the rule. */
    label?: string;
};
export type DecisionTableProps = {
    /** ID prefix for generated wrapper nodes. */
    id?: string;
    /** Ordered list of rules. Each rule has a `when` condition and a `then` element. */
    rules: DecisionRule[];
    /** Fallback element rendered when no rules match. */
    default?: React.ReactElement;
    /** `"first-match"` (default): first matching rule wins. `"all-match"`: all matching rules run in parallel. */
    strategy?: "first-match" | "all-match";
    skipIf?: boolean;
};
/**
 * Structured deterministic routing. Replaces deeply nested Branches with a
 * flat, declarative rule table.
 *
 * - `"first-match"` builds nested Branch elements so the first matching rule wins.
 * - `"all-match"` gathers all matching rules' `then` elements into a Parallel.
 *
 * Composes Branch and Parallel internally.
 */
export declare function DecisionTable(props: DecisionTableProps): React.ReactElement<unknown, string | React.JSXElementConstructor<any>> | React.FunctionComponentElement<import("./Parallel").ParallelProps> | null;
