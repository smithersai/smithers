/**
 * What the starter seats cost, so the header's cost is a number and not
 * `$0.00` after four hundred thousand tokens.
 *
 * The table is a snapshot of the providers' published list prices, in
 * dollars per million tokens, for the seats `smithers opencode` picks by
 * default. A seat it does not know costs zero, and a host that knows better
 * passes its own `Serve.Options.pricing`.
 *
 * @since 1.0.0
 */
import type * as Projection from "./Projection.ts"

const sonnet: Projection.Pricing = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75
}

/** Dollars per million tokens, by seat id, as the providers list them. */
const table: Readonly<Record<string, Projection.Pricing>> = {
  // Cerebras bills cached input at the full input rate, which is what
  // `Projection.costOf` charges when the cache rates are absent.
  "cerebras:qwen-3.8-27b": { inputPerMillion: 0.99, outputPerMillion: 1.49 },
  "cerebras:gpt-oss-120b": { inputPerMillion: 0.25, outputPerMillion: 0.69 },
  "anthropic:claude-sonnet-4-5": sonnet,
  "openrouter:anthropic/claude-sonnet-4.5": sonnet,
  "gemini:gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 }
}

/**
 * The price of a seat, or `undefined` for a seat the table does not know.
 *
 * @param seat the seat as `provider:model`
 * @category getters
 * @since 1.0.0
 */
export const pricingOf = (seat: string): Projection.Pricing | undefined => table[seat]
