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
import { CaptureChecks, checkLayers, RetainSemantic, reviewCheck, RunChecks, type CheckOutput, type SemanticVerdict } from "../repository/checks.ts"
import { assessScore } from "../repository/evaluation.ts"
import type { Work } from "../repository/jobs.ts"
import type { EvalCase, JobResult, StepResult } from "../repository/schema.ts"

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

const step = { id: "review", name: "Review changes", mode: "approved" as const,
  prompt: "Review the actual proposed revision and compare with the correct base. Report concrete findings with code evidence." }
/** The exact Work RunSteps builds for a review step: the reviewed draft configures
 * no checks, so the step's own review check is the only one it runs. */
const reviewWork: typeof Work.Type = { repo: "example/repo", job: "review", step, checks: [reviewCheck(step)],
  landing: "ask", replies: "draft", executionMode: "evaluation", deadlineAt: Date.now() + 120_000,
  event: { source: "github", type: "pull_request", action: "opened", deliveryKey: key,
    payload: { pull_request: { base: { sha: base }, head: { sha: candidate } } } },
  evidence: { repo: "example/repo", source: { changeId: "reviewcandidate", commitId: candidate, treeId, operationId: "operation", parentCommitIds: [base] },
    files: [], missing: [], history: [], records: [], sources: [] } }

/** The production check step runs for real; only the checker's verdict is
 * scripted, and null stands for a checker execution that never finished. */
const runReviewStep = (options: ImmutableSourceOptions, verdict: typeof SemanticVerdict.Type | null) => {
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
    const plan = yield* handlers.get(CaptureChecks.name)!(Schema.decodeUnknownSync(CaptureChecks.payloadSchema)({ work: reviewWork })).execute
    return (yield* handlers.get(RunChecks.name)!(Schema.decodeUnknownSync(RunChecks.payloadSchema)(plan)).execute.pipe(
      Effect.provideService(FlowRuntime.FlowInstance, { executionId: "review-step" } as never))) as typeof StepResult.Type
  }).pipe(Effect.scoped, Effect.provideService(FlowRuntime.FlowRuntime, runtime as never),
    Effect.provide([Jj.layerNoop({ diff: () => Effect.succeed(diff) }), NodeServices.layer]))
}

const observed = (result: typeof StepResult.Type): JobResult => ({ repo: "example/repo", job: "review", revision: 3,
  digest: "b".repeat(64), sourceRevision: candidate, eventKey: key, publicActions: [], results: [result],
  status: result.status === "error" ? "partial" : "completed" })
const heldOut: typeof EvalCase.Type = { id: "review-open-canary-pr", name: "Review the open canary PR against its base",
  required: true, expected: "The review step compares the head revision against the correct base and reports what it found.",
  input: JSON.stringify({ event: reviewWork.event, sourceRevision: candidate,
    assertions: [{ path: "/results/0/stepId", equals: "review" }] }) }
const score = { verdict: "pass" as const, reason: "The review reports what the diff actually changes.", evidenceIds: [0] }

test("a review the checker could not establish is judged on its substance", async t => {
  const f = await fixture(t)
  const result = await Effect.runPromise(runReviewStep(f.options,
    { verdict: "uncertain", summary: "The supplied diff does not carry earlier commits to recheck.", examinedPaths: ["README.md"], findings: [] }))
  assert.equal(result.status, "error", "an inconclusive required review still blocks its own gate")
  const assessment = assessScore(heldOut, observed(result), score)
  assert.equal(assessment.status, "passed")
  assert.equal(assessment.observed, score.reason)
})

test("a clean review and a review with findings are both judged, never refused", async t => {
  const f = await fixture(t)
  const clean = await Effect.runPromise(runReviewStep(f.options,
    { verdict: "pass", summary: "The change only updates documentation.", examinedPaths: ["README.md"], findings: [] }))
  assert.equal(clean.status, "completed")
  assert.equal(assessScore(heldOut, observed(clean), score).status, "passed")
  const finding = await Effect.runPromise(runReviewStep(f.options,
    { verdict: "fail", summary: "The summary claims a feature the diff does not add.", examinedPaths: ["README.md"],
      findings: [{ path: "README.md", line: 3, message: "Unsupported claim" }] }))
  assert.equal(assessScore(heldOut, observed(finding), score).status, "passed")
  assert.equal(assessScore(heldOut, observed(finding), { ...score, verdict: "fail" }).status, "failed")
})

test("a review whose checker never finished still refuses, naming the step and why", async t => {
  const f = await fixture(t)
  const result = await Effect.runPromise(runReviewStep(f.options, null))
  const assessment = assessScore(heldOut, observed(result), score)
  assert.equal(assessment.status, "error")
  assert.equal(assessment.observed, `${refused}: step review error — The check could not finish; inspect its execution`)
})

test("a review receipt that contradicts its gate or names another source stays an execution failure", async t => {
  const f = await fixture(t)
  const result = await Effect.runPromise(runReviewStep(f.options,
    { verdict: "uncertain", summary: "The rule cannot be evaluated here.", examinedPaths: ["README.md"], findings: [] }))
  const output = result.output as typeof CheckOutput.Type
  const contradicted = assessScore(heldOut, observed({ ...result, status: "completed",
    output: JSON.parse(JSON.stringify({ ...output, gate: "passed" })) }), score)
  assert.equal(contradicted.status, "error", "a contradictory recorded gate is not a reviewed verdict")
  assert.ok(contradicted.observed.startsWith(`${refused}: step review completed`), contradicted.observed)
  const elsewhere = assessScore(heldOut, { ...observed(result), sourceRevision: "c".repeat(40) }, score)
  assert.equal(elsewhere.status, "error")
  assert.equal(elsewhere.observed, `${refused}: step review error — The recorded check names another source`)
})
