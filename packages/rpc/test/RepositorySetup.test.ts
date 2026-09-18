import { describe, expect, it } from "vitest"
import {
  archiveReplacedSetupReceipt,
  editSetup,
  initialSetup,
  reconcileSetupHistory,
  type RepositorySetup,
  RepositorySetupSchema,
  setupActivationProblems,
  setupCandidate,
  SetupDraftSchema,
  SetupHostInputSchema,
  type SetupReceipt
} from "../src/RepositorySetup.ts"

const caseFixture = {
  id: "unrelated",
  name: "Unrelated change",
  input: "synthetic case fixture",
  expected: "Take no unrelated actions",
  required: true
}

function receipt(setup: RepositorySetup, operation: SetupReceipt["operation"]): SetupReceipt {
  return {
    requestId: `${operation}-request`,
    runId: `${operation}-run`,
    revision: setup.revision,
    operation,
    phase: "completed",
    digest: setupCandidate(setup),
    updatedAt: 100,
    results: setup.draft.cases.map((test) => ({
      caseId: test.id,
      status: "passed",
      observed: test.expected,
      evidence: [`execution:${test.id}`],
      executionId: test.id
    })),
    evidence: ["webhook:delivery-1", "run:trial-run"],
    sourceRevision: "candidate-commit",
    trialIssue: { source: "github", number: 12, url: "https://github.com/example/repo/issues/12" }
  }
}
const proven = (): RepositorySetup => {
  const setup = initialSetup("example/repo", "issues", "maintainer")
  setup.draft.cases = [{ ...caseFixture }]
  return { ...setup, evaluation: receipt(setup, "evaluate"), trial: receipt(setup, "trial") }
}

it("a durable guide request survives edits without becoming setup evidence", () => {
  const setup = initialSetup("example/repo", "issues", "maintainer")
  setup.guidance = { id: "6405cbb6-c18f-452e-99db-adb1283ee18a", state: "requested" }
  const parsed = RepositorySetupSchema.parse(setup)
  const changed = editSetup(parsed, { ...parsed.draft, trialTitle: "A concrete issue" })
  expect(changed.guidance).toEqual(setup.guidance)
  expect(setupActivationProblems(changed)).toContain("Run evals for this draft.")
  expect(RepositorySetupSchema.safeParse({ ...setup, guidance: { ...setup.guidance, state: "completed" } }).success)
    .toBe(false)
})

it("a scheduler observation is retained independently of a draft and never supplies activation proof", () => {
  const setup = initialSetup("example/repo", "chores", "maintainer")
  setup.draft.schedule = "0 9 * * *"
  setup.active = {
    revision: 1,
    digest: setupCandidate(setup),
    registrationId: "chore",
    sourceRevision: "source",
    enabled: true,
    schedule: { expression: setup.draft.schedule, nextFireAt: "2026-09-18T09:00:00Z" }
  }
  const parsed = RepositorySetupSchema.parse(setup)
  expect(parsed.active?.schedule).toEqual(setup.active.schedule)
  expect(setupActivationProblems(parsed)).toContain("Run evals for this draft.")
  expect(setupActivationProblems(parsed)).toContain("Complete the live trial for this draft.")
  const changed = editSetup(parsed, { ...parsed.draft, schedule: "" })
  expect(changed.draft.schedule).toBe("")
  expect(changed.active?.schedule?.expression).toBe("0 9 * * *")
  expect(changed.revision).toBe(2)
  expect(
    RepositorySetupSchema.safeParse({
      ...setup,
      active: { ...setup.active, schedule: { expression: "0 9 * * *", nextFireAt: "tomorrow" } }
    }).success
  ).toBe(false)
})

it("a chore event joins the candidate, defaults to none in a stored draft and needs a step that actually runs", () => {
  const unattended = "Set the chore to run automatically or on approval."
  const setup = initialSetup("example/repo", "chores", "maintainer")
  expect(setup.draft.choreEvent).toBe("none")
  const { choreEvent: _absent, ...stored } = setup.draft
  expect(SetupDraftSchema.parse(stored).choreEvent).toBe("none")
  expect(setupActivationProblems(setup)).not.toContain(unattended)
  const running = (draft: RepositorySetup["draft"]) => ({
    ...draft,
    steps: draft.steps.map((step) => ({ ...step, mode: "approved" as const }))
  })
  for (
    const draft of [{ ...setup.draft, choreEvent: "push" as const }, {
      ...setup.draft,
      choreEvent: "labeled" as const,
      label: "chore"
    }, { ...setup.draft, schedule: "0 9 * * *" }]
  ) {
    expect(setupCandidate({ ...setup, draft })).not.toBe(setupCandidate(setup))
    expect(setupActivationProblems({ ...setup, draft })).toContain(unattended)
    expect(setupActivationProblems({ ...setup, draft: running(draft) })).not.toContain(unattended)
  }
  expect(
    setupActivationProblems({
      ...setup,
      draft: { ...setup.draft, choreEvent: "labeled", steps: running(setup.draft).steps }
    })
  )
    .toContain("Choose the issue label.")
  const issues = initialSetup("example/repo", "issues", "maintainer")
  expect(setupActivationProblems({ ...issues, draft: { ...issues.draft, schedule: "0 9 * * *" } })).not.toContain(
    unattended
  )
})

it("refuses a padded label where the label decides what runs, so a label that never fires cannot register", () => {
  const padded = "Remove the spaces around the issue label."
  const chore = initialSetup("example/repo", "chores", "maintainer")
  const running = chore.draft.steps.map((step) => ({ ...step, mode: "approved" as const }))
  expect(
    setupActivationProblems({
      ...chore,
      draft: { ...chore.draft, steps: running, choreEvent: "labeled", label: " chore " }
    })
  ).toContain(padded)
  expect(
    setupActivationProblems({
      ...chore,
      draft: { ...chore.draft, steps: running, choreEvent: "labeled", label: "chore" }
    })
  ).not.toContain(padded)
  const issues = initialSetup("example/repo", "issues", "maintainer")
  expect(setupActivationProblems({ ...issues, draft: { ...issues.draft, scope: "label", label: "triage " } }))
    .toContain(padded)
  const blank = setupActivationProblems({ ...issues, draft: { ...issues.draft, scope: "label", label: " " } })
  expect(blank).toContain("Choose the issue label.")
  expect(blank).not.toContain(padded)
  expect(setupActivationProblems({ ...issues, draft: { ...issues.draft, label: " triage " } })).not.toContain(padded)
})

/** Digests the pre-stack code at 1f7d9b40bcc5 computed, which is what stored
 * setup records, registration rows and retained cards still carry. */
const STORED_DIGESTS = {
  issues: "eaa65868ff1b8e731c14d789e16b27f980d92492601fca521d9a4534a9b3194f",
  chores: "bbf342a61d1c36d83ecd20c7f7372dbc27cf61bf121f36590b874196b6ffdf35"
} as const

it.each(["issues", "chores"] as const)(
  "a %s candidate stored before the chore event existed keeps its digest, in both skew directions",
  (job) => {
    const setup = initialSetup("example/repo", job, "maintainer")
    const { choreEvent: _absent, ...stored } = setup.draft
    expect(
      SetupHostInputSchema.safeParse({
        requestId: "stored-request",
        repo: setup.repo,
        job,
        revision: setup.revision,
        digest: STORED_DIGESTS[job],
        draft: stored,
        operation: "apply"
      }).success
    ).toBe(true)
    expect(setupCandidate(setup)).toBe(STORED_DIGESTS[job])
    for (const choreEvent of ["push", "labeled"] as const) {
      expect(setupCandidate({ ...setup, draft: { ...setup.draft, choreEvent } })).not.toBe(STORED_DIGESTS[job])
    }
  }
)

describe("repository setup receipt history", () => {
  it("archiving a displaced receipt preserves terminal evidence and deduplicates without granting activation", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    const pause = receipt(setup, "pause"), apply = receipt(setup, "apply")
    setup.receipt = { ...pause, phase: "running", updatedAt: 200 }
    setup.previousReceipts = [pause]
    const archived = archiveReplacedSetupReceipt(setup, apply)
    expect(archived.previousReceipts).toEqual([pause])
    expect(archiveReplacedSetupReceipt(archived, apply).previousReceipts).toEqual([pause])
    expect(archived.receipt).toBe(setup.receipt)
    expect(archived.evaluation).toBeUndefined()
    expect(archived.trial).toBeUndefined()
    expect(setupActivationProblems(archived)).toHaveLength(2)
  })

  it("bounds receipt history while retaining the newly displaced current request", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    setup.receipt = receipt(setup, "pause")
    setup.previousReceipts = Array.from(
      { length: 50 },
      (_, index) => ({ ...receipt(setup, "inspect"), requestId: `older-${index}` })
    )
    const archived = archiveReplacedSetupReceipt(setup, receipt(setup, "apply"))
    expect(archived.previousReceipts).toHaveLength(50)
    expect(archived.previousReceipts[0]?.requestId).toBe("older-1")
    expect(archived.previousReceipts.at(-1)).toEqual(setup.receipt)
    expect(setup.previousReceipts[0]?.requestId).toBe("older-0")
  })

  it("a current receipt is not duplicated, while different candidate identities remain distinct", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    setup.receipt = receipt(setup, "pause")
    expect(archiveReplacedSetupReceipt(setup, { ...setup.receipt, updatedAt: 200 })).toBe(setup)
    const previous = { ...setup.receipt, revision: 2, digest: "other-candidate" }
    setup.previousReceipts = [previous]
    expect(archiveReplacedSetupReceipt(setup, receipt(setup, "apply")).previousReceipts).toEqual([
      previous,
      setup.receipt
    ])
  })

  it("uses actual eval and trial receipts without inventing a missing outcome", () => {
    const setup = proven()
    const unknown = { ...setup.evaluation!, requestId: "unobserved", phase: "running" as const }
    setup.previousReceipts = [
      { ...setup.evaluation!, phase: "running" },
      { ...setup.trial!, phase: "waiting" },
      unknown
    ]
    expect(reconcileSetupHistory(setup).previousReceipts).toEqual([setup.evaluation, setup.trial, unknown])
    expect(setup.previousReceipts[0]?.phase).toBe("running")
  })

  it.each([
    { requestId: "another" },
    { revision: 2 },
    { digest: "another" },
    { operation: "trial" as const },
    { runId: "another" },
    { jobRunId: "another" }
  ])("does not heal a different receipt identity: %j", (changed) => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    const previous = { ...receipt(setup, "inspect"), phase: "running" as const, jobRunId: "job-run" }
    setup.previousReceipts = [previous]
    setup.receipt = { ...previous, phase: "completed", ...changed }
    expect(reconcileSetupHistory(setup)).toBe(setup)
  })

  it.each(["completed", "failed", "stopped"] as const)(
    "preserves a %s receipt against later progress or a conflicting terminal result",
    (phase) => {
      const setup = initialSetup("example/repo", "issues", "maintainer")
      const previous = { ...receipt(setup, "inspect"), phase }
      setup.previousReceipts = [previous]
      setup.receipt = { ...previous, phase: "running", updatedAt: 200 }
      expect(reconcileSetupHistory(setup)).toBe(setup)
      const edited = editSetup(setup, { ...setup.draft, trialTitle: "Changed candidate" })
      expect(edited.previousReceipts).toEqual([previous])
      setup.receipt = { ...previous, phase: phase === "completed" ? "failed" : "completed", updatedAt: 300 }
      expect(reconcileSetupHistory(setup)).toBe(setup)
    }
  )
})

describe("repository setup activation evidence", () => {
  it("manual work selects an enabled step and an explicit subject, without accepting signed event data", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    const input = {
      requestId: "manual-request",
      repo: setup.repo,
      job: setup.job,
      revision: setup.revision,
      draft: setup.draft,
      digest: setupCandidate(setup),
      operation: "run",
      manual: {
        stepId: "poc",
        prompt: "Try the reported fix",
        subject: { source: "github", kind: "issue", number: 12 }
      }
    }
    expect(SetupHostInputSchema.safeParse(input).success).toBe(true)
    expect(SetupHostInputSchema.parse({ ...input, event: { sender: "admin" } })).not.toHaveProperty("event")
    for (
      const manual of [undefined, { ...input.manual, stepId: "missing" }, { ...input.manual, subject: undefined }, {
        ...input.manual,
        subject: { ...input.manual.subject, number: -1 }
      }]
    ) {
      expect(SetupHostInputSchema.safeParse({ ...input, manual }).success).toBe(false)
    }
    expect(SetupHostInputSchema.safeParse({ ...input, operation: "trial" }).success).toBe(false)
  })
  it("does not let two expected cases share the same execution result id", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    expect(
      SetupDraftSchema.safeParse({
        ...setup.draft,
        cases: [{ ...caseFixture }, { ...caseFixture, expected: "A different expectation" }]
      }).success
    ).toBe(false)
  })
  it("is opt-in with production fixes and POCs independent and manually started", () => {
    const setup = initialSetup("example/repo", "issues", "maintainer")
    expect(setup.active).toBeUndefined()
    expect(setup.draft.steps.filter((step) => step.mode === "automatic").map((step) => step.id)).toEqual([
      "research",
      "duplicates",
      "reproduce"
    ])
    expect(setup.draft.steps.find((step) => step.id === "poc")?.mode).toBe("manual")
    expect(setup.draft.steps.find((step) => step.id === "fix")?.mode).toBe("manual")
    expect(setup.draft.replies).toBe("draft")
    expect(setupActivationProblems(setup)).toHaveLength(2)
  })
  it("restarts a paused registration from the draft it was activated with, without new evals or trial", () => {
    const applied = proven()
    const active = {
      revision: applied.revision,
      digest: setupCandidate(applied),
      registrationId: "paused-registration",
      sourceRevision: "candidate-commit",
      enabled: false
    }
    // The post-pause card: Cloud re-enables only a newer revision, so the
    // candidate advances while its evidence moves into the history.
    const paused: RepositorySetup = {
      ...applied,
      revision: applied.revision + 1,
      evaluation: undefined,
      trial: undefined,
      active,
      previousReceipts: [applied.evaluation!, applied.trial!]
    }
    expect(setupActivationProblems(paused)).toEqual([])
    expect(setupActivationProblems({ ...paused, active: { ...active, enabled: true } })).toHaveLength(2)
    const edited = editSetup(paused, { ...paused.draft, budgetMinutes: 20 })
    expect(setupActivationProblems(edited)).toContain("Complete the live trial for this draft.")
    expect(setupActivationProblems(edited)).toContain("Run evals for this draft.")
    expect(setupActivationProblems({ ...paused, active: { ...active, digest: setupCandidate(edited) } })).toContain(
      "Run evals for this draft."
    )
  })
  it("requires both current evals and a real live issue trial", () => {
    const setup = proven()
    expect(setupActivationProblems(setup)).toEqual([])
    setup.trial!.phase = "running"
    expect(setupActivationProblems(setup)).toContain("Complete the live trial for this draft.")
    setup.trial!.phase = "completed"
    delete setup.trial!.trialIssue
    expect(setupActivationProblems(setup)).toContain("The live trial needs a real issue receipt.")
  })
  it("does not accept launch success, cross-repository receipts, or mismatched operation receipts", () => {
    const setup = proven()
    setup.evaluation!.phase = "queued"
    expect(setupActivationProblems(setup)).toContain("Run evals for this draft.")
    setup.evaluation = receipt(initialSetup("other/repo", "issues", "maintainer"), "evaluate")
    expect(setupActivationProblems(setup)).toContain("Run evals for this draft.")
    setup.evaluation = receipt(setup, "trial")
    expect(setupActivationProblems(setup)).toContain("Run evals for this draft.")
  })
  it.each(["failed", "review", "error"] as const)("a required case that is %s blocks activation", (status) => {
    const setup = proven()
    setup.evaluation!.results[0]!.status = status
    expect(setupActivationProblems(setup)).toContain("Resolve eval: Unrelated change.")
  })
  it("rejects missing, duplicate, and unsupported passing results", () => {
    const setup = proven()
    setup.evaluation!.results.shift()
    expect(setupActivationProblems(setup)).toContain("Resolve eval: Unrelated change.")
    setup.evaluation = receipt(setup, "evaluate")
    setup.evaluation.results.push(setup.evaluation.results[0]!)
    expect(setupActivationProblems(setup)).toContain("Resolve eval: Unrelated change.")
    setup.evaluation = receipt(setup, "evaluate")
    setup.evaluation.results[0]!.evidence = []
    expect(setupActivationProblems(setup)).toContain("Resolve eval: Unrelated change.")
  })
  it("prompt edits invalidate candidate evidence while preserving the active policy", () => {
    const setup = proven()
    setup.active = {
      revision: 1,
      digest: setupCandidate(setup),
      registrationId: "registration-1",
      sourceRevision: "commit-1",
      enabled: true
    }
    const changed = editSetup(setup, {
      ...setup.draft,
      steps: setup.draft.steps.map((step) => step.id === "research" ? { ...step, prompt: "A revised rule" } : step)
    })
    expect(changed.revision).toBe(2)
    expect(changed.active).toEqual(setup.active)
    expect(changed.evaluation).toBeUndefined()
    expect(changed.trial).toBeUndefined()
    expect(setupActivationProblems({ ...changed, evaluation: setup.evaluation, trial: setup.trial })).toHaveLength(2)
    expect(editSetup(changed, changed.draft)).toBe(changed)
  })
  it("editing recovered pending work retains its read-only identity until a real terminal receipt arrives", () => {
    const setup = proven()
    setup.receipt = { ...receipt(setup, "apply"), phase: "waiting" }
    setup.request = {
      id: setup.receipt.requestId,
      operation: "apply",
      revision: setup.revision,
      digest: setupCandidate(setup),
      state: "failed",
      error: "Disconnected",
      observeOnly: true
    }
    const edited = editSetup(setup, { ...setup.draft, budgetMinutes: 12 })
    expect(edited.request).toEqual(setup.request)
    expect(edited.receipt?.phase).toBe("waiting")
    expect(edited.evaluation).toBeUndefined()
    expect(edited.trial).toBeUndefined()
    const finished = editSetup({ ...edited, receipt: { ...edited.receipt!, phase: "completed" } }, {
      ...edited.draft,
      budgetMinutes: 13
    })
    expect(finished.request).toBeUndefined()
    expect(finished.previousReceipts.find((item) => item.requestId === setup.receipt!.requestId)?.phase).toBe(
      "completed"
    )
  })
  it("requires a label for label-scoped activation and at least one enabled flow", () => {
    const setup = proven()
    setup.draft.scope = "label"
    setup.draft.steps = setup.draft.steps.map((step) => ({ ...step, mode: "off" }))
    expect(setupActivationProblems(setup)).toContain("Choose the issue label.")
    expect(setupActivationProblems(setup)).toContain("Choose a flow to enable.")
  })
  it("waits for repository inspection to author real cases and refuses empty-case activation", () => {
    for (const job of ["issues", "ci", "review", "feature", "chores"] as const) {
      const setup = initialSetup("example/repo", job, null)
      expect(setup.draft.cases).toEqual([])
      setup.evaluation = receipt(setup, "evaluate")
      setup.trial = receipt(setup, "trial")
      expect(setupActivationProblems(setup)).toContain("Add required eval cases.")
    }
  })
})
