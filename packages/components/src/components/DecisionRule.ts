import type React from "react";

export type DecisionRule = {
	/** Condition evaluated at render time. */
	when: boolean;
	/** Element to render when this rule matches. */
	then: React.ReactElement;
	/** Optional display label for the rule. */
	label?: string;
};
