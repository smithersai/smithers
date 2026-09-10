/**
 * Which seat each review step runs on.
 *
 * A seat is an opaque `provider:model` string the host's `SeatResolver` turns
 * into a live model, so this module decides policy and nothing else: no
 * credential is read here and no provider client is built.
 * `reviewSeatResolver.ts` owns the credential half, which is why the 0.x
 * agent-pool construction (Claude Code and Codex subprocesses, per-account
 * config directories, `--output-schema` files) is gone rather than ported.
 *
 * @since 1.0.0
 */

/**
 * The four seats one review run uses.
 *
 * @since 1.0.0
 * @category models
 */
export interface ReviewSeats {
  /** Reads one file's diff and reports findings. */
  readonly review: string;
  /** Adjudicates the findings the review produced. */
  readonly verify: string;
  /** Writes the walkthrough story. */
  readonly narrate: string;
  /** Writes the comprehension quiz. */
  readonly quiz: string;
}

/** The reviewing and verifying seat when the environment names none. */
export const DEFAULT_REVIEW_SEAT = "anthropic:claude-sonnet-4-5";

/** The narrating and quizzing seat when the environment names none. */
export const DEFAULT_CHEAP_SEAT = "anthropic:claude-haiku-4-5";

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
};

/**
 * Reads the seat policy off an environment.
 *
 * `SMITHERS_REVIEW_SEAT` sets the reviewing and verifying seat,
 * `SMITHERS_REVIEW_CHEAP_SEAT` the narrating and quizzing one, and
 * `SMITHERS_REVIEW_VERIFY_SEAT` / `SMITHERS_REVIEW_NARRATE_SEAT` /
 * `SMITHERS_REVIEW_QUIZ_SEAT` override one step each.
 *
 * The environment is a parameter rather than a global read so a caller can
 * resolve seats for a run without mutating `process.env`.
 *
 * @since 1.0.0
 * @category constructors
 */
export const resolveReviewSeats = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReviewSeats => {
  const review = trimmed(environment.SMITHERS_REVIEW_SEAT) ?? DEFAULT_REVIEW_SEAT;
  const cheap = trimmed(environment.SMITHERS_REVIEW_CHEAP_SEAT) ?? DEFAULT_CHEAP_SEAT;
  return {
    review,
    verify: trimmed(environment.SMITHERS_REVIEW_VERIFY_SEAT) ?? review,
    narrate: trimmed(environment.SMITHERS_REVIEW_NARRATE_SEAT) ?? cheap,
    quiz: trimmed(environment.SMITHERS_REVIEW_QUIZ_SEAT) ?? cheap,
  };
};

/**
 * The seat names the review flow declares.
 *
 * A declared seat is a logical name: the resolver maps it to whatever the
 * environment says. Declaring logical names rather than model ids keeps the
 * flow's step identities stable when the model behind a step changes.
 *
 * @since 1.0.0
 * @category constants
 */
export const SEAT = {
  review: "review",
  verify: "review-verify",
  narrate: "review-narrate",
  quiz: "review-quiz",
} as const;
