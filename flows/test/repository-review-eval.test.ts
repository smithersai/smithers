import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, FileSystem, Layer, Schema } from "effect"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import type { ImmutableSourceOptions } from "../coding/immutable-source.ts"
import { CodingError } from "../coding/schema.ts"
import { CaptureChecks, checkLayers, RetainSemantic, reviewCheck, RunChecks, verifyTrialChecks, type CheckOutput, type SemanticVerdict } from "../repository/checks.ts"
import { assessScore } from "../repository/evaluation.ts"
import type { Work } from "../repository/jobs.ts"
import type { Check, EvalCase, JobResult, Step, StepResult } from "../repository/schema.ts"

const base = "fb8c7b08f0d0feb5887cabbec5650e28dae2e6c1", candidate = "989b1f1c0c4c153d3917d89de00f2caee95292d0"
const treeId = "2c9d4b3a17f6e5d0c8b7a69584736251f0e1d2c3"
const key = "899f48bc0a28af10ca78ffa4f5fdc13e87c8e29107ab907cfb122512f0bf2933"
const readme = "# Canary sandbox\n\nOpen this repository in Smithers.\nReview changes in the cloud before landing.\n"
const diff = `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,4 @@\n # Canary sandbox\n \n+Open this repository in Smithers.\n+Review changes in the cloud before landing.\n`
const refused = "The production flow did not complete its evaluated work"

/** A two-commit repository whose candidate changes one documented file. The
 * exporter and the merge-base query stand in for the host's own binaries. */
const fixture = async (t: TestContext) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "review-eval-")))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo"), bin = join(temporary, "bin")
  await mkdir(root, { recursive: true })
  await mkdir(bin, { recursive: true })
  await writeFile(join(root, "README.md"), readme)
  const exporter = join(bin, "export")
  await writeFile(exporter, `#!/bin/sh\nout="$3/tree"\nmkdir -p "$out"\ncat > "$out/README.md" <<'SOURCE'\n${readme}SOURCE\nprintf '{"commitId":"%s","changeId":"reviewcandidate","treeId":"${treeId}","path":"%s","fileCount":1}\\n' "$2" "$out"\n`)
  await writeFile(join(bin, "jj"), `#!/bin/sh\nprintf '${base}\\n'\n`)
  await chmod(exporter, 0o755)
  await chmod(join(bin, "jj"), 0o755)
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  return { options: { repositoryPath: root, fs, exporterPath: exporter, environment: { PATH: `${bin}:/usr/bin:/bin` } } }
}

/** Both steps and both prompts are the reviewed draft of the production
 * registration in `.artifacts/mvp-canary-walk-20260917/B-23-state-review-evals.json`. */
const step: typeof Step.Type = { id: "review", name: "Review changes", mode: "approved",
  prompt: "Review the actual proposed revision and compare with the correct base. Report concrete findings with code evidence. Do not invent findings for a clean change. Update existing feedback after new commits." }
const followup: typeof Step.Type = { id: "followup", name: "Review new commits", mode: "approved",
  prompt: "Review material updates to the same PR. Recheck prior findings and avoid duplicate comments." }
/** The exact Work RunSteps builds for a review step: the reviewed draft configures
 * no checks, and an evaluation inherits no CI policy, so the step's own review
 * check is the only one it runs. The event is the frozen case's own event. */
const reviewWork: typeof Work.Type = { repo: "example/repo", job: "review", step, checks: [reviewCheck(step)],
  landing: "ask", replies: "draft", executionMode: "evaluation", deadlineAt: Date.now() + 120_000,
  event: { source: "github", type: "pull_request", action: "opened", deliveryKey: key,
    payload: { pull_request: { title: "Canary: read-only repository summary",
      body: "Durable production fixture. The Multi concierge should mention this open pull request in its repository update.",
      base: { sha: base }, head: { sha: candidate } } } },
  evidence: { repo: "example/repo", source: { changeId: "reviewcandidate", commitId: candidate, treeId, operationId: "operation", parentCommitIds: [base] },
    files: [], missing: [], history: [], records: [], sources: [] } }
const workFor = (value: typeof Step.Type, configured: readonly (typeof Check.Type)[] = []): typeof Work.Type =>
  ({ ...reviewWork, step: value, checks: [reviewCheck(value), ...configured] })

/** The production check step runs for real; only the checker's verdict is
 * scripted, and null stands for a checker execution that never finished. */
const runReviewStep = (options: ImmutableSourceOptions, verdict: typeof SemanticVerdict.Type | null, work = reviewWork) => {
  const handlers = new Map<string, (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }>()
  const runtime = {
    register: (declared: { _tag: string }, action: (payload: unknown) => { execute: Effect.Effect<unknown, unknown, never> }) =>
      Effect.sync(() => handlers.set(declared._tag, action)),
    execute: (flow: { _tag: string }, request: { executionId: string; payload: { plan: unknown; check: unknown; comparison: unknown } }) => {
      if (flow._tag !== "repository/AICheck") return Effect.die(`unexpected child flow ${flow._tag}`)
      if (!verdict) return Effect.fail(new CodingError({ code: "execution", message: "The checker execution was lost" }))
      return handlers.get(RetainSemantic.name)!(Schema.decodeUnknownSync(RetainSemantic.payloadSchema)({
        plan: request.payload.plan, check: request.payload.check, comparison: request.payload.comparison, verdict
      })).execute.pipe(Effect.provideService(FlowRuntime.FlowInstance, { executionId: request.executionId } as never))
    }
  }
  return Effect.gen(function*() {
    yield* Layer.build(checkLayers(options).pipe(Layer.provide([Layer.succeed(FlowRuntime.FlowRuntime, runtime as never), Action.layerImplementations])))
    const plan = yield* handlers.get(CaptureChecks.name)!(Schema.decodeUnknownSync(CaptureChecks.payloadSchema)({ work })).execute
    return (yield* handlers.get(RunChecks.name)!(Schema.decodeUnknownSync(RunChecks.payloadSchema)(plan)).execute.pipe(
      Effect.provideService(FlowRuntime.FlowInstance, { executionId: `step-${work.step.id}` } as never))) as typeof StepResult.Type
  }).pipe(Effect.scoped, Effect.provideService(FlowRuntime.FlowRuntime, runtime as never),
    Effect.provide([Jj.layerNoop({ diff: () => Effect.succeed(diff) }), NodeServices.layer]))
}

const observed = (...results: readonly (typeof StepResult.Type)[]): JobResult => ({ repo: "example/repo", job: "review", revision: 3,
  digest: "b".repeat(64), sourceRevision: candidate, eventKey: key, publicActions: [], results,
  status: results.some(result => result.status === "error") ? "partial" : "completed" })
/** The frozen production case, verbatim from the receipt named above: both of
 * its assertions, its event payload and its expected text. Only the redacted
 * delivery key is this fixture's own. */
const heldOut: typeof EvalCase.Type = { id: "review-open-canary-pr", name: "Review the open canary summary PR against its base",
  required: true,
  expected: "The review step runs on the open pull request 'Canary: read-only repository summary' and compares the head revision against the correct base. The repository is a documentation-only canary fixture whose README describes opening the repo in Smithers, requesting a small change via Chat, and reviewing changes in the cloud before landing. A correct run grounds every finding in the actual changed files: it reports concrete findings with code evidence if the diff introduces a problem, and explicitly reports no findings for a clean change rather than inventing issues. It must not modify files, and its summary identifies what was reviewed and the verdict reached.",
  input: JSON.stringify({ event: reviewWork.event, sourceRevision: candidate,
    assertions: [{ path: "/results/0/stepId", equals: "review" }, { path: "/results/0/status", equals: "completed" }] }) }
const score = { verdict: "pass" as const, reason: "The review reports what the diff actually changes.", evidenceIds: [0] }
const inconclusive: typeof SemanticVerdict.Type = { verdict: "uncertain",
  summary: "The supplied diff does not carry earlier commits to recheck.", examinedPaths: ["README.md"], findings: [] }
const clean: typeof SemanticVerdict.Type = { verdict: "pass", summary: "The change only updates documentation.", examinedPaths: ["README.md"], findings: [] }
const reported: typeof SemanticVerdict.Type = { verdict: "fail", summary: "The summary claims a feature the diff does not add.",
  examinedPaths: ["README.md"], findings: [{ path: "README.md", line: 3, message: "Unsupported claim" }] }

test("the frozen production case is scored on the review's substance, whatever the review concluded", async t => {
  const f = await fixture(t)
  for (const verdict of [clean, reported, inconclusive]) {
    const result = await Effect.runPromise(runReviewStep(f.options, verdict))
    assert.equal(result.status, "completed", `a review that ran completes its step: ${verdict.verdict}`)
    assert.equal((result.output as typeof CheckOutput.Type).gate, "passed")
    const assessment = assessScore(heldOut, observed(result), score)
    assert.equal(assessment.status, "passed", assessment.observed)
    assert.equal(assessment.observed, score.reason)
    assert.equal(assessScore(heldOut, observed(result), { ...score, verdict: "fail" }).status, "failed")
  }
})

test("the frozen case passes whichever of the draft's two steps could not conclude", async t => {
  const f = await fixture(t)
  const reviewed = await Effect.runPromise(runReviewStep(f.options, inconclusive))
  const second = await Effect.runPromise(runReviewStep(f.options, clean, workFor(followup)))
  assert.equal(second.stepId, "followup")
  assert.equal(assessScore(heldOut, observed(reviewed, second), score).status, "passed")
  const other = await Effect.runPromise(runReviewStep(f.options, inconclusive, workFor(followup)))
  const first = await Effect.runPromise(runReviewStep(f.options, clean))
  assert.equal(assessScore(heldOut, observed(first, other), score).status, "passed")
})

test("a review trial that reports grounded findings verifies its own check", async t => {
  const f = await fixture(t)
  const result = await Effect.runPromise(runReviewStep(f.options, reported))
  assert.doesNotThrow(() => verifyTrialChecks({ checks: [], steps: [step, followup] }, observed(result)))
  const lost = await Effect.runPromise(runReviewStep(f.options, null))
  assert.throws(() => verifyTrialChecks({ checks: [], steps: [step, followup] }, observed(lost)), /unavailable or inconsistent/)
})

test("a checker that contradicts its findings or cites source it never captured stays an execution failure", async t => {
  const f = await fixture(t)
  const contradicted = await Effect.runPromise(runReviewStep(f.options, { ...clean, findings: reported.findings }))
  const first = assessScore(heldOut, observed(contradicted), score)
  assert.equal(first.status, "error", first.observed)
  assert.equal(first.observed, `${refused}: step review completed — The AI verdict contradicts its recorded findings`)
  const invented = await Effect.runPromise(runReviewStep(f.options, { ...reported, findings: [{ path: "README.md", line: 9000, message: "Unsupported claim" }] }))
  const second = assessScore(heldOut, observed(invented), score)
  assert.equal(second.status, "error", second.observed)
  assert.equal(second.observed, `${refused}: step review completed — The AI check cited source outside its captured evidence`)
})

test("an inconclusive maintainer check is still an unavailable execution", async t => {
  const f = await fixture(t)
  const configured: typeof Check.Type = { id: "coverage", name: "Coverage", kind: "ai", rule: "Every documented claim is supported.", paths: [], policy: "required" }
  const result = await Effect.runPromise(runReviewStep(f.options, inconclusive, workFor(step, [configured])))
  assert.equal(result.status, "error", "the maintainer's own required rule still blocks its gate")
  const assessment = assessScore(heldOut, observed(result), score)
  assert.equal(assessment.status, "error")
  assert.equal(assessment.observed, `${refused}: step review error — The AI check did not establish complete scope coverage`)
})

test("a review whose checker never finished still refuses, naming the step and why", async t => {
  const f = await fixture(t)
  const result = await Effect.runPromise(runReviewStep(f.options, null))
  const assessment = assessScore(heldOut, observed(result), score)
  assert.equal(assessment.status, "error")
  assert.equal(assessment.observed, `${refused}: step review completed — The check could not finish; inspect its execution`)
})

test("a review receipt that contradicts its gate or names another source stays an execution failure", async t => {
  const f = await fixture(t)
  const result = await Effect.runPromise(runReviewStep(f.options, inconclusive))
  const output = result.output as typeof CheckOutput.Type
  const contradicted = assessScore(heldOut, observed({ ...result,
    output: JSON.parse(JSON.stringify({ ...output, gate: "blocked" })) }), score)
  assert.equal(contradicted.status, "error", "a contradictory recorded gate is not a reviewed verdict")
  assert.ok(contradicted.observed.startsWith(`${refused}: step review completed`), contradicted.observed)
  const elsewhere = assessScore(heldOut, { ...observed(result), sourceRevision: "c".repeat(40) }, score)
  assert.equal(elsewhere.status, "error")
  assert.equal(elsewhere.observed, `${refused}: step review completed — The recorded check names another source` +
    ` (the case's pinned commit ${candidate.slice(0, 12)} was not held by this workspace; scored against cccccccccccc)`)
})
