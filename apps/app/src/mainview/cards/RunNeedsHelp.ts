/**
 * The run's latest supervisor reading, projected off the journal the card
 * already holds.
 *
 * `control.agent.supervisor-settled` journals Jev's `needsHelp` word verbatim
 * (see `@smthrs/harness/AgentEvent` `SupervisorSettled`). A newer reading
 * replaces an older one. `control.agent.supervisor-unjudged` means nobody
 * could judge, so it clears nothing: the last judged word stands. A run with
 * no settled reading, or whose latest reading is `none`, shows no indicator.
 */
import type { JournalRecord } from "./RunTrace"

export const NEEDS_HELP_VALUES = ["none", "clarification", "permission", "stuck", "risky_action"] as const
export type NeedsHelp = typeof NEEDS_HELP_VALUES[number]

/** The only words the indicator is allowed to say. */
export const NEEDS_HELP_LABELS: Readonly<Record<Exclude<NeedsHelp, "none">, string>> = {
  clarification: "Needs clarification",
  permission: "Needs permission",
  stuck: "Stuck",
  risky_action: "Risky action"
}

const isNeedsHelp = (value: unknown): value is NeedsHelp =>
  typeof value === "string" && (NEEDS_HELP_VALUES as ReadonlyArray<string>).includes(value)

/** The latest settled `needsHelp`, by journal sequence; undefined when Jev never judged. */
export const latestNeedsHelp = (journal: ReadonlyArray<JournalRecord>): NeedsHelp | undefined => {
  let best: { readonly sequence: number; readonly value: NeedsHelp } | undefined
  for (const row of journal) {
    if (row.kind !== "control.agent.supervisor-settled") continue
    const payload = typeof row.payload === "object" && row.payload !== null
      ? row.payload as Record<string, unknown>
      : undefined
    const value = payload?.needsHelp
    if (!isNeedsHelp(value)) continue
    const sequence = typeof row.sequence === "number" ? row.sequence : -1
    if (best === undefined || sequence >= best.sequence) best = { sequence, value }
  }
  return best?.value
}
