import { llmJudge } from "./llmJudge.js";
/** @typedef {import("@smithers/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */

/**
 * Creates a relevancy scorer that uses an LLM judge to evaluate whether
 * the output is relevant to the input.
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
export function relevancyScorer(judge) {
    return llmJudge({
        id: "relevancy",
        name: "Relevancy",
        description: "Evaluates whether the output is relevant and addresses the input",
        judge,
        instructions: `You are an answer relevancy evaluator. Your job is to determine if an LLM output is relevant to the input prompt.

Key Principles:
1. Evaluate whether the output addresses what the input is asking for
2. Consider both direct answers and related context
3. Prioritize relevance to the input over correctness
4. Responses can be partially relevant
5. Empty or error outputs should score 0`,
        promptTemplate: ({ input, output }) => `Evaluate the relevancy of this output to the given input.

Input: ${JSON.stringify(input)}

Output: ${JSON.stringify(output)}

Respond with a JSON object: { "score": <number 0-1>, "reason": "<brief explanation>" }

Where 1.0 means perfectly relevant and 0.0 means completely irrelevant.`,
    });
}
