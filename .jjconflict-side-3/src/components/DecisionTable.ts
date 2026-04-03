import React from "react";
import { Branch } from "./Branch";
import { Parallel } from "./Parallel";

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
export function DecisionTable(props: DecisionTableProps) {
  if (props.skipIf) return null;

  const { rules, strategy = "first-match" } = props;

  if (strategy === "all-match") {
    const matching = rules.filter((r) => r.when).map((r) => r.then);

    if (matching.length === 0) {
      return props.default ?? null;
    }

    return React.createElement(
      Parallel,
      { id: props.id },
      ...matching,
    );
  }

  // "first-match": build nested Branches from the last rule backward.
  // The innermost else is the default fallback.
  let fallback: React.ReactElement | null = props.default ?? null;

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
