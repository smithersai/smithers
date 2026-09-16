import assert from "node:assert/strict"
import { test } from "node:test"
import { assessScore } from "../repository/evaluation.ts"
import { retainedStepError } from "../repository/jobs.ts"
import { SuggestedCaseInput } from "../repository/setup.ts"
import { CodingError } from "../coding/schema.ts"
import { Schema } from "effect"
import type { JobResult } from "../repository/schema.ts"

test("eval evidence selects recorded references and cannot turn bad assertions or execution errors into a pass", () => {
  const observed: JobResult = { repo: "example/repo", job: "issues", revision: 1, digest: "a".repeat(64), sourceRevision: "b".repeat(40),
    eventKey: "case-1", status: "completed", publicActions: [], results: [{ stepId: "research", status: "completed", summary: "The greeting is hello",
      evidence: ["source:greeting.mjs@0123"], output: { classification: "question" }, executionId: "actual-step" }] }
  const expected = { id: "case-1", name: "Question", input: JSON.stringify({ sourceRevision: observed.sourceRevision,
    event: { source: "smithers-cloud", type: "issues", action: "opened", deliveryKey: "case-1", payload: {} },
    assertions: [{ path: "/results/0/output/classification", equals: "question" }] }), expected: "Cite the greeting's source", required: true }
  const score = { verdict: "pass" as const, reason: "The result matches the source", evidenceIds: [1] }
  assert.deepEqual(assessScore(expected, observed, score), { status: "passed", observed: score.reason, evidence: ["source:greeting.mjs@0123"] })
  for (const evidenceIds of [[], [-1], [1.5], [99]]) {
    const assessment = assessScore(expected, observed, { ...score, evidenceIds })
    assert.equal(assessment.status, "review")
    assert.deepEqual(assessment.evidence, [])
  }
  assert.equal(assessScore(expected, { ...observed, results: [{ ...observed.results[0]!, output: { classification: "bug" } }] }, score).status, "failed")
  assert.equal(assessScore(expected, { ...observed, status: "error", results: [{ ...observed.results[0]!, status: "error" }] }, score).status, "error")
})

test("authored evals include their task, and retained failures remain valid JSON", () => {
  const input = { sourceRevision: "a".repeat(40), event: { source: "smithers-cloud", type: "issues", action: "opened", deliveryKey: "case-1",
    payload: { issue: { title: "What greeting is exported?", body: "Inspect greeting.mjs" } } },
    assertions: [{ path: "/results/0/output/classification", equals: "question" }] }
  assert.doesNotThrow(() => Schema.decodeUnknownSync(SuggestedCaseInput)(input))
  assert.throws(() => Schema.decodeUnknownSync(SuggestedCaseInput)({ ...input, event: { ...input.event, payload: {} } }))
  assert.throws(() => Schema.decodeUnknownSync(SuggestedCaseInput)({ ...input, assertions: [{ path: "/results/0/output/greeting", equals: "hello" }] }))
  const failure = new CodingError({ code: "invalid_receipt", message: "A source citation was not captured" })
  assert.deepEqual(Schema.decodeUnknownSync(Schema.Json)(retainedStepError(failure)), {
    _tag: "coding/Error", code: "invalid_receipt", message: "A source citation was not captured" })
  assert.deepEqual(Schema.decodeUnknownSync(Schema.Json)(retainedStepError(new Error("Process unavailable"))), { message: "Process unavailable" })
  assert.doesNotThrow(() => Schema.decodeUnknownSync(Schema.Json)(retainedStepError(undefined)))
})
