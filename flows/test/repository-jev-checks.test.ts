import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import * as Digest from "@smthrs/core/Digest"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Action } from "@smthrs/flow"
import { FlowEngine } from "@smthrs/engine"
import { Effect, FileSystem, Layer, ManagedRuntime, Schema } from "effect"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { AICheck, checkLayers, SemanticCheck, verifyTrialChecks, type CheckOutput, type CheckPlan, type CheckResult, type Comparison, type SemanticVerdict } from "../repository/checks.ts"
import { batches, evaluatorLayer, hunks, jevSemanticCheck, MAX_STATES } from "../repository/jev-checks.ts"
import type { CheckContext } from "../repository/check-context.ts"
import type { Work } from "../repository/jobs.ts"
import type { Check, Draft, JobResult, StepResult } from "../repository/schema.ts"

const base = "a".repeat(40), candidate = "b".repeat(40)
const lines = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `const ${prefix}${index + 1} = ${index + 1}`).join("\n") + "\n"
const sourceA = lines(30, "a"), sourceB = lines(12, "b")

/** Two files, three hunks: one at the top of a.ts, one deeper in a.ts, one in b.ts. */
const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a1 = 1
+const added = 2
 const a2 = 2
 const a3 = 3
 const a4 = 4
@@ -20,3 +21,4 @@ context
 const a20 = 20
 const a21 = 21
+const twelfth = 12
 const a22 = 22
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -7,2 +7,3 @@
 const b7 = 7
+const beta = 2
 const b8 = 8
`

const comparison: typeof Comparison.Type = { base, candidate, diff, paths: ["src/a.ts", "src/b.ts"],
  files: [{ path: "src/a.ts", text: sourceA, digest: Digest.digest(sourceA), truncated: false },
    { path: "src/b.ts", text: sourceB, digest: Digest.digest(sourceB), truncated: false }],
  changes: [{ path: "src/a.ts", before: "old", after: sourceA }, { path: "src/b.ts", before: "old", after: sourceB }] }

const rule = "Every exported constant carries a unit in its name"
const check: typeof Check.Type = { id: "units", name: "Units", kind: "ai", rule, paths: ["src/**"], policy: "required" }

const context: CheckContext = { checkId: check.id, source: candidate,
  files: comparison.files,
  reads: comparison.files.map(file => ({ path: file.path, from: file.path, reason: "source" as const, required: true, status: "read" as const, digest: file.digest })) }

const work: typeof Work.Type = { repo: "example/repo", job: "ci",
  step: { id: "checks", name: "Checks", mode: "automatic", prompt: "Run configured checks" },
  checks: [check], landing: "ask", replies: "draft", executionMode: "live", deadlineAt: Date.now() + 120_000,
  event: { source: "github", type: "pull_request", action: "opened", deliveryKey: "event-1",
    payload: { pull_request: { base: { sha: base }, head: { sha: candidate } } } },
  evidence: { repo: "example/repo", source: { commitId: candidate, treeId: "c".repeat(40), changeId: "d".repeat(32), parentCommitIds: [base], operationId: "e".repeat(32) },
    files: [], missing: [], history: [], records: [], sources: [] } }
const plan: typeof CheckPlan.Type = { work, comparison, contexts: [context] }

test("hunk extraction reports every changed hunk and its first candidate line", () => {
  assert.deepEqual(hunks(comparison).map(hunk => ({ path: hunk.path, line: hunk.line })), [
    { path: "src/a.ts", line: 2 }, { path: "src/a.ts", line: 23 }, { path: "src/b.ts", line: 8 }
  ])
  const [first, second, third] = hunks(comparison)
  assert.ok(first!.hunk.startsWith("@@ -1,4 +1,5 @@") && first!.hunk.includes("+const added = 2"))
  assert.ok(!first!.hunk.includes("twelfth"), "a hunk carries its own lines, not the next hunk's")
  assert.ok(second!.hunk.includes("+const twelfth = 12"))
  assert.ok(third!.hunk.startsWith("@@ -7,2 +7,3 @@") && !third!.hunk.includes("diff --git"))
  assert.deepEqual(hunks({ ...comparison, diff: "" }), [], "no diff is no hunk, never a silent clean sweep")
})

test("a batch carries at most 64 states and keeps every one", () => {
  const seventy = Array.from({ length: 70 }, (_, index) => index)
  assert.equal(MAX_STATES, 64)
  assert.deepEqual(batches(seventy).map(batch => batch.length), [64, 6])
  assert.deepEqual(batches(seventy).flat(), seventy)
  assert.deepEqual(batches([]), [])
})

test("seventy hunks are judged in two batches and every one is answered", async () => {
  const body = Array.from({ length: 70 }, (_, index) => `@@ -${index * 10 + 1},1 +${index * 10 + 1},2 @@\n const a${index * 10 + 1} = 1\n+const added${index} = ${index}`).join("\n")
  const many: typeof Comparison.Type = { ...comparison, paths: ["src/a.ts"], diff: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${body}\n` }
  assert.equal(hunks(many).length, 70)
  assert.deepEqual(batches(hunks(many)).map(batch => batch.length), [64, 6])
  let calls = 0
  const verdict = await Effect.runPromise(jevSemanticCheck(many, check).pipe(
    Effect.provide(Evaluator.layerScripted(() => { calls++; return { violates: { probability: 0.01 } } }))))
  assert.equal(calls, 70, "no hunk is dropped between the batches")
  assert.equal(verdict.verdict, "pass")
  assert.equal(verdict.summary, "Jev found no hunk violating Units")
  assert.deepEqual([...verdict.examinedPaths], ["src/a.ts"])
})

/** One AI check run end to end through the real `AICheck` flow, with a scripted
 * Jev and a scripted seat, so the branch under test is the deployed one. */
const runCheck = async (probability: (path: string, line: number) => number | undefined, evaluator?: Layer.Layer<Evaluator.Evaluator>) => {
  const asked: Array<string> = []
  const seat: Array<string> = []
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const scripted = evaluator ?? Evaluator.layerScripted(request => {
    const state = request.state as { path: string; line: number; rule: string; hunk: string }
    assert.equal(state.rule, rule, "Jev is asked the maintainer's own rule")
    assert.ok(state.hunk.startsWith("@@"), "Jev is asked about one hunk")
    asked.push(`${state.path}:${state.line}`)
    const value = probability(state.path, state.line)
    if (value === undefined) return Effect.fail(new Evaluator.EvaluatorError({ code: "refused", message: "scripted refusal" }))
    return { violates: { probability: value } }
  })
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    checkLayers({ repositoryPath: "/nonexistent", fs, evaluator: scripted }),
    SemanticCheck.toLayer(input => Effect.sync(() => {
      seat.push(input.check.id)
      return { verdict: "pass" as const, summary: "The seat read the whole comparison", examinedPaths: input.comparison.paths, findings: [] }
    }))
  ).pipe(Layer.provide(Jj.layerNoop({})), Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeServices.layer)))
  try {
    const result = await runtime.runPromise(AICheck.execute({ plan, check, comparison, context }, { executionId: "jev-check" }))
    return { result, asked, seat }
  } finally {
    await runtime.dispose()
  }
}

const verdictOf = (result: typeof CheckResult.Type) => Schema.decodeUnknownSync(Schema.Struct({
  verdict: Schema.String, summary: Schema.String, examinedPaths: Schema.Array(Schema.String),
  findings: Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.Int, message: Schema.String })),
  decidedBy: Schema.optionalKey(Schema.String)
}))(result.detail)

test("every hunk decisively clean is a pass Jev decides on its own", async () => {
  const { result, asked, seat } = await runCheck(() => 0.02)
  assert.equal(result.status, "passed")
  assert.deepEqual(asked, ["src/a.ts:2", "src/a.ts:23", "src/b.ts:8"])
  assert.deepEqual(seat, [], "a decisive pass spends no frontier call")
  const verdict = verdictOf(result)
  assert.equal(verdict.verdict, "pass")
  assert.equal(verdict.decidedBy, "jev")
  assert.deepEqual(verdict.findings, [])
  assert.deepEqual([...verdict.examinedPaths], ["src/a.ts", "src/b.ts"])
  assert.equal(verdict.summary, "Jev found no hunk violating Units")
})

test("one decisively violating hunk is a fail whose finding is the rule itself", async () => {
  const { result, seat } = await runCheck((path, line) => path === "src/a.ts" && line === 23 ? 0.95 : 0.02)
  assert.equal(result.status, "failed")
  assert.deepEqual(seat, [], "a decisive fail spends no frontier call")
  const verdict = verdictOf(result)
  assert.equal(verdict.verdict, "fail")
  assert.equal(verdict.decidedBy, "jev")
  assert.deepEqual([...verdict.findings], [{ path: "src/a.ts", line: 23, message: rule }])
  assert.equal(verdict.summary, "Jev flagged 1 of 3 hunks against Units")
})

test("an indecisive hunk is the only thing that spends the seat", async () => {
  const { result, asked, seat } = await runCheck((path, line) => path === "src/b.ts" && line === 8 ? 0.5 : 0.02)
  assert.equal(asked.length, 3, "Jev still judges every hunk before the seat is asked")
  assert.deepEqual(seat, [check.id])
  const verdict = verdictOf(result)
  assert.equal(result.status, "passed")
  assert.equal(verdict.summary, "The seat read the whole comparison")
  assert.equal(verdict.decidedBy, "seat")
})

test("a host with no gateway key asks the seat, exactly as before Jev", async () => {
  const { result, asked, seat } = await runCheck(() => 0.02, evaluatorLayer({}))
  assert.deepEqual(asked, [], "the scripted evaluator is not installed at all")
  assert.deepEqual(seat, [check.id])
  assert.equal(verdictOf(result).decidedBy, "seat")
  assert.equal(result.status, "passed")
})

test("a refused evaluation is indecisive, never a verdict", async () => {
  const { seat } = await runCheck(() => undefined)
  assert.deepEqual(seat, [check.id])
})

test("a Jev verdict satisfies the trial verifier the seat's verdict satisfies", async () => {
  const { result } = await runCheck(() => 0.02)
  const output: typeof CheckOutput.Type = { base, candidate, gate: "passed", results: [result] }
  const step: typeof StepResult.Type = { stepId: "checks", executionId: "step-checks", status: "completed",
    summary: "1 of 1 checks passed", evidence: [...result.evidence], output: JSON.parse(JSON.stringify(output)) }
  const configuration: Pick<typeof Draft.Type, "checks" | "steps"> = { checks: [check], steps: [work.step] }
  const job: typeof JobResult.Type = { repo: "example/repo", job: "ci", revision: 1, digest: "f".repeat(64),
    sourceRevision: candidate, eventKey: "event-1", publicActions: [], results: [step], status: "completed" }
  verifyTrialChecks(configuration, job)
  assert.equal(verdictOf(result).decidedBy, "jev", "the retained row records which model decided")
})
