import type { z } from "zod";
import type { InferRow } from "./InferRow";

/**
 * Infer the output type from either a Zod schema or a Drizzle table.
 */
export type InferOutputEntry<T> = T extends z.ZodTypeAny
  ? z.infer<T>
  : T extends { $inferSelect: any }
    ? InferRow<T>
    : never;
