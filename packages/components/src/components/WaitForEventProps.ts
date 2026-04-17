import type { z } from "zod";
import type { OutputTarget } from "./OutputTarget.ts";

export type WaitForEventProps = {
	id: string;
	/** Event name/type to wait for. */
	event: string;
	/** Correlation key to match the right event instance. */
	correlationId?: string;
	/** Where to store the event payload. */
	output: OutputTarget;
	/** Zod schema for the event payload. */
	outputSchema?: z.ZodObject<z.ZodRawShape>;
	/** Max wait time in ms before timing out. */
	timeoutMs?: number;
	/** Behavior on timeout: fail (default), skip the node, or continue with null. */
	onTimeout?: "fail" | "skip" | "continue";
	/** Do not block unrelated downstream flow while waiting for the event. */
	async?: boolean;
	skipIf?: boolean;
	/** Explicit dependency on other task node IDs. */
	dependsOn?: string[];
	/** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
	needs?: Record<string, string>;
	label?: string;
	meta?: Record<string, unknown>;
	key?: string;
};
