/** Read the actual completed native request after the configured host stops. */
import assert from "node:assert/strict"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Effect, Layer } from "effect"
import * as NativeControl from "../../../packages/smithers/src/internal/NativeControl.ts"
import { ModuleOwner } from "../../../packages/smithers/src/internal/ModuleOwner.ts"
import { readVibeRequest } from "../../coding/vibe-evidence.ts"

export const observeCompletedRequest = async (platform: NativeControl.Platform, root: string, originalCommitId: string) => {
  const native = NativeControl.make(platform)
  const runtime = process.versions.bun ? await import("@smthrs/flows/BunRuntime") : await import("@smthrs/flows/NodeRuntime")
  const storage = runtime.storage(native.executionDatabasePath(root), root).pipe(Layer.provide([platform.host, platform.crypto]))
  const observations = Layer.mergeAll(native.engineDurable(root).runtime,
    RunCatalogRead.layer.pipe(Layer.provideMerge(storage)))
  const evidence = await Effect.runPromise(Effect.gen(function*() {
    const catalog = yield* RunCatalogRead.RunCatalogRead
    const page = yield* catalog.listRuns({ filters: { flowName: "coding/Request", status: "completed" }, limit: 2 })
    assert.equal(page.cursor, null)
    assert.equal(page.runs.length, 1)
    return yield* readVibeRequest({ requestExecutionId: page.runs[0]!.runId }).pipe(
      // This probe verifies real retained ownership, not a new finalization
      // approval. The production module boundary supplies this trusted service.
      Effect.provideService(ModuleOwner, { rootId: "fixture-vibe-probe", flowId: "coding/vibe" }))
  }).pipe(Effect.provide(observations), Effect.scoped))
  assert.equal(evidence.originalSource.commitId, originalCommitId)
  assert.equal(evidence.request.outcome.status, "validated")
  return evidence
}
