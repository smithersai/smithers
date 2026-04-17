import type { z } from "zod";

/** Valid output targets: a Zod schema (recommended), a Drizzle table object, or a string key (escape hatch). */
export type OutputTarget = z.ZodObject<z.ZodRawShape> | {
	$inferSelect: Record<string, unknown>;
} | string;
