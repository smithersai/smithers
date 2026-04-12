import { createScorer } from "./createScorer.js";
/**
 * Creates a schema adherence scorer that validates the output against
 * the task's Zod schema. Returns 1.0 if valid, 0.0 if invalid.
 */
export function schemaAdherenceScorer() {
    return createScorer({
        id: "schema-adherence",
        name: "Schema Adherence",
        description: "Validates that the output conforms to the expected Zod schema",
        score: async ({ output, outputSchema }) => {
            if (!outputSchema) {
                return {
                    score: 1,
                    reason: "No output schema defined; skipping validation",
                    meta: { skipped: true },
                };
            }
            const result = outputSchema.safeParse(output);
            if (result.success) {
                return { score: 1, reason: "Output matches schema" };
            }
            const issues = result.error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ");
            return {
                score: 0,
                reason: `Schema validation failed: ${issues}`,
                meta: { issues: result.error.issues },
            };
        },
    });
}
