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
 * This is the table that answers the ones it can. Three rules hold it honest,
 * and the third is why it answers all nine of the harness's codes but one and
 * only three of the model's.
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
 *   {@link SHARED_CODES}. That is what costs the table nine of the model's
 *   twelve codes: `flows/librarian` re-raises the seven provider conditions
 *   under its own tag, and three more are spelled by the stores, the scorers
 *   and `jj`. For those nine the fault's own lead — true about a union this
 *   side cannot split — is the honest answer.
 *
 *   The rule cuts the other way too. A lead must be true about every member of
 *   the union it covers, so a code whose lead is FALSE cannot be left to it.
 *   `content_policy` and `context_overflow` are refusals of the request a
 *   person made; "nothing your request could have changed" is untrue of both
 *   under every author that can raise them, and `invalid_provider_output` is
 *   the provider's own answer, not Smithers' side. Those three are sole-
 *   authored and answered here.
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
 * typed refusal under the harness wrapper"). That is why this vocabulary is
 * swept at all, and not just the outer one.
 *
 * Three of these twelve have a row — `content_policy`, `context_overflow` and
 * `invalid_provider_output`, the three that describe an exchange that reached
 * the provider. The other nine are in {@link SHARED_CODES}: seven because
 * `flows/librarian/runtime.ts` re-raises the provider conditions under
 * `librarian/ProviderUnavailable`, and `invalid_request` and `unknown` because
 * the scorers, the stores, sync and `jj` spell them. All twelve are listed
 * because the sweep still has to find them: a code the model package adds
 * tomorrow has to be placed, shared or answered, before it can reach a person.
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
 * Membership here is not a free shrink. The lead a shared code falls back to
 * has to be true about every member of the union, and a row belongs here only
 * while it is. `content_policy` and `context_overflow` left this map because
 * "nothing your request could have changed" is false for both under either
 * author, and the union they were in was unreachable besides.
 *
 * `RunCause.test.ts` derives this map by parsing every source in the repo with
 * the TypeScript compiler API and evaluating the `code` member of every tagged
 * failure class that carries one beside a `message` — the exact record shape
 * `failureSummary` reads — so a package that starts spelling one of these codes
 * tomorrow reds that suite rather than reaching a person as somebody else's
 * sentence. It reads the declaration however it is spelled, because it follows
 * names to their declarations and calls into their bodies rather than matching
 * source text; a class whose `code` no declaration closes falls back to the
 * literals its own `new` sites pass.
 */
export const SHARED_CODES = {
  engine_failed: ["/harness/HarnessError", "@smthrs/opencode/DriverError"],
  invalid_request: [
    "flows/model/ModelError",
    "flows/scorers/ScorerError",
    "@smthrs/sync/SyncError",
    "coding/Error",
    "coding/NativeCodingError"
  ],
  no_route: ["flows/model/ModelError", "librarian/ProviderUnavailable"],
  authentication: ["flows/model/ModelError", "librarian/ProviderUnavailable"],
  rate_limited: [
    "flows/model/ModelError",
    "@smthrs/std/StdError",
    "@smthrs/time-travel/TimeTravelError",
    "librarian/ProviderUnavailable"
  ],
  quota_exceeded: ["flows/model/ModelError", "librarian/ProviderUnavailable"],
  provider_internal: ["flows/model/ModelError", "librarian/ProviderUnavailable"],
  transport: ["flows/model/ModelError", "librarian/ProviderUnavailable"],
  call_timeout: ["flows/model/ModelError", "librarian/ProviderUnavailable"],
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
} as const satisfies Readonly<Record<string, ReadonlyArray<string>>>

/** One code {@link SHARED_CODES} holds. */
export type SharedCode = keyof typeof SHARED_CODES

/**
 * A code exactly one failure vocabulary in this repo spells, so the string
 * does identify its author. Derived from {@link SHARED_CODES} rather than
 * restated, so removing a code from there is what opens a row for it.
 */
export type RunCauseCode = Exclude<HarnessCode | ModelCode, SharedCode>

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
 * {@link SHARED_CODES}, which today leaves eight of the harness's nine codes
 * and three of the model's twelve; a code added to either declaration is a red
 * in `RunCause.test.ts` until it is answered or shown to be shared.
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

  /*
   * The model boundary's vocabulary, which arrives here under a harness
   * wrapper. Three of its twelve codes have a row, and they are the three the
   * person's own request is the lever for. The fault's generic lead —
   * "Not your fault, and nothing your request could have changed" — is a false
   * statement about all three under every author that can raise them, so
   * leaving them to it was not a conservative shrink but a second wrong
   * sentence. The other nine are shared, each for its own reason below.
   */
  content_policy: {
    fault: "user",
    message: "The model provider refused this request under its content policy. Ask for something else."
  },
  context_overflow: {
    fault: "user",
    message: "The conversation outgrew the model's context window. Ask for something narrower, or start a fresh run."
  },
  invalid_provider_output: {
    fault: "dependency",
    message: "The model provider answered with something Smithers couldn't read. Not your doing — it's worth asking again."
  }
  /*
   * The nine with no row, and why each one has none.
   *
   * Seven of them — `no_route`, `authentication`, `transport`,
   * `provider_internal`, `call_timeout`, `rate_limited`, `quota_exceeded` —
   * are also `librarian/ProviderUnavailable`'s, which declares exactly the set
   * `flows/librarian/runtime.ts` can surface. One line of `<code>: <message>`
   * cannot say which of the two wrote it, so `no_route: ...` from the
   * librarian would reach a person as "No model seat was available for this
   * run" whether or not a seat was the problem. The fault's own lead is true
   * of both authors; a sentence picked for one of them is not. Narrowing that
   * declaration to what its code can build is what returned the three rows
   * above: `content_policy`, `context_overflow` and
   * `invalid_provider_output` describe an exchange that DID reach the
   * provider, and the librarian never re-raises one under its own tag.
   *
   * `rate_limited` would be shared even without the librarian: `@smthrs/std`
   * raises it when a tool's own provider throttles a search and
   * `@smthrs/time-travel` when Smithers' own rewind limiter refuses, and the
   * three do not even share a fault class.
   *
   * `invalid_request` is shared with `flows/scorers`, `@smthrs/sync` and the
   * coding flows' `CodingError`; the setup bridge is unaffected, since
   * `RunFailure.ts` answers a receipt code by its flow before this table is
   * consulted.
   *
   * `unknown` is the code that opened this: eleven vocabularies spell it and
   * the model's raises it least — only `RequestExecutor.ts`, and only when the
   * HTTP classifier returns nothing — while `jj`, the sandbox, sync, the
   * registry and four stores raise it routinely. "The model call failed"
   * beside a `run.calls` of 0 is the lie this table exists to stop telling.
   *
   * `engine_failed` is the harness's own loss, to
   * `@smthrs/opencode/DriverError`.
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
