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
  cases: [], replies: "draft", landing: "ask", scope: "future", label: "", schedule: "", choreEvent: "none", budgetMinutes: 10,
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
  replies: "automatic", landing: "checks", scope: "label", label: "model-label", schedule: "0 9 * * *", choreEvent: "push", budgetMinutes: 90,
  connectIssues: true, trialTitle: "Reproduce the reported crash", trialBody: "A realistic first request.", ...extra })
const captured = "c".repeat(40)
const merge = (existing: Draft, suggested: Suggestion) => suggestedSetupDraft(existing, suggested, captured)

test("a suggestion without step overrides keeps every step and the user's own decisions", () => {
  const merged = merge(draft, suggestion())
  assert.deepEqual(merged.steps, draft.steps)
  assert.equal(merged.steps[0], draft.steps[0], "an unchanged step is the draft's own step")
  assert.equal(merged.steps[1], draft.steps[1])
  for (const field of ["replies", "landing", "scope", "label", "schedule", "choreEvent", "connectIssues", "budgetMinutes"] as const) assert.deepEqual(merged[field], draft[field])
  assert.equal(merged.trialTitle, "Reproduce the reported crash")
  assert.equal(merged.trialBody, "A realistic first request.")
})

test("an override changes only the named step's named field", () => {
  const modes = merge(draft, suggestion({ steps: [{ id: "poc", mode: "automatic" }] }))
  assert.deepEqual(modes.steps[1], { ...draft.steps[1]!, mode: "automatic" })
  assert.equal(modes.steps[0], draft.steps[0])
  const prompts = merge(draft, suggestion({ steps: [{ id: "research", prompt: "Read crates/ first." }] }))
  assert.deepEqual(prompts.steps[0], { ...draft.steps[0]!, prompt: "Read crates/ first." })
  assert.equal(prompts.steps[1], draft.steps[1])
  assert.equal(draft.steps[1]!.mode, "manual", "merging cannot mutate the draft")
})

// The old contract re-emitted every step and passed the model's array through,
// so a rename or an invented step reached the user's draft. It cannot now.
test("a re-emitted old-shape steps array cannot rename a step or add a new one", () => {
  const reEmitted = [
    { id: "research", name: "Renamed by the model", mode: "off", prompt: "Ignore the repository." },
    { id: "poc", name: "Quick POC", mode: "manual", prompt: "Explore a cheap bounded fix in an isolated workspace." },
    { id: "invented", name: "Invented step", mode: "automatic", prompt: "Do unrequested work." }
  ]
  const merged = merge(draft, suggestion({ steps: reEmitted as unknown as NonNullable<Suggestion["steps"]> }))
  assert.deepEqual(merged.steps.map(step => step.id), ["research", "poc"])
  assert.deepEqual(merged.steps.map(step => step.name), draft.steps.map(step => step.name))
  assert.deepEqual(merged.steps[1], draft.steps[1], "a step re-emitted unchanged keeps its draft values")
  assert.deepEqual(merged.steps[0], { ...draft.steps[0]!, mode: "off", prompt: "Ignore the repository." })
})

test("an override for an unknown step ID is dropped, never added", () => {
  const merged = merge(draft, suggestion({ steps: [{ id: "invented", mode: "automatic", prompt: "Do new work." },
    { id: "poc", prompt: "Bound the experiment." }] }))
  assert.equal(merged.steps.length, 2)
  assert.deepEqual(merged.steps.map(step => step.id), ["research", "poc"])
  assert.equal(merged.steps[1]!.prompt, "Bound the experiment.")
})

test("suggested checks stay report-only and existing user cases survive inspection", () => {
  const rewritten = { ...draft.checks[0]!, rule: "Handlers record every failure class." }
  assert.deepEqual(merge(draft, suggestion({ checks: [rewritten] })).checks, [{ ...rewritten, policy: "report" }])
  assert.deepEqual(merge(draft, suggestion()).checks, draft.checks, "an unchanged authored rule keeps its policy")
  const authored: Draft = { ...draft, cases: [{ id: "mine", name: "Mine", input: "{}", expected: "Answers.", required: true }] }
  assert.deepEqual(merge(authored, suggestion()).cases, authored.cases)
  assert.deepEqual(merge(draft, suggestion()).cases,
    [{ ...suggestedCase, input: JSON.stringify({ ...suggestedCase.input, sourceRevision: captured }) }], "a model case is stored as validated JSON text")
})

/** A revision the model names is not a revision the host captured, and a case
 * pinned to a commit this workspace never held can never be evaluated. */
test("the held-out source of a suggested case is the commit the inspection captured", () => {
  const cases = suggestedSetupDraft(draft, suggestion(), captured).cases
  assert.equal(JSON.parse(cases[0]!.input).sourceRevision, captured)
  assert.notEqual(suggestedCase.input.sourceRevision, captured)
  const authored: Draft = { ...draft, cases: [{ id: "mine", name: "Mine", input: JSON.stringify(suggestedCase.input), expected: "Answers.", required: true }] }
  assert.deepEqual(suggestedSetupDraft(authored, suggestion(), captured).cases, authored.cases, "the host never rewrites a case the user already has")
})

/** The event a chore runs on is the maintainer's decision, not a suggestion. */
test("an inspection cannot change the chore event the maintainer chose", () => {
  assert.equal(merge(draft, suggestion({ choreEvent: "push" })).choreEvent, "none")
  assert.equal(merge(draft, suggestion({ choreEvent: "labeled" })).choreEvent, "none")
  const pushing: Draft = { ...draft, choreEvent: "push" }
  assert.equal(merge(pushing, suggestion({ choreEvent: "none" })).choreEvent, "push")
  assert.equal(merge(pushing, suggestion({ choreEvent: "labeled" })).choreEvent, "push")
})
