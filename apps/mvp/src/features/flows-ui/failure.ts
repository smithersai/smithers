// Why a draft round failed, as the closed code its row and its `flow.author` record carry (docs/features/flows.md#why-a-draft-failed,
// OBS-4). The drafting agent's failure (`@smthrs/agent` `AgentFailure`, as its step journaled it) is read for its tags
// and codes only: its message, its provider body and anything the model said never leave this module. The same
// reading chat's answers make of a model failure (src/features/agent/progress.ts), at a draft's grain.

/** Why a round failed. The first six are the agent's; the rest are the round's own. */
export const DRAFT_FAILURES = [
  "no_model",
  "quota",
  "rate_limited",
  "undecodable",
  "frames",
  "model_error",
  "checks",
  "stopped",
  "ended",
] as const
export type DraftFailure = (typeof DRAFT_FAILURES)[number]

/** A model failure's code, by what a person can do about it. */
const MODEL_CODES: Readonly<Record<string, DraftFailure>> = {
  no_route: "no_model",
  authentication: "no_model",
  quota_exceeded: "quota",
  out_of_credit: "quota",
  rate_limited: "rate_limited",
}

/** A failure's own tags, by what a person can do about it. */
const TAGS: Readonly<Record<string, DraftFailure>> = {
  "@smthrs/agent/Seat/SeatUnresolved": "no_model",
  "@smthrs/agent/Seat/SeatUnrouted": "no_model",
  "flows/agent/BudgetExceeded": "quota",
  "flows/agent/Skipped": "quota",
  "/harness/StructuredOutputFailure": "undecodable",
  FramesExhausted: "frames",
}

/** `value`'s own `name`, or undefined when it has none or reading it throws. */
const field = (value: object, name: string): unknown => {
  try {
    return Object.hasOwn(value, name) ? (value as Record<string, unknown>)[name] : undefined
    // expected: a getter that throws reads as no field
  } catch {
    return undefined
  }
}

/**
 * The closed code for the drafting agent's `failure`: walks it and its causes (at most 16 deep, each once) and answers
 * by the innermost failure that names one, else `model_error`.
 */
export const draftFailure = (failure: unknown): DraftFailure => {
  let found: DraftFailure | undefined
  const seen = new Set<unknown>()
  let current = failure
  for (let depth = 0; depth < 16 && typeof current === "object" && current !== null && !seen.has(current); depth++) {
    seen.add(current)
    const tag = field(current, "_tag")
    const code = field(current, "code")
    const byTag = typeof tag === "string" && Object.hasOwn(TAGS, tag) ? TAGS[tag] : undefined
    const byCode = tag === "flows/model/ModelError" && typeof code === "string" && Object.hasOwn(MODEL_CODES, code)
      ? MODEL_CODES[code]
      : undefined
    found = byTag ?? byCode ?? found
    current = field(current, "cause")
  }
  return found ?? "model_error"
}
