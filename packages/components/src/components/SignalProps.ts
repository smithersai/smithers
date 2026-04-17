import type React from "react";
import type { z } from "zod";

export type SignalProps<Schema extends z.ZodObject<any> = z.ZodObject<any>> = {
	id: string;
	schema: Schema;
	correlationId?: string;
	timeoutMs?: number;
	onTimeout?: "fail" | "skip" | "continue";
	/** Do not block unrelated downstream flow while waiting for the signal. */
	async?: boolean;
	skipIf?: boolean;
	dependsOn?: string[];
	needs?: Record<string, string>;
	label?: string;
	meta?: Record<string, unknown>;
	key?: string;
	children?: (data: z.infer<Schema>) => React.ReactNode;
	smithersContext?: React.Context<any>;
};
