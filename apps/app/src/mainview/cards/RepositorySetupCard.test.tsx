import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { initialSetup, setupCandidate, type RepositoryJob, type SetupReceipt } from "@smthrs/rpc/RepositorySetup"
import { flowArgs } from "../flows/FlowArgs"
import { payloadFor } from "../flows/SlashPayload"
import type { CardOf } from "./CardFamily"
import { RepositorySetupCard } from "./RepositorySetupCard"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

const makeCard = (job: RepositoryJob = "issues"): CardOf<"repository-setup"> => ({
  id: "setup", kind: "repository-setup", title: "Setup", status: "active", createdAt: 1, ordinal: 1,
  payload: initialSetup("example/repo", job, "maintainer")
})
const mount = (card = makeCard(), signedOut = false) => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = (next = card) => flushSync(() => root.render(<RepositorySetupCard card={next} signedOut={signedOut} onRunCommand={(name, args) => { calls.push([name, args]) }} />))
  render()
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === text)
  return { host, calls, render, button, close: () => { flushSync(() => root.unmount()); host.remove() } }
}

test("signed-out preview has a real sign-in door, editable native controls and no network action", () => {
  const t = mount(makeCard(), true)
  try {
    expect(t.button("Inspect repository")).toBeUndefined()
    expect(t.button("Enable issue handling")).toBeUndefined()
    expect(t.host.querySelector<HTMLSelectElement>("select")?.disabled).toBe(false)
    t.button("Sign in")!.click()
    expect(t.calls).toEqual([["auth.prompt", undefined]])
    expect(t.button("Sign in")!.tabIndex).toBe(0)
  } finally { t.close() }
})

test("Configure in Chat uses the registered card-scoped command grammar", () => {
  const card = makeCard()
  const t = mount(card)
  try {
    t.button("Configure in Chat")!.click()
    expect(t.calls).toEqual([["setup.guide", card.id]])
    expect(payloadFor("setup.guide", card.id)).toEqual({ payload: { cardId: card.id } })
  } finally { t.close() }
})

test.each(["issues", "feature"] as const)("%s links optional CI setup to the same repository", job => {
  const card = makeCard(job)
  const t = mount(card)
  try {
    t.button("Set up CI")!.click()
    expect(t.calls).toEqual([["ci.setup", card.payload.repo]])
    if (job === "feature") expect(t.host.textContent).toContain("Start from approved issues")
  } finally { t.close() }
})

test.each([
  ["issues", "Create test issue", "Enable issue handling", "Test issue title", "Test issue body"],
  ["review", "Review test PR", "Enable PR reviews", "Test PR", null],
  ["ci", "Test CI checks", "Enable CI checks", "CI trial", null],
  ["feature", "Try feature flow", "Enable feature flow", "Test feature", "Feature request"],
  ["chores", "Run test chore", "Enable chore", "Test chore", "Maintenance task"]
] as const)("%s trial and activation actions describe the actual job", (job, trial, enable, titleLabel, bodyLabel) => {
  const card = makeCard(job)
  card.payload.view = "test"
  if (job === "review" || job === "ci") card.payload.draft.trialBody = "https://github.com/example/repo/pull/42"
  const t = mount(card)
  try {
    expect(t.button(enable)?.disabled).toBe(true)
    t.button(trial)!.click()
    expect(t.calls).toEqual([["setup.run", flowArgs("setup.run", { cardId: card.id, operation: "trial" })]])
    const title = t.host.querySelector<HTMLInputElement>(`input[aria-label="${titleLabel}"]`)!
    title.value = "A specific trial"
    title.dispatchEvent(new Event("input", { bubbles: true }))
    expect(t.calls.at(-1)).toEqual(["setup.configure", flowArgs("setup.configure", { cardId: card.id, field: "trialTitle", value: "A specific trial" })])
    if (bodyLabel) {
      const body = t.host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${bodyLabel}"]`)!
      body.value = "Find the documented installation command."
      body.dispatchEvent(new Event("input", { bubbles: true }))
      expect(t.calls.at(-1)).toEqual(["setup.configure", flowArgs("setup.configure", { cardId: card.id, field: "trialBody", value: body.value })])
    }
    if (job === "issues" || job === "review") {
      expect(t.host.textContent).toContain("Replies drafted")
      card.payload.draft.replies = "automatic"
      t.render(card)
      expect(t.host.textContent).toContain("Replies drafted")
      expect(t.host.textContent).not.toContain("Test replies may be posted")
    } else expect(t.host.textContent).not.toContain("Replies drafted")
  } finally { t.close() }
})

test.each(["review", "ci"] as const)("%s trial requires an explicit PR and exposes source/number controls", job => {
  const card = makeCard(job)
  card.payload.view = "test"
  const t = mount(card)
  try {
    const action = job === "review" ? "Review test PR" : "Test CI checks"
    expect(t.button(action)?.disabled).toBe(true)
    const source = t.host.querySelector<HTMLSelectElement>('select[aria-label="Source"]')!
    source.value = "smithers-cloud"
    source.dispatchEvent(new Event("change", { bubbles: true }))
    const number = t.host.querySelector<HTMLInputElement>('input[aria-label="PR number"]')!
    number.value = "42"
    number.dispatchEvent(new Event("input", { bubbles: true }))
    expect(t.calls).toEqual([
      ["setup.configure", flowArgs("setup.configure", { cardId: "setup", field: "trial.source", value: "smithers-cloud" })],
      ["setup.configure", flowArgs("setup.configure", { cardId: "setup", field: "trial.number", value: 42 })]
    ])
    t.render({ ...card, payload: { ...card.payload, draft: { ...card.payload.draft, trialBody: '{"source":"smithers-cloud","number":42}' } } })
    expect(t.button(action)?.disabled).toBe(false)
  } finally { t.close() }
})

test("only a real scoped run enables Run; waiting alone never claims an approval", () => {
  const card = makeCard()
  const digest = setupCandidate(card.payload)
  const receipt: SetupReceipt = { requestId: "request", operation: "evaluate", revision: 1, digest, phase: "queued", updatedAt: 1, results: [], evidence: [] }
  card.payload.workspaceId = "de29f26b-e593-4ec2-99fc-583d4711f20a"
  card.payload.request = { id: "request", operation: "evaluate", revision: 1, digest, state: "running" }
  card.payload.receipt = receipt
  const t = mount(card)
  try {
    expect(t.button("Run")).toBeUndefined()
    expect(t.button("Approvals")).toBeUndefined()
    const next = { ...card, payload: { ...card.payload, receipt: { ...receipt, runId: "actual-run", phase: "waiting" as const },
      request: { ...card.payload.request, state: "failed" as const, error: "Connection lost" } } }
    t.render(next)
    expect(t.button("Approvals")).toBeUndefined()
    t.button("Run")!.click(); t.button("Reconnect")!.click()
    expect(t.calls).toEqual([
      ["runs.open", flowArgs("runs.open", { sourceCard: card.id, runId: "actual-run", repo: "example/repo" })],
      ["setup.retry", card.id]
    ])
    expect(t.host.textContent).toContain("Connection lost")
    expect(t.host.textContent).not.toContain("Stopped")
  } finally { t.close() }
})

test("old eval evidence remains readable after a candidate edit", () => {
  const card = makeCard()
  card.payload.view = "evals"
  card.payload.previousReceipts = [{ requestId: "old", runId: "old-run", operation: "evaluate", revision: 1, digest: "old", phase: "completed", updatedAt: 1,
    results: [{ caseId: "repro", status: "failed", observed: "The baseline did not reproduce.", executionId: "case-1", evidence: ["artifact:baseline-log"] }], evidence: ["artifact:eval-report"] }]
  const t = mount(card)
  try {
    expect(t.host.textContent).toContain("The baseline did not reproduce.")
    expect(t.host.textContent).toContain("artifact:baseline-log")
    expect(t.host.textContent).toContain("artifact:eval-report")
  } finally { t.close() }
})

test("a native trial shows one pending phase, real Issue/Run access and closed technical evidence", () => {
  const card = makeCard()
  card.payload.view = "test"
  card.payload.workspaceId = "de29f26b-e593-4ec2-99fc-583d4711f20a"
  card.payload.request = { id: "trial", operation: "trial", revision: 1, digest: setupCandidate(card.payload), state: "running" }
  card.payload.receipt = card.payload.trial = { requestId: "trial", runId: "trial-run", jobRunId: "trial-job", operation: "trial", revision: 1, digest: setupCandidate(card.payload), phase: "waiting", updatedAt: 1,
    results: [], evidence: ["issue:42", "candidate:.smithers/setup/candidate.json", "execution:trial-job", "source:immutable-commit"], trialIssue: { source: "smithers-cloud", number: 42 } }
  const t = mount(card)
  const phases = (phase: string) => [...t.host.querySelectorAll("span,p")].filter(node => node.textContent?.toLowerCase() === phase)
  try {
    expect(t.host.querySelector("a")).toBeNull()
    expect(phases("waiting")).toHaveLength(1)
    expect(t.button("Approvals")).toBeUndefined()
    const details = [...t.host.querySelectorAll("details")].find(detail => detail.querySelector("summary")?.textContent === "Technical details")!
    expect(details.open).toBe(false)
    expect([...details.querySelectorAll("code")].map(item => item.textContent)).toEqual(card.payload.trial.evidence)
    t.button("Issue #42")!.click()
    t.button("Job run")!.click()
    expect(t.calls).toEqual([
      ["issues.view", flowArgs("issues.view", { number: 42, repo: "example/repo", source: "smithers-cloud" })],
      ["runs.open", flowArgs("runs.open", { runId: "trial-job", repo: "example/repo", sourceCard: card.id })]
    ])
    const preview = mount(card, true)
    try {
      expect([...preview.host.querySelectorAll("span,p")].filter(node => node.textContent?.toLowerCase() === "waiting")).toHaveLength(1)
      expect(preview.button("Sign in")).toBeDefined()
    } finally { preview.close() }
    card.payload.request.state = "completed"
    card.payload.receipt = card.payload.trial = { ...card.payload.trial, phase: "completed" }
    t.render(card)
    expect(phases("completed")).toHaveLength(1)
    expect(phases("waiting")).toHaveLength(0)
  } finally { t.close() }
})

test("reply settings expose draft behavior and require explicit correction of an old automatic draft", () => {
  const card = makeCard()
  const t = mount(card)
  try {
    const replies = [...t.host.querySelectorAll<HTMLSelectElement>("select")].find(select => select.querySelector('option[value="draft"]'))!
    expect(replies.querySelector('option[value="automatic"]') === null).toBe(true)
    card.payload.draft.replies = "automatic"
    t.render(card)
    expect(replies.querySelector<HTMLOptionElement>('option[value="automatic"]')?.disabled).toBe(true)
    expect(t.host.textContent).toContain("Choose draft replies.")
    expect(t.calls).toHaveLength(0)
  } finally { t.close() }
})

test("a per-step work form edits labeled fields and opens the actual dispatched job", () => {
  const card = makeCard()
  card.payload.workspaceId = "de29f26b-e593-4ec2-99fc-583d4711f20a"
  card.payload.active = { enabled: true, revision: 1, digest: setupCandidate(card.payload), registrationId: "registered", sourceRevision: "source" }
  card.payload.view = "work"
  card.payload.manualDraft = { stepId: "fix", source: "smithers-cloud", number: 4, prompt: "Preserve compatibility" }
  const t = mount(card)
  try {
    const source = t.host.querySelector<HTMLSelectElement>('select[aria-label="Source"]')!
    source.value = "github"
    source.dispatchEvent(new Event("change", { bubbles: true }))
    const number = t.host.querySelector<HTMLInputElement>('input[aria-label="Issue number"]')!
    number.value = "8"
    number.dispatchEvent(new Event("input", { bubbles: true }))
    const instructions = t.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions (optional)"]')!
    instructions.value = "Keep the existing behavior."
    instructions.dispatchEvent(new Event("input", { bubbles: true }))
    expect(t.calls).toEqual([
      ["setup.work", flowArgs("setup.work", { cardId: card.id, stepId: "fix", field: "source", value: "github" })],
      ["setup.work", flowArgs("setup.work", { cardId: card.id, stepId: "fix", field: "number", value: 8 })],
      ["setup.work", flowArgs("setup.work", { cardId: card.id, stepId: "fix", field: "prompt", value: instructions.value })]
    ])
    t.calls.length = 0
    t.button("Fix for real")!.click()
    expect(payloadFor("setup.run", t.calls[0]![1]!)).toEqual({ payload: { cardId: "setup", operation: "run" } })
    card.payload.request = { id: "work", operation: "run", revision: 1, digest: setupCandidate(card.payload), state: "running" }
    card.payload.receipt = { requestId: "work", operation: "run", revision: 1, digest: setupCandidate(card.payload), phase: "waiting", updatedAt: 1,
      runId: "wrapper", jobRunId: "actual-job", results: [], evidence: [] }
    t.render(card)
    expect(t.button("Approvals")).toBeUndefined()
    t.button("Job run")!.click()
    expect(t.calls.slice(1)).toEqual([
      ["runs.open", flowArgs("runs.open", { runId: "actual-job", repo: "example/repo", sourceCard: "setup" })]
    ])
    card.payload.revision = 2
    card.payload.request = undefined
    t.render(card)
    expect(t.button("Fix for real")?.disabled).toBe(true)
  } finally { t.close() }
})
