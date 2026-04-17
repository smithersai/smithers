/** @typedef {import("./LlmJudgeConfig.js").LlmJudgeConfig} LlmJudgeConfig */
/** @typedef {import("./types.js").Scorer} Scorer */
/** @typedef {import("./types.js").ScorerInput} ScorerInput */
/** @typedef {import("./types.js").ScoreResult} ScoreResult */

/**
 * Creates an LLM-as-judge scorer that delegates evaluation to an AI agent.
 *
 * The judge agent receives a prompt constructed from `promptTemplate` and is
 * expected to return a JSON object with `score` (0-1) and optional `reason`.
 *
 * ```ts
 * const toneScorer = llmJudge({
 *   id: "tone",
 *   name: "Professional Tone",
 *   description: "Evaluates professional tone",
 *   judge: new AnthropicAgent({ model: "claude-sonnet-4-20250514" }),
 *   instructions: "You evaluate text for professional tone.",
 *   promptTemplate: ({ output }) =>
 *     `Rate the professionalism of this text (0-1 JSON):\n\n${String(output)}`,
 * });
 * ```
 *
 * @param {LlmJudgeConfig} config
 * @returns {Scorer}
 */
export function llmJudge(config) {
    const { id, name, description, judge, instructions, promptTemplate } = config;
    /**
   * @param {ScorerInput} input
   * @returns {Promise<ScoreResult>}
   */
    const score = async (input) => {
        const prompt = promptTemplate(input);
        const response = await judge.generate({
            prompt: `${instructions}\n\n${prompt}`,
        });
        // The response can be a string, or an object with a text field
        const text = typeof response === "string"
            ? response
            : typeof response?.text === "string"
                ? response.text
                : JSON.stringify(response);
        // Try to parse JSON from the response
        const jsonMatch = text.match(/\{[\s\S]*?"score"\s*:\s*[\d.]+[\s\S]*?\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                const rawScore = Number(parsed.score);
                return {
                    score: Number.isFinite(rawScore)
                        ? Math.max(0, Math.min(1, rawScore))
                        : 0,
                    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
                    meta: { raw: text },
                };
            }
            catch {
                // fall through to default
            }
        }
        // If we can't parse JSON, return a low-confidence score
        return {
            score: 0,
            reason: "Failed to parse judge response as JSON",
            meta: { raw: text },
        };
    };
    return { id, name, description, score };
}
