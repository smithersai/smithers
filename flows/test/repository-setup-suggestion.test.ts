import assert from "node:assert/strict"
import { test } from "node:test"
import { suggestedSetupDraft } from "../repository/setup.ts"
import type { Draft } from "../repository/schema.ts"

const draft: Draft = {
  steps: [
    { id: "research", name: "Research issue", mode: "automatic", prompt: "Classify the issue and inspect relevant source." },
    { id: "poc", name: "Quick POC", mode: "manual", prompt: "Explore a cheap bounded fix in an isolated workspace." }
  ],
  checks: [{ id: "telemetry", name: "Telemetry", kind: "ai", rule: "Handlers record failures.", paths: ["src/**"], policy: "required" }],
  cases: [], replies: "draft", landing: "ask", scope: "future", label: "", schedule: "", budgetMinutes: 10,
  connectIssues: false, trialTitle: "[Smithers test] Issues", trialBody: "A scoped setup trial."
}
type Suggestion = Parameters<typeof suggestedSetupDraft>[1]
const suggestedCase = { id: "answers-a-source-question", name: "Answers a source question", required: true,
  expected: "The reply cites the captured README.", input: { sourceRevision: "a".repeat(40),
    event: { source: "smithers-cloud", type: "issues", action: "opened", deliveryKey: "delivery-1",
      payload: { issue: { title: "What does the CLI do?", body: "Explain the entry point." } } },
    assertions: [{ path: "/results/0/status", equals: "completed" }] } } satisfies Suggestion["cases"][number]
/** Every non-step field here differs from the draft, so the host's discards stay observable. */
const suggestion = (extra: Partial<Suggestion> = {}): Suggestion => ({ checks: draft.checks, cases: [suggestedCase],
  replies: "automatic", landing: "checks", scope: "label", label: "model-label", schedule: "0 9 * * *", budgetMinutes: 90,
  connectIssues: true, trialTitle: "Reproduce the reported crash", trialBody: "A realistic first request.", ...extra })

test("a suggestion without step overrides keeps every step and the user's own decisions", () => {
  const merged = suggestedSetupDraft(draft, suggestion())
  assert.deepEqual(merged.steps, draft.steps)
  assert.equal(merged.steps[0], draft.steps[0], "an unchanged step is the draft's own step")
  assert.equal(merged.steps[1], draft.steps[1])
  for (const field of ["replies", "landing", "scope", "label", "schedule", "budgetMinutes"] as const) assert.deepEqual(merged[field], draft[field])
  assert.equal(merged.trialTitle, "Reproduce the reported crash")
  assert.equal(merged.trialBody, "A realistic first request.")
})

test("an override changes only the named step's named field", () => {
  const modes = suggestedSetupDraft(draft, suggestion({ steps: [{ id: "poc", mode: "automatic" }] }))
  assert.deepEqual(modes.steps[1], { ...draft.steps[1]!, mode: "automatic" })
  assert.equal(modes.steps[0], draft.steps[0])
  const prompts = suggestedSetupDraft(draft, suggestion({ steps: [{ id: "research", prompt: "Read crates/ first." }] }))
  assert.deepEqual(prompts.steps[0], { ...draft.steps[0]!, prompt: "Read crates/ first." })
  assert.equal(prompts.steps[1], draft.steps[1])
  assert.equal(draft.steps[1]!.mode, "manual", "merging cannot mutate the draft")
})

test("an override for an unknown step ID is dropped, never added", () => {
  const merged = suggestedSetupDraft(draft, suggestion({ steps: [{ id: "invented", mode: "automatic", prompt: "Do new work." },
    { id: "poc", prompt: "Bound the experiment." }] }))
  assert.equal(merged.steps.length, 2)
  assert.deepEqual(merged.steps.map(step => step.id), ["research", "poc"])
  assert.equal(merged.steps[1]!.prompt, "Bound the experiment.")
})

test("suggested checks stay report-only and existing user cases survive inspection", () => {
  const rewritten = { ...draft.checks[0]!, rule: "Handlers record every failure class." }
  assert.deepEqual(suggestedSetupDraft(draft, suggestion({ checks: [rewritten] })).checks, [{ ...rewritten, policy: "report" }])
  assert.deepEqual(suggestedSetupDraft(draft, suggestion()).checks, draft.checks, "an unchanged authored rule keeps its policy")
  const authored: Draft = { ...draft, cases: [{ id: "mine", name: "Mine", input: "{}", expected: "Answers.", required: true }] }
  assert.deepEqual(suggestedSetupDraft(authored, suggestion()).cases, authored.cases)
  assert.deepEqual(suggestedSetupDraft(draft, suggestion()).cases,
    [{ ...suggestedCase, input: JSON.stringify(suggestedCase.input) }], "a model case is stored as validated JSON text")
})
