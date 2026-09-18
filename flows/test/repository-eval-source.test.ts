import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, FileSystem, Layer, ManagedRuntime, Schema } from "effect"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { NativeCoding, type NativeRevision } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { Evaluate, evaluationLayers, ScoreCase } from "../repository/evaluation.ts"
import { CaptureRepository, captureRepository } from "../repository/inspection.ts"
import { FinishJob, Investigate, RunSteps } from "../repository/jobs.ts"
import { SetupInput, type JobResult, type RepositoryEvidence } from "../repository/schema.ts"

const exporter = process.env.PLUE_JJ_EXPORT_BINARY
const gate = { skip: exporter === undefined ? "Set PLUE_JJ_EXPORT_BINARY to the native source exporter" : false, timeout: 120_000 }
const RunEvaluate = Flow.make("test/RunEvaluate", { payload: Evaluate.payloadSchema, success: Evaluate.successSchema,
  error: CodingError, body: input => Evaluate.call(input) })
const short = (id: string) => id.slice(0, 12)
/** A commit id no repository in this fixture holds; its lookup is the blind one. */
const unreachable = "a".repeat(40)
const judged = "The recorded result answers from the captured README."

/** One repository host, plus a commit id that only a replaced workspace ever held. */
async function fixture(t: TestContext, mode: "snapshot" | "immutable") {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "repository-eval-source-")))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = join(temporary, "repo"), replaced = join(temporary, "replaced"), blind = join(temporary, "blind")
  for (const path of [root, replaced]) {
    execFileSync("jj", ["git", "init", path], { stdio: "pipe" })
    execFileSync("jj", ["-R", path, "config", "set", "--repo", "user.name", "Eval source test"], { stdio: "pipe" })
    execFileSync("jj", ["-R", path, "config", "set", "--repo", "user.email", "eval-source@example.invalid"], { stdio: "pipe" })
  }
  // A jj that exits non-zero is a lookup that could not answer, never a proven absence.
  await mkdir(blind)
  await writeFile(join(blind, "jj"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  const jj = (path: string, ...args: string[]) => execFileSync("jj", ["-R", path, ...args], { stdio: "pipe" }).toString()
  const commit = (path: string) => jj(path, "log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "commit_id").trim()
  await writeFile(join(root, "README.md"), "# canary-sandbox\n\n## Purpose\nA disposable fixture.\n")
  jj(root, "status")
  const pinned = commit(root)
  await writeFile(join(root, "README.md"), "# canary-sandbox\n\n## Purpose\nA disposable fixture for testing Smithers in production.\n")
  jj(root, "status")
  await writeFile(join(replaced, "README.md"), "# another workspace\n")
  jj(replaced, "status")
  const stranger = commit(replaced)
  const at = () => JSON.parse(jj(root, "--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id as string
  const revision = (): Extract<NativeRevision, { kind: "resolved" }> => {
    const value = JSON.parse(jj(root, "--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "json(self)"))
    const tree = JSON.parse(execFileSync(exporter!, [root, value.commit_id, temporary], { stdio: "pipe" }).toString())
    return { kind: "resolved", changeId: tree.changeId, commitId: tree.commitId, treeId: tree.treeId, operationId: at(), parentCommitIds: value.parents }
  }
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const options = { repositoryPath: root, fs, exporterPath: exporter, environment: { PATH: process.env.PATH!, HOME: temporary } }
  const native: NativeCoding["Service"] = { sourcePublication: "cloud",
    read: () => Effect.sync(() => ({ status: "read" as const, operationId: at(), head: revision(), revisions: [], capabilities: [] })),
    apply: () => Effect.die("editing mutations are forbidden"), publishOriginalSource: () => Effect.die("unexpected publication"),
    createSource: () => Effect.die("unexpected source creation") }
  // Immutable capture never snapshots, so every other jj method fails by default.
  const snapshots: string[] = []
  const owned = Layer.merge(Layer.succeed(NativeCoding, native), Jj.layerNoop({ snapshot: message =>
    Effect.sync(() => { snapshots.push(message ?? ""); return { changeId: commit(root) } }) }))
    .pipe(Layer.provideMerge(NodeServices.layer))
  return { root, pinned, stranger, options, owned, snapshots, mode,
    unanswerable: { ...options, environment: { ...options.environment, PATH: blind } } }
}

interface Case { readonly id: string; readonly sourceRevision: string; readonly event: Schema.Json }
const setupFor = (job: "issues" | "review" | "ci", cases: readonly Case[]): SetupInput => {
  const setup = initialSetup("example/repo", job, "maintainer")
  setup.draft.cases = cases.map(test => ({ id: test.id, name: test.id, required: true,
    expected: "The investigation answers from the captured README.",
    input: JSON.stringify({ event: test.event, sourceRevision: test.sourceRevision,
      assertions: [{ path: "/results/0/output/classification", equals: "question" }] }) }))
  return Schema.decodeUnknownSync(SetupInput)({ requestId: "eval-source", repo: setup.repo, job: setup.job,
    operation: "evaluate", revision: setup.revision, digest: setupCandidate(setup), draft: setup.draft })
}
const json = (value: unknown) => value as Schema.Json
const issueEvent = json({ source: "smithers-cloud", type: "issues", action: "opened", deliveryKey: "seed", issueNumber: 53,
  payload: { issue: { title: "What is this repository for?", body: "The README is short. A cited answer is enough." } } })
const reviewEvent = json({ source: "github", type: "pull_request", action: "opened", deliveryKey: "seed",
  payload: { pull_request: { title: "Change the greeting", body: "Inspect README.md", base: { sha: "b".repeat(40) }, head: { sha: "c".repeat(40) } } } })
const ciEvent = json({ source: "smithers-cloud", type: "manual", action: "manual:checks", manualStep: "checks", deliveryKey: "seed",
  payload: { prompt: "Run the repository checks" } })

/** The production wiring is `"snapshot"`; `"immutable"` is the captured-source path. */
async function harness(t: TestContext, mode: "snapshot" | "immutable") {
  const f = await fixture(t, mode), captured: string[] = [], executed: string[] = [], refused = new Set<string>()
  const runtime = ManagedRuntime.make(Layer.mergeAll(evaluationLayers, Interpreter.layer(Investigate), Interpreter.layer(RunEvaluate),
    CaptureRepository.toLayer(input => {
      if (input.sourceRevision !== undefined) captured.push(input.sourceRevision)
      return input.sourceRevision !== undefined && refused.has(input.sourceRevision)
        ? Effect.fail(new CodingError({ code: "stale_revision", message: "Source changed during repository inspection; retry" }))
        : captureRepository(input.sourceRevision === unreachable ? f.unanswerable : f.options, input, mode)
    }),
    RunSteps.toLayer(({ input }) => Effect.sync(() => { executed.push(input.sourceRevision)
      return { [input.configuration.steps[0]!.id]: { stepId: input.configuration.steps[0]!.id,
        status: "completed" as const, summary: "The README states the purpose.", evidence: [`source:${input.sourceRevision}`],
        output: json({ classification: "question" }), executionId: `${input.event.deliveryKey}-step` } }
    })),
    FinishJob.toLayer(({ input, results }) => Effect.succeed({ repo: input.repo, job: input.job, revision: input.revision,
      digest: input.digest, sourceRevision: input.sourceRevision, eventKey: input.event.deliveryKey, status: "completed" as const,
      results: Object.values(results), publicActions: [] } satisfies JobResult)),
    ScoreCase.toLayer(() => Effect.succeed({ verdict: "pass" as const, reason: judged, evidenceIds: [1] }))
  ).pipe(Layer.provide(f.owned), Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeServices.layer)))
  t.after(() => runtime.dispose())
  const evidence: RepositoryEvidence = await Effect.runPromise(captureRepository(f.options, { repo: "example/repo", prompt: "README.md" }, mode)
    .pipe(Effect.provide(f.owned)))
  assert.equal(f.snapshots.length > 0, mode === "snapshot", "only snapshot capture snapshots the working copy")
  const evaluate = (job: "issues" | "review" | "ci", cases: readonly Case[], executionId: string) =>
    runtime.runPromise(RunEvaluate.execute({ setup: setupFor(job, cases), evidence, deadlineAt: Date.now() + 120_000 },
      { executionId }).pipe(Effect.scoped), { signal: t.signal })
  const capture = (payload: typeof CaptureRepository.payloadSchema.Type, options = f.options) =>
    Effect.runPromise(captureRepository(options, payload, mode).pipe(Effect.provide(f.owned), Effect.result))
  return { ...f, captured, executed, refused, evidence, evaluate, capture }
}

for (const mode of ["immutable", "snapshot"] as const) {
test(`a held-out case pinned to a commit this host never held still executes and names the substitution, and a real capture failure names its cause (${mode})`, gate, async t => {
  const f = await harness(t, mode), evidence = f.evidence

  const replaced = await f.evaluate("issues", [{ id: "readme-purpose-question", sourceRevision: f.stranger, event: issueEvent }], "issues-replaced-workspace")
  assert.equal(replaced[0]!.status, "passed", `a case authored in a replaced workspace still runs: ${replaced[0]!.observed}`)
  assert.deepEqual(replaced[0]!.evidence, [`source:${evidence.source.commitId}`], "it runs on the source this host captured")
  assert.equal(replaced[0]!.observed,
    `${judged} (the case's pinned commit ${short(f.stranger)} was not held by this workspace; scored against ${short(evidence.source.commitId)})`,
    "the substituted source is named in the row")

  const held = await f.evaluate("issues", [{ id: "readme-purpose-question", sourceRevision: f.pinned, event: issueEvent }], "issues-pinned")
  assert.equal(held[0]!.status, "passed", held[0]!.observed)
  assert.deepEqual(held[0]!.evidence, [`source:${f.pinned}`], "a pin this host still holds is captured and used")
  assert.equal(held[0]!.observed, judged, "a captured pin reports no substitution")

  for (const [job, event] of [["review", reviewEvent], ["ci", ciEvent]] as const) {
    const current = await f.evaluate(job, [{ id: `${job}-case`, sourceRevision: evidence.source.commitId, event }], `${job}-current`)
    assert.equal(current[0]!.status, "passed", current[0]!.observed)
    assert.deepEqual(current[0]!.evidence, [`source:${evidence.source.commitId}`], `${job} reuses the inspected evidence`)
  }

  f.refused.add(f.pinned)
  const broken = await f.evaluate("issues", [{ id: "readme-purpose-question", sourceRevision: f.pinned, event: issueEvent }], "issues-capture-failed")
  assert.equal(broken[0]!.status, "error")
  assert.equal(broken[0]!.observed,
    "The held-out source commit could not be captured: stale_revision — Source changed during repository inspection; retry")
  assert.ok(f.captured.includes(f.pinned), "the held pin reaches the capture")

  const fallback = await f.capture({ repo: "example/repo", prompt: "README.md", sourceRevision: f.stranger, heldOut: true })
  assert.equal(fallback._tag, "Success")
  assert.equal(fallback._tag === "Success" ? fallback.success.source.commitId : "", evidence.source.commitId)
  const required = await f.capture({ repo: "example/repo", prompt: "README.md", sourceRevision: f.stranger })
  assert.equal(required._tag, "Failure", "a job's own source revision stays mandatory")
  assert.equal(required._tag === "Failure" ? required.failure.code : "", "invalid_receipt")
})

test(`a source lookup that cannot answer keeps its own fault class instead of substituting source (${mode})`, gate, async t => {
  const f = await harness(t, mode), ran = f.executed.length

  const unanswered = await f.evaluate("issues", [{ id: "readme-purpose-question", sourceRevision: unreachable, event: issueEvent }], "issues-lookup-unavailable")
  assert.equal(unanswered[0]!.status, "error", `a lookup that cannot answer is not a proven absence: ${unanswered[0]!.observed}`)
  assert.equal(unanswered[0]!.observed,
    "The held-out source commit could not be captured: source_unavailable — The native source lookup could not complete")
  assert.equal(f.executed.length, ran, "the case never runs against substituted source when its lookup failed")

  const blind = await f.capture({ repo: "example/repo", prompt: "README.md", sourceRevision: unreachable, heldOut: true }, f.unanswerable)
  assert.equal(blind._tag, "Failure", "a lookup that cannot answer never substitutes source")
  assert.equal(blind._tag === "Failure" ? blind.failure.code : "", "source_unavailable")
  const malformed = await f.capture({ repo: "example/repo", prompt: "README.md", sourceRevision: "the-commit-i-remember", heldOut: true })
  assert.equal(malformed._tag, "Failure", "a malformed pin keeps its own refusal")
  assert.equal(malformed._tag === "Failure" ? malformed.failure.code : "", "source_refused")
})
}
