import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "../coding/native.ts"
import { checkInputDigest, type Plan, type Implementation, type Revision } from "../coding/schema.ts"
import { VibeEvidence } from "../coding/vibe-evidence.ts"
import { FenceVibeSource, fenceVibeSource, VerifyVibe } from "../coding/vibe-admission.ts"
import { policyLayers } from "../coding/workflow.ts"

const revision = (name: string, parent?: string): Revision => ({ changeId: `jj-${name}`, commitId: `commit-${name}`,
  treeId: `tree-${name}`, operationId: `op-${name}`, parentCommitIds: parent ? [`commit-${parent}`] : [] })
const base = revision("base")
const plan: Plan = { prompt: "Vibe the validated work", memoryRevision: "wiki", base, observedHead: base, changes: ["first", "last"].map(id => ({
  id, title: id, intent: id, implementation: "coding/implementation", implementationDigest: "0".repeat(64),
  atoms: [{ changeId: null, message: `✨ feat: ${id}`, intent: id, reads: [], writes: [id] }],
  checks: ["fast", "slow", "delivery"].map(tier => ({ id: tier, target: tier, flow: `checks/${tier}`, flowDigest: "0".repeat(64), tier: tier as "fast" | "slow" | "delivery", required: true }))
})) }
const implementations: Implementation[] = plan.changes.map((change, index) => ({ change: change.id, parent: index === 0 ? base : revision("first", "base"),
  atoms: [revision(change.id, index === 0 ? "base" : "first")], head: revision(change.id, index === 0 ? "base" : "first"), reads: [], writes: [change.id] }))
const evidence: VibeEvidence = { requestExecutionId: "request", controlRunId: "completed-control", planId: "approved", planDigest: "digest", pocExecutionId: "poc",
  originalSource: base, request: { plan, outcome: { status: "validated", rounds: 1, blocked: null, result: { status: "validated", findings: [],
    changes: implementations.map((implementation, index) => ({ implementation,
      receipts: plan.changes[index]!.checks.filter(check => check.tier !== "delivery").map(check => ({ change: implementation.change,
        checkId: check.id, target: check.target, tier: check.tier, commitId: implementation.head.commitId, treeId: implementation.head.treeId,
        inputDigest: checkInputDigest(implementation, check), status: "passed", findings: [], evidence: "real receipt fixture" })) })) } } } }

for (const mode of ["valid", "missing-change", "missing-fast", "missing-slow", "failed-fast", "failed-slow", "stale-receipt", "wrong-parent", "wrong-native-id", "unhandled-finding", "source-moved"] as const) {
  test(`vibe policy graph: ${mode}`, async t => {
    // Policy graph inputs are explicitly scripted. Separate evidence tests use
    // actual control planning/approval and retained native ancestry.
    const input = structuredClone(evidence)
    const changes = input.request.outcome.result!.changes
    if (mode === "missing-change") (changes as unknown[]).pop()
    if (mode === "missing-fast" || mode === "missing-slow") (changes[0]!.receipts as unknown[]).splice(mode === "missing-fast" ? 0 : 1, 1)
    if (mode === "failed-fast" || mode === "failed-slow") Object.assign(changes[0]!.receipts[mode === "failed-fast" ? 0 : 1]!, { status: "failed" })
    if (mode === "stale-receipt") Object.assign(changes[0]!.receipts[1]!, { commitId: "stale" })
    if (mode === "wrong-parent") Object.assign(changes[1]!.implementation.parent, { commitId: "stale" })
    if (mode === "wrong-native-id") Object.assign(input.request.plan.changes[0]!.atoms[0]!, { changeId: "wrong-jj" })
    if (mode === "unhandled-finding") Object.assign(changes[1]!.receipts[1]!, { findings: [{ owner: "first", sourceCommitId: implementations[1]!.head.commitId, message: "Unresolved review" }] })
    let snapshots = 0, reads = 0
    const leaf = FenceVibeSource.toLayer(fenceVibeSource).pipe(Layer.provide([
      Jj.layerNoop({ snapshot: () => Effect.sync(() => { snapshots++; return { changeId: "fixture" } }) }),
      Layer.succeed(NativeCoding, { read: () => Effect.sync(() => { reads++; return { status: "read" as const, operationId: "new-operation",
        head: { ...implementations[1]!.head, kind: "resolved" as const, operationId: "new-operation", ...(mode === "source-moved" ? { treeId: "changed" } : {}) }, revisions: [] } }),
        apply: () => Effect.die("Admission must not rewrite or land") })
    ]))
    const host = ManagedRuntime.make(Layer.mergeAll(Interpreter.layer(VerifyVibe), policyLayers, leaf).pipe(
      Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer)))
    t.after(() => host.dispose())
    if (mode === "valid") {
      const result = await host.runPromise(VerifyVibe.execute(input, { executionId: "vibe-policy" }))
      assert.equal(result.validatedHead.operationId, "new-operation")
      assert.equal(result.validatedHead.commitId, implementations[1]!.head.commitId)
      assert.deepEqual([snapshots, reads], [1, 1])
      assert.deepEqual(await host.runPromise(VerifyVibe.execute(input, { executionId: "vibe-policy" })), result)
      assert.deepEqual([snapshots, reads], [1, 1], "replay uses the action receipt; the later mutation must present this exact fence")
    } else {
      await assert.rejects(host.runPromise(VerifyVibe.execute(input, { executionId: "vibe-policy" })))
      assert.deepEqual([snapshots, reads], mode === "source-moved" ? [1, 1] : [0, 0], "all retained check and atomic policy gates precede final source observation")
    }
  })
}
