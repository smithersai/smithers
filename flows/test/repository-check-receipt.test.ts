import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { NodeCrypto, NodeHttpClient } from "@effect/platform-node"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import { RunNotFound } from "@smthrs/control/ControlError"
import { FlowEngine } from "@smthrs/engine"
import { DurableEngineState } from "@smthrs/engine-store"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action, Flow } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { Landing } from "../coding/landing.ts"
import { NativeCoding } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { CheckStep } from "../repository/checks.ts"
import { RepositoryCheckReceipts, make, verifiedCheckStep } from "../repository/check-receipt.ts"
import * as Delivery from "../repository/delivery.ts"
import { completedJob } from "../repository/receipts.ts"
import { StepResult } from "../repository/schema.ts"

const changeId = "k".repeat(31) + "m"
const mainCommit = "a1".repeat(20), mainTree = "a2".repeat(20)
const sourceCommit = "b1".repeat(20), sourceTree = "b2".repeat(20)
const operationId = "c3".repeat(64), workspaceId = "11111111-1111-4111-a111-111111111111"
const registrationId = "33333333-3333-4333-a333-333333333333"
const ref = { repositoryId: 3, registrationId, revision: 7, digest: "e".repeat(64), executionDigest: "f".repeat(64), requiredCheckIds: ["verify", "review"] }
const pinned = { kind: "pinned" as const, ref, checks: [] }
const base = { kind: "resolved" as const, changeId: "k".repeat(32), commitId: mainCommit, treeId: mainTree, operationId, parentCommitIds: [] }
const source = { kind: "resolved" as const, changeId, commitId: sourceCommit, treeId: sourceTree, operationId, parentCommitIds: [mainCommit] }
const creation = { status: "created" as const, replayed: false, requestId: "22222222-2222-4222-a222-222222222222",
  requestDigest: "d".repeat(64), repositoryId: 3, workspaceId, operationId, parentOperationId: operationId,
  base: { changeId: base.changeId, commitId: mainCommit, treeId: mainTree, parentCommitIds: [] }, head: source, source, publicationReady: true }
const checkExecutionId = "job-run/checks"
const results = [
  { checkId: "verify", policy: "required", status: "passed", summary: "Exit 0", evidence: [], executionId: `${checkExecutionId}/verify`, detail: null },
  { checkId: "review", policy: "required", status: "skipped", summary: "No changed paths match this check", evidence: [], executionId: `${checkExecutionId}/review`, detail: null },
  { checkId: "style", policy: "report", status: "failed", summary: "Exit 1", evidence: [], executionId: `${checkExecutionId}/style`, detail: null }
]
const checkOutput = (candidate = sourceCommit, values = results) => ({ base: mainCommit, candidate, gate: "passed", results: values })
const checks = (candidate = sourceCommit, values = results) => ({ stepId: "checks", status: "completed", summary: "1 checks passed",
  evidence: [], executionId: checkExecutionId, output: checkOutput(candidate, values) })
const work = { repo: "example/repo", job: "feature", step: { id: "feature", name: "Feature", mode: "manual", prompt: "Update code.txt" },
  event: { source: "smithers-cloud", type: "manual", action: "manual:feature", manualStep: "feature", deliveryKey: "feature", payload: {} },
  evidence: { repo: "example/repo", source: { changeId: base.changeId, commitId: mainCommit, treeId: mainTree, operationId, parentCommitIds: [] },
    files: [], missing: [], history: [], records: [], sources: [] },
  checks: [{ id: "verify", name: "Verify", kind: "command", policy: "required", rule: "true", paths: [] }],
  landing: "checks", replies: "draft", executionMode: "live", deadlineAt: 0 }
const result = (candidate = sourceCommit, values = results) => ({ stepId: "feature", status: "completed", summary: "Implemented",
  evidence: [], executionId: "job-run/implement", output: { status: "implemented", source, creation, checks: candidate === "" ? undefined : checks(candidate, values) } })

const resultCodec = Schema.toCodecJson(Flow.Result({ success: StepResult, error: CodingError }))
const stepState = (options: { candidate?: string; values?: typeof results; flowName?: string; policy?: unknown; parent?: string | null }) =>
  JSON.stringify({ version: 1, flowName: options.flowName ?? CheckStep._tag,
    payload: { work: { ...work, ciPolicy: options.policy === undefined ? pinned : options.policy } },
    ...(options.parent === undefined || options.parent === null ? {} : { parentExecutionId: options.parent }),
    result: Schema.encodeSync(resultCodec)(new Flow.Complete({ exit: Exit.succeed(Schema.decodeUnknownSync(StepResult)(
      checks(options.candidate ?? sourceCommit, options.values ?? results))) })) })
const row = (id: string, stateJson: string, status: RunStore.RunRow["status"] = "completed", parentRunId: string | null = null): RunStore.RunRow => ({
  runId: id, status, createdAtMs: 1, startedAtMs: 1, finishedAtMs: 2, owner: null, heartbeatAtMs: null, claim: null,
  claimedAtMs: null, parentRunId, cancelRequestedAtMs: null, stateJson })
const jobState = JSON.stringify({ version: 1, flowName: "repository/RepositoryJob", payload: {} })
const runSummary = (status: string) => ({ runId: "control-run", flowId: "repository-jobs/feature", status, planId: "plan-1",
  planDigest: "digest-1", createdAt: 1, updatedAt: 2 })
const storedPlan = (decision = "approved") => ({ decision, decodedInput: {},
  card: { planId: "plan-1", flowId: "repository-jobs/feature", digest: "digest-1", inputSummary: "", envelope: { capabilities: [], flows: [], budget: {} },
    deployClass: false, executionDigest: ref.executionDigest, nodes: [], approval: {} } })

/** The durable stores the verifier reads: a completed CheckStep under a job run
 * that is still delivering, under an approved control run. */
const stores = (options: { rows?: Record<string, RunStore.RunRow>; runStatus?: string; decision?: string; parents?: Record<string, readonly string[]> } = {}) => {
  const rows = options.rows ?? { [checkExecutionId]: row(checkExecutionId, stepState({}), "completed", "job-run"), "job-run": row("job-run", jobState, "running", "control-run"),
    "control-run": row("control-run", jobState, "running", null) }
  const reads: string[] = []
  const control = { getRun: (runId: string) => runId === "control-run"
      ? Effect.succeed(runSummary(options.runStatus ?? "running")) : Effect.fail(new RunNotFound({ code: "run_not_found", runId })),
    getPlan: () => Effect.succeed(storedPlan(options.decision)) }
  return { reads, rows, layer: Layer.mergeAll(
    RunStore.layerNoop({ get: id => Effect.suspend(() => { reads.push(id)
      const found = rows[id]
      return found ? Effect.succeed(found) : Effect.fail(new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: `Missing ${id}`, cause: { runId: id } })) }) }),
    Layer.succeed(DurableEngineState.DurableEngineState, { runParents: (childId: string) =>
      Effect.succeed((options.parents?.[childId] ?? (rows[childId]?.parentRunId === null || rows[childId]?.parentRunId === undefined ? [] : [rows[childId]!.parentRunId!]))
        .map(parentId => ({ parentId, childId }))) } as unknown as DurableEngineState.DurableEngineState["Service"]),
    Layer.succeed(RunCatalogRead.RunCatalogRead, { listRuns: () => Effect.succeed({ source: "0".repeat(32), revision: 1, cursor: null, runs: [] }),
      listRunIds: () => Effect.succeed([]) } as unknown as RunCatalogRead.Service),
    Layer.succeed(ControlRuntime, control as unknown as ControlRuntime["Service"])) }
}

const verify = (input: Parameters<typeof verifiedCheckStep>[0],
  layers: Layer.Layer<RunStore.RunStore | DurableEngineState.DurableEngineState | ControlRuntime> = stores().layer) =>
  Effect.runPromise(Effect.exit(verifiedCheckStep(input).pipe(Effect.provide(layers))))
const request = { executionId: checkExecutionId, commitId: sourceCommit, ref, rawCheckId: (id: string) => id }

test("the verifier accepts a completed CheckStep whose job is still awaiting landing", async () => {
  const verified = await verify(request)
  assert.equal(verified._tag, "Success")
  if (verified._tag !== "Success") return
  assert.deepEqual(verified.value, { runId: "control-run", executionId: checkExecutionId, candidate: sourceCommit,
    checks: [{ id: "verify", outcome: "passed" }, { id: "review", outcome: "skipped_no_matching_paths" }] })
})

test("completedJob still refuses the running job the verifier accepts", async () => {
  const f = stores()
  const refused = await Effect.runPromise(Effect.exit(completedJob("control-run", { repo: "example/repo", job: "feature", revision: 7, digest: "e".repeat(64) },
    { source: "smithers-cloud", issueNumber: 0 }).pipe(Effect.provide(f.layer))))
  assert.equal(refused._tag, "Success")
  assert.equal(refused._tag === "Success" ? refused.value : "read", undefined, "a running control run is not a completed job")
})

for (const [name, input, layers] of [
  ["a fabricated execution id", { ...request, executionId: "no-such-execution" }, stores().layer],
  ["another run's CheckStep result", { ...request, executionId: "other-check" }, stores({ rows: {
    "other-check": row("other-check", stepState({}), "completed", "other-job"), "other-job": row("other-job", jobState, "running", null) } }).layer],
  ["a cancelled parent", request, stores({ rows: { [checkExecutionId]: row(checkExecutionId, stepState({}), "completed", "job-run"),
    "job-run": row("job-run", jobState, "cancelled", "control-run"), "control-run": row("control-run", jobState, "running", null) } }).layer],
  ["a failed parent", request, stores({ rows: { [checkExecutionId]: row(checkExecutionId, stepState({}), "completed", "job-run"),
    "job-run": row("job-run", jobState, "failed", "control-run"), "control-run": row("control-run", jobState, "running", null) } }).layer],
  ["a cancelled control run", request, stores({ runStatus: "cancelled" }).layer],
  ["an unapproved plan", request, stores({ decision: "pending" }).layer],
  ["ambiguous ancestry", request, stores({ parents: { [checkExecutionId]: ["job-run", "other-job"] } }).layer],
  ["a candidate that is not the delivered commit", { ...request, commitId: "c1".repeat(20) }, stores().layer],
  ["a check id reused under another policy digest", { ...request, ref: { ...ref, digest: "1".repeat(64) } }, stores().layer],
  ["an incomplete CheckStep execution", request, stores({ rows: { [checkExecutionId]: row(checkExecutionId, stepState({}), "running", "job-run") } }).layer],
  ["a required check reported by another flow", { ...request }, stores({ rows: { [checkExecutionId]: row(checkExecutionId, stepState({ flowName: "user/Flow" }), "completed", "job-run"),
    "job-run": row("job-run", jobState, "running", "control-run"), "control-run": row("control-run", jobState, "running", null) } }).layer],
  ["a required check with no result", { ...request, ref: { ...ref, requiredCheckIds: ["verify", "review", "missing"] } }, stores().layer],
  ["a required check that failed", request, stores({ rows: { [checkExecutionId]: row(checkExecutionId, stepState({
    values: [{ ...results[0]!, status: "failed" }, results[1]!, results[2]!] }), "completed", "job-run"),
    "job-run": row("job-run", jobState, "running", "control-run"), "control-run": row("control-run", jobState, "running", null) } }).layer]
] as const) {
  test(`the verifier refuses ${name}`, async () => {
    const refused = await verify(input as Parameters<typeof verifiedCheckStep>[0], layers)
    assert.equal(refused._tag, "Failure")
    if (refused._tag !== "Failure") return
    const error = Exit.isFailure(refused) ? refused.cause : undefined
    assert.ok(error !== undefined)
  })
}

test("the verifier refuses a user-authored root flow that imitates the built-in job", async () => {
  const f = stores()
  const impostor = Layer.mergeAll(f.layer, Layer.succeed(ControlRuntime, { getRun: (runId: string) => runId === "control-run"
    ? Effect.succeed({ ...runSummary("running"), flowId: "user/my-flow" }) : Effect.fail(new RunNotFound({ code: "run_not_found", runId })),
    getPlan: () => Effect.succeed({ ...storedPlan(), card: { ...storedPlan().card, flowId: "user/my-flow" } }) } as unknown as ControlRuntime["Service"]))
  const refused = await verify(request, impostor)
  assert.equal(refused._tag, "Failure")
})

test("an unreadable store is an unavailable failure, never a pass", async () => {
  const broken = Layer.mergeAll(
    RunStore.layerNoop({ get: () => Effect.fail(new RunStore.RunStoreError({ code: "persistence_failed", method: "get", message: "disk", cause: {} })) }),
    Layer.succeed(DurableEngineState.DurableEngineState, { runParents: () => Effect.succeed([]) } as unknown as DurableEngineState.DurableEngineState["Service"]),
    Layer.succeed(ControlRuntime, { getRun: (runId: string) => Effect.fail(new RunNotFound({ code: "run_not_found", runId })), getPlan: () => Effect.die("no plan") } as unknown as ControlRuntime["Service"]))
  const refused = await verify(request, broken)
  assert.equal(refused._tag, "Failure")
})

/** A scripted Plue that records every receipt request it is asked to store. */
const plue = async (t: TestContext, respond: (requestId: string, count: number) => { status: number; body: unknown }) => {
  const seen: Array<{ method: string; url: string; authorization: string; body: unknown }> = []
  let count = 0
  const server: Server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    incoming.on("data", chunk => chunks.push(chunk as Buffer))
    incoming.on("end", () => {
      seen.push({ method: incoming.method ?? "", url: incoming.url ?? "", authorization: incoming.headers.authorization ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") })
      const answer = respond((incoming.url ?? "").split("/").at(-1) ?? "", count++)
      response.writeHead(answer.status, { "content-type": "application/json" })
      response.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  return { seen, port: (server.address() as AddressInfo).port }
}

const gatewayId = "44444444-4444-4444-a444-444444444444"
const landing = (calls: string[]): Landing["Service"] => ({
  binding: { repositoryId: 3, workspaceId },
  readMain: Effect.sync(() => { calls.push("readMain"); return mainCommit }),
  prepare: input => Effect.sync(() => { calls.push("prepare")
    return { ...input, status: "prepared" as const, changes: [{ change_id: changeId, commit_id: sourceCommit }] } }),
  create: requestId => Effect.sync(() => { calls.push("create"); return { requestId, number: 1 } }),
  queue: (identity, preparation, request) => Effect.sync(() => { calls.push("queue"); return { ...identity, taskId: 1, preparation, request } }),
  observe: queued => Effect.sync(() => { calls.push("observe")
    return { status: "landed" as const, task_id: 1, request: { change_ids: [sourceCommit], target_bookmark: "main" as const,
      expected_commit_id: mainCommit, operation_key: "fixture", append: { source_commit_id: sourceCommit, source_base_commit_id: mainCommit, description: queued.request.description } },
      result: { landed_count: 1, target_bookmark: "main" as const, target_commit_id: sourceCommit } } })
})
const native = { sourcePublication: "cloud" as const, read: () => Effect.die("no read"), apply: () => Effect.die("no apply"),
  publishOriginalSource: (input: { requestId: string }) => Effect.succeed({ status: "retained" as const, requestId: input.requestId,
    workspaceId, repositoryId: 3, ref: `refs/smithers/workspaces/${workspaceId}/sources/${sourceCommit}`,
    source: { changeId, commitId: sourceCommit, treeId: sourceTree, parentCommitIds: [mainCommit] } }) }

const deliver = async (t: TestContext, options: { port?: number; policy?: unknown; unreadable?: boolean; store?: ReturnType<typeof stores> }) => {
  const calls: string[] = []
  const f = options.store ?? stores()
  const receipts = Layer.effect(RepositoryCheckReceipts)(make({ apiBaseUrl: `http://127.0.0.1:${options.port}/api`, gatewayId,
    credential: "gateway-credential", repositorySlug: "example/repo", workspaceId }).pipe(
      Effect.map(service => ({ ...service, policy: () => options.unreadable === true
        ? Effect.fail(new CodingError({ code: "invalid_receipt", message: "The pinned repository CI policy is unreadable" }))
        : Effect.succeed(options.policy as never) }))))
    .pipe(Layer.provide(NodeHttpClient.layerUndici))
  const runtime = ManagedRuntime.make(Delivery.deliveryLayers.pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(NativeCoding, native as unknown as NativeCoding["Service"]), Layer.succeed(Landing, landing(calls)),
      receipts.pipe(Layer.orDie), f.layer)),
    Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer)))
  t.after(() => runtime.dispose())
  const payload = { work: { ...work, deadlineAt: Date.now() + 600_000 }, result: result() }
  const run = (executionId = "delivery") => runtime.runPromise(Delivery.DeliverChange.execute(payload as never, { executionId }))
  return { calls, run }
}

test("a pinned policy reports the receipt with the gateway credential before any landing exists", async t => {
  const store = await plue(t, requestId => ({ status: 201, body: { request_id: requestId, context: `repository-ci/${registrationId}@7.${ref.digest.slice(0, 12)}`, commit_id: sourceCommit, status: "success", status_id: 5 } }))
  const f = await deliver(t, { port: store.port, policy: pinned })
  const output = await f.run()
  assert.equal(output.status, "completed", output.summary)
  assert.equal(store.seen.length, 1)
  const seen = store.seen[0]!
  assert.equal(seen.method, "PUT")
  assert.equal(seen.authorization, "Bearer gateway-credential")
  assert.match(seen.url, new RegExp(`^/api/gateways/${gatewayId}/repository-jobs/ci/check-receipts/[0-9a-f-]{36}$`))
  assert.deepEqual(seen.body, { repo: "example/repo", workspace_id: workspaceId, registration_id: registrationId, revision: 7,
    digest: ref.digest, execution_digest: ref.executionDigest, run_id: "control-run", execution_id: checkExecutionId,
    commit_id: sourceCommit, change_id: changeId, base_commit_id: mainCommit, gate: "passed",
    checks: [{ id: "verify", outcome: "passed" }, { id: "review", outcome: "skipped_no_matching_paths" }] })
  assert.deepEqual(f.calls, ["readMain", "prepare", "create", "queue", "observe"])
})

test("a replay sends the identical request id and creates exactly one landing", async t => {
  const store = await plue(t, requestId => ({ status: 201, body: { request_id: requestId, context: `repository-ci/${registrationId}@7.${ref.digest.slice(0, 12)}`, commit_id: sourceCommit, status: "success", status_id: 5 } }))
  const f = await deliver(t, { port: store.port, policy: pinned })
  const first = await f.run()
  const second = await f.run()
  assert.deepEqual(second, first)
  assert.equal(store.seen.length, 1, "a durable replay never repeats the receipt")
  assert.equal(f.calls.filter(call => call === "create").length, 1)
})

for (const [status, expected] of [[409, /policy/i], [422, /required/i], [404, /policy/i], [503, /unavailable|store/i], [403, /refus|receipt/i]] as const) {
  test(`HTTP ${status} fails delivery before the landing request is created`, async t => {
    const store = await plue(t, () => ({ status, body: { error: "refused" } }))
    const f = await deliver(t, { port: store.port, policy: pinned })
    const output = await f.run()
    assert.equal(output.status, "needs-maintainer")
    assert.match(output.summary, expected)
    assert.equal(store.seen.length, 1)
    assert.deepEqual(f.calls, ["readMain", "prepare"], "no landing request is opened for an unproven source")
  })
}

test("an authoritative none policy delivers exactly as today with no receipt call", async t => {
  const store = await plue(t, () => ({ status: 500, body: {} }))
  const f = await deliver(t, { port: store.port, policy: { kind: "none" } })
  const output = await f.run()
  assert.equal(output.status, "completed")
  assert.equal(store.seen.length, 0)
  assert.deepEqual(f.calls, ["readMain", "prepare", "create", "queue", "observe"])
})

test("an unreadable policy fails delivery and is never treated as none", async t => {
  const store = await plue(t, () => ({ status: 201, body: {} }))
  const f = await deliver(t, { port: store.port, unreadable: true })
  const output = await f.run()
  assert.equal(output.status, "needs-maintainer")
  assert.equal(store.seen.length, 0)
  assert.deepEqual(f.calls, ["readMain", "prepare"])
})

test("the pinned policy is read from the job, and a malformed one is never none", async () => {
  const service = await Effect.runPromise(make({ apiBaseUrl: "http://127.0.0.1:1/api", gatewayId, credential: "gateway-credential",
    repositorySlug: "example/repo", workspaceId }).pipe(Effect.provide(NodeHttpClient.layerUndici)))
  assert.deepEqual(await Effect.runPromise(service.policy({ ...work })), { kind: "none" })
  assert.deepEqual(await Effect.runPromise(service.policy({ ...work, ciPolicy: pinned })), pinned)
  const malformed = await Effect.runPromise(Effect.exit(service.policy({ ...work, ciPolicy: { kind: "pinned", ref: { ...ref, revision: 0 }, checks: [] } })))
  assert.equal(malformed._tag, "Failure")
  assert.equal(service.rawCheckId("verify"), "verify")
})

test("the receipt action is not model invocable", () => {
  assert.deepEqual(Object.keys(Delivery).sort(), ["DeliverChange", "deliveryLayers"])
})
