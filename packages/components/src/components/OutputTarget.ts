/** Valid output targets: a Zod schema (recommended), a Drizzle table object, or a string key (escape hatch). */
export type OutputTarget = import("zod").ZodObject<any> | {
	$inferSelect: any;
} | string;
