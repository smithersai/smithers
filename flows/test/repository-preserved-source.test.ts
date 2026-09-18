import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, FileSystem, Layer, ManagedRuntime, Schema } from "effect"
import * as Snapshots from "../coding/snapshots.ts"
import { JobInput } from "../repository/schema.ts"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { composeCiChecks, inheritedCheckId, rawCheckId, readCiPolicy } from "../repository/ci-policy.ts"
import { Landing } from "../coding/landing.ts"
import { NativeCoding, NativeCodingError, SourceCreation, type CreateSource, type NativeRevision } from "../coding/native.ts"
import { changeAdmission, changeLayers, DraftChange, ProposalStep, selectChangeSource } from "../repository/changes.ts"
import { checkLayers, SemanticCheck } from "../repository/checks.ts"
import { deliveryLayers } from "../repository/delivery.ts"
import { captureJobSource } from "../repository/execution.ts"
import { captureRepository } from "../repository/inspection.ts"
import { type Work } from "../repository/jobs.ts"

const exporter = process.env.PLUE_JJ_EXPORT_BINARY, adapterSource = process.env.PLUE_CODING_ADAPTER_SOURCE
const gate = { skip: exporter === undefined || adapterSource === undefined ? "Set PLUE_JJ_EXPORT_BINARY and PLUE_CODING_ADAPTER_SOURCE to the native helper and adapter" : false, timeout: 90000 }
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
async function fixture(t: TestContext) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "preserved-source-"))), root = join(temporary, "repo")
  t.after(() => rm(temporary, { recursive: true, force: true }))
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Preserved source test")
  jj("config", "set", "--repo", "user.email", "preserved@example.invalid")
  await writeFile(join(root, "README.md"), "# Fixture\nThe implementation is code.txt.\n")
  await writeFile(join(root, "code.txt"), "original\n")
  jj("describe", "-m", "Public main")
  const main = jj("log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "commit_id").trim()
  jj("bookmark", "create", "main")
  // This is a fixed native receipt fixture for the TS composition test. The
  // actual creator, owner proof, races and transfer are tested by Rust's JJ suite.
  jj("new", "-m", "Checked candidate fixture")
  await writeFile(join(root, "code.txt"), "checked implementation\n")
  jj("status")
  const candidate = jj("log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "commit_id").trim()
  jj("new", main, "-m", "Saved repository setup")
  await mkdir(join(root, ".smithers", "repository-jobs", "issues"), { recursive: true })
  await mkdir(join(root, ".smithers", "flows", "repository-jobs"), { recursive: true })
  await writeFile(join(root, ".smithers", "repository-jobs", "issues", "prompt.md"), "saved prompt")
  await writeFile(join(root, ".smithers", "flows", "repository-jobs", "issues.md"), "saved flow")
  jj("status"); jj("new", "-m", "Editor descendant"); jj("bookmark", "create", "my-work")
  const at = () => JSON.parse(jj("--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "json(self)")).id as string
  const revision = (id: string): Extract<NativeRevision, { kind: "resolved" }> => {
    const commit = JSON.parse(jj("--ignore-working-copy", "log", "-r", id === "@" ? "@" : `commit_id("${id}")`, "--no-graph", "-T", "json(self)"))
    const tree = JSON.parse(execFileSync(exporter!, [root, commit.commit_id, temporary], { stdio: "pipe" }).toString())
    return { kind: "resolved", changeId: tree.changeId, commitId: tree.commitId, treeId: tree.treeId, operationId: at(), parentCommitIds: commit.parents }
  }
  const head = revision("@"), base = revision(main), child = revision(candidate)
  await writeFile(join(root, "code.txt"), "uncommitted editor bytes\n")
  await writeFile(join(root, ".smithers", "repository-jobs", "issues", "prompt.md"), "uncommitted prompt edit")
  const bookmarks = () => jj("--ignore-working-copy", "bookmark", "list", "--all-remotes")
  const before = { operation: at(), bookmarks: bookmarks() }
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const options = { repositoryPath: root, fs, exporterPath: exporter, environment: { PATH: process.env.PATH! } }
  const native: NativeCoding["Service"] = { sourcePublication: "cloud", read: () => Effect.sync(() => ({ status: "read" as const, operationId: at(),
    head: { ...head, operationId: at() }, revisions: [], capabilities: ["create-source/v1"] })),
    apply: () => Effect.die("editing mutations are forbidden"), publishOriginalSource: () => Effect.die("unexpected publication"),
    createSource: () => Effect.die("unexpected source creation") }
  const config = join(temporary, "binding.json"), reporter = join(temporary, "reporter"), adapter = join(temporary, "adapter.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "11111111-1111-4111-a111-111111111111", repositoryId: 3, actorId: 2, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(adapter, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(adapterSource)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)}, engine="--engine" in sys.argv)))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)
  const platform = Snapshots.layerAt({ repositoryPath: root, adapterPath: adapter }).pipe(Layer.provideMerge(NodeServices.layer))
  const owned = Layer.merge(platform, Layer.succeed(NativeCoding, native))
  const unchanged = async () => {
    assert.equal(at(), before.operation); assert.equal(bookmarks(), before.bookmarks)
    assert.equal(await readFile(join(root, "code.txt"), "utf8"), "uncommitted editor bytes\n")
    assert.equal(await readFile(join(root, ".smithers", "repository-jobs", "issues", "prompt.md"), "utf8"), "uncommitted prompt edit")
    assert.equal(await readFile(join(root, ".smithers", "flows", "repository-jobs", "issues.md"), "utf8"), "saved flow")
  }
  return { root, base, child, head, options, native, owned, platform, unchanged }
}

test("initial writable capture and main selection never snapshot dirty editor or saved setup assets", gate, async t => {
  const f = await fixture(t), setup = initialSetup("example/repo", "feature", "owner")
  const input = Schema.decodeUnknownSync(JobInput)({ repo: setup.repo, job: "feature" as const, revision: 1, digest: setupCandidate(setup), sourceRevision: f.head.commitId, configuration: setup.draft,
    event: { source: "smithers-cloud" as const, type: "manual", action: "manual:feature", manualStep: "feature", deliveryKey: "request", payload: { manual: { prompt: "Update code.txt" } } } })
  const evidence = await Effect.runPromise(captureJobSource(f.options, input).pipe(Effect.provide(f.owned), Effect.provideService(FlowRuntime.FlowInstance, { executionId: "initial-capture" } as FlowRuntime.FlowInstance["Service"])))
  assert.equal(evidence.source.commitId, f.head.commitId)
  assert.equal(evidence.files.find(file => file.path === "code.txt")?.text, "original\n")
  await f.unchanged()
  const work: typeof Work.Type = { repo: setup.repo, job: "feature", event: input.event, step: setup.draft.steps[0]!, evidence,
    checks: [], landing: "ask", replies: "draft", executionMode: "live", deadlineAt: Date.now() + 60000 }
  const landing: Landing["Service"] = { readMain: Effect.succeed(f.base.commitId), binding: { repositoryId: 3, workspaceId: "11111111-1111-4111-a111-111111111111" },
    prepare: () => Effect.die("no preparation"), create: () => Effect.die("no landing"), queue: () => Effect.die("no queue"), observe: () => Effect.die("no observation") }
  const selected = await Effect.runPromise(selectChangeSource(f.options, work).pipe(Effect.provide(f.owned), Effect.provideService(Landing, landing)))
  assert.equal(selected.blocked, ""); assert.equal(selected.work.evidence.source.commitId, f.base.commitId)
  assert.equal(selected.work.evidence.files.find(file => file.path === "code.txt")?.text, "original\n")
  const unavailable = await Effect.runPromise(selectChangeSource(f.options, work).pipe(Effect.provide(f.owned), Effect.provideService(Landing, { ...landing, readMain: Effect.succeed("f".repeat(40)) })))
  assert.ok(unavailable.blocked); assert.equal(unavailable.work, work)
  const trial = { ...work, executionMode: "trial" as const }
  assert.equal((await Effect.runPromise(selectChangeSource(f.options, trial).pipe(Effect.provide(f.owned)))).work, trial)
  await f.unchanged()
})

/** The reviewed CI policy exactly as the production reader emits it, so the
 * native run composes and runs inherited rules under their reserved ids. */
const registrationId = "33333333-3333-4333-a333-333333333333"
const pinned = (rule: string) => {
  const setup = initialSetup("example/repo", "ci", "maintainer")
  setup.draft.checks = [{ id: "verify", name: "Verify", kind: "command", policy: "required", rule, paths: [] }]
  const digest = setupCandidate(setup)
  const policy = readCiPolicy("example/repo", [{ id: registrationId, repository_id: 3, workspace_id: "11111111-1111-4111-a111-111111111111",
    user_id: 7, job: "ci", mode: "enabled", revision: setup.revision, digest, source_revision: "a".repeat(40),
    flow_id: "repository-jobs/ci", enabled: true,
    configuration: { repo: "example/repo", workspace_id: "11111111-1111-4111-a111-111111111111", flow_id: "repository-jobs/ci",
      revision: setup.revision, digest, source_revision: "a".repeat(40), execution_digest: "f".repeat(64), mode: "enabled", input: setup.draft } }])
  if (policy.kind !== "pinned") throw new Error("expected a pinned policy")
  return policy
}

for (const mode of ["land", "ai-only-land", "ai-only-blocked", "ai-only-fix", "push-chore", "push-chore-ci", "push-chore-main-moved", "old-helper", "changed-main", "changed-before-create", "creation-unacknowledged", "delivery-main-moved", "publication-failed", "foreign-creation", "post-commit-race", "bad-child", "fresh-check-failed"] as const) {
  test(`proposal flow preserves editor and binds final native source: ${mode}`, gate, async t => {
    const f = await fixture(t), calls: string[] = [], seenChecks: string[] = []
    const evidence = await Effect.runPromise(captureRepository(f.options, { repo: "example/repo", prompt: "code.txt", sourceRevision: f.head.commitId }, "immutable").pipe(Effect.provide(f.owned)))
    const command = `${JSON.stringify(process.execPath)} -e "const fs=require('node:fs');if(fs.readFileSync('code.txt','utf8')!=='checked implementation\\n')process.exit(7);console.log('measured checked bytes')"`
    // A push to the default branch is the first trigger that both names an
    // immutable revision and produces a new one.
    const chore = mode === "push-chore" || mode === "push-chore-ci" || mode === "push-chore-main-moved"
    // The configuration the setup guide produces: one AI check and no command.
    const advisory = { id: "docs-only-scope", name: "Docs-only scope", kind: "ai" as const, paths: [],
      policy: mode === "ai-only-blocked" ? "required" as const : "report" as const, rule: "Report changes outside the requested scope" }
    const trigger = { ref: "refs/heads/main", before: "a".repeat(40), after: f.base.commitId, created: false, deleted: false,
      repository: { default_branch: "main" }, candidateCommitId: f.base.commitId, baseCommitId: "a".repeat(40) }
    const work: typeof Work.Type = { repo: "example/repo", job: chore ? "chores" : mode === "ai-only-fix" ? "issues" : "feature",
      step: chore ? { id: "chore", name: "Chore", mode: "automatic", prompt: "Update code.txt" }
        : mode === "ai-only-fix" ? { id: "fix", name: "Fix for real", mode: "manual", prompt: "Update code.txt" }
        : { id: "feature", name: "Feature", mode: "manual", prompt: "Update code.txt" },
      event: chore ? { source: "github", type: "push", action: "", deliveryKey: "github:signed-push", payload: trigger }
        : { source: "smithers-cloud", type: "manual", action: "manual:feature", manualStep: "feature", deliveryKey: "feature", payload: { manual: { prompt: "Update code.txt" } } },
      evidence, checks: mode === "push-chore-ci" ? composeCiChecks([], pinned(command))
        : mode.startsWith("ai-only") ? [advisory]
        : [{ id: "verify", name: "Verify", kind: "command", policy: "required", rule: command, paths: [] }],
      ...(mode === "push-chore-ci" ? { policy: pinned(command) } : {}),
      landing: mode === "old-helper" ? "ask" : "checks", replies: "draft", executionMode: "live", deadlineAt: Date.now() + 60000 }
    let draftedAdmissionReads = 0
    const landing: Landing["Service"] = { binding: { repositoryId: 3, workspaceId: "11111111-1111-4111-a111-111111111111" },
      readMain: Effect.sync(() => {
        // Model the actual phase, independent of extra source-availability fences.
        if (calls.includes("draft") && !calls.includes("create")) draftedAdmissionReads++
        return (((mode === "changed-main" || mode === "push-chore-main-moved") && draftedAdmissionReads >= 1) || (mode === "changed-before-create" && draftedAdmissionReads >= 2) ||
          (mode === "delivery-main-moved" && calls.includes("create"))) ? "f".repeat(40) : f.base.commitId
      }),
      prepare: input => Effect.sync(() => { calls.push("prepare"); assert.equal(input.source_commit_id, f.child.commitId); assert.equal(input.source_base_commit_id, f.base.commitId)
        return { ...input, status: "prepared" as const, changes: [{ change_id: f.child.changeId, commit_id: f.child.commitId }] } }),
      create: requestId => Effect.sync(() => { calls.push("landing"); return { requestId, number: 1 } }),
      queue: (identity, preparation, request) => Effect.sync(() => { calls.push("queue"); return { ...identity, taskId: 1, preparation, request } }),
      observe: queued => Effect.succeed({ status: "landed", task_id: 1, request: { change_ids: [f.child.commitId], target_bookmark: "main", expected_commit_id: f.base.commitId,
        operation_key: "fixture", append: { source_commit_id: f.child.commitId, source_base_commit_id: f.base.commitId, description: queued.request.description } },
        result: { landed_count: 1, target_bookmark: "main", target_commit_id: f.child.commitId } }) }
    let receipt!: typeof SourceCreation.Type
    const creationRequests: Array<typeof CreateSource.Type> = []
    const native: NativeCoding["Service"] = { ...f.native,
      read: () => f.native.read().pipe(Effect.map(value => ({ ...value, capabilities: mode === "old-helper" ? [] : value.capabilities ?? [] }))),
      createSource: (request: typeof CreateSource.Type) => Effect.sync(() => {
        creationRequests.push(request)
        calls.push("create"); assert.equal(request.base.commitId, f.base.commitId); assert.equal(request.base.operationId, request.expectedOperationId)
        assert.deepEqual(request.files, [{ path: "code.txt", beforeDigest: digest("original\n"), content: "checked implementation\n" }])
        receipt = { status: "created", replayed: false, requestId: request.requestId, requestDigest: "a".repeat(64), repositoryId: 3,
          workspaceId: mode === "foreign-creation" ? "22222222-2222-4222-a222-222222222222" : landing.binding.workspaceId, operationId: f.child.operationId, parentOperationId: request.expectedOperationId, base: f.base,
          source: mode === "bad-child" ? { ...f.child, parentCommitIds: ["f".repeat(40)] } : f.child, head: f.head, publicationReady: mode !== "post-commit-race" }
        return receipt
      }).pipe(Effect.flatMap(result => mode === "creation-unacknowledged"
        ? Effect.fail(new NativeCodingError({ code: "outcome_unknown", message: "Native source was created but its response was lost" }))
        : Effect.succeed(result))),
      publishOriginalSource: request => mode === "publication-failed" ? Effect.fail(new NativeCodingError({ code: "source_publication_unavailable", message: "Fixture refuses external publication" })) : Effect.sync(() => { calls.push("publish"); assert.equal(request.source.commitId, f.child.commitId)
        assert.deepEqual(request.creation, { requestId: receipt.requestId, requestDigest: receipt.requestDigest })
        return { status: "retained" as const, requestId: request.requestId, workspaceId: receipt.workspaceId, repositoryId: 3,
          ref: `refs/smithers/workspaces/${receipt.workspaceId}/sources/${f.child.commitId}`, source: f.child } }) }
    const runtime = ManagedRuntime.make(Layer.mergeAll(changeLayers(f.options), checkLayers(f.options), deliveryLayers,
      DraftChange.toLayer(author => Effect.sync(() => { calls.push("draft"); assert.equal(author.evidence.source.commitId, f.base.commitId)
        return { summary: "Update the implementation", question: "", children: [], baseline: [], proposal: [{ path: "code.txt", beforeDigest: digest("original\n"), content: "checked implementation\n" }] } })),
      SemanticCheck.toLayer(input => Effect.sync(() => { seenChecks.push(input.comparison.candidate)
        if (input.check.id === advisory.id) return { verdict: "fail" as const, summary: "The change edits code.txt",
          examinedPaths: input.comparison.paths, findings: input.comparison.paths.map(path => ({ path, line: 1, message: "Outside the requested scope" })) }
        return { verdict: mode === "fresh-check-failed" && input.comparison.candidate === f.child.commitId ? "uncertain" as const : "pass" as const,
          summary: "Scripted semantic review; commands measure actual bytes", examinedPaths: input.comparison.paths, findings: [] } }))
    ).pipe(Layer.provide(Layer.mergeAll(f.platform, Layer.succeed(NativeCoding, native), Layer.succeed(Landing, landing))),
      Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeServices.layer)))
    t.after(() => runtime.dispose())
    const output = await runtime.runPromise(ProposalStep.execute({ work }, { executionId: chore ? "preserved-chore" : "preserved-feature" }))
    if (mode === "push-chore") {
      const retained = output.output as Record<string, Schema.Json>
      assert.equal(output.status, "completed")
      assert.ok(seenChecks.includes(f.child.commitId), "fresh checks verify the produced child, not the triggering push")
      assert.deepEqual(retained.trigger, trigger, "the triggering push stays on the result as provenance")
      assert.ok(calls.includes("create") && calls.includes("publish"))
    } else if (mode === "push-chore-main-moved") {
      assert.equal(output.status, "needs-maintainer")
      assert.deepEqual(calls, ["draft"], "main advancing between capture and selection blocks before any creation")
      assert.ok(!seenChecks.includes(f.child.commitId))
    } else if (mode === "push-chore-ci") {
      const policy = pinned(command), reserved = inheritedCheckId(policy.ref, "verify")
      const retained = output.output as Record<string, Schema.Json>
      const checked = (retained.checks as Record<string, Schema.Json>).output as Record<string, Schema.Json>
      assert.equal(checked.candidate, f.child.commitId, "the inherited rule runs on the produced change, not the push's after commit")
      assert.equal(checked.base, f.base.commitId)
      const inheritedResult = (checked.results as Array<Record<string, Schema.Json>>).find(value => value.checkId === reserved)
      assert.equal(inheritedResult?.status, "passed", "the inherited required rule ran under its reserved id")
      assert.equal((inheritedResult?.detail as Record<string, Schema.Json>).exitCode, 0, "a real command measured the produced bytes")
      assert.equal(rawCheckId(policy.ref, policy.checks, reserved), "verify", "the wire keeps the raw configured id")
      assert.equal(output.status, "needs-maintainer")
      assert.match(output.summary, /receipt publisher/i)
      assert.deepEqual(calls, ["draft", "create", "publish", "prepare"], "a pinned policy with no receipt publisher opens no landing request")
    } else if (mode === "land") {
      assert.deepEqual(calls, ["draft", "create", "publish", "prepare", "landing", "queue"])
      assert.equal((output.output as Record<string, Schema.Json>).landed, true)
      assert.ok(seenChecks.some(candidate => candidate.startsWith(f.base.commitId + "+")))
      assert.ok(seenChecks.includes(f.child.commitId), "fresh checks inspect the actual immutable result")
      assert.deepEqual(await runtime.runPromise(ProposalStep.execute({ work }, { executionId: "preserved-feature" })), output)
      assert.equal(calls.length, 6, "durable replay does not create or publish twice")
    } else if (mode === "ai-only-land") {
      assert.deepEqual(calls, ["draft", "create", "publish", "prepare", "landing", "queue"], "a passed AI-only gate opens the same landing request a command-checked change opens")
      assert.equal(output.status, "completed")
      assert.equal((output.output as Record<string, Schema.Json>).landed, true)
      const checked = ((output.output as Record<string, Schema.Json>).checks as Record<string, Schema.Json>).output as Record<string, Schema.Json>
      assert.equal(checked.gate, "passed")
      assert.deepEqual((checked.results as Array<Record<string, Schema.Json>>).map(value => [value.checkId, value.policy, value.status]),
        [[advisory.id, "report", "failed"], ["implementation-review", "required", "passed"]], "a report-only finding informs without holding landing")
    } else if (mode === "ai-only-blocked") {
      assert.equal(output.status, "error")
      assert.deepEqual(calls, ["draft"], "a failed required AI check holds landing before any native creation")
      const recorded = ((output.output as Record<string, Schema.Json>).checks as Array<Record<string, Schema.Json>>).at(-1)!
      assert.equal((recorded.output as Record<string, Schema.Json>).gate, "blocked")
    } else if (mode === "ai-only-fix") {
      assert.equal(output.status, "needs-maintainer")
      assert.equal(output.summary, "A fix needs a required command check to establish its failing regression")
      assert.deepEqual(calls, ["draft"], "an unprovable regression says so instead of retaining a silent draft")
    } else {
      assert.equal(output.status, "needs-maintainer")
      assert.ok(!calls.includes("publish") && !calls.includes("queue"))
      if (mode === "old-helper" || mode === "changed-main" || mode === "changed-before-create") assert.deepEqual(calls, ["draft"])
      else if (mode === "creation-unacknowledged") {
        assert.ok(creationRequests.length > 1, "the retry policy exhausted actual creation attempts")
        assert.ok(creationRequests.every(request => JSON.stringify(request) === JSON.stringify(creationRequests[0])), "all retries use the exact prepared request")
        const retained = output.output as Record<string, Schema.Json>
        assert.equal(retained.sourceRequestId, receipt.requestId, "retain the actual prepared creation ID after a lost acknowledgement")
        assert.equal(retained.creation, undefined, "a lost native response is not an observed creation receipt")
        const attempts = creationRequests.length
        assert.deepEqual(await runtime.runPromise(ProposalStep.execute({ work }, { executionId: "preserved-feature" })), output)
        assert.equal(creationRequests.length, attempts, "durable replay does not launch a new creation request")
      }
      else assert.ok((output.output as Record<string, Schema.Json>).creation, "a created child remains inspectable when subsequent verification fails")
    }
    await f.unchanged()
  })
}
