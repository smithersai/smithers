import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"

export const owner: Ownership.OwnerId = { hostId: "cache-policy", pid: 7, nonce: "lane-c" }
export const descriptor: ActionPersistence.BoundaryMetadata = { readSet: [], writeSet: [], boundaryMode: "hard" }
export const evidence: StepBoundary.BoundaryEvidence = {
  declaredOutputs: { outputs: [] },
  diffIdentity: "policy-diff",
  wholeTreeWritesVerified: true,
  hermeticReadsVerified: true
}
export const activate = (
  runId: string,
  runOwner: Ownership.OwnerId = owner,
  options: { readonly parentRunId?: string; readonly claimedAtMs?: number } = {}
) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(
      runId,
      "{}",
      options.parentRunId === undefined ? undefined : { parentRunId: options.parentRunId }
    )
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, runOwner, options.claimedAtMs ?? 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, runOwner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })
export const jjWith = (overrides: Partial<Parameters<typeof Jj.make>[0]> = {}) =>
  Layer.succeed(
    Jj.Jj,
    Jj.make({
      snapshot: () => Effect.succeed({ commitId: "policy-snapshot" as never, changeId: "policy-snapshot" as never }),
      restore: () => Effect.void,
      diff: () => Effect.succeed(""),
      workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void,
      status: () => Effect.succeed(""),
      ...overrides
    })
  )
export const jj = jjWith()
export const boundary = (onReplay: () => void = () => {}) =>
  Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.make({
      prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
      settle: () => Effect.succeed(evidence),
      replayOutputs: () => Effect.sync(onReplay)
    })
  )
export const dispatch = (
  runId: string,
  key: string,
  execute: ActionPersistence.Dependencies["execute"],
  action: unknown = {}
) =>
  ActionPersistence.make({ runId, owner, sourceId: "cache-policy", execute })({
    action,
    key,
    tier: "sealed",
    attempt: 1,
    metadata: descriptor
  })
