import { describe, expect, test } from "bun:test"
import {
  deletionOutcome,
  githubCreationBar,
  makeCreationBar,
  scenarioOutcome,
  TeardownRefusal,
  teardownSentence
} from "./teardown"

/** A promise that never answers, standing for a wait that runs out its budget. */
const rejects = (message: string): Promise<never> => Promise.reject(new Error(message))

describe("the answer the final Delete click produced", () => {
  test("is the deletion when the repository page goes away", async () => {
    expect(await deletionOutcome({
      repository: "codeplanesmithers/smithers-e2e-import-x",
      navigatedAway: Promise.resolve(),
      sudoConfirmVisible: rejects("locator.waitFor: Timeout 60000ms exceeded")
    })).toBe("deleted")
  })

  test("is the deletion even when the account wall also rendered, because the repository is gone either way", async () => {
    expect(await deletionOutcome({
      repository: "codeplanesmithers/smithers-e2e-import-x",
      navigatedAway: Promise.resolve(),
      sudoConfirmVisible: Promise.resolve()
    })).toBe("deleted")
  })

  test("is a typed sudo-mode refusal naming the act that clears it, not a timeout on a navigation that cannot happen", async () => {
    const refusal = await deletionOutcome({
      repository: "codeplanesmithers/smithers-e2e-import-s15-1789805719968-0eua79",
      navigatedAway: rejects("page.waitForURL: Timeout 60000ms exceeded\n=========== logs ==========="),
      sudoConfirmVisible: Promise.resolve()
    }).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(TeardownRefusal)
    const typed = refusal as TeardownRefusal
    expect(typed.reason).toBe("github-sudo-mode")
    expect(typed.message).toContain("sudo mode")
    expect(typed.message).toContain("Verify via email")
    expect(typed.message).toContain("codeplanesmithers/smithers-e2e-import-s15-1789805719968-0eua79")
    // A person reads this sentence. A library's own words about its internals
    // are not a sentence, and neither is a timeout budget.
    expect(typed.message).not.toContain("Timeout")
    expect(typed.message).not.toContain("waitForURL")
    expect(typed.message).not.toContain("60000")
  })

  test("is a typed unsettled refusal when neither the deletion nor the wall answered", async () => {
    const refusal = await deletionOutcome({
      repository: "codeplanesmithers/smithers-e2e-import-x",
      navigatedAway: rejects("page.waitForURL: Timeout 60000ms exceeded"),
      sudoConfirmVisible: rejects("locator.waitFor: Timeout 60000ms exceeded")
    }).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(TeardownRefusal)
    expect((refusal as TeardownRefusal).reason).toBe("delete-unsettled")
    expect((refusal as TeardownRefusal).message).not.toContain("Timeout")
    // The raw causes survive for a trace reader, off the sentence.
    expect((refusal as TeardownRefusal).cause).toHaveLength(2)
  })
})

describe("the bar on creating what this run can no longer delete", () => {
  test("is down until a cleanup raises it", () => {
    const bar = makeCreationBar()
    expect(bar.reason()).toBeUndefined()
    bar.raise("GitHub is holding the test account in sudo mode.")
    expect(bar.reason()).toBe("GitHub is holding the test account in sudo mode.")
  })

  test("keeps the first wall's sentence, because that is the one a person must clear", () => {
    const bar = makeCreationBar()
    bar.raise("first wall")
    bar.raise("second wall")
    expect(bar.reason()).toBe("first wall")
  })

  test("is shared by this worker's scenarios and starts down", () => {
    expect(githubCreationBar.reason()).toBeUndefined()
  })
})

describe("what a scenario reports", () => {
  const repository = "codeplanesmithers/smithers-e2e-import-x"

  test("is nothing when the body passed, however the cleanup went", () => {
    const outcome = scenarioOutcome({
      repository,
      teardownFailures: [new TeardownRefusal("github-sudo-mode", "GitHub is holding the test account in sudo mode.")]
    })
    expect(outcome.verdict).toBeUndefined()
    expect(outcome.teardown).toEqual(["GitHub is holding the test account in sudo mode."])
  })

  test("is the body's own error when the body failed, not an aggregate that buries it", () => {
    const bodyError = new Error("the transcript never showed the imported repository")
    const outcome = scenarioOutcome({
      repository,
      bodyError,
      teardownFailures: [new TeardownRefusal("github-sudo-mode", "GitHub is holding the test account in sudo mode.")]
    })
    expect(outcome.verdict).toBe(bodyError)
    expect(outcome.teardown).toHaveLength(1)
  })

  test("carries no teardown line when cleanup finished", () => {
    expect(scenarioOutcome({ repository, teardownFailures: [] }).teardown).toEqual([])
  })
})

describe("the sentence a teardown failure is filed under", () => {
  const repository = "codeplanesmithers/smithers-e2e-import-x"

  test("is the refusal's own sentence when this module raised it", () => {
    expect(teardownSentence(repository, new TeardownRefusal("github-sudo-mode", "a whole sentence"))).toBe("a whole sentence")
  })

  test("names an unrecognised failure by what it leaves behind, never by what it threw", () => {
    const sentence = teardownSentence(repository, new Error("apiKey=sk-live-abcdefgh rejected by upstream 502"))
    expect(sentence).toContain(repository)
    expect(sentence).not.toContain("sk-live-abcdefgh")
    expect(sentence).not.toContain("502")
  })

  test("reads every branch of an aggregate, so one refusal inside it still speaks", () => {
    const sentence = teardownSentence(repository, new AggregateError([
      new TeardownRefusal("github-sudo-mode", "the account wall sentence"),
      new Error("Projection.Snapshot 500")
    ], "cleanup was incomplete"))
    expect(sentence).toContain("the account wall sentence")
    expect(sentence).not.toContain("Projection.Snapshot")
  })
})
