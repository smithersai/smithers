import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer } from "effect"
import { NativeCoding, type NativeRevision } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { admitStackBase } from "../coding/stack.ts"

/*
 * A stack request stands on a fresh working change on the retained stack
 * tip before it gathers anything: the import and the create carry request
 * ids derived from the execution, and a workspace already on such a change
 * answers it without touching the native store again.
 */

const workspace = "11111111-1111-4111-a111-111111111111"
const tip = "a".repeat(40)
const base = { commitId: tip, ref: `refs/smithers/workspaces/${workspace}/sources/${tip}` }
const op = (n: string) => n.repeat(128)
const resolved = (changeLetter: string, commit: string, parents: ReadonlyArray<string>, extra: Partial<NativeRevision> = {}): NativeRevision => ({
  kind: "resolved", changeId: changeLetter.repeat(32), commitId: commit, treeId: "e".repeat(40), operationId: op("1"),
  parentCommitIds: [...parents], ...extra } as NativeRevision)

const fake = (head: NativeRevision, createdParent = tip) => {
  const calls: string[] = []
  const layer = Layer.succeed(NativeCoding, {
    sourcePublication: "cloud",
    read: () => Effect.sync(() => { calls.push("read"); return { status: "read" as const, operationId: op("1"), head, revisions: [] } }),
    apply: operation => Effect.sync(() => {
      calls.push(`${operation.operation}:${operation.target.commitId}`)
      const created = resolved("m", "c".repeat(40), [createdParent], { empty: true, description: "" })
      return { status: "accepted" as const, operationId: op("3"), parentOperationId: op("2"), timestamp: "t", head: created, revision: created,
        revisions: [created], provenance: "pending" as const }
    }),
    publishOriginalSource: () => Effect.die("no publication"),
    importSource: request => Effect.sync(() => {
      calls.push(`import:${request.commits.map(commit => commit.ref).join(",")}`)
      return { status: "imported" as const, requestId: request.requestId, workspaceId: workspace, repositoryId: 1, operationId: op("2"),
        head, revisions: [resolved("l", tip, ["b".repeat(40)])] }
    })
  })
  return { calls, layer }
}

test("the tip is imported and a fresh working change is created on it", async () => {
  const { calls, layer } = fake(resolved("k", "d".repeat(40), ["f".repeat(40)]))
  const working = await Effect.runPromise(admitStackBase(base, "execution").pipe(Effect.provide(layer)))
  assert.deepEqual(working.parentCommitIds, [tip])
  assert.deepEqual(calls, ["read", `import:${base.ref}`, `create:${tip}`])
})

test("a workspace already on a fresh change on the tip is answered as is", async () => {
  const { calls, layer } = fake(resolved("m", "c".repeat(40), [tip], { empty: true, description: "" }))
  const working = await Effect.runPromise(admitStackBase(base, "execution").pipe(Effect.provide(layer)))
  assert.equal(working.commitId, "c".repeat(40))
  assert.deepEqual(calls, ["read"])
})

test("a change created anywhere but on the tip is refused", async () => {
  const { layer } = fake(resolved("k", "d".repeat(40), ["f".repeat(40)]), "9".repeat(40))
  const error = await Effect.runPromise(Effect.flip(admitStackBase(base, "execution").pipe(Effect.provide(layer))))
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "source_refused")
})

test("coding/verify runs every check on the imported commit and fails on a failed required one", { timeout: 60_000 }, async t => {
  const { NodeCrypto } = await import("@effect/platform-node")
  const { FlowEngine } = await import("@smthrs/engine")
  const { Action, Interpreter } = await import("@smthrs/flow")
  const { ManagedRuntime } = await import("effect")
  const { Verify } = await import("../coding/verify.ts")
  const { AdmitVerifySource } = await import("../coding/verify-schema.ts")
  const { RunCheck } = await import("../coding/workflow.ts")
  const head = resolved("l", tip, ["b".repeat(40)])
  const checks = [
    { id: "fast", target: "flows", flow: "checks/fast", flowDigest: "f".repeat(64), tier: "fast" as const, required: true },
    { id: "slow", target: "flows", flow: "checks/slow", flowDigest: "s".repeat(64), tier: "slow" as const, required: true },
    { id: "lint", target: "flows", flow: "checks/lint", flowDigest: "l".repeat(64), tier: "slow" as const, required: false }
  ]
  const ran: string[] = []
  const layer = Layer.mergeAll(Interpreter.layer(Verify),
    AdmitVerifySource.toLayer(() => Effect.succeed({ changeId: head.changeId, commitId: head.commitId, treeId: "e".repeat(40),
      operationId: op("1"), parentCommitIds: [...head.parentCommitIds] })),
    RunCheck.toLayer(({ implementation, check }) => Effect.sync(() => {
      ran.push(`${check.id}@${implementation.head.commitId.slice(0, 4)}`)
      return { checkId: check.id, target: check.target, tier: check.tier, change: implementation.change, commitId: implementation.head.commitId,
        treeId: implementation.head.treeId, inputDigest: "d", status: check.id === "slow" ? "failed" as const : "passed" as const,
        evidence: "", findings: [] }
    }))
  ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(FlowEngine.layerMemory), Layer.provideMerge(NodeCrypto.layer))
  const host = ManagedRuntime.make(layer)
  t.after(() => host.dispose())
  const result = await host.runPromise(Verify.execute({ source: base, checks }, { executionId: "verify" }))
  assert.deepEqual([...ran].sort(), ["fast@aaaa", "lint@aaaa", "slow@aaaa"])
  assert.equal(result.status, "failed")
  assert.deepEqual(result.failed, ["slow"])
})
