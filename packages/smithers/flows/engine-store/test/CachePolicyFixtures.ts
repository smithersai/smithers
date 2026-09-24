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
export const activate = (runId: string, parentRunId?: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}", parentRunId === undefined ? undefined : { parentRunId })
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die("claim lost")
    yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
  })
export const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "policy-snapshot" as never, changeId: "policy-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)
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
