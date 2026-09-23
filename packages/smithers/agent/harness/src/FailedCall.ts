/**
 * The completion its own cell wrote before a call in it failed.
 *
 * A cell is authored blind: the model writes the whole program, `ctx.done`
 * included, before any call in it settles, and a failed call resolves
 * `{ ok: false, error }` rather than throwing, so the rest of the cell runs.
 * A cell that makes a request and completes in the same program therefore
 * reports the request as made whatever the request did. The sentence is not a
 * lie the model told; it is a sentence written about a result that did not
 * exist yet.
 *
 * It is not hypothetical. A TUI coordinator on a small seat ran
 * `ctx.call("agent.delegate", …)` and `ctx.done("Delegated the estimation
 * system design to codex astra.")` in one cell. The delegation failed with
 * "Three workers are active; wait for a completion", the cell ran on, and the
 * user was told work was running that never started.
 *
 * ## What the harness does, and why it reads no prose
 *
 * The rule is structural. A completion whose own frame settled a failed call
 * was written before that failure existed, and no earlier frame showed it to
 * the model. The harness cannot decide from the sentence whether it states
 * the failure, and it does not try: it hands the frame back once with the
 * failure, as a demand, so the next completion is written by a model that has
 * read the result. Two exact tests spare a cell that was written to handle the
 * failure: one whose source reads a call envelope's `ok` or `error`, the
 * branch the cell prompt teaches, and one whose completion already quotes the
 * flow's own failure reason. Neither reads what the claim means; each reads
 * whether the claim could have depended on the result at all.
 *
 * Where no frame is left to hand back, or the demand was already spent, the
 * completion stands with the failure appended to it by {@link state}. The
 * harness never lets a claim written before a failure be the whole answer, and
 * it never asks a model whether the claim is true: a weak seat's honesty is
 * not a control.
 *
 * @since 1.0.0-rc.1
 */

/**
 * How many completions one run may have handed back for a failed call.
 *
 * One, like every measured demand: the answer to it is written by a model
 * that has read the failure, and asking twice would be the loop grading that
 * answer.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const cap = 1

/**
 * The heading of the demand, so a transcript and a test can find it.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const heading = "Call failed before completion"

/**
 * The line {@link state} appends a failure under.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export const stated = "Failed before this answer was written:"

/**
 * One call a completing frame settled as a failure.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Failure {
  /** The flow the call named. */
  readonly flow: string
  /** What the flow said about its failure, verbatim; empty when it said nothing. */
  readonly message: string
}

/** The frame accounting's view of one settled call. */
interface Settled {
  readonly flow: string
  readonly ok: boolean
  readonly message: string | undefined
}

const reasonPrefix = /^Flow \S+ failed: /

/**
 * The flow's own words for why a call failed, without the harness's prefix.
 *
 * @category conversions
 * @since 1.0.0-rc.1
 */
export const reason = (failure: Failure): string => failure.message.replace(reasonPrefix, "").trim()

/**
 * Whether a cell's source reads a call envelope's `ok` or `error`.
 *
 * `r.ok`, `r?.error`, `r["ok"]` and `const { ok, error } = r` all count;
 * `console.error` does not. A cell that reads either wrote a branch for a
 * failed call, so its completion is not one written blind.
 *
 * @category predicates
 * @since 1.0.0-rc.1
 */
export const inspects = (source: string): boolean =>
  /(?<!\bconsole)\??\.\s*(?:ok|error)\b|\[\s*["'`](?:ok|error)["'`]\s*\]|\{[^{}]*\b(?:ok|error)\b[^{}]*\}\s*=[^=>]/
    .test(source)

/**
 * The failed calls a completion was written before, oldest first.
 *
 * Every call this frame settled with `ok: false`, unless the cell's source
 * inspects call envelopes (see {@link inspects}), and except one whose reason
 * the claim already quotes: that cell read the result and wrote from it. A
 * failure with no message is named by its flow alone and is never quoted, so
 * it is always reported.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const find = (calls: ReadonlyArray<Settled>, claim: string, source: string): ReadonlyArray<Failure> =>
  inspects(source) ? [] : calls.flatMap((call): ReadonlyArray<Failure> => {
    if (call.ok) return []
    const failure = { flow: call.flow, message: call.message ?? "" }
    const said = reason(failure)
    return said !== "" && claim.includes(said) ? [] : [failure]
  })

const line = (failure: Failure): string => {
  const said = reason(failure)
  return said === "" ? `- ${failure.flow} failed` : `- ${failure.flow} failed: ${said}`
}

/**
 * The demand a completion over failed calls is handed back with.
 *
 * @category conversions
 * @since 1.0.0-rc.1
 */
export const demand = (failures: ReadonlyArray<Failure>): string =>
  `${heading} — this cell completed after a call in it had already failed, so the answer was written before its result existed:

${failures.map(line).join("\n")}

Your answer is not the answer that stands yet. Retry the call if the failure is one you can fix, or complete again stating plainly what was not done and why. Never report failed work as requested, started or done.`

/**
 * The answer a completion stands on when it could not be handed back.
 *
 * The claim is kept, because the harness cannot tell a claim that states the
 * failure from one that does not, and the failure is appended in the flow's
 * own words, so a reader sees what happened whatever the claim says.
 *
 * @category conversions
 * @since 1.0.0-rc.1
 */
export const state = (claim: string, failures: ReadonlyArray<Failure>): string =>
  failures.length === 0
    ? claim
    : [claim.trim(), [stated, ...failures.map(line)].join("\n")].filter((part) => part !== "").join("\n\n")
