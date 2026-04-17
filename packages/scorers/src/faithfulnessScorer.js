import { llmJudge } from "./llmJudge.js";
/** @typedef {import("@smithers/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */

/**
 * Creates a faithfulness scorer that uses an LLM judge to check whether
 * the output is faithful to the provided context (no hallucinations).
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
export function faithfulnessScorer(judge) {
    return llmJudge({
        id: "faithfulness",
        name: "Faithfulness",
        description: "Checks if the output is faithful to the provided context without hallucinations",
        judge,
        instructions: `You are a faithfulness evaluator. Your job is to determine if an LLM output is faithful to the provided context and does not contain hallucinations.

Key Principles:
1. Every claim in the output should be supported by the context
2. Unsupported claims count against faithfulness
3. Directly quoting context is maximally faithful
4. Reasonable inferences from context are acceptable
5. If no context is provided, evaluate based on internal consistency`,
        promptTemplate: ({ input, output, context }) => `Evaluate the faithfulness of the output to the provided context.

Input: ${JSON.stringify(input)}

Output: ${JSON.stringify(output)}

Context: ${context != null ? JSON.stringify(context) : "No context provided"}

Respond with a JSON object: { "score": <number 0-1>, "reason": "<brief explanation>" }

Where 1.0 means completely faithful (no hallucinations) and 0.0 means entirely fabricated.`,
    });
}
