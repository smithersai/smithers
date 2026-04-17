import type React from "react";
import type { DecisionRule } from "./DecisionRule.ts";

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
