import type React from "react";
import type { z } from "zod";
import type { SmithersCtx } from "@smithers/driver";

export type SignalProps<Schema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> = {
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
	smithersContext?: React.Context<SmithersCtx<unknown> | null>;
};
