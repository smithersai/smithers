/**
 * What a run that died mid-flight says it died of.
 *
 * A run that opened six turns, made nine calls and then stopped used to end
 * with one sentence — "Something on Smithers' side failed. Not your fault, and
 * nothing your request could have changed." That lead is true about blame and
 * empty about cause, and it is the last thing a person reads after a run that
 * visibly did most of its work. The cause was not missing: the harness and the
 * model package each declare a closed code vocabulary, the run journals the
 * innermost `<code>: <sentence>` pair on `control.run.failed`, and the
 * gateway's verdict repeats that same first line. Nothing on this side read
 * either one, so every code in both vocabularies flattened into the lead.
 *
 * This is the table that answers them. Two rules hold it honest:
 *
 * - A code is never read off prose, and prose is never rendered at a person.
 *   The harness writes run ids into its own messages (`The agent session
 *   "<runId>" ended without a completed answer after 6 frames`) and the brake
 *   writes three probabilities into its own; neither is a sentence anybody
 *   should read. The code selects a sentence this file owns, and the harness's
 *   own words stay where they already were, in the card's technical details.
 * - The set is closed to what the two packages declare. `RunCause.test.ts`
 *   reads both declarations, so a code either package adds fails that suite
 *   until it is answered here rather than reaching a person as the lead again.
 *
 * @see ../../../../../packages/smithers/agent/harness/src/HarnessError.ts
 * @see ../../../../../packages/smithers/agent/model/src/ModelError.ts
 */
import type { PlueFault } from "@smthrs/rpc/Refusal"

/**
 * Every code the harness raises, verbatim from `HarnessError.HarnessErrorCode`.
 *
 * These are the harness's own vocabulary: a cap it enforces, a judgement it
 * could not get, a claim it refused. They are what a LATE failure looks like —
 * a run that got turns in before it stopped — which is exactly the shape the
 * generic lead was worst at.
 */
export const HARNESS_CODES = [
  "assembly_failed",
  "incompatible_journal",
  "render_failed",
  "model_failed",
  "engine_failed",
  "read_only_cap",
  "completion_unjudged",
  "claim_unproven",
  "suspended"
] as const

/** One member of {@link HARNESS_CODES}. */
export type HarnessCode = (typeof HARNESS_CODES)[number]

/**
 * Every code the model boundary raises, verbatim from `ModelError.ModelErrorCode`.
 *
 * `failureSummary` keeps the INNERMOST typed pair, so a provider refusal under
 * a harness wrapper journals the provider's code rather than the harness's
 * (`packages/smithers/agent/test/FailureSummary.test.ts`, "keeps the provider's
 * typed refusal under the harness wrapper"). That is why both vocabularies are
 * answered here and not just the outer one.
 */
export const MODEL_CODES = [
  "invalid_request",
  "context_overflow",
  "no_route",
  "authentication",
  "rate_limited",
  "quota_exceeded",
  "content_policy",
  "provider_internal",
  "transport",
  "call_timeout",
  "invalid_provider_output",
  "unknown"
] as const

/** One member of {@link MODEL_CODES}. */
export type ModelCode = (typeof MODEL_CODES)[number]

/** A code either vocabulary declares. The two are disjoint, so the string identifies its author. */
export type RunCauseCode = HarnessCode | ModelCode

/** What one code says happened, and whose problem it is. */
export interface RunCauseRow {
  readonly fault: PlueFault
  /** The whole sentence a person reads. It replaces the fault's lead; it is never appended to it. */
  readonly message: string
}

/**
 * The sentence for each code. Total over both vocabularies; a code added to
 * either declaration is a red in `RunCause.test.ts` until it is answered.
 *
 * Every fault that is not the person's keeps "Not your fault" or "Not your
 * doing" and then ADDS the fact the lead was missing. A fault that is the
 * person's names the act instead, because "not your fault" in front of an act
 * they have to perform is a contradiction.
 */
export const RUN_CAUSE_COPY: Readonly<Record<RunCauseCode, RunCauseRow>> = {
  /* The harness's own vocabulary. */
  assembly_failed: {
    fault: "infra",
    message: "This run couldn't be assembled, so no turn ever opened. Not your fault — it's worth starting it again."
  },
  incompatible_journal: {
    fault: "infra",
    message:
      "This run's record was written by a different version of Smithers and can't be read back. Not your fault — start a new run."
  },
  render_failed: {
    fault: "bug",
    message: "Smithers couldn't build the next turn to send. Not your fault, and not your request's — that's a defect here."
  },
  /*
   * The condition this file was opened for. It covers a turn that opened and
   * got nothing back, a sealed model step that ended with no settlement, and a
   * session whose frames ran out with no completed answer. The journal does not
   * distinguish them — one code covers all three — so the sentence says the one
   * thing true of every one of them rather than picking a story.
   */
  model_failed: {
    fault: "infra",
    message:
      "A turn opened and the model never answered, so the run stopped with no result. Not your fault — the turns it finished stand, and it's worth asking again."
  },
  engine_failed: {
    fault: "infra",
    message: "The engine driving this run failed part way through a turn. Not your fault — it's worth asking again."
  },
  read_only_cap: {
    fault: "user",
    message:
      "This run read for turn after turn without changing anything, so Smithers stopped it. Say which change you want made, then run it again."
  },
  /*
   * The completion brake, both halves. Since 46fcc61722f5 they mean different
   * things: one is the brake unable to ask its question, the other is the brake
   * asking and refusing the answer. A person who reads one sentence for both
   * cannot tell "nothing checked this" from "this was checked and rejected".
   */
  completion_unjudged: {
    fault: "infra",
    message:
      "The run finished, but nothing was able to check its answer, so Smithers didn't pass it on. Not your fault — it's worth asking again."
  },
  claim_unproven: {
    fault: "infra",
    message:
      "The run claimed work its own record doesn't show it doing, so Smithers refused the answer rather than pass it on. Not your fault — ask again and it has to show the work."
  },
  suspended: {
    fault: "infra",
    message: "The run stopped to wait for something that never came. Not your fault — it's worth starting it again."
  },

  /* The model boundary's vocabulary, which arrives here under a harness wrapper. */
  /*
   * The one collision between the vocabularies this app reads. `invalid_request`
   * is declared by the model package AND by the coding flows' `CodingError`
   * (`RunFailure.ts` `RECEIPT_CODES`), and the journal line carries the code
   * alone. The setup bridge is answered before this table is consulted, so its
   * own reading is unaffected; for every other flow the two are genuinely
   * indistinguishable here, and the sentence says so instead of picking one and
   * assigning blame on the strength of the guess.
   */
  invalid_request: {
    fault: "infra",
    message:
      "Something refused the request this run was built from, and Smithers can't tell whether that was the model provider or its own flow. Not your fault as far as this run can say — it's worth asking for it a different way."
  },
  context_overflow: {
    fault: "user",
    message: "The conversation outgrew the model's context window. Ask for something narrower, or start a fresh run."
  },
  no_route: {
    fault: "infra",
    message: "No model seat was available for this run. Not your fault — it's a setting on Smithers' side."
  },
  authentication: {
    fault: "infra",
    message:
      "The model provider rejected Smithers' credentials. Not your fault — the key on this side has to be fixed before the run can finish."
  },
  rate_limited: {
    fault: "dependency",
    message: "The model provider is rate limiting Smithers. Not your doing — it's worth asking again shortly."
  },
  quota_exceeded: {
    fault: "dependency",
    message:
      "The model provider says this account has no quota left. Not your doing — the account has to be topped up before the run can finish."
  },
  content_policy: {
    fault: "user",
    message: "The model provider refused this request under its content policy. Ask for something else."
  },
  provider_internal: {
    fault: "dependency",
    message: "The model provider failed on its own side. Not your doing — it's worth asking again."
  },
  transport: {
    fault: "dependency",
    message: "The call to the model provider never completed. Not your doing — it's worth asking again."
  },
  call_timeout: {
    fault: "infra",
    message:
      "The model took longer than this run allows, and the call was cut off before it answered. Not your fault — it's worth asking again."
  },
  invalid_provider_output: {
    fault: "dependency",
    message: "The model provider answered with something Smithers couldn't read. Not your doing — it's worth asking again."
  },
  unknown: {
    fault: "infra",
    message: "The model call failed and gave no reason Smithers could read. Not your fault — it's worth asking again."
  }
}

/**
 * What a journalled or settled code says happened, or `undefined` for a string
 * neither vocabulary declares.
 *
 * `undefined` is the honest answer rather than a fallback sentence: a code this
 * build has never heard of is still a code, and inventing a cause for it is the
 * defect this table exists to remove.
 *
 * @category conversions
 */
export const runCause = (code: string): RunCauseRow | undefined =>
  Object.hasOwn(RUN_CAUSE_COPY, code) ? RUN_CAUSE_COPY[code as RunCauseCode] : undefined
