import assert from "node:assert/strict"
import { test } from "node:test"
import { Schema } from "effect"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { assessScore, evaluatedCandidate } from "../repository/evaluation.ts"
import { candidateFiles } from "../repository/setup.ts"
import { JobInput, SetupInput, type JobResult } from "../repository/schema.ts"

const heldOut = "HELD_OUT_EXPECTATION: cite greeting.mjs and identify hello"
const sourceRevision = "a".repeat(40)
const event = { source: "smithers-cloud", type: "issues", action: "opened", deliveryKey: "held-out", issueNumber: 4,
  payload: { issue: { number: 4, title: "What greeting is exported?", body: "Inspect greeting.mjs" } } }
const caseInput = JSON.stringify({ sourceRevision, event,
  assertions: [{ path: "/results/0/output/classification", equals: "question" }] })
const held = (cases: boolean): SetupInput => {
  const setup = initialSetup("example/repo", "issues", "maintainer")
  setup.draft.cases = cases
    ? [{ id: "research", name: "Held-out question", input: caseInput, expected: heldOut, source: "issue:4", required: true }]
    : []
  return Schema.decodeUnknownSync(SetupInput)({ requestId: "setup-request", repo: setup.repo, job: setup.job,
    operation: "evaluate", revision: setup.revision, digest: setupCandidate(setup), draft: setup.draft })
}
const observedQuestion = (classification: string): JobResult => ({ repo: "example/repo", job: "issues", revision: 1,
  digest: "e".repeat(64), sourceRevision, eventKey: "held-out", status: "completed", publicActions: [],
  results: [{ stepId: "research", status: "completed", summary: "The exported greeting is hello.",
    evidence: ["source:greeting.mjs@0123"], output: { classification, summary: "The exported greeting is hello." },
    executionId: "actual-research" }] })
const score = { verdict: "pass" as const, reason: "The recorded result classifies a question and cites the greeting.", evidenceIds: [1] }

test("the committed candidate keeps each public test definition and never its held-out answer", () => {
  const input = held(true), files = candidateFiles(input)
  for (const [name, contents] of Object.entries(files)) assert(!contents.includes("HELD_OUT_EXPECTATION"), `${name} retains the answer`)
  const definitions = [{ id: "research", name: "Held-out question", input: caseInput, required: true }]
  assert.deepEqual(JSON.parse(files["evals.json"]!), definitions)
  const candidate = JSON.parse(files["candidate.json"]!)
  assert.deepEqual(candidate.draft.cases, definitions)
  assert.equal(candidate.digest, input.digest)
  assert.deepEqual({ ...candidate.draft, cases: input.draft.cases }, JSON.parse(JSON.stringify(input.draft)))
  assert.equal(files["prompt-research.md"], input.draft.steps.find(step => step.id === "research")!.prompt + "\n")
  assert.deepEqual(candidateFiles(held(true)), files)
})

test("a draft with no cases materialises the same bytes as before the split", () => {
  const input = held(false), files = candidateFiles(input)
  assert.equal(files["candidate.json"], JSON.stringify({ repo: input.repo, job: input.job, revision: input.revision,
    digest: input.digest, draft: input.draft }, null, 2) + "\n")
  assert.equal(files["evals.json"], "[]\n")
})

test("the evaluated job receives no case material and still verifies the configuration it carries", () => {
  const input = held(true), candidate = evaluatedCandidate(input)
  const job = Schema.decodeUnknownSync(JobInput)({ ...candidate, sourceRevision, event: { ...event, deliveryKey: "eval-key" } })
  assert(!JSON.stringify(job).includes("HELD_OUT_EXPECTATION"))
  assert.deepEqual(job.configuration.cases, [])
  assert.deepEqual({ ...job.configuration, cases: input.draft.cases }, input.draft)
  assert.equal(input.digest, "6a35b1cf11f6f740821c48bc4055c5e14f30963bdffea204005aad62e61f05e1")
  assert.equal(job.digest, "eaa65868ff1b8e731c14d789e16b27f980d92492601fca521d9a4534a9b3194f")
  assert.doesNotThrow(() => Schema.decodeUnknownSync(JobInput)({ repo: input.repo, job: input.job, revision: input.revision,
    digest: input.digest, configuration: input.draft, sourceRevision, event: { ...event, deliveryKey: "live-key" } }))
})

test("the judge still decides the held-out case against the maintainer's original answer", () => {
  const input = held(true), test = input.draft.cases[0]!
  assert.equal(test.expected, heldOut)
  assert.equal(assessScore(test, observedQuestion("question"), score).status, "passed")
  assert.equal(assessScore(test, observedQuestion("bug"), score).status, "failed")
  assert.equal(assessScore(test, observedQuestion("question"), { ...score, verdict: "fail" }).status, "failed")
})
