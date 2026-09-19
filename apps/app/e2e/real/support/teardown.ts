/**
 * What a real E2E scenario does when its own cleanup cannot finish.
 *
 * Two rules live here, both learned from one night's runs against the live
 * GitHub account:
 *
 * 1. **A teardown problem is not a verdict.** A scenario answers for its body.
 *    When the body ran to completion and only cleanup failed, reporting the
 *    scenario as failed hides a passing proof behind a housekeeping error, and
 *    a suite nobody trusts is a suite nobody reads.
 * 2. **A cleanup that cannot finish stops the run from making more work for
 *    it.** The fixture mints a GitHub repository per scenario and deletes it
 *    afterwards. Once deletion is known to be impossible, every further
 *    scenario that mints one leaks another, so the first refusal bars the rest
 *    of this worker's creations instead of letting them pile up.
 *
 * The seam is pure on purpose: the race, the bar and the verdict are decided
 * here over plain promises and values, so they are proven by `bun test` rather
 * than by a live browser against a production account.
 */

/** Why a GitHub repository this run owns could not be deleted. */
export type TeardownRefusalReason = "github-sudo-mode" | "delete-unsettled"

/**
 * A cleanup step that stopped for a named reason.
 *
 * `message` is the whole sentence a person reads. It names the account wall or
 * the unanswered step and the exact act that clears it, and it never carries an
 * internal identifier or a message thrown by a library: those belong in
 * {@link TeardownRefusal.cause}, which only a trace reader opens.
 */
export class TeardownRefusal extends Error {
  readonly reason: TeardownRefusalReason
  constructor(reason: TeardownRefusalReason, message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = "TeardownRefusal"
    this.reason = reason
  }
}

/**
 * The sentence a person reads when GitHub holds the test account in sudo mode.
 *
 * The wall is real and a machine cannot pass it: GitHub offers one factor, an
 * emailed code, so the act that clears it is a person opening the saved E2E
 * browser profile and reading the account's inbox. Until then a deletion is
 * refused rather than waited on, because the navigation it was waiting for can
 * never happen.
 */
export const sudoModeSentence = (repository: string): string =>
  `GitHub is holding the test account in sudo mode, so ${repository} could not be deleted. ` +
  "The only factor GitHub offers here is an emailed code, so a person must open the saved E2E browser " +
  "profile, choose Verify via email, and enter the code sent to the test account's inbox. " +
  "Until that is done this run creates no further repositories, and the ones it already owns stay."

/** The sentence a person reads when neither the deletion nor the wall answered. */
export const unsettledSentence = (repository: string): string =>
  `Deleting ${repository} neither completed nor reached a page that says why, so the repository may still exist. ` +
  "Open it in the saved E2E browser profile and finish or repeat the deletion there."

/**
 * Which of the two answers the final Delete click produced.
 *
 * `navigatedAway` is the repository page going away, which is GitHub having
 * deleted it. `sudoConfirmVisible` is the Confirm access page, which is GitHub
 * refusing until the account re-verifies. Exactly one of them can be true, and
 * before this raced them the refusal read as a 60 second timeout on the
 * navigation — a wait for something that could never happen, reported as a
 * library message nobody could act on.
 *
 * The first answer ends the wait. Both waits carry the same long budget, so
 * settling both would charge every ordinary successful deletion the full budget
 * of a wall that never appeared, which is a minute of dead time per scenario on
 * the path where nothing is wrong. The loser is abandoned where it stands:
 * nothing awaits it again, and its eventual rejection is already claimed here,
 * so it can neither delay the teardown nor crash the run.
 *
 * A rejection never decides the race: the loser of a real answer always rejects
 * too, on its own timeout. Only both rejecting is an outcome, and it is the
 * unsettled one.
 */
export const deletionOutcome = async (options: {
  readonly repository: string
  readonly navigatedAway: Promise<unknown>
  readonly sudoConfirmVisible: Promise<unknown>
}): Promise<"deleted"> => {
  /*
   * The deletion is listed first, so when both answers arrive in the same turn
   * the deletion is the one `Promise.any` settles on: the repository is gone
   * either way, and a wall that rendered beside its own deletion clears nothing.
   */
  const answer = await Promise.any([
    options.navigatedAway.then(() => "deleted" as const),
    options.sudoConfirmVisible.then(() => "sudo" as const)
  ]).catch((unanswered: AggregateError) => unanswered)
  if (answer === "deleted") return "deleted"
  if (answer === "sudo") {
    throw new TeardownRefusal("github-sudo-mode", sudoModeSentence(options.repository))
  }
  throw new TeardownRefusal("delete-unsettled", unsettledSentence(options.repository), { cause: answer.errors })
}

/**
 * A one-way switch that stops a run from creating what it can no longer delete.
 *
 * Raised by the first cleanup that proves deletion impossible and read by every
 * later creation. One bar per worker process, which is the scope Playwright
 * gives a module: a second worker has its own account session and finds the
 * same wall on its own first deletion.
 */
export interface CreationBar {
  /** Raises the bar. The first reason wins, so the sentence names the original wall. */
  readonly raise: (reason: string) => void
  /** The sentence to refuse with, or `undefined` while creation is still allowed. */
  readonly reason: () => string | undefined
}

/** Builds an independent bar. Production shares {@link githubCreationBar}; a test makes its own. */
export const makeCreationBar = (): CreationBar => {
  let reason: string | undefined
  return {
    raise: (next) => {
      if (reason === undefined) reason = next
    },
    reason: () => reason
  }
}

/** The bar every GitHub repository this worker creates is checked against. */
export const githubCreationBar: CreationBar = makeCreationBar()

/**
 * What a scenario reports, given what its body did and what its cleanup could
 * not do.
 *
 * The body decides the verdict. Cleanup failures come back separately so the
 * fixture can file them as teardown problems, where the run-level gate reads
 * them, instead of dressing a passing body as a failure.
 */
export interface ScenarioOutcome {
  /** Rethrown by the fixture: the body's own error, or `undefined` when it passed. */
  readonly verdict: unknown | undefined
  /** Filed as teardown annotations, never as the scenario's verdict. */
  readonly teardown: ReadonlyArray<string>
}

/**
 * The sentence a teardown failure is filed under.
 *
 * A refusal this module raised already carries a whole sentence. Anything else
 * is named by its class and the repository it was cleaning up, because a raw
 * thrown message is a library's words about its own internals and reads to a
 * person as noise.
 */
export const teardownSentence = (repository: string, failure: unknown): string => {
  if (failure instanceof TeardownRefusal) return failure.message
  if (failure instanceof AggregateError) {
    return failure.errors.map((nested) => teardownSentence(repository, nested)).join(" ")
  }
  return `Cleanup of ${repository} did not finish, so it may still exist. ` +
    "Its cause is on the scenario's trace; open the repository in the saved E2E browser profile and remove it there."
}

/**
 * Splits a scenario's body verdict from its cleanup problems.
 *
 * @param bodyError What the body threw, or `undefined` when it passed.
 */
export const scenarioOutcome = (options: {
  readonly repository: string
  readonly bodyError?: unknown
  readonly teardownFailures: ReadonlyArray<unknown>
}): ScenarioOutcome => ({
  verdict: options.bodyError,
  teardown: options.teardownFailures.map((failure) => teardownSentence(options.repository, failure))
})

/**
 * The annotation type a teardown problem is filed under.
 *
 * The real-E2E reporter turns every one of these into a reporter error, so a
 * run that leaked a repository fails its gate while each scenario keeps the
 * verdict its own body earned.
 */
export const TEARDOWN_ANNOTATION = "teardown-unfinished"
