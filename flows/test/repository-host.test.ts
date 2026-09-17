import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { ApprovalAuthority, Control, ControlRpcs } from "@smthrs/control"
import * as Model from "@smthrs/model/Model"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import { Cause, Context, Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as NetAddress from "effect/unstable/net/NetAddress"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { layer } from "../coding/host.ts"
import { NativeCoding, nativeLayer } from "../coding/native.ts"
import { RepositoryRemote } from "../repository/remote.ts"
import { initialSetup, setupCandidate, SetupOperationResponseSchema } from "../../packages/rpc/src/RepositorySetup.ts"
import { JobInput, JobResult } from "../repository/schema.ts"
import { verifyTrialChecks } from "../repository/checks.ts"
import { assessScore } from "../repository/evaluation.ts"

const source = process.env.PLUE_CODING_ADAPTER_SOURCE, exporter = process.env.PLUE_JJ_EXPORT_BINARY
const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))
const nativeOptions = {
  skip: source === undefined || exporter === undefined ? "Set the Plue native adapter and exporter paths" : false, timeout: 180000
}
async function proveRepository(t: TestContext, proof: { setup?: boolean; jobs?: ReadonlyArray<"review" | "ci" | "push" | "feature" | "chores" | "fix" | "draft" | "ai-match" | "ai-skip" | "ai-proposal" | "ai-empty-review" | "ai-unavailable">; interactions?: ReadonlyArray<"author" | "reproduction" | "false-reproduction">; mutation?: boolean }) {
  const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  const temporary = await mkdtemp(join(tmpdir(), "repository-host-")), root = join(temporary, "repo")
  let passed = false
  t.diagnostic(`Native repository evidence: ${temporary}`)
  t.after(() => passed ? rm(temporary, { recursive: true, force: true }) : Promise.resolve())
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Repository test")
  jj("config", "set", "--repo", "user.email", "repository@example.com")
  await writeFile(join(root, "README.md"), "# Test repository\nThe greeting lives in greeting.mjs.\n")
  await writeFile(join(root, "greeting.mjs"), "export const greeting = 'hello';\n")
  await writeFile(join(root, ".gitignore"), "node_modules\n.flows/\n")
  jj("status")
  jj("new", "-m", "Document the greeting")
  const greetingSource = "export const greeting = 'hello';\n// Public greeting\n"
  await writeFile(join(root, "greeting.mjs"), greetingSource)
  jj("status")
  const config = join(temporary, "binding.json"), reporter = join(temporary, "reporter"), adapter = join(temporary, "adapter.py"), nativeSource = join(temporary, "native.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "host-repository", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(nativeSource, (await readFile(source!, "utf8")).replace('"/usr/local/bin/smithers-jj-export"', JSON.stringify(exporter)))
  await writeFile(adapter, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(nativeSource)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)}, engine="--engine" in sys.argv)))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)
  const workspaceId = "22222222-2222-4222-8222-222222222222", repo = "example/demo"
  const base = { repositoryPath: root, adapterPath: adapter, sourcePublication: "local-only" as const, exporterPath: exporter }
  const native = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read()).pipe(Effect.provide(nativeLayer(base)), Effect.provide(platform.host), Effect.scoped))
  const setup = initialSetup(repo, "issues", "maintainer")
  setup.draft.replies = "automatic"
  setup.draft.steps = [setup.draft.steps[0]!, setup.draft.steps[1]!, setup.draft.steps.find(step => step.id === "poc")!]
  setup.draft.cases = [{ id: "research", name: "Held-out question", input: JSON.stringify({ sourceRevision: native.head.commitId,
    event: { source: "smithers-cloud", type: "issues", action: "opened", deliveryKey: "held-out", issueNumber: 4,
      payload: { issue: { number: 4, title: "What greeting is exported?", body: "Inspect greeting.mjs", user: { login: "reporter" } } } },
    assertions: [{ path: "/results/0/output/classification", equals: "question" }] }), expected: "HELD_OUT_EXPECTATION: cite greeting.mjs and identify hello", required: true }]
  setup.draft.trialTitle = "What greeting is exported?"
  setup.draft.trialBody = "Inspect greeting.mjs"
  const projectionMismatches: string[] = []
  const digest = setupCandidate(setup), requests: string[] = [], registrations: Array<Record<string, any>> = [], dispatches: any[] = []
  const connect = () => RpcClient.make(ControlRpcs.ControlRpcs)
  let client!: Effect.Success<ReturnType<typeof connect>>
  let issueNumber = 10, creates = 0, comments = 0
  const issues = new Map<string, any>()
  const remote = RepositoryRemote.of({ repo, workspaceId,
    source: Effect.succeed("smithers-cloud"),
    history: Effect.succeed({ records: [], sources: [{ path: "repository:issues", status: "read", summary: "0 issues" }] }),
    pause: () => Effect.succeed(json({ enabled: false })), dispatches: () => Effect.succeed(json(dispatches)),
    comment: (job, step, raw) => Effect.sync(() => {
      assert.equal(job, "issues")
      const value = raw as Record<string, any>
      assert.equal(value.delivery_key, "manual:test-run", "a setup trial cannot publish its draft")
      comments++
      return json({ registration_id: "33333333-3333-4333-8333-333333333333", revision: value.revision, digest: value.digest,
        delivery_key: value.delivery_key, step, source: "smithers-cloud", issue_number: value.issue_number, comment_id: 100, api_path: "/repos/example/demo/issues/4/comments" })
    }),
    manual: (job, requestId, raw) => Effect.promise(async () => {
      const value = raw as Record<string, any>, active = registrations.findLast(row => row.mode === "enabled")!
      assert.equal(value.digest, active.digest)
      assert.equal(value.revision, active.revision)
      assert.equal(value.step_id, "poc")
      const event = { source: "smithers-cloud" as const, type: "manual", action: "manual:poc", manualStep: "poc", deliveryKey: `manual:${requestId}`,
        issueNumber: value.subject.number, payload: { manual: { stepId: "poc", prompt: value.prompt }, issue: { number: value.subject.number, title: "Try another greeting", body: "Inspect greeting.mjs" } } }
      const input: JobInput = { repo, job, revision: active.revision, digest: active.digest, sourceRevision: active.source_revision, configuration: active.input, event }
      const plan = await Effect.runPromise(client.Plan({ flowId: `repository-jobs/${job}`, input: json(input), idempotencyKey: `${requestId}:plan` })) as any
      assert.equal(plan.executionDigest, active.execution_digest)
      assert.deepEqual(plan.envelope, active.envelope)
      await Effect.runPromise(client.Approve({ ...plan.approval, scope: "once" }))
      const launched = await Effect.runPromise(client.Run({ _tag: "Plan", planId: plan.planId, digest: plan.digest, envelope: plan.envelope, idempotencyKey: `${requestId}:run` })) as any
      const row = { id: 2, registration_id: "33333333-3333-4333-8333-333333333333", revision: active.revision, digest: active.digest, source: event.source,
        issue_number: event.issueNumber, delivery_key: event.deliveryKey, status: "submitted", run_id: launched.runId }
      dispatches.push(row)
      return json({ ...row, dispatch_id: row.id })
    }),
    createTrial: (_job, requestId) => Effect.sync(() => {
      if (!issues.has(requestId)) { creates++; issues.set(requestId, { source: "smithers-cloud", number: issueNumber++, issue_id: 1, request_id: requestId, api_path: "/repos/example/demo/issues/10" }) }
      return json(issues.get(requestId))
    }),
    register: (job, raw) => Effect.promise(async () => {
      const value = raw as Record<string, any>
      registrations.push(value)
      const registration = { registration_id: "33333333-3333-4333-8333-333333333333", revision: value.revision, digest: value.digest,
        source_revision: value.source_revision, mode: value.mode, enabled: true }
      if (value.mode === "trial") {
        const input: JobInput = { repo, job, revision: value.revision, digest: value.digest, sourceRevision: value.source_revision, configuration: value.input,
          event: { source: "smithers-cloud", type: "issues", action: "opened", trial: true, deliveryKey: "native-test-outbox", issueNumber: value.trial_issue_number,
            payload: { issue: { number: value.trial_issue_number, title: setup.draft.trialTitle, body: setup.draft.trialBody, user: { login: "reporter" } } } } }
        const plan = await Effect.runPromise(client.Plan({ flowId: `repository-jobs/${job}`, input: json(input), idempotencyKey: "trial-plan" })) as any
        assert.equal(plan.executionDigest, value.execution_digest)
        assert.deepEqual(plan.envelope, value.envelope)
        await Effect.runPromise(client.Approve({ ...plan.approval, scope: "once" }))
        const launched = await Effect.runPromise(client.Run({ _tag: "Plan", planId: plan.planId, digest: plan.digest, envelope: plan.envelope, idempotencyKey: "trial-run" })) as any
        dispatches.push({ id: 1, registration_id: registration.registration_id, revision: value.revision, digest: value.digest, source: "smithers-cloud",
          issue_number: value.trial_issue_number, delivery_key: input.event.deliveryKey, status: "submitted", run_id: launched.runId })
      }
      return json(registration)
    })
  })
  const model = Model.make({ stream: request => Stream.suspend(() => {
    const text = JSON.stringify(request); requests.push(text)
    const scoring = text.includes("Independently evaluate the recorded production job")
    const suggesting = text.includes("Propose a configuration for this one repository responsibility")
    const changing = text.includes("Implement the maintainer's configured responsibility as a bounded full-file proposal")
    const checking = text.includes("Check the maintainer's exact rule against this captured base/candidate comparison")
    const reviewingRepro = text.includes("Independently review this executed reproduction against the original issue")
    const taskText = request.system.find(part => part.type === "text" && part.text.startsWith("The task for this run:\n\n"))
    const task = taskText?.type === "text" ? JSON.parse(taskText.text.slice("The task for this run:\n\n".length).split("\n")[0]!) : undefined
    if (!scoring && !suggesting) assert(!text.includes("HELD_OUT_EXPECTATION"), "production worker must not receive expected eval answers")
    const response: any = suggesting ? { ...setup.draft, cases: setup.draft.cases.map(test => ({ ...test, input: JSON.parse(test.input) })) } : scoring
      ? { verdict: "pass", reason: "The recorded result classifies a question and cites the source greeting.", evidenceIds: [0] }
      : checking ? { verdict: "pass", summary: "Every supplied changed file matches the fixture's requested behavior.", examinedPaths: task.comparison.paths, findings: [] }
      : reviewingRepro ? { verdict: task.result.output.fixture[0].content.includes("import { greeting }") ? "demonstrates" : "unrelated",
        summary: task.result.output.fixture[0].content.includes("import { greeting }") ? "The executed assertion imports the repository greeting and establishes its wrong value." : "An unconditional throw does not exercise repository behavior.",
        citations: ["greeting.mjs", "repro.mjs"] }
      : changing ? { summary: "Change the greeting to goodbye and retain its regression test.", question: "", baseline: [],
        proposal: [{ path: "greeting.mjs", beforeDigest: task.evidence.files.find((file: any) => file.path === "greeting.mjs").digest, content: "export const greeting = 'goodbye';\n" },
          { path: "regression.mjs", beforeDigest: null, content: "import { greeting } from './greeting.mjs';\nif (greeting !== 'goodbye') throw new Error('wrong greeting');\n" }], children: [] }
      : { classification: "question", summary: "The exported greeting is hello.", question: "", citations: ["greeting.mjs"], duplicates: [], reproduction: null }
    if (checking && task.check.rule === "Fixture: telemetry context is unavailable") {
      response.verdict = "uncertain"
      response.summary = "The telemetry helper required by this rule was not supplied."
    }
    if (!scoring && !suggesting && !checking && !changing && !reviewingRepro && task.event.payload.issue?.title === "Ask twice") {
      const replies = task.event.payload.authorReplies ?? []
      response.question = replies.length < 2 ? `Provide detail ${replies.length + 1}` : ""
    }
    if (!scoring && !suggesting && task.step?.id === "reproduce" && ["Reproduce greeting", "False reproduction"].includes(task.event.payload.issue?.title)) {
      response.classification = "bug"
      response.reproduction = { files: [{ path: "repro.mjs", content: task.event.payload.issue.title === "False reproduction" ? "throw new Error('wrong greeting');\n"
        : "import { greeting } from './greeting.mjs';\nif (greeting !== 'goodbye') throw new Error('wrong greeting');\n" }],
        argv: [process.execPath, "repro.mjs"], cwd: ".", expected: "The greeting is goodbye", failureContains: "wrong greeting", timeoutMs: 5000 }
    }
    if (changing && task.step.id === "fix") response.baseline = [response.proposal.find((file: any) => file.path === "regression.mjs")]
    // Extract one actual reference from the evaluator input; no fabricated IDs.
    if (scoring) {
      const reference = task.evidenceIndex.find((item: any) => item.reference.startsWith("source:greeting.mjs@"))
      response.evidenceIds = reference ? [reference.id] : []
    }
    return Stream.fromIterable([ModelEvent.TextStart({ type: "text-start", id: "cell" }),
      ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\nctx.done(" + JSON.stringify(response) + ");\n```" }),
      ModelEvent.TextEnd({ type: "text-end", id: "cell" }), ModelEvent.Settle({ type: "settle", stopReason: "stop" })])
  }) })
  const seats = { resolve: (id: string) => Effect.succeed({ id, modelId: "scripted", model, contextWindowTokens: 100000,
    route: { prepare: () => Effect.succeed({ routeId: "fixture", protocolId: "fixture", method: "POST" as const, url: "https://fixture.invalid", publicHeaders: {}, body: new TextEncoder().encode("{}"), bodyText: "{}" }) } }) }
  const listening = await Effect.runPromise(Deferred.make<number>())
  const observedPlatform: NativeControl.Platform = { ...platform, gateway: (health, options) => platform.gateway(health, options).pipe(Layer.tap(context => {
    const server = Context.get(context, HttpServer.HttpServer)
    if (!NetAddress.isInetAddress(server.address)) throw new Error("expected TCP gateway")
    return Deferred.succeed(listening, server.address.port)
  })) }
  await Effect.runPromise(Effect.gen(function*() {
    const control = yield* Control.Control
    yield* Effect.forkScoped(Serve.host({ host: "127.0.0.1", port: 0, listen: false, credential: "fixture-key" }, root).pipe(Effect.tapCause(cause => Effect.sync(() => t.diagnostic(Cause.pretty(cause))))))
    const port = yield* Deferred.await(listening).pipe(Effect.timeout("30 seconds"))
    const protocol = yield* Layer.build(RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${port}/rpc`, transformClient: client => HttpClient.mapRequest(client, HttpClientRequest.bearerToken("fixture-key")) }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])))
    client = yield* RpcClient.make(ControlRpcs.ControlRpcs).pipe(Effect.provide(protocol))
    for (const operation of proof.setup ? ["inspect", "evaluate", "trial", "apply", "run"] as const : []) {
      const input = { requestId: `test-${operation}`, repo, job: "issues", revision: setup.revision, digest, draft: setup.draft, workspaceId, operation,
        ...(operation === "run" ? { manual: { stepId: "poc", prompt: "Try the greeting change", subject: { source: "smithers-cloud", kind: "issue", number: 4 } } } : {}) }
      const plan = yield* client.Plan({ flowId: "repository/setup", input: json(input), idempotencyKey: `${operation}:plan` })
      assert.equal(plan.flowId, "repository/setup")
      assert.equal(plan.envelope.budget.tokens, 200000)
      yield* client.Approve({ ...plan.approval, scope: "once" })
      const launched = yield* client.Run({ _tag: "Plan", planId: plan.planId, digest: plan.digest, envelope: plan.envelope, idempotencyKey: `${operation}:run` })
      if (launched._tag !== "Accepted" || !launched.runId) throw new Error("Expected accepted setup run")
      const events = yield* control.watch({ runId: launched.runId, follow: true }).pipe(Stream.tap(event => Effect.promise(() => appendFile(join(temporary, "events.ndjson"), JSON.stringify(event) + "\n"))),
        Stream.takeUntil(event => event.kind === "control.engine.projection-settled"), Stream.runCollect, Effect.timeout("90 seconds"))
      assert(!events.some(event => event.kind === "control.run.failed"), `${operation} failed: ${JSON.stringify(events.filter(event => event.kind === "control.run.failed"))}`)
      const outputs = events.flatMap(event => { const e = event.payload as any; const value = e?.payload?.state
        return value?.flowName === "repository/Setup" && value?.result?._tag === "Complete" && value.result.exit?._tag === "Success" ? [value.result.exit.value] : [] })
      assert.equal(outputs.length, 1, `${operation} must retain a typed host result`)
      const projected = yield* Effect.promise(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/projections`, { method: "POST", headers: { authorization: "Bearer fixture-key", "content-type": "application/ndjson" },
          body: JSON.stringify({ _tag: "Request", id: 1, tag: "Projection.Snapshot", payload: { selector: { _tag: "run-summary", runId: launched.runId } }, headers: [] }) + "\n" })
        const lines = (await response.text()).trim().split("\n").map(line => JSON.parse(line))
        const value = lines.find(line => line._tag === "Exit")
        assert.equal(value?.exit._tag, "Success", JSON.stringify(value))
        return value.exit.value.rows[0]
      })
      const result = SetupOperationResponseSchema.parse(outputs[0])
      yield* Effect.promise(() => writeFile(join(temporary, `projection-${operation}.json`), JSON.stringify(projected, null, 2)))
      const projectionOutput = typeof projected.finalOutput === "string" ? JSON.parse(projected.finalOutput) : projected.finalOutput
      if (projectionOutput === undefined) projectionMismatches.push(operation)
      else assert.deepEqual(SetupOperationResponseSchema.parse(projectionOutput), result, "Worker sees the exact durable host result")
      assert.equal(result.receipt?.phase, "completed", JSON.stringify(result))
      assert.equal(result.receipt?.runId, launched.runId)
      if (operation === "evaluate") assert.equal(result.receipt?.results[0]?.status, "passed", JSON.stringify(result))
      if (operation === "trial") {
        assert(result.receipt?.evidence.some(item => item.startsWith("execution:")))
        assert.equal(comments, 0)
      }
      if (operation === "run") {
        assert.equal(result.receipt?.jobRunId, dispatches.find(row => row.id === 2).run_id)
        assert.notEqual(result.receipt?.jobRunId, result.receipt?.runId)
      }
    }
    const source = (yield* Effect.flatMap(NativeCoding, native => native.read()).pipe(Effect.provide(nativeLayer(base)), Effect.provide(platform.host), Effect.scoped)).head
    for (const kind of proof.jobs ?? []) {
      const job = kind === "fix" ? "issues" : kind === "draft" || kind === "ai-proposal" || kind === "ai-unavailable" ? "feature" : kind === "push" || kind === "ai-match" || kind === "ai-skip" ? "ci" : kind === "ai-empty-review" ? "review" : kind
      const configured = initialSetup(repo, job, "maintainer")
      if (kind === "fix") configured.draft.steps = [configured.draft.steps.find(step => step.id === "fix")!]
      configured.draft.cases = []
      configured.draft.checks = job === "review" || kind === "draft" ? [] : [{ id: "real-command", name: "Run fixture", kind: "command", policy: "required", paths: [],
        rule: job === "ci" ? `${process.execPath} -e "import('./greeting.mjs').then(m => { if (m.greeting !== 'hello') process.exit(1) })"` : `${process.execPath} regression.mjs` }]
      if (kind.startsWith("ai-") && kind !== "ai-empty-review") configured.draft.checks.push({ id: "observability", name: "Observability", kind: "ai", policy: "report",
        paths: [kind === "ai-skip" ? "unrelated/**" : "greeting.mjs"], rule: kind === "ai-unavailable" ? "Fixture: telemetry context is unavailable" : "Review the requested greeting change using its source." })
      const event = kind === "push" ? { source: "github" as const, type: "push", action: "", deliveryKey: "github:signed-push", issueNumber: 0,
        payload: { ref: "refs/heads/main", before: native.head.parentCommitIds[0], after: native.head.commitId, created: false, deleted: false, forced: false,
          repository: { id: 42, full_name: "original/source" }, sender: { login: "maintainer" } } }
        : { source: "smithers-cloud" as const, type: job === "review" || job === "ci" ? "pull_request" : "issues", action: "opened", trial: true,
        ...(kind === "fix" ? { type: "manual", action: "manual:fix", manualStep: "fix" } : {}),
        deliveryKey: `job:${kind}`, issueNumber: 30, payload: job === "review" || job === "ci"
          ? { pull_request: { number: 30, head: { sha: native.head.commitId }, base: { sha: kind === "ai-empty-review" ? native.head.commitId : native.head.parentCommitIds[0] } } }
          : { issue: { number: 30, title: "Use goodbye", body: "Change greeting.mjs to export goodbye" } } }
      const input = { repo, job, revision: configured.revision, digest: setupCandidate(configured), sourceRevision: source.commitId,
        configuration: configured.draft, event }
      const plan = yield* client.Plan({ flowId: `repository-jobs/${job}`, input: json(input), idempotencyKey: `${kind}:plan` })
      yield* client.Approve({ ...plan.approval, scope: "once" })
      const launched = yield* client.Run({ _tag: "Plan", planId: plan.planId, digest: plan.digest, envelope: plan.envelope, idempotencyKey: `${kind}:run` })
      assert.equal(launched._tag, "Accepted")
      const events = yield* control.watch({ runId: launched.runId!, follow: true }).pipe(Stream.tap(event => Effect.promise(() => appendFile(join(temporary, "events.ndjson"), JSON.stringify(event) + "\n"))),
        Stream.takeUntil(event => event.kind === "control.engine.projection-settled"), Stream.runCollect, Effect.timeout("90 seconds"))
      assert(!events.some(event => event.kind === "control.run.failed"), `${job} failed`)
      const outputs = events.flatMap(event => { const state = (event.payload as any)?.payload?.state
        return state?.flowName === "repository/Job" && state?.result?._tag === "Complete" && state.result.exit?._tag === "Success" ? [state.result.exit.value] : [] })
      assert.equal(outputs.length, 1, `${job} needs its actual native job result`)
      const output = Schema.decodeUnknownSync(JobResult)(outputs[0])
      assert.equal(output.status, "completed", JSON.stringify(output))
      assert(output.results.length > 0)
      assert(output.results.every(step => step.status === "completed" && step.evidence.length > 0))
      if (kind.startsWith("ai-")) {
        const verify = () => verifyTrialChecks(configured.draft, output)
        if (kind === "ai-skip" || kind === "ai-empty-review") assert.throws(verify, /AI check .+in-scope trial/)
        else if (kind === "ai-unavailable") assert.throws(verify, /unavailable.*check/)
        else assert.doesNotThrow(verify)
        if (kind === "ai-skip") {
          assert.equal((output.results[0]!.output as any).results.find((check: any) => check.checkId === "observability").status, "skipped")
          assert.equal(output.status, "completed", "unrelated ordinary work retains legitimate skips")
        }
      }
      if (job === "review") {
        if (kind === "ai-empty-review") assert((output.results[0]!.output as any).results.every((check: any) => check.status === "skipped"))
        else {
          assert((output.results[0]!.output as any).results.some((check: any) => check.status === "passed" && check.detail.examinedPaths.includes("greeting.mjs")))
          assert.doesNotThrow(() => verifyTrialChecks(configured.draft, output))
        }
      }
      if (job === "ci") {
        assert.equal((output.results[0]!.output as any).results[0].detail.exitCode, 0)
        assert.equal((output.results[0]!.output as any).candidate, native.head.commitId)
        assert.equal((output.results[0]!.output as any).base, native.head.parentCommitIds[0])
      }
      if (job === "feature" || job === "chores" || kind === "fix") {
        const change = output.results[0]!.output as any
        assert.equal(change.status, kind === "draft" ? "proposal" : "checked-proposal")
        assert(change.proposal.some((file: any) => file.path === "greeting.mjs"))
        if (kind === "draft") assert.equal(output.results[0]!.summary, "Reviewed draft")
        else assert(change.checks.at(-1).output.results.some((check: any) => check.detail.exitCode === 0))
        if (kind === "fix") assert(change.checks[0].output.results.some((check: any) => check.status === "failed" && check.detail.exitCode !== 0))
        if (kind === "fix" || kind === "ai-unavailable") {
          const index = change.checks.length - 1
          const expected = { id: "recorded-proposal", name: "Judge actual proposal checks", expected: "Use the measured final check results", required: true,
            input: JSON.stringify({ event: input.event, sourceRevision: output.sourceRevision,
              assertions: [{ path: `/results/0/output/checks/${index}/output/gate`, equals: "passed" }] }) }
          assert.equal(assessScore(expected, output, { verdict: "pass", reason: "Scripted favorable judge; execution facts must still hold", evidenceIds: [0] }).status,
            kind === "fix" ? "passed" : "error", "a real failing regression baseline is valid; an unavailable AI candidate remains an execution error")
          if (kind === "ai-unavailable") assert(change.checks[index].output.results.some((check: any) => check.checkId === "observability" && check.status === "error"))
        }
      }
    }
    const waitFor = (runId: string, predicate: (row: any) => boolean) => Effect.gen(function*() {
      for (let attempt = 0; attempt < 800; attempt++) {
        const listed = yield* client.List({ _tag: "runs", filters: { runId } })
        const row = listed._tag === "runs" ? listed.items[0] : undefined
        if (row && predicate(row)) return row
        if (row?.status === "failed" || row?.status === "cancelled") throw new Error(`Native run ${runId} failed before its expected wait`)
        yield* Effect.sleep("50 millis")
      }
      throw new Error(`Native run ${runId} did not reach its expected state`)
    })
    for (const mode of proof.interactions ?? []) {
      const configured = initialSetup(repo, "issues", "maintainer")
      const stepId = mode === "author" ? "research" : "reproduce"
      configured.draft.steps = [configured.draft.steps.find(step => step.id === stepId)!]
      configured.draft.cases = []
      const input = { repo, job: "issues", revision: configured.revision, digest: setupCandidate(configured), sourceRevision: source.commitId, configuration: configured.draft,
        event: { source: "smithers-cloud", type: "issues", action: "opened", deliveryKey: mode, issueNumber: 50,
          payload: { issue: { number: 50, title: mode === "author" ? "Ask twice" : mode === "false-reproduction" ? "False reproduction" : "Reproduce greeting", body: "Inspect greeting.mjs", user: { id: 1, login: "reporter" } } } } }
      const plan = yield* client.Plan({ flowId: "repository-jobs/issues", input: json(input), idempotencyKey: `${mode}:plan` })
      yield* client.Approve({ ...plan.approval, scope: "once" })
      const launched = yield* client.Run({ _tag: "Plan", planId: plan.planId, digest: plan.digest, envelope: plan.envelope, idempotencyKey: `${mode}:run` })
      assert.equal(launched._tag, "Accepted")
      const runId = launched.runId!
      if (mode !== "author") {
        const waiting = yield* waitFor(runId, row => row.status === "waiting-approval")
        assert(waiting.pendingWaits?.some((wait: any) => wait.name === "repository-run-reproduction"))
        assert.equal(yield* Effect.promise(() => readFile(join(root, "greeting.mjs"), "utf8")), greetingSource)
        for (let attempt = 0; attempt < 800; attempt++) {
          const receipt = yield* client.Signal({ runId, signal: { name: "repository-run-reproduction", payload: true }, idempotencyKey: `approve-reproduction:${attempt}` }).pipe(Effect.result)
          if (receipt._tag === "Success") { assert.equal(receipt.success._tag, "Accepted"); break }
          if (receipt.failure._tag !== "/control/NoMatchingWait" || attempt === 799) throw receipt.failure
          yield* Effect.sleep("50 millis")
        }
      } else {
        for (const [index, author] of [2, 1, 1].entries()) {
          yield* waitFor(runId, row => row.status === "parked" && row.waitingReason === "event")
          const reply = { source: "smithers-cloud", type: "issue_comment", action: "created", deliveryKey: `reply:${index}`, issueNumber: 50,
            payload: { comment: { id: index + 1, body: `Detail ${index}`, user: { id: author, login: author === 1 ? "reporter" : "bystander" } } } }
          for (let attempt = 0; attempt < 800; attempt++) {
            const receipt = yield* client.Signal({ runId, signal: { name: "repository-job.author-reply", payload: json(reply) }, idempotencyKey: `author:${index}:${attempt}` }).pipe(Effect.result)
            if (receipt._tag === "Success") { assert.equal(receipt.success._tag, "Accepted"); break }
            if (receipt.failure._tag !== "/control/NoMatchingWait" || attempt === 799) throw receipt.failure
            yield* Effect.sleep("50 millis")
          }
        }
      }
      yield* waitFor(runId, row => row.status === "completed")
      const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
      const outputs = events.flatMap(event => { const state = (event.payload as any)?.payload?.state
        return state?.flowName === "repository/Job" && state?.result?._tag === "Complete" && state.result.exit?._tag === "Success" ? [state.result.exit.value] : [] })
      assert.equal(outputs.length, 1)
      const result = Schema.decodeUnknownSync(JobResult)(outputs[0])
      assert.equal(result.status, mode === "false-reproduction" ? "needs-maintainer" : "completed", JSON.stringify(result))
      assert.equal(result.eventKey, mode, "author replies retain the original admitted event identity")
      if (mode !== "author") {
        const output = result.results[0]!.output as any
        assert.equal(output.status, mode === "false-reproduction" ? "needs-review" : "reproduced")
        assert.equal(output.review.verdict, mode === "false-reproduction" ? "unrelated" : "demonstrates")
        assert.notEqual(output.exitCode, 0)
        assert.match(output.stderr, /wrong greeting/)
      } else {
        const investigated = requests.filter(request => request.includes("Ask twice") && !request.includes("Propose a configuration") && !request.includes("Independently evaluate"))
        assert.equal(investigated.length, 3, "an unrelated reply cannot rerun the investigation")
      }
    }
    if (proof.mutation) {
      const configured = initialSetup(repo, "feature", "maintainer")
      configured.draft.checks = [{ id: "regression", name: "Run regression", kind: "command", policy: "required", paths: [], rule: `${process.execPath} regression.mjs` }]
      configured.draft.landing = "checks"
      const input = { repo, job: "feature", revision: configured.revision, digest: setupCandidate(configured), sourceRevision: source.commitId, configuration: configured.draft,
        event: { source: "smithers-cloud", type: "manual", action: "manual:feature", manualStep: "feature", deliveryKey: "native-mutation", issueNumber: 0,
          payload: { manual: { stepId: "feature", prompt: "Change greeting.mjs to goodbye and check it" } } } }
      const plan = yield* client.Plan({ flowId: "repository-jobs/feature", input: json(input), idempotencyKey: "mutation:plan" })
      yield* client.Approve({ ...plan.approval, scope: "once" })
      const launched = yield* client.Run({ _tag: "Plan", planId: plan.planId, digest: plan.digest, envelope: plan.envelope, idempotencyKey: "mutation:run" })
      assert.equal(launched._tag, "Accepted")
      const events = yield* control.watch({ runId: launched.runId!, follow: true }).pipe(Stream.tap(event => Effect.promise(() => appendFile(join(temporary, "events.ndjson"), JSON.stringify(event) + "\n"))),
        Stream.takeUntil(event => event.kind === "control.engine.projection-settled"), Stream.runCollect, Effect.timeout("90 seconds"))
      const applied = events.flatMap(event => { const state = (event.payload as any)?.payload?.state
        return state?.flowName === "repository/ApplyChange" && state?.result?._tag === "Complete" && state.result.exit?._tag === "Success" ? [state.result.exit.value] : [] })
      assert.equal(applied.length, 1, "the native file operation must complete and retain its checked source")
      const output = applied[0].output
      assert.equal(output.status, "implemented")
      assert.equal(output.landed, false)
      assert.equal(output.checks.output.candidate, output.source.commitId)
      assert(output.checks.output.results.some((check: any) => check.checkId === "implementation-review" && check.status === "passed"))
      assert(output.recovery.path)
      assert.equal(yield* Effect.promise(() => readFile(output.recovery.files.find((file: any) => file.path === "greeting.mjs").preimage, "utf8")), greetingSource)
      const jobs = events.flatMap(event => { const state = (event.payload as any)?.payload?.state
        return state?.flowName === "repository/Job" && state?.result?._tag === "Complete" && state.result.exit?._tag === "Success" ? [state.result.exit.value] : [] })
      assert.equal(jobs[0]?.status, "partial", "a local-only host cannot pretend it landed a change")
      assert.match(jobs[0].results[0].summary, /landing|publication|retention/i)
    }
  }).pipe(Effect.provide(layer(observedPlatform, { ...base, gatewayId: "11111111-1111-4111-8111-111111111111", credential: "fixture-key",
    implementationModel: "test:scripted", checkEnvironment: { PATH: process.env.PATH! }, repositoryRemote: Layer.succeed(RepositoryRemote, remote) }, seats)), Effect.scoped))
  assert.equal(creates, proof.setup ? 1 : 0)
  assert.equal(comments, proof.setup ? 1 : 0)
  if (proof.setup) assert.equal(registrations.at(-1)?.mode, "enabled")
  assert.equal(await readFile(join(root, "greeting.mjs"), "utf8"), proof.mutation ? "export const greeting = 'goodbye';\n" : greetingSource)
  if (proof.setup) assert((await readFile(join(root, ".smithers", "repository-jobs", "issues", digest, "candidate.json"), "utf8")).includes(digest))
  await writeFile(join(temporary, "model-requests.json"), JSON.stringify(requests))
  assert.deepEqual(projectionMismatches, [], "Worker needs the exact typed finalOutput for every setup operation")
  passed = true
}
test("plain repository verifies setup, evals, real trial, activation, all five jobs and a single manual step", nativeOptions,
  t => proveRepository(t, { setup: true, jobs: ["review", "ci", "feature", "chores", "fix", "draft"] }))
test("native reproduction waits for human approval and records the actual failing source execution", nativeOptions,
  t => proveRepository(t, { interactions: ["reproduction"] }))
test("an executed unconditional throw cannot become a reproduced repository bug", nativeOptions,
  t => proveRepository(t, { interactions: ["false-reproduction"] }))
test("a real GitHub push envelope runs CI on its immutable after commit and before comparison", nativeOptions,
  t => proveRepository(t, { jobs: ["push"] }))
test("native AI trials require matched execution while ordinary events preserve scoped skips", nativeOptions,
  t => proveRepository(t, { jobs: ["ai-match", "ai-skip", "ai-proposal", "ai-empty-review"] }))
test("native proposal evaluation keeps a failing regression baseline distinct from unavailable AI", nativeOptions,
  t => proveRepository(t, { jobs: ["fix", "ai-unavailable"] }))
test("native author signals ignore bystanders and resume the same job across two questions", nativeOptions,
  t => proveRepository(t, { interactions: ["author"] }))
test("native checked changes retain exact versioned files and recovery bytes, and refuse unverified landing", nativeOptions,
  t => proveRepository(t, { mutation: true }))
