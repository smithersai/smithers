/** @typedef {import("./CreateScorerConfig.js").CreateScorerConfig} CreateScorerConfig */
/** @typedef {import("./types.js").Scorer} Scorer */

/**
 * Creates a scorer from a plain configuration object.
 *
 * ```ts
 * const myScorer = createScorer({
 *   id: "word-count",
 *   name: "Word Count",
 *   description: "Scores based on word count",
 *   score: async ({ output }) => ({
 *     score: Math.min(String(output).split(/\s+/).length / 200, 1),
 *   }),
 * });
 * ```
 *
 * @param {CreateScorerConfig} config
 * @returns {Scorer}
 */
export function createScorer(config) {
    return {
        id: config.id,
        name: config.name,
        description: config.description,
        score: config.score,
    };
}
