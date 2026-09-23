/**
 * Where a journal keeps what a Jev reading cost.
 *
 * Three event types meter Jev, one per caller: `claim-demanded` for the
 * completion brake, `supervisor-settled` for the per-frame supervisor, and a
 * `cell-call-settled` of the `jev` flow for an agent's own call, whose usage
 * sits inside the recorded call result. `decision-settled` repeats a reading
 * without usage and is never priced. `scorecard.ts` and `lib/run-cost.mjs`
 * both read through here, so the scorecard and the full benchmark's ledger
 * cannot disagree about what a reading cost.
 *
 * @since 0.1.0
 */

/**
 * The event types that carry Jev usage.
 *
 * @category constants
 * @since 0.1.0
 */
export const jevSources: ReadonlySet<string> = new Set([
  "control.agent.claim-demanded",
  "control.agent.supervisor-settled",
  "control.agent.cell-call-settled"
])

/**
 * One Jev reading's token counts.
 *
 * @category models
 * @since 0.1.0
 */
export interface JevUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const count = (value: unknown): number => typeof value === "number" ? value : 0

/**
 * The Jev usage one journal row records, or nothing when the row is not a
 * Jev reading. A `jev` flow call that failed records no usage and is not a
 * call Jev answered; one that settled without usage is a call the transport
 * did not meter, counted but priced at zero tokens. A malformed count is
 * handed back as it stands so the caller can refuse it rather than read it
 * as zero.
 *
 * @category conversions
 * @since 0.1.0
 */
export const jevUsageOf = (eventType: string, payload: Record<string, unknown>): JevUsage | undefined => {
  if (!jevSources.has(eventType)) return undefined
  if (eventType === "control.agent.cell-call-settled") {
    if (payload.flowName !== "jev" || payload.outcome !== "success") return undefined
    const usage = record(record(payload.value)?.usage)
    return { inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens) }
  }
  const usage = record(payload.usage)
  return { inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens) }
}
