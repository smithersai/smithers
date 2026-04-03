import type { AgentLike } from "../AgentLike";
import type { Scorer, ScorerFn, ScorerInput, ScoreResult } from "./types";

// ---------------------------------------------------------------------------
// Simple scorer factory
// ---------------------------------------------------------------------------

export type CreateScorerConfig = {
  id: string;
  name: string;
  description: string;
  score: ScorerFn;
};

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
 */
export function createScorer(config: CreateScorerConfig): Scorer {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    score: config.score,
  };
}

// ---------------------------------------------------------------------------
// LLM-as-judge factory
// ---------------------------------------------------------------------------

export type LlmJudgeConfig = {
  id: string;
  name: string;
  description: string;
  /** An agent that will act as the judge. */
  judge: AgentLike;
  /** System-level instructions for the judge agent. */
  instructions: string;
  /**
   * Build the prompt sent to the judge from the scorer input.
   * The prompt should instruct the judge to respond with JSON: `{ "score": <0-1>, "reason": "<text>" }`.
   */
  promptTemplate: (input: ScorerInput) => string;
};

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
 */
export function llmJudge(config: LlmJudgeConfig): Scorer {
  const { id, name, description, judge, instructions, promptTemplate } = config;

  const score: ScorerFn = async (input: ScorerInput): Promise<ScoreResult> => {
    const prompt = promptTemplate(input);

    const response = await judge.generate({
      prompt: `${instructions}\n\n${prompt}`,
    });

    // The response can be a string, or an object with a text field
    const text =
      typeof response === "string"
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
      } catch {
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
