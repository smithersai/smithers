import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Poll, Sleep } from "@smthrs/flow"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Landing } from "../coding/landing.ts"
import type { AppendObservation, AppendPreparation } from "../coding/landing-schema.ts"
import { NativeCoding, NativeCodingError } from "../coding/native.ts"
import { CodingError, checkInputDigest, type Implementation, type Plan, type Revision } from "../coding/schema.ts"
import { LandVibe, landingLayers } from "../coding/vibe-landing.ts"
import { publicationLayers } from "../coding/vibe-publication.ts"
import type { VibeCleanup } from "../coding/vibe-schema.ts"

/** Native ID patterns: 32 letters k..z for changes, 40 hex for commits and trees. */
const ids: Record<string, [letter: string, hex: string]> = { original: ["k", "a"], earlier: ["l", "b"], first: ["m", "c"], last: ["n", "d"] }
const revision = (name: string, parent?: string): Revision => ({ changeId: ids[name]![0].repeat(32), commitId: ids[name]![1].repeat(40),
  treeId: ids[name]![1].repeat(39) + "e", operationId: "0".repeat(128), parentCommitIds: parent ? [ids[parent]![1].repeat(40)] : [] })
const original = revision("original"), base = revision("earlier", "original"), first = revision("first", "earlier"), last = revision("last", "first")
const plan: Plan = { prompt: "Finish", memoryRevision: "wiki", base, observedHead: base, changes: ["first", "last"].map(id => ({
  id, title: id, intent: id, implementation: "coding/implementation", implementationDigest: "0".repeat(64),
  atoms: [{ changeId: null, message: `✨ feat: ${id}`, intent: id, reads: [], writes: [id] }],
  checks: [{ id: "fast", target: "fast", flow: "checks/fast", flowDigest: "0".repeat(64), tier: "fast", required: true }] })) }
const implementations: Implementation[] = [{ change: "first", parent: base, atoms: [first], head: first, reads: [], writes: ["first"] },
  { change: "last", parent: first, atoms: [last], head: last, reads: [], writes: ["last"] }]
const result = { status: "validated" as const, findings: [], changes: implementations.map((implementation, index) => ({ implementation,
  receipts: plan.changes[index]!.checks.map(check => ({ change: implementation.change, checkId: check.id, target: check.target, tier: check.tier,
    commitId: implementation.head.commitId, treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check),
    status: "passed" as const, findings: [], evidence: "fixture" })) })) }
const cleanup: VibeCleanup = { summary: "✨ feat: finish the validated request", result, head: last,
  admission: { requestExecutionId: "request", controlRunId: "control", planId: "plan", planDigest: "digest", pocExecutionId: "poc",
    originalSource: original, validatedHead: last, request: { plan, outcome: { status: "validated", rounds: 1, blocked: null, result } } } }
const main = "5".repeat(40)
const preparation: AppendPreparation = { status: "prepared", target_bookmark: "main", expected_commit_id: main, source_commit_id: last.commitId,
  source_base_commit_id: original.commitId, changes: [base, first, last].map(atom => ({ change_id: atom.changeId, commit_id: atom.commitId })) }
const landed = (status: AppendObservation["status"]) => ({ status, task_id: 12, request: { change_ids: preparation.changes.map(change => change.change_id),
  target_bookmark: "main" as const, expected_commit_id: main, operation_key: "existing", append: { source_commit_id: last.commitId,
  source_base_commit_id: original.commitId, description: cleanup.summary } },
  ...(status === "landed" ? { result: { landed_count: 3, target_bookmark: "main" as const, target_commit_id: "9".repeat(40) } } : {}) }) as AppendObservation
const modes = ["valid", "pending-then-landed", "policy-failed", "foreign-tail", "unretained", "count-mismatch"] as const
for (const mode of modes) test(`vibe landing: ${mode}`, { timeout: 60_000 }, async t => {
  const calls: string[] = []
  let observations = 0
  const fake: Landing["Service"] = {
    binding: { repositoryId: 42, workspaceId: "11111111-1111-4111-a111-111111111111" },
    readMain: Effect.sync(() => { calls.push("main"); return main }),
    prepare: input => Effect.sync(() => { calls.push("prepare")
      assert.deepEqual(input, { target_bookmark: "main", expected_commit_id: main, source_commit_id: last.commitId, source_base_commit_id: original.commitId })
      return mode === "foreign-tail" ? { ...preparation, changes: [...preparation.changes, { change_id: "z".repeat(32), commit_id: "f".repeat(40) }] } : preparation }),
    create: (requestId, _preparation, description) => Effect.sync(() => { calls.push(`create:${requestId}`); assert.equal(description, cleanup.summary); return { requestId, number: 7 } }),
    queue: (identity, prepared, request) => Effect.sync(() => { calls.push("queue"); return { ...identity, taskId: 12, preparation: prepared, request } }),
    observe: () => Effect.sync(() => { calls.push("observe"); observations++
      if (mode === "policy-failed") return landed("failed")
      if (mode === "pending-then-landed" && observations < 3) return landed(observations === 1 ? "pending" : "running")
      const value = landed("landed")
      return mode === "count-mismatch" ? { ...value, result: { ...(value as Extract<AppendObservation, { status: "landed" }>).result, landed_count: 2 } } as AppendObservation : value })
  }
  const native = Layer.succeed(NativeCoding, { sourcePublication: "cloud", read: () => Effect.die("no reads"), apply: () => Effect.die("no writes"),
    publishOriginalSource: request => {
      calls.push(`retain:${request.source.commitId}`)
      return mode === "unretained" ? Effect.fail(new NativeCodingError({ code: "source_publication_unavailable", message: "no ACK" }))
        : Effect.succeed({ status: "retained" as const, requestId: request.requestId, workspaceId: fake.binding.workspaceId, repositoryId: 42,
          ref: `refs/smithers/workspaces/${fake.binding.workspaceId}/sources/${request.source.commitId}`, source: request.source })
    } })
  const host = ManagedRuntime.make(Layer.mergeAll(landingLayers, publicationLayers, Poll.layer, Sleep.layer).pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(Landing, fake), native)),
    Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer)))
  t.after(() => host.dispose())
  const execute = LandVibe.execute(cleanup, { executionId: "land" })
  if (mode === "valid" || mode === "pending-then-landed") {
    // The pending case waits two real durable rounds (10 s each); nothing re-queues.
    const value = await host.runPromise(execute)
    assert.equal(value.mainCommitId, "9".repeat(40)); assert.equal(value.landedCount, 3); assert.equal(value.taskId, 12)
    assert.equal(value.cleanedSource.source.commitId, last.commitId)
    const expected = [`retain:${last.commitId}`, "main", "prepare", calls[3]!, "queue", ...Array<string>(mode === "valid" ? 1 : 3).fill("observe")]
    assert.deepEqual(calls, expected); assert.match(calls[3]!, /^create:[0-9a-f-]{36}$/)
    assert.deepEqual(await host.runPromise(execute), value); assert.equal(calls.length, expected.length, "replay uses receipts; nothing is re-queued")
  } else {
    const error = await host.runPromise(Effect.flip(execute))
    assert(error instanceof CodingError)
    assert.equal(error.code, mode === "unretained" ? "unavailable" : "invalid_receipt")
    assert.deepEqual(calls.filter(call => call === "queue").length, mode === "policy-failed" || mode === "count-mismatch" ? 1 : 0, "refusals before queue never queue")
    if (mode === "foreign-tail") assert.deepEqual(calls.slice(1), ["main", "prepare"])
  }
})
