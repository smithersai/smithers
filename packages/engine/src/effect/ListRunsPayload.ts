import type { RunStatusSchema } from "./RunStatusSchema.ts";

export type ListRunsPayload = {
	limit?: number;
	status?: RunStatusSchema;
};
