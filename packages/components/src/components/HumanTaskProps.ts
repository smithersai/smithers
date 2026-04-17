import type React from "react";
import type { OutputTarget } from "./OutputTarget.ts";

export type HumanTaskProps = {
	id: string;
	/** Where to store the human's response. */
	output: OutputTarget;
	/** Zod schema the human must conform to. Used for validation. */
	outputSchema?: import("zod").ZodObject<any>;
	/** Instructions for the human (string or ReactNode). */
	prompt: string | React.ReactNode;
	/** Max validation retries before failure. */
	maxAttempts?: number;
	/** Do not block unrelated downstream flow while waiting for human input. */
	async?: boolean;
	skipIf?: boolean;
	timeoutMs?: number;
	continueOnFail?: boolean;
	/** Explicit dependency on other task node IDs. */
	dependsOn?: string[];
	/** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
	needs?: Record<string, string>;
	label?: string;
	meta?: Record<string, unknown>;
	key?: string;
};
