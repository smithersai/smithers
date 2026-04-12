import type { Scorer } from "./types";
/**
 * Creates a schema adherence scorer that validates the output against
 * the task's Zod schema. Returns 1.0 if valid, 0.0 if invalid.
 */
export declare function schemaAdherenceScorer(): Scorer;
