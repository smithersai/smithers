/**
 * The committed price table the scorecard grades cost with.
 *
 * Prices are USD per million tokens, as published for the OpenAI API. They are
 * committed rather than fetched so that re-scoring an old run reproduces the
 * old number: a price change must be an edit here, with a date, not a silent
 * drift in someone's report.
 *
 * Verified 2026-08-19 against:
 *   - https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/
 *     (the GPT-5.6 launch post: Sol at $5 / $30 per 1M input / output)
 *   - https://www.orcarouter.ai/blog/gpt-5-6-sol-pricing (verified 2026-08-18:
 *     $5.00 input on a cache miss, $0.50 cached input, $30.00 output)
 *   - https://openrouter.ai/openai/gpt-5.6-sol (quotes the same base rates
 *     under a promotional 50% discount, cache read at half of $0.50)
 *
 * A seat the table does not name has undefined cost with an explicit
 * `unpriced` note, never silently at another model's rate.
 *
 * Jev is priced from the journal beside the seat, never folded into the
 * seat's number: `claim-demanded` and `supervisor-settled` carry the usage of
 * the two harness classifiers, and a `cell-call-settled` of the `jev` flow
 * carries the usage of an agent's own call. `decision-settled` carries the
 * same readings without usage and is never priced.
 *
 * @since 0.1.0
 */

/**
 * One model's USD price per million tokens.
 *
 * @category models
 * @since 0.1.0
 */
export interface Price {
  /** Uncached input tokens, USD per 1M. */
  readonly input: number
  /** Cache-read input tokens, USD per 1M. */
  readonly cachedInput: number
  /** Output tokens, including reasoning tokens, USD per 1M. */
  readonly output: number
  /** Where the numbers came from, and when they were checked. */
  readonly source: string
}

/**
 * The gateway id of Jev, as `Evaluator.defaultModel` names it. Every Jev
 * reading a journal records is priced under this row, whichever seat the
 * run's model turns were on.
 *
 * @category constants
 * @since 0.1.0
 */
export const jevModel = "typesafe-ai/jev"

/**
 * The table, keyed by both the bare model id and the seat spelling the flows
 * CLI uses, because a run's journal records the seat and a codex run records
 * the model.
 *
 * @category constants
 * @since 0.1.0
 */
export const prices: Record<string, Price> = {
  "gpt-5.6-sol": {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    source: "OpenAI API list price, verified 2026-08-19"
  },
  "openai:gpt-5.6-sol": {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    source: "OpenAI API list price, verified 2026-08-19"
  },
  // The standard-tier short-context rate; prompts over 272K input tokens are
  // billed at 2x input and 1.5x output for the whole request, which no row here
  // models. A run served by the ChatGPT subscription (`SMITHERS_OPENAI_AUTH=
  // chatgpt`) is billed by the month, not by the token: the price below is
  // what the same tokens WOULD cost on the API, and `evals/harbor` leaves such
  // runs unpriced rather than quote it as spend.
  "gpt-6-sol": {
    input: 2,
    cachedInput: 0.2,
    output: 10,
    source: "OpenAI API list price, https://developers.openai.com/api/docs/models/gpt-6-sol, verified 2026-09-22"
  },
  "openai:gpt-6-sol": {
    input: 2,
    cachedInput: 0.2,
    output: 10,
    source: "OpenAI API list price, https://developers.openai.com/api/docs/models/gpt-6-sol, verified 2026-09-22"
  },
  // Jev, the decision model the harness asks through the Vercel AI Gateway:
  // the completion brake, the per-frame supervisor and the agent-callable
  // `jev` flow all bill against it. The gateway quotes per-token pricing of
  // 0.000000042 USD input and 0 output (that is 0.042 USD per 1M input; the
  // gateway's model page rounds it to $0.04/1M). Jev has no cached-input
  // tier, so the cache-read rate is the input rate.
  [jevModel]: {
    input: 0.042,
    cachedInput: 0.042,
    output: 0,
    source:
      "Vercel AI Gateway list price, https://ai-gateway.vercel.sh/v1/models/typesafe-ai/jev (pricing.input 0.000000042 per token, output 0) and https://vercel.com/ai-gateway/models ($0.04/1M input, $0.00/1M output), verified 2026-09-22"
  }
}

/**
 * Computes USD for one run's token counts.
 *
 * `inputTokens` is the provider's total prompt count and already contains
 * `cachedInputTokens`, so the cached share is billed at the cache-read rate and
 * only the remainder at the input rate. Reasoning tokens are part of the output
 * count and are not billed twice.
 *
 * @category constructors
 * @since 0.1.0
 */
export const usd = (
  model: string | undefined,
  tokens: { readonly inputTokens: number; readonly cachedInputTokens: number; readonly outputTokens: number }
): { readonly usd: number | undefined; readonly source: string } => {
  const price = model === undefined ? undefined : prices[model]
  if (price === undefined) {
    return { usd: undefined, source: `unpriced: no committed price for ${model ?? "an unrecorded model"}` }
  }
  const uncached = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens)
  const total = (uncached * price.input + tokens.cachedInputTokens * price.cachedInput
    + tokens.outputTokens * price.output) / 1_000_000
  return { usd: Math.round(total * 10_000) / 10_000, source: price.source }
}
