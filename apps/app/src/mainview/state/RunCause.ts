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
 * This is the table that answers them. Three rules hold it honest:
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
 * - A code is answered only while it is the private property of ONE failure
 *   vocabulary in this repo. The line that reaches this file is
 *   `<code>: <message>` and nothing more (`FailureSummary.ts`), so the record's
 *   `_tag`, the package that raised it and the seam it crossed are all gone by
 *   the time a card reads it: a code string does NOT identify its author. Where
 *   two vocabularies spell the same code, this file answers neither — see
 *   {@link SHARED_CODES}.
 *
 * @see ../../../../../packages/smithers/agent/harness/src/HarnessError.ts
 * @see ../../../../../packages/smithers/agent/model/src/ModelError.ts
 * @see ../../../../../packages/smithers/agent/src/internal/FailureSummary.ts
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

/**
 * Every code one of the two vocabularies spells that ANOTHER failure
 * vocabulary in this repo also spells, with every tag that spells it.
 *
 * The harness's nine codes and the model's twelve do not overlap each other,
 * and that used to be written here as "the string identifies its author". It
 * does not. `failureSummary` walks a rendered failure to the innermost record
 * carrying a `message` and prefixes THAT record's `code`, off any record
 * (`agent/src/internal/FailureSummary.ts`); `AgentSession.settle` journals the
 * pair as the first line of `control.run.failed` and `Diagnosis.verdict`
 * repeats it. Nothing on that path constrains the code to either vocabulary,
 * and nothing on it carries the `_tag` that would say whose it is. A
 * `@smthrs/jj/JjError` raised because `jj` could not start in a deleted
 * directory arrives here as `unknown: ...`, indistinguishable from a model
 * call that returned nothing.
 *
 * So these codes get no sentence. `runCause` returns `undefined` and the
 * fault's own lead stands — true about a union this side cannot split, which
 * is the same discipline `model_failed` already applies to its three
 * conditions. A specific sentence that is false for four of its five possible
 * authors is worse than a general one that is true for all of them.
 *
 * `RunCause.test.ts` derives this map by sweeping every `Schema.TaggedError`
 * in `packages/`, `flows/` and `apps/` that declares a closed `code` set
 * beside a `message` — the exact record shape `failureSummary` reads — so a
 * package that starts spelling one of these codes tomorrow reds that suite
 * rather than reaching a person as somebody else's sentence.
 */
export const SHARED_CODES: Readonly<Record<string, ReadonlyArray<string>>> = {
  engine_failed: ["/harness/HarnessError", "@smthrs/opencode/DriverError"],
  invalid_request: ["flows/model/ModelError", "flows/scorers/ScorerError", "@smthrs/sync/SyncError", "coding/Error"],
  rate_limited: ["flows/model/ModelError", "@smthrs/std/StdError", "@smthrs/time-travel/TimeTravelError"],
  unknown: [
    "flows/model/ModelError",
    "flows/registry/DiscoveryError",
    "flows/registry/RegistryError",
    "@smthrs/journal/JournalError",
    "@smthrs/run-store/AttemptStoreError",
    "@smthrs/plan/PlanStoreError",
    "@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError",
    "@smthrs/jj/JjError",
    "@smthrs/sync/SyncError",
    "@smthrs/time-travel/TimeTravelError",
    "@smthrs/step-cache/CacheStoreError"
  ]
}

/** One member of {@link SHARED_CODES}. */
export type SharedCode = keyof typeof SHARED_CODES

/** A code exactly one failure vocabulary in this repo spells, so the string does identify its author. */
export type RunCauseCode = Exclude<HarnessCode | ModelCode, "engine_failed" | "invalid_request" | "rate_limited" | "unknown">

/** Whether {@link SHARED_CODES} holds this code, so no sentence here may claim it. */
export const isSharedCode = (code: string): boolean => Object.hasOwn(SHARED_CODES, code)

/** What one code says happened, and whose problem it is. */
export interface RunCauseRow {
  readonly fault: PlueFault
  /** The whole sentence a person reads. It replaces the fault's lead; it is never appended to it. */
  readonly message: string
}

/**
 * The sentence for each code. Total over both vocabularies minus
 * {@link SHARED_CODES}; a code added to either declaration is a red in
 * `RunCause.test.ts` until it is answered or shown to be shared.
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
  /* `engine_failed` has no row: `@smthrs/opencode/DriverError` spells it too. */
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
   * `invalid_request` has no row: the model package, `flows/scorers`,
   * `@smthrs/sync` and the coding flows' `CodingError` all spell it. The setup
   * bridge's own reading is unaffected — `RunFailure.ts` answers a receipt code
   * by its flow before this table is consulted — but for every other flow the
   * four are indistinguishable from one line of `<code>: <message>`.
   */
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
  /*
   * `rate_limited` has no row: `@smthrs/std` raises it when a tool's own
   * provider throttles a search, and `@smthrs/time-travel` when Smithers' own
   * rewind limiter refuses. "The model provider is rate limiting Smithers" is
   * false for both, and the three do not even share a fault class — the
   * model's and the tool's are a dependency's, the rewind limiter's is
   * Smithers' own — so there is no honest sentence for the union either.
   */
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
  }
  /*
   * `unknown` has no row, and it is the code that opened this: eleven
   * vocabularies spell it and the model's is the one that raises it least —
   * only `RequestExecutor.ts` does, and only when the HTTP classifier returns
   * nothing — while `jj`, the sandbox, sync, the registry and four stores
   * raise it routinely. "The model call failed" beside a `run.calls` of 0 is
   * the lie this table exists to stop telling.
   */
}

/** Every code this table answers: the two vocabularies minus what {@link SHARED_CODES} excludes. */
export const ANSWERED_CODES: ReadonlyArray<RunCauseCode> = Object.keys(RUN_CAUSE_COPY) as ReadonlyArray<RunCauseCode>

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
